/*
 * The closed set of plugin API error codes and the reply envelope every call resolves to. Messages
 * are fixed English text with numbers at most: they reach a plugin page, so they never carry a path,
 * another plugin's id or OS error text.
 */

// -- Library Imports --
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiCode {
    Denied,
    RateLimited,
    InvalidArgs,
    TooLarge,
    NotFound,
    UnknownMethod,
    Busy,
    Timeout,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ApiError {
    pub code: ApiCode,
    pub message: String,
    /// Only with `RateLimited`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// Refines a code without changing it: `no_gesture` with `Denied`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

impl ApiError {
    fn new(code: ApiCode, message: &'static str) -> ApiError {
        ApiError {
            code,
            message: message.to_string(),
            retry_after_ms: None,
            reason: None,
        }
    }

    pub fn denied() -> ApiError {
        ApiError::new(ApiCode::Denied, "This call is not permitted.")
    }

    /// A gated call made with the plugin's page hidden and no valid gesture token.
    pub fn no_gesture() -> ApiError {
        ApiError {
            reason: Some("no_gesture"),
            ..ApiError::new(
                ApiCode::Denied,
                "A prompt needs the plugin's page open or a recent click on its controls.",
            )
        }
    }

    pub fn rate_limited(retry_after_ms: u64) -> ApiError {
        ApiError {
            retry_after_ms: Some(retry_after_ms),
            ..ApiError::new(ApiCode::RateLimited, "Too many calls; retry later.")
        }
    }

    pub fn invalid_args(message: &'static str) -> ApiError {
        ApiError::new(ApiCode::InvalidArgs, message)
    }

    pub fn too_large(message: &'static str) -> ApiError {
        ApiError::new(ApiCode::TooLarge, message)
    }

    pub fn not_found() -> ApiError {
        ApiError::new(ApiCode::NotFound, "Not found.")
    }

    pub fn unknown_method() -> ApiError {
        ApiError::new(ApiCode::UnknownMethod, "Unknown method.")
    }

    pub fn busy() -> ApiError {
        ApiError::new(ApiCode::Busy, "Too many calls in progress.")
    }

    pub fn timeout() -> ApiError {
        ApiError::new(ApiCode::Timeout, "The call timed out.")
    }

    pub fn unavailable() -> ApiError {
        ApiError::new(ApiCode::Unavailable, "Plisto cannot answer this call now.")
    }
}

/// The answer to one plugin call: a result or an error, never both.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CallReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
}

impl From<Result<Value, ApiError>> for CallReply {
    fn from(outcome: Result<Value, ApiError>) -> CallReply {
        match outcome {
            Ok(result) => CallReply {
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => CallReply {
                ok: false,
                result: None,
                error: Some(error),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_reply_serializes_in_both_shapes() {
        let ok = CallReply::from(Ok(json!({ "a": 1 })));
        assert_eq!(
            serde_json::to_value(ok).unwrap(),
            json!({ "ok": true, "result": { "a": 1 } })
        );
        // A null result is still a result.
        let null = CallReply::from(Ok(Value::Null));
        assert_eq!(
            serde_json::to_value(null).unwrap(),
            json!({ "ok": true, "result": null })
        );
        let limited = CallReply::from(Err(ApiError::rate_limited(400)));
        assert_eq!(
            serde_json::to_value(limited).unwrap(),
            json!({ "ok": false, "error": {
                "code": "rate_limited", "message": "Too many calls; retry later.", "retry_after_ms": 400
            }})
        );
        let denied = CallReply::from(Err(ApiError::denied()));
        let json = serde_json::to_value(denied).unwrap();
        assert_eq!(json["error"]["code"], "denied");
        assert!(json["error"].get("retry_after_ms").is_none());
    }

    #[test]
    fn every_code_has_its_wire_name() {
        let cases = [
            (ApiError::denied(), "denied"),
            (ApiError::rate_limited(1), "rate_limited"),
            (ApiError::invalid_args("x"), "invalid_args"),
            (ApiError::too_large("x"), "too_large"),
            (ApiError::not_found(), "not_found"),
            (ApiError::unknown_method(), "unknown_method"),
            (ApiError::busy(), "busy"),
            (ApiError::timeout(), "timeout"),
            (ApiError::unavailable(), "unavailable"),
        ];
        for (error, name) in cases {
            assert_eq!(serde_json::to_value(error.code).unwrap(), name);
            assert!(error.message.is_ascii() && !error.message.is_empty());
        }
    }

    #[test]
    fn the_reason_is_sent_only_when_set() {
        let json = serde_json::to_value(CallReply::from(Err(ApiError::no_gesture()))).unwrap();
        assert_eq!(
            json["error"],
            json!({
                "code": "denied",
                "message": "A prompt needs the plugin's page open or a recent click on its controls.",
                "reason": "no_gesture"
            })
        );
        let json = serde_json::to_value(ApiError::denied()).unwrap();
        assert!(json.get("reason").is_none());
    }
}
