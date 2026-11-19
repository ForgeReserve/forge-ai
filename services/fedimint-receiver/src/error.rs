//! The errors the API answers with. `code` is the stable part for a caller to branch on; the
//! message is for people and may change.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    /// No bearer token, or the wrong one.
    Unauthorized,
    /// The request body or a path parameter is malformed.
    BadRequest,
    /// Not an invite code.
    BadInvite,
    /// Not notes this service can read, or notes whose signatures do not verify under the
    /// federation they name.
    BadNotes,
    /// The notes' federation has not been joined: nothing was spent or stored.
    NotJoined,
    /// The notes carry only a federation id prefix, and more than one joined federation has it.
    AmbiguousFederation,
    /// The federation has no mint module this service speaks (mint v1 or mintv2), or not the one
    /// that issued these notes.
    ModuleUnsupported,
    /// The federation would charge at least as much to reissue the notes as they are worth.
    FeeExceedsValue,
    /// The federation did not answer (joining needs its guardians).
    Unreachable,
    /// No such receive or federation.
    NotFound,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Unauthorized => "unauthorized",
            Code::BadRequest => "bad_request",
            Code::BadInvite => "bad_invite",
            Code::BadNotes => "bad_notes",
            Code::NotJoined => "not_joined",
            Code::AmbiguousFederation => "ambiguous_federation",
            Code::ModuleUnsupported => "module_unsupported",
            Code::FeeExceedsValue => "fee_exceeds_value",
            Code::Unreachable => "unreachable",
            Code::NotFound => "not_found",
            Code::Internal => "internal",
        }
    }

    pub fn status(self) -> StatusCode {
        match self {
            Code::Unauthorized => StatusCode::UNAUTHORIZED,
            Code::BadRequest => StatusCode::BAD_REQUEST,
            Code::BadInvite | Code::BadNotes | Code::ModuleUnsupported | Code::FeeExceedsValue => StatusCode::UNPROCESSABLE_ENTITY,
            Code::NotJoined | Code::AmbiguousFederation => StatusCode::CONFLICT,
            Code::Unreachable => StatusCode::BAD_GATEWAY,
            Code::NotFound => StatusCode::NOT_FOUND,
            Code::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Debug)]
pub struct ApiError {
    pub code: Code,
    pub message: String,
}

impl ApiError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn internal(e: impl std::fmt::Display) -> Self {
        tracing::error!("internal error: {e}");
        Self::new(Code::Internal, "internal error; see the service log")
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self::internal(format!("{e:#}"))
    }
}

/// `{"error": {"code": "...", "message": "..."}}`, the shape the gateway's own API uses.
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({ "error": { "code": self.code.as_str(), "message": self.message } });
        (self.code.status(), Json(body)).into_response()
    }
}
