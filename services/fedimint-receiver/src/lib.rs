//! fedimint-receiver: holds Fedimint eCash for the Forge AI gateway.
//!
//! One process, any number of federations. A federation is joined by invite code; the joined
//! federations are the only ones whose notes are received. The gateway reaches this service over
//! the internal network with a bearer token, and asks it to read notes (`/parse`) and to receive
//! them (`/receive`). See docs/FEDIMINT-RECEIVER.md.

pub mod api;
pub mod backup;
pub mod config;
pub mod error;
pub mod hooks;
pub mod notes;
pub mod seed;
pub mod store;
pub mod wallet;

use anyhow::{Context as _, Result};

/// Open the data directory, bind, and serve until SIGINT or SIGTERM. Prints the bound address
/// as one JSON line on stdout once listening (`{"listening":"127.0.0.1:8790"}`), for whoever
/// started the process with port 0.
pub async fn serve(cfg: config::Config) -> Result<()> {
    store::create_private_dir(&cfg.data_dir)?;
    let _lock = store::lock_data_dir(&cfg.data_dir)?;
    let root_secret = {
        let seed = seed::load(&cfg.data_dir, cfg.mnemonic.as_deref())?;
        tracing::info!(source = ?seed.source, "seed loaded");
        seed.root_secret()
    };
    let wallet = wallet::Wallet::open(&cfg.data_dir, root_secret).await?;
    let state = api::AppState { wallet, token: cfg.token.into() };
    let listener = tokio::net::TcpListener::bind(cfg.listen).await.with_context(|| format!("binding {}", cfg.listen))?;
    let addr = listener.local_addr()?;
    println!("{}", serde_json::json!({ "listening": addr.to_string() }));
    tracing::info!(%addr, "listening");
    axum::serve(listener, api::router(state)).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

/// `fedimint-receiver recover`: rebuild every federation's wallet from the seed into a data
/// directory that lost its client databases. The federations come from `backup` (whose files are
/// first put into the directory, which must be empty), from `invites` (one invite code each, as
/// the gateway exports them), and from what an earlier `recover` that stopped left to do. Returns
/// one JSON object per federation, with no invite, note or word in it; never starts a new seed.
pub async fn recover(
    data_dir: &std::path::Path,
    mnemonic: Option<&str>,
    backup: Option<backup::Bundle>,
    invites: &[String],
) -> Result<Vec<serde_json::Value>> {
    store::create_private_dir(data_dir)?;
    let _lock = store::lock_data_dir(data_dir)?;
    let st = store::Store::open(data_dir)?;
    if let Some(b) = &backup {
        backup::unpack(b, &st)?;
        tracing::info!(federations = b.federations.len(), receives = b.receives.len(), "backup unpacked");
    }
    if mnemonic.is_none() && !data_dir.join(seed::MNEMONIC_FILE).exists() {
        anyhow::bail!("recover needs the wallet's words: set {} (or restore a backup that holds a generated mnemonic)", seed::MNEMONIC_ENV);
    }
    let root_secret = {
        let seed = seed::load(data_dir, mnemonic)?;
        tracing::info!(source = ?seed.source, "seed loaded");
        seed.root_secret()
    };
    for invite in invites {
        let code = <fedimint_core::invite_code::InviteCode as std::str::FromStr>::from_str(invite.trim())
            .map_err(|_| anyhow::anyhow!("an invite given to recover is not a Fedimint invite code"))?;
        let id = code.federation_id().to_string();
        if st.restore_file(&id)?.is_none() && (st.federation_file(&id)?.is_none() || !st.federation_dir(&id).join("client.db").exists()) {
            st.save_restore_file(&store::FederationFile {
                id,
                invite: code.to_string(),
                name: None,
                joined_at: store::now(),
                restored_at: None,
                restore_closed_at: None,
            })?;
        }
    }
    let wallet = wallet::Wallet::bare(data_dir, root_secret).await?;
    let mut out = Vec::new();
    for id in st.federation_ids()? {
        let earlier = match (st.restore_file(&id)?, st.federation_file(&id)?) {
            (Some(f), _) | (None, Some(f)) => f,
            // A join that never got as far as its federation.json, and nothing to restore it from.
            (None, None) => continue,
        };
        match wallet.restore(&earlier).await {
            Ok((fed, rebuilt)) => {
                let file = st.federation_file(&id)?;
                out.push(serde_json::json!({
                    "federation_id": id,
                    "name": fed.name,
                    "rebuilt": rebuilt,
                    "balance_msat": fed.balance_msat().await,
                    "restored_at": file.as_ref().and_then(|f| f.restored_at),
                    "restore_open": file.as_ref().is_some_and(store::FederationFile::restore_open),
                }));
            }
            Err(e) => {
                tracing::error!(federation = %id, "recovery failed: {}", e.message);
                out.push(serde_json::json!({ "federation_id": id, "error": { "code": e.code.as_str(), "message": e.message } }));
            }
        }
    }
    let receives = st.receives()?;
    out.push(serde_json::json!({
        "receives": receives.len(),
        "pending": receives.iter().filter(|r| r.state == store::State::Pending).count(),
    }));
    Ok(out)
}

/// `fedimint-receiver restore-done`: close the restore of one federation, or of every one. From
/// then on a rejection of notes first given after the restore is a rejection again.
pub fn restore_done(data_dir: &std::path::Path, which: Option<&str>) -> Result<Vec<serde_json::Value>> {
    let st = store::Store { dir: data_dir.to_path_buf() };
    let mut out = Vec::new();
    for mut f in st.federations()? {
        if which.is_some_and(|id| id != f.id) {
            continue;
        }
        let closed = f.restore_open();
        if closed {
            f.restore_closed_at = Some(store::now());
            st.save_federation(&f)?;
        }
        out.push(serde_json::json!({ "federation_id": f.id, "restored_at": f.restored_at, "closed_now": closed, "restore_open": f.restore_open() }));
    }
    if let Some(id) = which
        && out.is_empty()
    {
        anyhow::bail!("no joined federation has the id {id}");
    }
    Ok(out)
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
    tracing::info!("shutting down");
}

#[cfg(feature = "devfed")]
pub mod devfed;
