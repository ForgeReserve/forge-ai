//! fedimint-receiver: holds Fedimint eCash for the Forge AI gateway.
//!
//! One process, any number of federations. A federation is joined by invite code; the joined
//! federations are the only ones whose notes are received. The gateway reaches this service over
//! the internal network with a bearer token, and asks it to read notes (`/parse`) and to receive
//! them (`/receive`). See docs/FEDIMINT-RECEIVER.md.

pub mod api;
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
