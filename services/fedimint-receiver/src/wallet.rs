//! The wallet: one fedimint client per joined federation, all from one seed, and the receive
//! flow on top of them.
//!
//! A receive goes:
//!
//! 1. read the notes (no federation contact) and find their federation among those joined;
//! 2. check their signatures against that federation's keys and ask the client what the reissue
//!    would cost;
//! 3. write the receive record (state `pending`, the fedimint operation id, the notes), synced to
//!    disk;
//! 4. hand the notes to the client, which submits the reissue in its own state machines;
//! 5. follow the operation until the federation has issued the wallet's new notes (`done`) or
//!    refused the old ones (`failed`), and write the outcome.
//!
//! The operation id is derived from the notes by fedimint itself, so it is known at step 3. After
//! a restart, a pending record whose operation the client never saw (a crash between 3 and 4) is
//! submitted again; one the client has is only followed, and the client resumes its own state
//! machines. A set of notes is never submitted under two operation ids, so it is never counted
//! twice.

use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{Context as _, Result, anyhow};
use fedimint_client::{Client, ClientHandleArc, RootSecret};
use fedimint_connectors::ConnectorRegistry;
use fedimint_core::config::{ClientConfig, FederationId};
use fedimint_core::core::OperationId;
use fedimint_core::db::Database;
use fedimint_core::invite_code::InviteCode;
use fedimint_core::module::AmountUnit;
use futures::StreamExt as _;
use serde::Serialize;
use tokio::sync::{Mutex, RwLock};

use crate::error::{ApiError, Code};
use crate::notes::{Inner, Kind, Notes};
use crate::store::{FederationFile, ReceiveRecord, State, Store, now};

/// One joined federation.
pub struct Federation {
    pub id: FederationId,
    pub name: Option<String>,
    pub client: ClientHandleArc,
    /// Every module kind in the federation's config.
    pub modules: Vec<String>,
}

impl Federation {
    fn has_kind(&self, kind: Kind) -> bool {
        self.modules.iter().any(|m| m == kind.as_str())
    }

    /// The kinds of notes this federation can receive here.
    pub fn receives(&self) -> Vec<&'static str> {
        [Kind::MintV1, Kind::MintV2].into_iter().filter(|k| self.has_kind(*k)).map(Kind::as_str).collect()
    }

    /// What the wallet holds in this federation: the sum over its mint modules. A client counts
    /// only its primary module in its own balance, and with both mints the change of a reissue
    /// can land in either.
    pub async fn balance_msat(&self) -> u64 {
        let cfg = self.client.config().await;
        let mut total = 0u64;
        for (id, m) in &cfg.modules {
            let kind = m.kind().as_str();
            if kind != Kind::MintV1.as_str() && kind != Kind::MintV2.as_str() {
                continue;
            }
            let Ok(module) = self.client.get_module_client_dyn(*id) else { continue };
            let mut dbtx = self.client.db().begin_transaction_nc().await;
            total = total.saturating_add(module.get_balance(*id, &mut dbtx.to_ref_nc(), AmountUnit::BITCOIN).await.msats);
        }
        total
    }
}

/// How joined federations are matched to a set of notes.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    /// Exactly one joined federation.
    Joined,
    /// None.
    NotJoined,
    /// The notes carry only a prefix, and several joined federations share it.
    Ambiguous,
}

pub struct Wallet {
    pub store: Store,
    root_secret: RootSecret,
    connectors: ConnectorRegistry,
    feds: RwLock<BTreeMap<FederationId, Arc<Federation>>>,
    join_lock: Mutex<()>,
    receive_lock: Mutex<()>,
}

fn module_inits(builder: &mut fedimint_client::ClientBuilder) {
    builder.with_module(fedimint_mint_client::MintClientInit);
    builder.with_module(fedimint_mintv2_client::MintClientInit);
}

async fn open_db(path: &Path) -> Result<Database> {
    Ok(fedimint_rocksdb::RocksDb::build(path).open().await.with_context(|| format!("opening {}", path.display()))?.into())
}

fn module_kinds(cfg: &ClientConfig) -> Vec<String> {
    let mut kinds: Vec<String> = cfg.modules.values().map(|m| m.kind().as_str().to_owned()).collect();
    kinds.sort();
    kinds.dedup();
    kinds
}

impl Wallet {
    /// Open the data directory: every federation joined before, and the receives still pending,
    /// which are picked up again in the background.
    pub async fn open(data_dir: &Path, root_secret: RootSecret) -> Result<Arc<Self>> {
        let store = Store::open(data_dir)?;
        let connectors = ConnectorRegistry::build_from_client_defaults().with_env_var_overrides().bind().await;
        let w = Arc::new(Self {
            store,
            root_secret,
            connectors,
            feds: RwLock::new(BTreeMap::new()),
            join_lock: Mutex::new(()),
            receive_lock: Mutex::new(()),
        });
        for f in w.store.federations()? {
            let fed = w.open_federation(&f).await.with_context(|| format!("opening federation {}", f.id))?;
            tracing::info!(federation = %fed.id, modules = ?fed.modules, "federation opened");
            w.feds.write().await.insert(fed.id, Arc::new(fed));
        }
        w.resume().await?;
        Ok(w)
    }

    async fn open_federation(&self, f: &FederationFile) -> Result<Federation> {
        let db = open_db(&self.store.federation_dir(&f.id).join("client.db")).await?;
        let mut builder = Client::builder().await;
        module_inits(&mut builder);
        let client = builder.open(self.connectors.clone(), db, self.root_secret.clone()).await?;
        let cfg = client.config().await;
        let id = client.federation_id();
        anyhow::ensure!(id.to_string() == f.id, "the client database holds federation {id}, not {}", f.id);
        Ok(Federation { id, name: f.name.clone(), modules: module_kinds(&cfg), client: Arc::new(client) })
    }

    pub async fn federations(&self) -> Vec<Arc<Federation>> {
        self.feds.read().await.values().cloned().collect()
    }

    pub async fn federation(&self, id: &str) -> Option<Arc<Federation>> {
        let id = FederationId::from_str(id).ok()?;
        self.feds.read().await.get(&id).cloned()
    }

    /// Join the federation behind `invite`, or return it when it is joined already. Refuses a
    /// federation with no mint module this service speaks, before anything is written.
    pub async fn join(&self, invite: &str) -> Result<(Arc<Federation>, bool), ApiError> {
        let invite_code = InviteCode::from_str(invite.trim()).map_err(|_| ApiError::new(Code::BadInvite, "not a Fedimint invite code"))?;
        let _guard = self.join_lock.lock().await;
        if let Some(fed) = self.feds.read().await.get(&invite_code.federation_id()) {
            return Ok((fed.clone(), true));
        }
        let mut builder = Client::builder().await;
        module_inits(&mut builder);
        let preview = builder.preview(self.connectors.clone(), &invite_code).await.map_err(|e| {
            tracing::warn!(federation = %invite_code.federation_id(), "join: the federation did not answer: {e:#}");
            ApiError::new(Code::Unreachable, format!("could not read the federation's config: {e}"))
        })?;
        let cfg = preview.config().clone();
        let id = cfg.calculate_federation_id();
        if id != invite_code.federation_id() {
            return Err(ApiError::new(Code::BadInvite, "the federation's config does not match the invite code"));
        }
        let modules = module_kinds(&cfg);
        if !modules.iter().any(|m| m == Kind::MintV1.as_str() || m == Kind::MintV2.as_str()) {
            return Err(ApiError::new(
                Code::ModuleUnsupported,
                format!("the federation has no mint module this service speaks (it has {modules:?})"),
            ));
        }
        let dir = self.store.federation_dir(&id.to_string());
        crate::store::create_private_dir(&dir)?;
        let db = open_db(&dir.join("client.db")).await?;
        // A join that crashed after the client was made but before federation.json was written
        // left an initialised database: open it rather than join a second time.
        let client = if Client::is_initialized(&db).await {
            let mut builder = Client::builder().await;
            module_inits(&mut builder);
            builder.open(self.connectors.clone(), db, self.root_secret.clone()).await.map_err(|e| anyhow!("{e:#}"))?
        } else {
            preview.join(db, self.root_secret.clone()).await.map_err(|e| anyhow!("joining: {e:#}"))?
        };
        let name = cfg.global.federation_name().map(str::to_owned);
        self.store.save_federation(&FederationFile {
            id: id.to_string(),
            invite: invite_code.to_string(),
            name: name.clone(),
            joined_at: now(),
        })?;
        let fed = Arc::new(Federation { id, name, modules, client: Arc::new(client) });
        self.feds.write().await.insert(id, fed.clone());
        tracing::info!(federation = %id, modules = ?fed.modules, "federation joined");
        Ok((fed, false))
    }

    /// Which joined federation issued `notes`, if exactly one did.
    pub async fn resolve(&self, notes: &Notes) -> (Resolution, Option<Arc<Federation>>) {
        let feds = self.feds.read().await;
        if let Some(id) = notes.federation_id {
            return match feds.get(&id) {
                Some(f) => (Resolution::Joined, Some(f.clone())),
                None => (Resolution::NotJoined, None),
            };
        }
        let mut matches = feds.values().filter(|f| f.id.to_prefix() == notes.prefix);
        match (matches.next(), matches.next()) {
            (Some(f), None) => (Resolution::Joined, Some(f.clone())),
            (None, _) => (Resolution::NotJoined, None),
            (Some(_), Some(_)) => (Resolution::Ambiguous, None),
        }
    }

    /// The federation for a receive of `notes`, or the error that says why there is none.
    pub async fn federation_for(&self, notes: &Notes) -> Result<Arc<Federation>, ApiError> {
        match self.resolve(notes).await {
            (Resolution::Joined, Some(f)) if f.has_kind(notes.kind) => Ok(f),
            (Resolution::Joined, Some(f)) => Err(ApiError::new(
                Code::ModuleUnsupported,
                format!("these are {} notes and federation {} has no {} module", notes.kind.as_str(), f.id, notes.kind.as_str()),
            )),
            (Resolution::Ambiguous, _) => Err(ApiError::new(
                Code::AmbiguousFederation,
                "the notes carry only a federation id prefix and more than one joined federation has it",
            )),
            _ => Err(ApiError::new(Code::NotJoined, "the federation that issued these notes has not been joined")),
        }
    }

    /// Whether every note's signature verifies under the federation's keys for its amount. Read
    /// from the client's config: no federation contact.
    pub async fn signatures_valid(&self, fed: &Federation, notes: &Notes) -> bool {
        let cfg = fed.client.config().await;
        match &notes.inner {
            Inner::V1(oob) => {
                use fedimint_mint_common::config::MintClientConfig;
                let Some((_, mc)) = cfg.get_first_module_by_kind::<MintClientConfig>(fedimint_mint_common::KIND).ok() else {
                    return false;
                };
                oob.notes().iter_items().all(|(amount, n)| {
                    mc.tbs_pks
                        .get(amount)
                        .is_some_and(|pk| fedimint_mint_common::Note { nonce: n.nonce(), signature: n.signature }.verify(*pk))
                })
            }
            Inner::V2(ecash) => {
                use fedimint_mintv2_common::config::MintClientConfig;
                let Some((_, mc)) = cfg.get_first_module_by_kind::<MintClientConfig>(fedimint_mintv2_common::KIND).ok() else {
                    return false;
                };
                ecash.notes().iter().all(|n| {
                    mc.tbs_agg_pks.get(&n.denomination).is_some_and(|pk| {
                        let note = fedimint_mintv2_common::Note {
                            denomination: n.denomination,
                            nonce: n.keypair.public_key(),
                            signature: n.signature,
                        };
                        fedimint_mintv2_common::verify_note(note, *pk)
                    })
                })
            }
        }
    }

    /// What the federation would charge to reissue `notes` into this wallet, in msat. Computed by
    /// the client from its config and its own notes, without contacting the federation.
    async fn fee_quote(&self, fed: &Federation, notes: &Notes) -> Result<u64, ApiError> {
        let quote = match &notes.inner {
            Inner::V1(oob) => {
                let mint = fed.client.get_first_module::<fedimint_mint_client::MintClientModule>().map_err(ApiError::internal)?;
                mint.reissue_fee_quote(oob).await
            }
            Inner::V2(ecash) => {
                let mint = fed.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(ApiError::internal)?;
                mint.receive_fee_quote(ecash).await
            }
        };
        match quote {
            Ok(q) => Ok(q.total().get_bitcoin().msats),
            Err(e) if e.is_insufficient_funds() => {
                Err(ApiError::new(Code::FeeExceedsValue, "reissuing these notes would cost the federation's fee and leave nothing"))
            }
            Err(e) => Err(ApiError::internal(format!("fee quote: {e}"))),
        }
    }

    /// Start receiving `notes`, or return the record of the receive started earlier for the
    /// same notes (whatever key that one had). The bool is true for such a repeat.
    pub async fn receive(self: &Arc<Self>, notes: &Notes, key: &str) -> Result<(ReceiveRecord, bool), ApiError> {
        let _guard = self.receive_lock.lock().await;
        if let Some(r) = self.store.receive(&notes.id)? {
            return Ok((r, true));
        }
        let fed = self.federation_for(notes).await?;
        if !self.signatures_valid(&fed, notes).await {
            return Err(ApiError::new(Code::BadNotes, "the notes' signatures do not verify under the federation's keys"));
        }
        if let Inner::V2(ecash) = &notes.inner {
            // The mintv2 client refuses a note worth no more than the base fee; refuse it here,
            // before anything is recorded, rather than record a receive it will not start.
            use fedimint_mintv2_common::config::MintClientConfig;
            let cfg = fed.client.config().await;
            if let Ok((_, mc)) = cfg.get_first_module_by_kind::<MintClientConfig>(fedimint_mintv2_common::KIND)
                && ecash.notes().iter().any(|n| n.amount() <= mc.fee_consensus.base_fee())
            {
                return Err(ApiError::new(Code::FeeExceedsValue, "a note is worth no more than the federation's fee to reissue it"));
            }
        }
        let fee = self.fee_quote(&fed, notes).await?;
        if fee >= notes.amount_msat {
            return Err(ApiError::new(Code::FeeExceedsValue, "reissuing these notes would cost at least what they are worth"));
        }
        let t = now();
        let operation_id = notes.operation_id();
        let record = ReceiveRecord {
            notes_id: notes.id.clone(),
            key: key.to_owned(),
            federation_id: fed.id.to_string(),
            module: notes.kind,
            operation_id: operation_id.fmt_full().to_string(),
            state: State::Pending,
            gross_msat: notes.amount_msat,
            fee_msat: fee,
            net_msat: notes.amount_msat - fee,
            failure: None,
            reason: None,
            created_at: t,
            updated_at: t,
            notes: Some(notes.canonical()),
        };
        self.store.save_receive(&record)?;
        tracing::info!(notes_id = %record.notes_id, federation = %record.federation_id, gross_msat = record.gross_msat, "receive recorded");
        crate::hooks::crash_point("after_persist");
        let record = match self.submit(&fed, notes, operation_id).await {
            Ok(()) => record,
            Err(reason) => self.finish(record, State::Failed, Some(("refused", reason)), None)?,
        };
        crate::hooks::crash_point("after_submit");
        if record.state == State::Pending {
            self.spawn_follow(fed, record.clone());
        }
        Ok((record, false))
    }

    pub fn record(&self, notes_id: &str) -> Result<Option<ReceiveRecord>> {
        self.store.receive(notes_id)
    }

    /// Hand the notes to the client. An operation the client already has (submitted before a
    /// restart) counts as submitted. Errors only for a refusal made by this client before
    /// anything reached the federation.
    async fn submit(&self, fed: &Federation, notes: &Notes, expected: OperationId) -> Result<(), String> {
        let meta = serde_json::json!({ "forge_notes_id": notes.id });
        let op = match &notes.inner {
            Inner::V1(oob) => {
                let mint = fed.client.get_first_module::<fedimint_mint_client::MintClientModule>().map_err(|e| e.to_string())?;
                match mint.reissue_external_notes(oob.clone(), meta).await {
                    Ok(op) => op,
                    Err(fedimint_mint_client::ReissueExternalNotesError::AlreadyReissued) => expected,
                    Err(e) => return Err(e.to_string()),
                }
            }
            Inner::V2(ecash) => {
                let mint = fed.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(|e| e.to_string())?;
                match mint.receive(ecash.clone(), meta).await {
                    Ok(op) => op,
                    Err(fedimint_mintv2_client::ReceiveECashError::AlreadyReceived) => expected,
                    Err(e) => return Err(e.to_string()),
                }
            }
        };
        if op != expected {
            // Never expected: fedimint derives the id from the notes the same way notes.rs does.
            // The federation still refuses a second spend of the same notes, so this is a bug to
            // fix, not money at risk.
            tracing::error!(notes_id = %notes.id, "the client ran the receive under operation {} instead of {}", op.fmt_full(), expected.fmt_full());
        }
        Ok(())
    }

    /// Write the end of a receive. The notes leave the record with it.
    fn finish(&self, mut r: ReceiveRecord, state: State, failure: Option<(&str, String)>, fee_msat: Option<u64>) -> Result<ReceiveRecord> {
        r.state = state;
        if let Some(fee) = fee_msat {
            r.fee_msat = fee;
            r.net_msat = r.gross_msat.saturating_sub(fee);
        }
        if let Some((code, reason)) = failure {
            r.failure = Some(code.to_owned());
            r.reason = Some(reason);
        }
        r.notes = None;
        r.updated_at = now();
        self.store.save_receive(&r)?;
        match r.state {
            State::Done => tracing::info!(notes_id = %r.notes_id, net_msat = r.net_msat, fee_msat = r.fee_msat, "receive done"),
            _ => tracing::warn!(notes_id = %r.notes_id, failure = ?r.failure, reason = ?r.reason, "receive failed"),
        }
        Ok(r)
    }

    fn spawn_follow(self: &Arc<Self>, fed: Arc<Federation>, record: ReceiveRecord) {
        let w = self.clone();
        tokio::spawn(async move {
            // Following can fail only on the client's own reads; try again, more slowly each time,
            // and the receive stays pending meanwhile.
            let mut wait = std::time::Duration::from_secs(2);
            while let Err(e) = w.follow(&fed, record.clone()).await {
                tracing::error!(notes_id = %record.notes_id, "following the receive failed: {e:#}; trying again in {}s", wait.as_secs());
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(std::time::Duration::from_secs(300));
            }
        });
    }

    /// Follow the receive's operation to its end and write the outcome.
    async fn follow(&self, fed: &Federation, record: ReceiveRecord) -> Result<()> {
        let op = OperationId::from_str(&record.operation_id).map_err(|e| anyhow!("bad operation id: {e}"))?;
        let outcome: Result<(), (&str, String)> = match record.module {
            Kind::MintV1 => {
                use fedimint_mint_client::ReissueExternalNotesState as S;
                let mint = fed.client.get_first_module::<fedimint_mint_client::MintClientModule>()?;
                let mut updates = mint.subscribe_reissue_external_notes(op).await?.into_stream();
                let mut accepted = false;
                let mut end = Err(("issuance_failed", "the client stopped reporting before the receive ended".to_owned()));
                while let Some(state) = updates.next().await {
                    match state {
                        S::Created => {}
                        S::Issuing => accepted = true,
                        S::Done => {
                            end = Ok(());
                            break;
                        }
                        S::Failed(reason) => {
                            end = Err((if accepted { "issuance_failed" } else { "rejected" }, reason));
                            break;
                        }
                    }
                }
                end
            }
            Kind::MintV2 => {
                use fedimint_mintv2_client::{FinalReceiveOperationState, MintClientModule, MintOperationMeta};
                let mint = fed.client.get_first_module::<MintClientModule>()?;
                match mint.await_final_receive_operation_state(op).await? {
                    FinalReceiveOperationState::Rejected => {
                        Err(("rejected", "the federation refused the notes: spent already, or not valid".to_owned()))
                    }
                    FinalReceiveOperationState::Success => {
                        // Success means the federation took the transaction. The wallet's new
                        // notes are issued after that; done waits for them.
                        let entry = fed.client.operation_log().get_operation(op).await.context("the receive's operation is gone")?;
                        match entry.meta::<MintOperationMeta>() {
                            MintOperationMeta::Receive { change_outpoint_range, .. } => fed
                                .client
                                .await_primary_bitcoin_module_outputs(op, change_outpoint_range.into_iter().collect())
                                .await
                                .map_err(|e| ("issuance_failed", e.to_string())),
                            _ => Err(("issuance_failed", "the operation is not a receive".to_owned())),
                        }
                    }
                }
            }
        };
        match outcome {
            Ok(()) => {
                let fee = fed.client.get_operation_fees(op).await.ok().flatten().map(|a| a.get_bitcoin().msats);
                self.finish(record, State::Done, None, fee)?;
            }
            Err(failure) => {
                self.finish(record, State::Failed, Some(failure), None)?;
            }
        }
        Ok(())
    }

    /// Pick up every receive still pending after a restart.
    async fn resume(self: &Arc<Self>) -> Result<()> {
        for record in self.store.pending_receives()? {
            let Some(fed) = self.federation(&record.federation_id).await else {
                tracing::error!(notes_id = %record.notes_id, federation = %record.federation_id, "a pending receive's federation is not open; left pending");
                continue;
            };
            let op = OperationId::from_str(&record.operation_id).map_err(|e| anyhow!("bad operation id: {e}"))?;
            if fed.client.operation_log().get_operation(op).await.is_none() {
                // Recorded, never submitted: the process stopped between the two.
                let Some(text) = record.notes.clone() else {
                    self.finish(record, State::Failed, Some(("refused", "pending without its notes".to_owned())), None)?;
                    continue;
                };
                let notes = crate::notes::parse(&text).map_err(|e| anyhow!("a pending receive's notes no longer read: {e}"))?;
                tracing::info!(notes_id = %record.notes_id, "submitting a receive that was recorded before a restart");
                if let Err(reason) = self.submit(&fed, &notes, op).await {
                    self.finish(record, State::Failed, Some(("refused", reason)), None)?;
                    continue;
                }
            } else {
                tracing::info!(notes_id = %record.notes_id, "following a receive started before a restart");
            }
            self.spawn_follow(fed, record);
        }
        Ok(())
    }
}
