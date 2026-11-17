//! JSON payload extraction, bilingual/camelCase+snake_case normalization, and error mapping helpers.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use gpui_telegram_client::e2ee::E2eeError;
use gpui_telegram_client::net::HttpClientError;
use gpui_telegram_core::error::TelegramError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct CoreDispatchError {
    pub code: String,
    pub message: String,
}

impl CoreDispatchError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        Self::new("VALIDATION_ERROR", msg)
    }

    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::new("UNAUTHORIZED", msg)
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", msg)
    }

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::new("PERMISSION_DENIED", msg)
    }

    pub fn passcode_locked() -> Self {
        Self::new(
            "PASSCODE_LOCKED",
            "Application is locked by local passcode; unlockApp is required first",
        )
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new("INTERNAL_ERROR", msg)
    }
}

impl std::fmt::Display for CoreDispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for CoreDispatchError {}

impl From<HttpClientError> for CoreDispatchError {
    fn from(err: HttpClientError) -> Self {
        match err {
            HttpClientError::Unauthorized(msg) => Self::new("UNAUTHORIZED", msg),
            HttpClientError::Conflict(msg) => Self::new("CONFLICT", msg),
            HttpClientError::Proxy(msg) => Self::new("PROXY_ERROR", msg),
            HttpClientError::Serialization(e) => Self::new("SERIALIZATION_ERROR", e.to_string()),
            HttpClientError::Network(e) => Self::new("NETWORK_ERROR", e.to_string()),
            HttpClientError::Api { status, message } => {
                let code = match status {
                    400 | 422 => "VALIDATION_ERROR",
                    401 => "UNAUTHORIZED",
                    403 => "PERMISSION_DENIED",
                    404 => "NOT_FOUND",
                    409 => "CONFLICT",
                    423 => "LEASE_BUSY",
                    429 => "RATE_LIMITED",
                    _ => "HTTP_API_ERROR",
                };
                Self::new(code, format!("HTTP {status}: {message}"))
            }
        }
    }
}

impl From<TelegramError> for CoreDispatchError {
    fn from(err: TelegramError) -> Self {
        match err {
            TelegramError::Auth(m) => Self::new("UNAUTHORIZED", m),
            TelegramError::PermissionDenied(m) => Self::new("PERMISSION_DENIED", m),
            TelegramError::NotFound(m) => Self::new("NOT_FOUND", m),
            TelegramError::Validation(m) => Self::new("VALIDATION_ERROR", m),
            TelegramError::Serialization(m) => Self::new("SERIALIZATION_ERROR", m),
            TelegramError::Network(m) => Self::new("NETWORK_ERROR", m),
            other => Self::new("CORE_ERROR", other.to_string()),
        }
    }
}

impl From<E2eeError> for CoreDispatchError {
    fn from(err: E2eeError) -> Self {
        Self::new("E2EE_ERROR", err.to_string())
    }
}

impl From<serde_json::Error> for CoreDispatchError {
    fn from(err: serde_json::Error) -> Self {
        Self::new("INVALID_JSON", err.to_string())
    }
}

pub type CoreResult<T = Value> = std::result::Result<T, CoreDispatchError>;

pub fn parse_payload(payload_json: &str) -> CoreResult<Value> {
    let trimmed = payload_json.trim();
    if trimmed.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(trimmed).map_err(CoreDispatchError::from)
}

pub fn get_val<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let obj = v.as_object()?;
    for k in keys {
        if let Some(found) = obj.get(*k) {
            if !found.is_null() {
                return Some(found);
            }
        }
    }
    None
}

pub fn opt_str(v: &Value, keys: &[&str]) -> Option<String> {
    get_val(v, keys).and_then(|val| match val {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    })
}

pub fn req_str(v: &Value, keys: &[&str], label: &str) -> CoreResult<String> {
    opt_str(v, keys)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CoreDispatchError::validation(format!("Missing required string '{label}'")))
}

pub fn opt_i64(v: &Value, keys: &[&str]) -> Option<i64> {
    get_val(v, keys).and_then(|val| {
        val.as_i64()
            .or_else(|| val.as_u64().and_then(|u| i64::try_from(u).ok()))
            .or_else(|| val.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
    })
}

pub fn req_i64(v: &Value, keys: &[&str], label: &str) -> CoreResult<i64> {
    opt_i64(v, keys)
        .ok_or_else(|| CoreDispatchError::validation(format!("Missing required integer '{label}'")))
}

pub fn opt_u64(v: &Value, keys: &[&str]) -> Option<u64> {
    get_val(v, keys).and_then(|val| {
        val.as_u64()
            .or_else(|| val.as_i64().and_then(|i| u64::try_from(i).ok()))
            .or_else(|| val.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
    })
}

pub fn req_u64(v: &Value, keys: &[&str], label: &str) -> CoreResult<u64> {
    opt_u64(v, keys)
        .ok_or_else(|| CoreDispatchError::validation(format!("Missing required u64 '{label}'")))
}

pub fn opt_u32(v: &Value, keys: &[&str]) -> Option<u32> {
    opt_u64(v, keys).and_then(|u| u32::try_from(u).ok())
}

pub fn opt_usize(v: &Value, keys: &[&str]) -> Option<usize> {
    opt_u64(v, keys).and_then(|u| usize::try_from(u).ok())
}

pub fn opt_bool(v: &Value, keys: &[&str]) -> Option<bool> {
    get_val(v, keys).and_then(|val| {
        val.as_bool().or_else(|| {
            val.as_str().and_then(|s| match s.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Some(true),
                "false" | "0" | "no" | "off" => Some(false),
                _ => None,
            })
        })
    })
}

pub fn opt_u64_vec(v: &Value, keys: &[&str]) -> Vec<u64> {
    get_val(v, keys)
        .and_then(|val| val.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    item.as_u64()
                        .or_else(|| item.as_i64().and_then(|i| u64::try_from(i).ok()))
                        .or_else(|| item.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn opt_i64_vec(v: &Value, keys: &[&str]) -> Vec<i64> {
    get_val(v, keys)
        .and_then(|val| val.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    item.as_i64()
                        .or_else(|| item.as_u64().and_then(|u| i64::try_from(u).ok()))
                        .or_else(|| item.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn opt_string_vec(v: &Value, keys: &[&str]) -> Vec<String> {
    get_val(v, keys)
        .and_then(|val| val.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn b64_decode(raw: &str) -> CoreResult<Vec<u8>> {
    let trimmed = raw.trim();
    let stripped = trimmed
        .split_once(";base64,")
        .map(|(_, b)| b)
        .unwrap_or(trimmed);
    B64.decode(stripped)
        .map_err(|e| CoreDispatchError::validation(format!("Invalid base64 payload: {e}")))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

pub fn to_json_val<T: serde::Serialize>(val: T) -> CoreResult<Value> {
    serde_json::to_value(val).map_err(CoreDispatchError::from)
}
