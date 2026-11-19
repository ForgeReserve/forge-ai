//! `devfed`: a development federation for end to end tests, in one process (feature `devfed`).
//!
//!   cargo run --features devfed --bin devfed -- [--mints mint|mintv2|both] [--no-fees] [--listen 127.0.0.1:0]
//!
//! Starts four guardians on loopback ports with a fake bitcoin backend, then prints one JSON line
//! on stdout and serves until killed:
//!
//!   {"invite":"fed11...","federation_id":"...","url":"http://127.0.0.1:PORT","mints":"mint"}
//!
//! - `GET /invite`: `{"invite": "..."}`.
//! - `POST /notes` `{"amount_msat": 50000, "module": "mint" | "mintv2", "include_invite": false}`:
//!   new notes from the federation's issuing client, `{"notes": "...", "amount_msat": ...}`, where
//!   `amount_msat` is the notes' value (the wallet rounds up to what its notes can make).
//!   `module` matters only with `--mints both`.
//! - `POST /spend` `{"notes": "..."}`: spend those notes into the issuer's own wallet, so that
//!   nobody else can receive them.
//!
//! No token: it listens on loopback only and holds nothing of value. Mint v1 is the default, the
//! module a Fedimint card till's wallet needs.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use fedimint_receiver::devfed::{DevFed, Mints};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct NotesReq {
    amount_msat: u64,
    #[serde(default)]
    module: Option<String>,
    #[serde(default)]
    include_invite: bool,
}

#[derive(Deserialize)]
struct SpendReq {
    notes: String,
}

type Answer = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn fail(e: anyhow::Error) -> (StatusCode, Json<Value>) {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": format!("{e:#}") })))
}

async fn notes(State(f): State<Arc<DevFed>>, Json(r): Json<NotesReq>) -> Answer {
    let v2 = r.module.as_deref() == Some("mintv2");
    let (notes, value) = f.notes(r.amount_msat, v2, r.include_invite).await.map_err(fail)?;
    Ok(Json(json!({ "notes": notes, "amount_msat": value })))
}

async fn spend(State(f): State<Arc<DevFed>>, Json(r): Json<SpendReq>) -> Answer {
    f.spend(&r.notes).await.map_err(fail)?;
    Ok(Json(json!({ "ok": true })))
}

async fn invite(State(f): State<Arc<DevFed>>) -> Json<Value> {
    Json(json!({ "invite": f.invite() }))
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut mints = Mints::V1;
    let mut fees = true;
    let mut listen: SocketAddr = "127.0.0.1:0".parse()?;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--mints" => mints = args.next().context("--mints needs a value")?.parse()?,
            "--no-fees" => fees = false,
            "--listen" => listen = args.next().context("--listen needs an address")?.parse()?,
            "-h" | "--help" => {
                println!("devfed [--mints mint|mintv2|both] [--no-fees] [--listen 127.0.0.1:0]");
                return Ok(());
            }
            other => bail!("unknown argument {other:?}"),
        }
    }
    if !listen.ip().is_loopback() {
        bail!("devfed listens on loopback only");
    }
    let fed = Arc::new(DevFed::start(mints, fees).await?);
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let url = format!("http://{}", listener.local_addr()?);
    let label = match mints {
        Mints::V1 => "mint",
        Mints::V2 => "mintv2",
        Mints::Both => "both",
    };
    println!("{}", json!({ "invite": fed.invite(), "federation_id": fed.id(), "url": url, "mints": label }));
    let app = Router::new().route("/invite", get(invite)).route("/notes", post(notes)).route("/spend", post(spend)).with_state(fed);
    axum::serve(listener, app).await?;
    Ok(())
}
