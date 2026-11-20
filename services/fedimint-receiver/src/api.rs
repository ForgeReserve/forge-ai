//! The HTTP API (docs/FEDIMINT-RECEIVER.md). JSON in and out; every route needs the bearer token.

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Path, Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{ApiError, Code};
use crate::store::ReceiveRecord;
use crate::wallet::{Federation, Resolution, Wallet};

/// Largest request body taken. Notes for a large payment are a few kilobytes.
const MAX_BODY: usize = 256 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub wallet: Arc<Wallet>,
    pub token: Arc<str>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/federations", get(list_federations).post(join))
        .route("/federations/{id}/balance", get(balance))
        .route("/parse", post(parse))
        .route("/receive", post(receive))
        .route("/receive/{notes_id}", get(receive_status))
        .fallback(not_found)
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state)
}

/// Compare without stopping at the first different byte, so the answer time says nothing about
/// how much of a guess was right.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn auth(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let given = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    match given {
        Some(t) if same(t.as_bytes(), s.token.as_bytes()) => next.run(req).await,
        _ => ApiError::new(Code::Unauthorized, "a bearer token is required").into_response(),
    }
}

async fn not_found() -> ApiError {
    ApiError::new(Code::NotFound, "no such route")
}

/// `Json`, with a malformed body answered in this API's error shape.
struct Body<T>(T);

impl<S: Send + Sync, T: serde::de::DeserializeOwned> FromRequest<S> for Body<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(Body(v)),
            Err(e) => Err(ApiError::new(Code::BadRequest, body_error(&e))),
        }
    }
}

fn body_error(e: &JsonRejection) -> String {
    // The body text (which may hold notes) is never echoed back.
    match e {
        JsonRejection::MissingJsonContentType(_) => "send Content-Type: application/json".into(),
        JsonRejection::JsonSyntaxError(_) => "the body is not JSON".into(),
        JsonRejection::JsonDataError(_) => "the body is missing a field or has one of the wrong type".into(),
        _ => "the body could not be read".into(),
    }
}

async fn health(State(s): State<AppState>) -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "federations": s.wallet.federations().await.len() }))
}

async fn federation_json(s: &AppState, fed: &Federation, with_balance: bool) -> Value {
    let mut v = json!({ "id": fed.id.to_string(), "name": fed.name, "modules": fed.modules, "receives": fed.receives() });
    // Whether its wallet was rebuilt from the seed, and whether that restore is still open
    // (wallet.rs, the restore rule).
    let file = s.wallet.store.federation_file(&fed.id.to_string()).ok().flatten();
    v["restored_at"] = json!(file.as_ref().and_then(|f| f.restored_at));
    v["restore_open"] = json!(file.as_ref().is_some_and(crate::store::FederationFile::restore_open));
    if with_balance {
        v["balance_msat"] = json!(fed.balance_msat().await);
    }
    v
}

#[derive(Deserialize)]
struct JoinBody {
    invite: String,
}

async fn join(State(s): State<AppState>, Body(b): Body<JoinBody>) -> Result<Json<Value>, ApiError> {
    let (fed, already) = s.wallet.join(&b.invite).await?;
    let mut v = federation_json(&s, &fed, false).await;
    v["already_joined"] = json!(already);
    Ok(Json(v))
}

async fn list_federations(State(s): State<AppState>) -> Json<Value> {
    let mut out = Vec::new();
    for fed in s.wallet.federations().await {
        out.push(federation_json(&s, &fed, true).await);
    }
    Json(json!({ "federations": out }))
}

async fn balance(State(s): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let fed = s.wallet.federation(&id).await.ok_or_else(|| ApiError::new(Code::NotFound, "no joined federation has this id"))?;
    Ok(Json(json!({ "id": fed.id.to_string(), "balance_msat": fed.balance_msat().await })))
}

#[derive(Deserialize)]
struct NotesBody {
    notes: String,
}

async fn parse(State(s): State<AppState>, Body(b): Body<NotesBody>) -> Result<Json<Value>, ApiError> {
    let notes = crate::notes::parse(&b.notes).map_err(|e| ApiError::new(Code::BadNotes, e.0))?;
    let (resolution, fed) = s.wallet.resolve(&notes).await;
    let federation_id = fed.as_ref().map(|f| f.id.to_string()).or(notes.federation_id.map(|id| id.to_string()));
    let (module_supported, signatures_valid) = match &fed {
        Some(f) => (Some(f.receives().contains(&notes.kind.as_str())), Some(s.wallet.signatures_valid(f, &notes).await)),
        None => (None, None),
    };
    let received = s.wallet.record(&notes.id)?.map(|r| r.state);
    Ok(Json(json!({
        "notes_id": notes.id,
        "module": notes.kind.as_str(),
        "amount_msat": notes.amount_msat,
        "count": notes.count,
        "federation_id": federation_id,
        "federation_prefix": notes.prefix.to_string(),
        "joined": resolution == Resolution::Joined,
        "resolution": resolution,
        "module_supported": module_supported,
        "signatures_valid": signatures_valid,
        "received": received,
    })))
}

#[derive(Deserialize)]
struct ReceiveBody {
    notes: String,
    key: String,
}

fn valid_key(k: &str) -> bool {
    (1..=128).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b))
}

/// A record as the API shows it: never the notes. `repeat` (on `POST /receive` only) says the
/// record existed before this request.
fn record_json(r: &ReceiveRecord, repeat: Option<bool>) -> Value {
    let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("notes");
        if let Some(repeat) = repeat {
            o.insert("repeat".into(), json!(repeat));
        }
    }
    v
}

async fn receive(State(s): State<AppState>, Body(b): Body<ReceiveBody>) -> Result<Json<Value>, ApiError> {
    if !valid_key(&b.key) {
        return Err(ApiError::new(Code::BadRequest, "key must be 1 to 128 characters of A-Z a-z 0-9 - _ : ."));
    }
    let notes = crate::notes::parse(&b.notes).map_err(|e| ApiError::new(Code::BadNotes, e.0))?;
    let (record, repeat) = s.wallet.receive(&notes, &b.key).await?;
    Ok(Json(record_json(&record, Some(repeat))))
}

async fn receive_status(State(s): State<AppState>, Path(notes_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let r = s.wallet.record(&notes_id)?.ok_or_else(|| ApiError::new(Code::NotFound, "no receive has this notes_id"))?;
    Ok(Json(record_json(&r, None)))
}
