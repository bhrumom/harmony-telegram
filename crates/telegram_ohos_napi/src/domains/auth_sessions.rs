//! Domains 1–2: `auth` (7 auth flows, 2FA, Passkey, QR Pair, Server/Proxy config) &
//! `sessions` (Multi-Account Switcher, Generation Fence, Argon2 Passcode Lock, ASSET Token Vault).

use argon2::Argon2;
use gpui_telegram_client::net::{
    AuthResponse, ClientProxyConfig, EmailRegisterRequest, LoginRequest, PhoneVerifyRequest,
    RegisterRequest, TwoFactorSetRequest, TwoFactorVerifyRequest,
};
use gpui_telegram_client::session_persistence::ProxyEndpointRecord;
use serde_json::{json, Value};

use crate::engine::{TelegramCoreEngine, MAX_MULTI_ACCOUNTS};
use crate::helpers::{
    b64_encode, opt_bool, opt_str, opt_u32, opt_u64, req_str, sha256_hex, to_json_val,
    CoreDispatchError, CoreResult,
};

fn hash_passcode_argon2(passcode: &str, salt_hex: &str) -> CoreResult<String> {
    let mut out = [0u8; 32];
    Argon2::default()
        .hash_password_into(passcode.as_bytes(), salt_hex.as_bytes(), &mut out)
        .map_err(|e| CoreDispatchError::internal(format!("Argon2 hash failed: {e}")))?;
    Ok(out.iter().map(|b| format!("{b:02x}")).collect())
}

pub async fn handle_auth(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    match action {
        "setServerConfig" => {
            let raw_url = req_str(payload, &["serverUrl", "server_url", "url"], "serverUrl")?;
            if !raw_url.starts_with("http://") && !raw_url.starts_with("https://") {
                return Err(CoreDispatchError::validation(
                    "serverUrl must begin with http:// or https://",
                ));
            }
            let normalized = raw_url.trim_end_matches('/').to_string();
            let slot = engine.with_state_mut(|st| {
                st.server_url = normalized.clone();
                st.active_slot.clone()
            })?;
            let client = engine.rebuild_client_for_slot(&slot)?;
            let probe = opt_bool(payload, &["probe", "checkHealth"]).unwrap_or(false);
            let reachable = if probe {
                Some(client.check_health().await?)
            } else {
                None
            };
            Ok(json!({
                "serverUrl": normalized,
                "reachable": reachable,
                "generation": engine.generation()
            }))
        }
        "setProxyConfig" => {
            let enabled = opt_bool(payload, &["enabled"]).unwrap_or(true);
            let kind_raw = opt_str(payload, &["kind", "type", "protocol"])
                .unwrap_or_else(|| "SOCKS5".to_string());
            let kind = match kind_raw.trim().to_ascii_uppercase().as_str() {
                "DIRECT" | "NONE" => "Direct".to_string(),
                "SOCKS5" | "SOCKS" => "SOCKS5".to_string(),
                "HTTP" | "HTTPS" => "HTTP".to_string(),
                "MTPROTO" => "MTProto".to_string(),
                other => {
                    return Err(CoreDispatchError::validation(format!(
                        "Unsupported proxy kind '{other}'; expected Direct, SOCKS5, HTTP, or MTProto"
                    )));
                }
            };
            let host = if kind == "Direct" {
                opt_str(payload, &["host"]).unwrap_or_else(|| "127.0.0.1".into())
            } else {
                req_str(payload, &["host", "server"], "host")?
            };
            let port_u32 = opt_u32(payload, &["port"]).unwrap_or(if kind == "Direct" { 0 } else { 1080 });
            if kind != "Direct" && (port_u32 == 0 || port_u32 > 65535) {
                return Err(CoreDispatchError::validation(format!(
                    "Proxy port {port_u32} must be in 1..=65535"
                )));
            }
            let username = opt_str(payload, &["username", "user"]);
            let password = opt_str(payload, &["password", "pass"]);
            let secret = opt_str(payload, &["secret", "secretOrUser"]).unwrap_or_default();

            let rec = ProxyEndpointRecord {
                id: opt_u32(payload, &["id"]).unwrap_or(1),
                kind: kind.clone(),
                host,
                port: port_u32 as u16,
                secret_or_user: secret,
                username,
                password,
                ping_ms: 0,
                enabled: enabled && kind != "Direct",
            };
            let active_cfg = if rec.enabled {
                ClientProxyConfig::from_record(&rec)
            } else {
                None
            };
            let client = engine.client()?;
            client.apply_proxy(active_cfg)?;
            engine.with_state_mut(|st| {
                st.proxy = Some(rec.clone());
            })?;
            Ok(json!({
                "proxy": rec,
                "deepLink": rec.tg_deep_link()
            }))
        }
        "checkHealth" | "getServerStatus" => {
            let client = engine.client()?;
            let healthy = client.check_health().await?;
            let status = client.fetch_server_status().await?;
            Ok(json!({
                "ok": healthy,
                "healthy": healthy,
                "status": status
            }))
        }
        "registerPassword" | "register" => {
            let username = req_str(payload, &["username"], "username")?;
            let password = req_str(payload, &["password"], "password")?;
            if password.len() < 6 {
                return Err(CoreDispatchError::validation(
                    "Password must be at least 6 characters",
                ));
            }
            let first_name = opt_str(payload, &["firstName", "first_name", "displayName"])
                .unwrap_or_else(|| username.clone());
            let device_name = opt_str(payload, &["deviceName", "device_name"])
                .unwrap_or_else(|| "HarmonyOS NEXT".into());
            let client = engine.client()?;
            let req = RegisterRequest {
                username,
                password,
                first_name,
                device_name,
            };
            let auth = client.register(&req).await?;
            let slot = engine.record_authenticated_session(&auth)?;
            Ok(json!({
                "userId": auth.user_id,
                "user_id": auth.user_id,
                "username": auth.username,
                "token": auth.token,
                "session": auth,
                "account": slot
            }))
        }
        "loginPassword" | "login" => {
            let username = req_str(payload, &["username"], "username")?;
            let password = req_str(payload, &["password"], "password")?;
            let device_name = opt_str(payload, &["deviceName", "device_name"])
                .unwrap_or_else(|| "HarmonyOS NEXT".into());
            let client = engine.client()?;
            // Check raw login response first in case 2FA challenge is returned by server
            let raw: Value = client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/auth/login",
                    None,
                    Some(&LoginRequest {
                        username: username.clone(),
                        password: password.clone(),
                        device_name,
                    }),
                )
                .await?;
            if raw
                .get("two_factor_required")
                .or_else(|| raw.get("twoFactorRequired"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                return Ok(json!({
                    "twoFactorRequired": true,
                    "challenge": raw
                }));
            }
            let auth: AuthResponse = serde_json::from_value(raw)?;
            let slot = engine.record_authenticated_session(&auth)?;
            Ok(json!({
                "twoFactorRequired": false,
                "userId": auth.user_id,
                "user_id": auth.user_id,
                "username": auth.username,
                "token": auth.token,
                "session": auth,
                "account": slot
            }))
        }
        "logout" => {
            let client = engine.client()?;
            let _ = client.logout().await;
            engine.with_state_mut(|st| {
                if let Some(active) = st.active_account_id.take() {
                    st.accounts.retain(|a| a.account_id != active);
                }
                if let Some(next) = st.accounts.first().cloned() {
                    st.active_account_id = Some(next.account_id);
                    st.active_slot = next.slot_name;
                }
            })?;
            let slot = engine.persisted_snapshot().active_slot;
            let _ = engine.rebuild_client_for_slot(&slot);
            Ok(json!({ "loggedOut": true }))
        }
        "sendPhoneCode" => {
            let phone = req_str(payload, &["phone", "phoneNumber"], "phone")?;
            let client = engine.client()?;
            let resp = client.phone_send_code(&phone).await?;
            to_json_val(resp)
        }
        "verifyPhoneCode" => {
            let phone = req_str(payload, &["phone", "phoneNumber"], "phone")?;
            let code = req_str(payload, &["code", "phoneCode"], "code")?;
            let phone_code_hash = opt_str(payload, &["phoneCodeHash", "phone_code_hash"])
                .unwrap_or_default();
            let password = opt_str(payload, &["password", "cloudPassword"]);
            let first_name = opt_str(payload, &["firstName", "first_name"]);
            let last_name = opt_str(payload, &["lastName", "last_name"]);
            let mut body = serde_json::Map::new();
            body.insert("phone".into(), Value::String(phone));
            body.insert("code".into(), Value::String(code));
            if !phone_code_hash.is_empty() {
                body.insert("phone_code_hash".into(), Value::String(phone_code_hash));
            }
            if let Some(pw) = password {
                body.insert("password".into(), Value::String(pw));
            }
            if let Some(fnm) = first_name {
                body.insert("first_name".into(), Value::String(fnm));
            }
            if let Some(lnm) = last_name {
                body.insert("last_name".into(), Value::String(lnm));
            }
            let req: PhoneVerifyRequest = serde_json::from_value(Value::Object(body))?;
            let client = engine.client()?;
            let auth = client.phone_verify(&req).await?;
            let slot = engine.record_authenticated_session(&auth)?;
            Ok(json!({ "session": auth, "account": slot }))
        }
        "get2faStatus" => {
            let client = engine.client()?;
            to_json_val(client.get_2fa_status().await?)
        }
        "setup2fa" => {
            let new_pw = req_str(payload, &["newPassword", "new_password", "password"], "newPassword")?;
            let cur_pw = opt_str(payload, &["currentPassword", "current_password"]);
            let hint = opt_str(payload, &["hint", "passwordHint"]);
            let recovery_email = opt_str(payload, &["recoveryEmail", "recovery_email", "email"]);
            let mut map = serde_json::Map::new();
            map.insert("new_password".into(), Value::String(new_pw));
            if let Some(c) = cur_pw {
                map.insert("current_password".into(), Value::String(c));
            }
            if let Some(h) = hint {
                map.insert("hint".into(), Value::String(h));
            }
            if let Some(e) = recovery_email {
                map.insert("recovery_email".into(), Value::String(e));
            }
            let req: TwoFactorSetRequest = serde_json::from_value(Value::Object(map))?;
            let client = engine.client()?;
            to_json_val(client.set_2fa(&req).await?)
        }
        "verify2fa" => {
            let password = req_str(payload, &["password", "cloudPassword"], "password")?;
            let pending = req_str(
                payload,
                &["pendingToken", "pending_token", "loginToken", "login_token", "challengeId"],
                "pendingToken",
            )?;
            let mut map = serde_json::Map::new();
            map.insert("password".into(), Value::String(password));
            map.insert("pending_token".into(), Value::String(pending));
            let req: TwoFactorVerifyRequest = serde_json::from_value(Value::Object(map))?;
            let client = engine.client()?;
            let auth = client.verify_2fa(&req).await?;
            let slot = engine.record_authenticated_session(&auth)?;
            Ok(json!({
                "userId": auth.user_id,
                "user_id": auth.user_id,
                "username": auth.username,
                "token": auth.token,
                "session": auth,
                "account": slot
            }))
        }
        "disable2fa" => {
            let cur = opt_str(payload, &["currentPassword", "current_password", "password"]);
            let client = engine.client()?;
            client.disable_2fa(cur.as_deref()).await?;
            Ok(json!({ "disabled": true }))
        }
        "startAlipayQr" => {
            let client = engine.client()?;
            to_json_val(client.http_client.alipay_start().await?)
        }
        "simulateAlipayScan" => {
            let attempt_id = req_str(payload, &["attemptId", "attempt_id"], "attemptId")?;
            let client = engine.client()?;
            client.http_client.alipay_simulate_scan(&attempt_id).await?;
            Ok(json!({ "simulated": true, "attemptId": attempt_id }))
        }
        "pollAlipayQr" => {
            let attempt_id = req_str(payload, &["attemptId", "attempt_id"], "attemptId")?;
            let client = engine.client()?;
            let poll = client.http_client.alipay_poll(&attempt_id).await?;
            let mut slot_val = Value::Null;
            if poll.is_completed() {
                if let Some(ref auth) = poll.session {
                    slot_val = to_json_val(engine.record_authenticated_session(auth)?)?;
                } else if let Some(ref tok) = poll.token {
                    let uid = poll
                        .user_id
                        .or_else(|| poll.user.as_ref().map(|u| u.user_id))
                        .unwrap_or(100003);
                    let uname = poll
                        .username
                        .clone()
                        .or_else(|| poll.user.as_ref().and_then(|u| u.username.clone()))
                        .unwrap_or_else(|| format!("alipay_{uid}"));
                    let auth = AuthResponse {
                        user_id: uid,
                        username: uname.clone(),
                        session_id: format!("alipay_{attempt_id}"),
                        token: tok.clone(),
                        first_name: Some(uname),
                        created_at: None,
                        expires_at: None,
                    };
                    slot_val = to_json_val(engine.record_authenticated_session(&auth)?)?;
                }
            }
            Ok(json!({
                "poll": poll,
                "account": slot_val
            }))
        }
        "sendEmailCode" => {
            let email = req_str(payload, &["email"], "email")?;
            if !email.contains('@') {
                return Err(CoreDispatchError::validation("Invalid email address format"));
            }
            let client = engine.client()?;
            to_json_val(client.email_send_code(&email).await?)
        }
        "registerEmail" => {
            let email = req_str(payload, &["email"], "email")?;
            let code = req_str(payload, &["code"], "code")?;
            let username = opt_str(payload, &["username"]).unwrap_or_else(|| {
                email
                    .split('@')
                    .next()
                    .unwrap_or("email_user")
                    .replace(|c: char| !c.is_ascii_alphanumeric() && c != '_', "_")
            });
            let password = opt_str(payload, &["password"])
                .unwrap_or_else(|| format!("EmailPass_{}!", &sha256_hex(email.as_bytes())[..8]));
            let first_name = opt_str(payload, &["firstName", "first_name"])
                .unwrap_or_else(|| username.clone());
            let req = EmailRegisterRequest {
                email,
                code,
                username,
                password,
                first_name,
            };
            let client = engine.client()?;
            let auth = client.email_register(&req).await?;
            let slot = engine.record_authenticated_session(&auth)?;
            Ok(json!({ "session": auth, "account": slot }))
        }
        "startQrPairing" => {
            let client = engine.client()?;
            to_json_val(client.qr_pair_init().await?)
        }
        "approveQrPairing" => {
            let pair_token = req_str(payload, &["pairToken", "pair_token", "token"], "pairToken")?;
            let client = engine.client()?;
            client.qr_pair_accept(&pair_token).await?;
            Ok(json!({ "approved": true, "pairToken": pair_token }))
        }
        "pollQrPairing" => {
            let pair_token = req_str(payload, &["pairToken", "pair_token", "token"], "pairToken")?;
            let cloud_pw = opt_str(payload, &["cloudPassword", "cloud_password", "password"]);
            let client = engine.client()?;
            let res = if cloud_pw.is_some() {
                client.qr_pair_verify(&pair_token, cloud_pw.as_deref()).await?
            } else {
                client.qr_pair_poll(&pair_token).await?
            };
            let mut slot_val = Value::Null;
            if let Some(sess) = client.current_auth_session() {
                if res.session.is_some() {
                    slot_val = to_json_val(engine.record_authenticated_session(&sess)?)?;
                }
            }
            Ok(json!({ "poll": res, "account": slot_val }))
        }
        "passkeyChallenge" => {
            let username = opt_str(payload, &["username"]);
            let client = engine.client()?;
            client.passkey_challenge(username.as_deref()).await.map_err(Into::into)
        }
        "registerPasskey" => {
            let client = engine.client()?;
            client.register_passkey(payload).await.map_err(Into::into)
        }
        "verifyPasskey" => {
            let client = engine.client()?;
            let auth = client.passkey_verify(payload).await?;
            let slot = engine.record_authenticated_session(&auth)?;
            Ok(json!({ "session": auth, "account": slot }))
        }
        "listPasskeys" => {
            let client = engine.client()?;
            to_json_val(client.list_passkeys().await?)
        }
        "deletePasskey" => {
            let id = req_str(payload, &["passkeyId", "passkey_id", "id"], "passkeyId")?;
            let client = engine.client()?;
            client.delete_passkey(&id).await?;
            Ok(json!({ "deleted": true, "passkeyId": id }))
        }
        "getMe" => {
            let client = engine.client()?;
            to_json_val(client.get_me().await?)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported auth action '{other}'"),
        )),
    }
}

pub async fn handle_sessions(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    match action {
        "listAccounts" => {
            let snap = engine.persisted_snapshot();
            Ok(json!({
                "accounts": snap.accounts,
                "activeAccountId": snap.active_account_id,
                "activeSlot": snap.active_slot,
                "maxAccounts": MAX_MULTI_ACCOUNTS,
                "locked": snap.locked,
                "passcodeEnabled": snap.passcode_enabled,
                "generation": engine.generation()
            }))
        }
        "addAccount" => {
            let snap = engine.persisted_snapshot();
            if snap.accounts.len() >= MAX_MULTI_ACCOUNTS {
                return Err(CoreDispatchError::validation(format!(
                    "Cannot exceed maximum of {MAX_MULTI_ACCOUNTS} concurrent accounts"
                )));
            }
            let new_slot = format!("slot_{}_{}", snap.accounts.len() + 1, chrono::Utc::now().timestamp_millis());
            engine.with_state_mut(|st| {
                st.active_slot = new_slot.clone();
                st.active_account_id = None;
            })?;
            let next_gen = engine.bump_generation();
            let client = engine.rebuild_client_for_slot(&new_slot)?;

            // Optional immediate registration or login on the new account slot
            let mut authenticated_slot = Value::Null;
            if let (Some(username), Some(password)) =
                (opt_str(payload, &["username"]), opt_str(payload, &["password"]))
            {
                let register_new = opt_bool(payload, &["register"]).unwrap_or(false);
                let auth = if register_new {
                    let first_name = opt_str(payload, &["firstName", "first_name"])
                        .unwrap_or_else(|| username.clone());
                    client
                        .register(&RegisterRequest {
                            username,
                            password,
                            first_name,
                            device_name: "HarmonyOS NEXT".into(),
                        })
                        .await?
                } else {
                    client
                        .login(&LoginRequest {
                            username,
                            password,
                            device_name: "HarmonyOS NEXT".into(),
                        })
                        .await?
                };
                authenticated_slot = to_json_val(engine.record_authenticated_session(&auth)?)?;
            }

            engine.emit_push(
                "accountAdded",
                json!({ "slot": new_slot, "generation": next_gen }),
            );
            Ok(json!({
                "slot": new_slot,
                "generation": next_gen,
                "account": authenticated_slot
            }))
        }
        "switchAccount" => {
            let target = req_str(
                payload,
                &["accountId", "account_id", "userId", "username"],
                "accountId",
            )?;
            let found = {
                let snap = engine.persisted_snapshot();
                snap.accounts
                    .into_iter()
                    .find(|a| {
                        a.account_id == target
                            || a.username == target
                            || a.user_id.to_string() == target
                    })
                    .ok_or_else(|| {
                        CoreDispatchError::not_found(format!("Account '{target}' not found in vault"))
                    })?
            };
            engine.with_state_mut(|st| {
                st.active_account_id = Some(found.account_id.clone());
                st.active_slot = found.slot_name.clone();
                st.server_url = found.server_url.clone();
            })?;
            let next_gen = engine.bump_generation();
            let _ = engine.rebuild_client_for_slot(&found.slot_name)?;
            engine.emit_push(
                "accountSwitched",
                json!({
                    "accountId": found.account_id,
                    "username": found.username,
                    "generation": next_gen
                }),
            );
            Ok(json!({
                "switched": true,
                "activeAccount": found,
                "generation": next_gen
            }))
        }
        "removeAccount" => {
            let target = req_str(payload, &["accountId", "account_id"], "accountId")?;
            let removed = engine.with_state_mut(|st| {
                let before = st.accounts.len();
                st.accounts.retain(|a| a.account_id != target);
                if st.active_account_id.as_deref() == Some(target.as_str()) {
                    st.active_account_id = st.accounts.first().map(|a| a.account_id.clone());
                    if let Some(first) = st.accounts.first() {
                        st.active_slot = first.slot_name.clone();
                    }
                }
                st.accounts.len() < before
            })?;
            if !removed {
                return Err(CoreDispatchError::not_found(format!(
                    "Account '{target}' does not exist"
                )));
            }
            let next_gen = engine.bump_generation();
            Ok(json!({ "removed": true, "generation": next_gen }))
        }
        "listDeviceSessions" => {
            let client = engine.client()?;
            to_json_val(client.list_sessions().await?)
        }
        "revokeDeviceSession" => {
            let sid = req_str(payload, &["sessionId", "session_id"], "sessionId")?;
            let client = engine.client()?;
            let revoked = client.revoke_session(&sid).await?;
            Ok(json!({ "revoked": revoked, "sessionId": sid }))
        }
        "revokeOtherSessions" => {
            let client = engine.client()?;
            client.revoke_other_sessions().await?;
            Ok(json!({ "revokedOthers": true }))
        }
        "setPasscodeLock" => {
            let enabled = opt_bool(payload, &["enabled"]).unwrap_or(true);
            if !enabled {
                engine.with_state_mut(|st| {
                    st.passcode_enabled = false;
                    st.passcode_salt_hex = None;
                    st.passcode_hash_hex = None;
                    st.locked = false;
                    st.failed_unlock_attempts = 0;
                })?;
                return Ok(json!({ "passcodeEnabled": false, "locked": false }));
            }
            let pin = req_str(payload, &["passcode", "pin"], "passcode")?;
            if pin.len() < 4 || pin.len() > 64 {
                return Err(CoreDispatchError::validation(
                    "Passcode must be between 4 and 64 characters",
                ));
            }
            let auto_lock = opt_u32(payload, &["autoLockSeconds", "auto_lock_seconds"]).unwrap_or(300);
            let mut salt_bytes = [0u8; 16];
            getrandom::getrandom(&mut salt_bytes)
                .map_err(|e| CoreDispatchError::internal(format!("CSPRNG failed: {e}")))?;
            let salt_hex: String = salt_bytes.iter().map(|b| format!("{b:02x}")).collect();
            let hash_hex = hash_passcode_argon2(&pin, &salt_hex)?;
            engine.with_state_mut(|st| {
                st.passcode_enabled = true;
                st.passcode_salt_hex = Some(salt_hex);
                st.passcode_hash_hex = Some(hash_hex);
                st.auto_lock_seconds = auto_lock;
                st.failed_unlock_attempts = 0;
            })?;
            Ok(json!({
                "passcodeEnabled": true,
                "autoLockSeconds": auto_lock
            }))
        }
        "lockApp" => {
            let snap = engine.persisted_snapshot();
            if !snap.passcode_enabled {
                return Err(CoreDispatchError::validation(
                    "Cannot lockApp before setPasscodeLock is configured",
                ));
            }
            engine.with_state_mut(|st| {
                st.locked = true;
            })?;
            engine.emit_push("appLocked", json!({ "locked": true }));
            Ok(json!({ "locked": true }))
        }
        "unlockApp" => {
            let pin = req_str(payload, &["passcode", "pin"], "passcode")?;
            let snap = engine.persisted_snapshot();
            let (Some(salt), Some(expected_hash)) = (snap.passcode_salt_hex, snap.passcode_hash_hex)
            else {
                engine.with_state_mut(|st| st.locked = false)?;
                return Ok(json!({ "locked": false, "unlocked": true }));
            };
            let candidate = hash_passcode_argon2(&pin, &salt)?;
            if candidate != expected_hash {
                let attempts = engine.with_state_mut(|st| {
                    st.failed_unlock_attempts = st.failed_unlock_attempts.saturating_add(1);
                    st.failed_unlock_attempts
                })?;
                return Err(CoreDispatchError::new(
                    "AUTH_INVALID_PASSCODE",
                    format!("Incorrect passcode (failed attempts: {attempts})"),
                ));
            }
            engine.with_state_mut(|st| {
                st.locked = false;
                st.failed_unlock_attempts = 0;
            })?;
            engine.emit_push("appUnlocked", json!({ "locked": false }));
            Ok(json!({
                "locked": false,
                "unlocked": true,
                "failedAttempts": 0
            }))
        }
        "passcodeStatus" => {
            let snap = engine.persisted_snapshot();
            Ok(json!({
                "passcodeEnabled": snap.passcode_enabled,
                "locked": snap.locked,
                "autoLockSeconds": snap.auto_lock_seconds,
                "failedUnlockAttempts": snap.failed_unlock_attempts
            }))
        }
        "verifyAssetToken" => {
            let snap = engine.persisted_snapshot();
            let account_id = opt_str(payload, &["accountId", "account_id"])
                .or(snap.active_account_id.clone())
                .ok_or_else(|| CoreDispatchError::validation("Missing accountId"))?;
            let token_cand = opt_str(payload, &["assetToken", "asset_token"]).unwrap_or_else(|| {
                snap.accounts
                    .iter()
                    .find(|a| a.account_id == account_id)
                    .map(|a| a.asset_token.clone())
                    .unwrap_or_default()
            });
            let valid = engine.verify_asset_token(&account_id, &token_cand);
            if !valid && opt_bool(payload, &["strict"]).unwrap_or(false) {
                return Err(CoreDispatchError::unauthorized(
                    "Hardware ASSET token verification failed",
                ));
            }
            Ok(json!({
                "accountId": account_id,
                "valid": valid,
                "hardwareBacked": true,
                "tokenPreview": if token_cand.len() > 16 { &token_cand[..16] } else { &token_cand }
            }))
        }
        "checkGenerationFence" => {
            let current = engine.generation();
            let expected = opt_u64(payload, &["expectedGeneration", "generation"])
                .map(|g| g as u32)
                .unwrap_or(current);
            let matches = expected == current;
            if !matches && opt_bool(payload, &["strict", "failOnStale"]).unwrap_or(false) {
                return Err(CoreDispatchError::new(
                    "STALE_GENERATION",
                    format!("Expected generation {expected} does not match current generation {current}"),
                ));
            }
            Ok(json!({
                "currentGeneration": current,
                "expectedGeneration": expected,
                "matches": matches,
                "stale": !matches,
                "tokenFingerprint": b64_encode(&current.to_be_bytes())
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported sessions action '{other}'"),
        )),
    }
}
