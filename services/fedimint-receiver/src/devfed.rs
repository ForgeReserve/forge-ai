//! A development federation in this process (feature `devfed`): four guardians from
//! fedimint-testing on loopback ports, a fake bitcoin backend, and one issuing client that hands
//! out real notes. No devimint, no nix, no bitcoind, no real money: the issuer funds itself from
//! the test-only dummy module, which makes value from nothing.
//!
//! The `devfed` binary serves this over HTTP for the gateway's end to end tests; this crate's own
//! tests use it directly.

use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow, bail};
use fedimint_client::ClientHandleArc;
use fedimint_client::transaction::TransactionBuilder;
use fedimint_core::Amount;
use fedimint_core::base32::{self, FEDIMINT_PREFIX};
use fedimint_core::core::OperationId;
use fedimint_dummy_client::{DummyClientInit, DummyClientModule};
use fedimint_dummy_server::DummyInit;
use fedimint_testing::federation::FederationTest;
use fedimint_testing::fixtures::Fixtures;
use futures::StreamExt as _;

/// Which mint modules the federation runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mints {
    /// Mint v1 only: the shape of the federations Fedimint card tills use.
    V1,
    /// Mintv2 only: what a 0.13 federation runs by default.
    V2,
    /// Both, mint v1 first.
    Both,
}

impl FromStr for Mints {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s {
            "mint" | "v1" => Ok(Mints::V1),
            "mintv2" | "v2" => Ok(Mints::V2),
            "both" => Ok(Mints::Both),
            _ => bail!("unknown mint set {s:?}: mint, mintv2 or both"),
        }
    }
}

/// Upper bound for each step, so a stalled guardian fails instead of hanging.
pub const STEP: Duration = Duration::from_secs(60);

pub struct DevFed {
    /// Keep alive: dropping it stops the guardians.
    pub fed: FederationTest,
    /// The client that hands out mint v1 notes, and the one for mintv2 notes (the same client on
    /// a federation with one mint).
    issuer_v1: Option<ClientHandleArc>,
    issuer_v2: Option<ClientHandleArc>,
    pub mints: Mints,
}

/// A client of `fed` that knows one mint module (and the dummy module that funds it), so its
/// funds are always notes of that mint. A client with both mints keeps its change in whichever is
/// its primary module, and could not hand out notes of the other.
async fn single_mint_client(fed: &FederationTest, v2: bool) -> Result<ClientHandleArc> {
    use fedimint_bip39::Bip39RootSecretStrategy;
    use fedimint_client::secret::RootSecretStrategy as _;
    let mut builder = fedimint_client::Client::builder().await;
    if v2 {
        builder.with_module(fedimint_mintv2_client::MintClientInit);
    } else {
        builder.with_module(fedimint_mint_client::MintClientInit);
    }
    builder.with_module(DummyClientInit);
    let connectors = fedimint_connectors::ConnectorRegistry::build_from_testing_env().bind().await;
    let preview = builder.preview(connectors, &fed.invite_code()).await?;
    let words = Bip39RootSecretStrategy::<12>::random(&mut fedimint_core::secp256k1::rand::thread_rng());
    let root = fedimint_client::RootSecret::StandardDoubleDerive(Bip39RootSecretStrategy::<12>::to_root_secret(&words));
    let db: fedimint_core::db::Database = fedimint_core::db::mem_impl::MemDatabase::new().into();
    Ok(std::sync::Arc::new(preview.join(db, root).await?))
}

impl DevFed {
    /// Start a federation. `fees`: the test federation's default mint fees (100 msat a note);
    /// without, every fee is zero.
    pub async fn start(mints: Mints, fees: bool) -> Result<Self> {
        if std::env::var_os("FM_TEST_USE_REAL_DAEMONS").is_some() {
            bail!("FM_TEST_USE_REAL_DAEMONS is set: this needs the in-process fake bitcoin backend; unset it");
        }
        let fixtures = match mints {
            Mints::V1 => Fixtures::new_primary(fedimint_mint_client::MintClientInit, fedimint_mint_server::MintInit),
            Mints::V2 => Fixtures::new_primary(fedimint_mintv2_client::MintClientInit, fedimint_mintv2_server::MintInit),
            Mints::Both => Fixtures::new_primary(fedimint_mint_client::MintClientInit, fedimint_mint_server::MintInit)
                .with_module(fedimint_mintv2_client::MintClientInit, fedimint_mintv2_server::MintInit),
        }
        .with_module(DummyClientInit, DummyInit);
        let mut builder = fixtures.new_fed_builder(0);
        if !fees {
            builder = builder.disable_mint_fees();
        }
        let fed = tokio::time::timeout(STEP, builder.build()).await.context("the federation did not start within 60 s")?;
        let (issuer_v1, issuer_v2) = match mints {
            Mints::V1 => (Some(fed.new_client().await), None),
            Mints::V2 => (None, Some(fed.new_client().await)),
            Mints::Both => (Some(single_mint_client(&fed, false).await?), Some(single_mint_client(&fed, true).await?)),
        };
        Ok(Self { fed, issuer_v1, issuer_v2, mints })
    }

    pub fn invite(&self) -> String {
        self.fed.invite_code().to_string()
    }

    pub fn id(&self) -> String {
        self.fed.id().to_string()
    }

    fn issuer(&self, v2: bool) -> Result<&ClientHandleArc> {
        let issuer = if v2 { &self.issuer_v2 } else { &self.issuer_v1 };
        issuer.as_ref().ok_or_else(|| anyhow!("this federation has no {} module", if v2 { "mintv2" } else { "mint" }))
    }

    /// Give `issuer` `amount` from nothing (the dummy module).
    async fn fund(issuer: &ClientHandleArc, amount: Amount) -> Result<()> {
        let dummy = issuer.get_first_module::<DummyClientModule>()?;
        let op = OperationId::new_random();
        let range = issuer
            .finalize_and_submit_transaction(op, "fund", |_| (), TransactionBuilder::new().with_inputs(dummy.create_input(amount)))
            .await?;
        tokio::time::timeout(STEP, issuer.await_primary_bitcoin_module_outputs(op, range.into_iter().collect()))
            .await
            .context("funding timed out")??;
        Ok(())
    }

    /// Notes for `amount_msat` from the issuer, the way a wallet hands them out: mint v1's
    /// `send_oob_notes` (what a Fedimint card till's wallet calls) or mintv2's `send`. `v2` picks
    /// the module on a federation with both. Both round the amount up to what their notes can
    /// make, so the notes' own value comes back with them.
    pub async fn notes(&self, amount_msat: u64, v2: bool, include_invite: bool) -> Result<(String, u64)> {
        let amount = Amount::from_msats(amount_msat);
        let use_v2 = match self.mints {
            Mints::V1 => false,
            Mints::V2 => true,
            Mints::Both => v2,
        };
        let issuer = self.issuer(use_v2)?;
        Self::fund(issuer, Amount::from_msats(amount_msat.saturating_mul(2).saturating_add(100_000))).await?;
        if use_v2 {
            let mint = issuer.get_first_module::<fedimint_mintv2_client::MintClientModule>()?;
            let (_, ecash) = tokio::time::timeout(STEP, mint.send(amount, serde_json::Value::Null, include_invite))
                .await
                .context("send timed out")?
                .map_err(|e| anyhow!("mintv2 send: {e}"))?;
            Ok((base32::encode_prefixed(FEDIMINT_PREFIX, &ecash), ecash.amount().msats))
        } else {
            let mint = issuer.get_first_module::<fedimint_mint_client::MintClientModule>()?;
            let notes = tokio::time::timeout(STEP, mint.send_oob_notes(amount, ())).await.context("send timed out")??;
            let value = notes.total_amount().msats;
            let text = if include_invite {
                fedimint_mint_client::OOBNotes::new_with_invite(notes.notes().clone(), &self.fed.invite_code()).to_string()
            } else {
                notes.to_string()
            };
            Ok((text, value))
        }
    }

    /// Spend `notes` into the issuer's own wallet, as another wallet would: afterwards nobody else
    /// can receive them.
    pub async fn spend(&self, notes: &str) -> Result<()> {
        let parsed = crate::notes::parse(notes).map_err(|e| anyhow!("{e}"))?;
        match parsed.inner {
            crate::notes::Inner::V1(oob) => {
                use fedimint_mint_client::ReissueExternalNotesState as S;
                let mint = self.issuer(false)?.get_first_module::<fedimint_mint_client::MintClientModule>()?;
                let op = mint.reissue_external_notes(oob, ()).await?;
                let mut updates = mint.subscribe_reissue_external_notes(op).await?.into_stream();
                tokio::time::timeout(STEP, async {
                    while let Some(s) = updates.next().await {
                        match s {
                            S::Done => return Ok(()),
                            S::Failed(e) => return Err(anyhow!("the spend failed: {e}")),
                            S::Created | S::Issuing => {}
                        }
                    }
                    Err(anyhow!("the spend ended without an outcome"))
                })
                .await
                .context("the spend timed out")?
            }
            crate::notes::Inner::V2(ecash) => {
                let mint = self.issuer(true)?.get_first_module::<fedimint_mintv2_client::MintClientModule>()?;
                let op = mint.receive(ecash, serde_json::Value::Null).await?;
                let state =
                    tokio::time::timeout(STEP, mint.await_final_receive_operation_state(op)).await.context("the spend timed out")??;
                if state != fedimint_mintv2_client::FinalReceiveOperationState::Success {
                    bail!("the spend ended {state:?}");
                }
                Ok(())
            }
        }
    }
}
