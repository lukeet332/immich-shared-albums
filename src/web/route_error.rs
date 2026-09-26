/** web/route_error.rs — the one place a sidecar route turns a failure into a status. See ARCHITECTURE.md. */
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Why an operation failed, and therefore what the caller should do about it.
///
/// Every failure used to answer 400: an Immich outage, a peer that would not dial and a mistyped
/// mapping id were indistinguishable to the panel, which retried a perfectly good request against a
/// perfectly good sidecar and blamed the user. The distinction is the caller's to act on:
///
/// - `BadInput` — the CALLER's request was wrong: a name that resolves to nothing, a refused join,
///   an expired link. Retrying unchanged is pointless. 400.
/// - `Unavailable` — this side could not do the work because something it depends on did not answer:
///   Immich, the peer transport, our own provisioning state mid-retry. Retrying is the right move.
///   502, because the caller did nothing wrong and should be told so.
#[derive(Debug)]
pub enum RouteError {
    BadInput(String),
    Unavailable(String),
}

impl RouteError {
    pub fn bad_input(message: impl Into<String>) -> Self {
        RouteError::BadInput(message.into())
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        RouteError::Unavailable(message.into())
    }

    pub fn status(&self) -> StatusCode {
        match self {
            RouteError::BadInput(_) => StatusCode::BAD_REQUEST,
            RouteError::Unavailable(_) => StatusCode::BAD_GATEWAY,
        }
    }
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RouteError::BadInput(e) => write!(f, "{e}"),
            RouteError::Unavailable(e) => write!(f, "{e}"),
        }
    }
}

/// The one failure shape every route answers with, so the panel parses one thing.
impl IntoResponse for RouteError {
    fn into_response(self) -> Response {
        let status = self.status();
        let body = json!({ "error": self.to_string() });
        (status, axum::Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_caller_mistake_and_the_dead_dependency_answer_differently() {
        assert_eq!(
            RouteError::bad_input("unknown household").status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            RouteError::unavailable("could not reach Immich").status(),
            StatusCode::BAD_GATEWAY
        );
    }

    #[test]
    fn the_answer_names_what_went_wrong_in_the_one_shape_the_panel_parses() {
        let e = RouteError::bad_input("unknown household");
        assert_eq!(e.to_string(), "unknown household");
    }
}
