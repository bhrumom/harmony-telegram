//! Domains 12–16: `contacts`, `inspector`, `settings` (26 sections), `wallet` (Stars & TON),
//! and `passport` (ChaCha20-Poly1305 encrypted vault + `PassportFormController`).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use gpui_telegram_client::net::{
    AddContactHttpRequest, ProtoUpdateProfileRequest, StarGiftRequest, UserPrivacySettingsDto,
};
use gpui_telegram_client::session_persistence::ProxyEndpointRecord;
use gpui_telegram_core::passport::passport_form_controller::{
    File as PassportFile, FileType as PassportFileType, FormRequest, LoadStatus,
    Value as PassportValue, ValueType,
};
use serde_json::{json, Value};

use crate::engine::TelegramCoreEngine;
use crate::helpers::{
    opt_bool, opt_i64, opt_str, opt_u32, opt_u64, opt_u64_vec, opt_usize, req_i64, req_str,
    req_u64, sha256_hex, to_json_val, CoreDispatchError, CoreResult,
};
use crate::ui_head::{normalize_locale_id, normalize_theme_id, theme_palette};

pub const ALL_26_SETTINGS_SECTIONS: &[(&str, &str)] = &[
    ("profile", "Profile & Bio"),
    ("account", "Account & Username"),
    ("privacy", "Privacy & Visibility"),
    ("security", "Security & Blocked Peers"),
    ("devices", "Active Device Sessions"),
    ("passcode", "Local Passcode & Biometric Lock"),
    ("two_factor", "Two-Step Cloud Password"),
    ("passkeys", "WebAuthn Passkeys"),
    ("notifications", "Notifications & App Badge"),
    ("appearance", "Appearance & Typography"),
    ("themes", "4-Theme Engine"),
    ("chat_settings", "Chat & Composer Settings"),
    ("folders", "Dialog Folders"),
    ("stickers_emoji", "Stickers & Animated Emoji"),
    ("data_storage", "Data, Cache & Storage"),
    ("network_proxy", "SOCKS5 / HTTP / MTProto Proxy"),
    ("power_saving", "Battery & Power Saving"),
    ("language", "Bilingual Language (zh-CN / en-US)"),
    ("premium", "Telegram Premium & Membership"),
    ("stars_wallet", "Telegram Stars Ledger"),
    ("ton_wallet", "TON Self-Custodial Wallet"),
    ("passport", "Telegram Passport Vault"),
    ("business", "Telegram Business Suite"),
    ("hermes_ai", "Hermes AI & Soul Configuration"),
    ("magpie_gateway", "Magpie Multi-Provider AI Gateway"),
    ("about_updates", "About & Release Updater"),
];

fn dir_size_bytes(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    total = total.saturating_add(dir_size_bytes(&p));
                } else {
                    total = total.saturating_add(meta.len());
                }
            }
        }
    }
    total
}

fn clear_dir_contents(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    let before = dir_size_bytes(path);
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let _ = fs::remove_dir_all(&p);
            } else {
                let _ = fs::remove_file(&p);
            }
        }
    }
    before.saturating_sub(dir_size_bytes(path))
}

pub async fn handle_contacts(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "listContacts" => {
            let contacts = client.list_contacts().await?;
            Ok(json!({ "contacts": contacts, "count": contacts.len() }))
        }
        "addContact" => {
            let mut map = serde_json::Map::new();
            if let Some(uid) = opt_u64(payload, &["userId", "user_id"]) {
                map.insert("user_id".into(), json!(uid));
            }
            if let Some(uname) = opt_str(payload, &["username"]) {
                map.insert("username".into(), Value::String(uname.trim_start_matches('@').into()));
            }
            if let Some(phone) = opt_str(payload, &["phone"]) {
                map.insert("phone".into(), Value::String(phone));
            }
            let first = opt_str(payload, &["firstName", "first_name"]).unwrap_or_else(|| "Contact".into());
            map.insert("first_name".into(), Value::String(first));
            if let Some(last) = opt_str(payload, &["lastName", "last_name"]) {
                map.insert("last_name".into(), Value::String(last));
            }
            let req: AddContactHttpRequest = serde_json::from_value(Value::Object(map))?;
            to_json_val(client.add_contact(req).await?)
        }
        "deleteContact" => {
            let uid = req_u64(payload, &["userId", "user_id"], "userId")?;
            client.delete_contact(uid).await?;
            Ok(json!({ "deleted": true, "userId": uid }))
        }
        "resolveUsername" => {
            let username = req_str(payload, &["username", "peer"], "username")?;
            let clean = username.trim_start_matches('@');
            to_json_val(client.resolve_peer(clean).await?)
        }
        "blockUser" => {
            let uid = req_u64(payload, &["userId", "user_id"], "userId")?;
            to_json_val(client.block_user(uid).await?)
        }
        "unblockUser" => {
            let uid = req_u64(payload, &["userId", "user_id"], "userId")?;
            client.unblock_user(uid).await?;
            Ok(json!({ "unblocked": true, "userId": uid }))
        }
        "listBlocked" => {
            let blocked = client.list_blocked_users().await?;
            Ok(json!({ "blocked": blocked, "count": blocked.len() }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported contacts action '{other}'"),
        )),
    }
}

pub async fn handle_inspector(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "getPeerProfile" => {
            if let Some(uid) = opt_u64(payload, &["userId", "user_id"]) {
                return to_json_val(client.get_user_profile(uid).await?);
            }
            if let Some(cid) = opt_i64(payload, &["chatId", "chat_id"]) {
                return to_json_val(client.get_chat(cid).await?);
            }
            let uname = req_str(payload, &["username"], "userId/chatId/username")?;
            to_json_val(client.resolve_peer(uname.trim_start_matches('@')).await?)
        }
        "listMembers" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let members = client.get_chat_members(chat_id).await?;
            Ok(json!({ "members": members, "count": members.len() }))
        }
        "addMembers" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let mut uids = opt_u64_vec(payload, &["userIds", "user_ids", "memberIds"]);
            if let Some(single) = opt_u64(payload, &["userId", "user_id"]) {
                if !uids.contains(&single) {
                    uids.push(single);
                }
            }
            if uids.is_empty() {
                return Err(CoreDispatchError::validation("addMembers requires userIds"));
            }
            let ok = client.add_chat_members(chat_id, &uids).await?;
            Ok(json!({ "added": ok, "chatId": chat_id, "userIds": uids }))
        }
        "updateMemberRole" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let uid = req_u64(payload, &["userId", "user_id"], "userId")?;
            let role = req_str(payload, &["role"], "role")?;
            let title = opt_str(payload, &["adminTitle", "admin_title"]);
            let rights = opt_u64(payload, &["adminRights", "admin_rights"]);
            let ok = client
                .update_chat_member_role(chat_id, uid, &role, title.as_deref(), rights)
                .await?;
            Ok(json!({ "updated": ok, "chatId": chat_id, "userId": uid, "role": role }))
        }
        "removeMember" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let uid = req_u64(payload, &["userId", "user_id"], "userId")?;
            let ok = client.remove_chat_member(chat_id, uid).await?;
            Ok(json!({ "removed": ok, "chatId": chat_id, "userId": uid }))
        }
        "listInvites" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let invites = client.list_invites(chat_id).await?;
            Ok(json!({ "invites": invites, "count": invites.len() }))
        }
        "createInvite" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let title = opt_str(payload, &["title"]);
            let limit = opt_u32(payload, &["usageLimit", "usage_limit"]);
            let expire = opt_i64(payload, &["expireDateMs", "expire_date_ms"]);
            let req_needed = opt_bool(payload, &["requestNeeded", "request_needed"]).unwrap_or(false);
            to_json_val(
                client
                    .create_invite(chat_id, title.as_deref(), limit, expire, req_needed)
                    .await?,
            )
        }
        "revokeInvite" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let invite_id = req_str(payload, &["inviteId", "invite_id", "code"], "inviteId")?;
            client.revoke_invite(chat_id, &invite_id).await?;
            Ok(json!({ "revoked": true, "chatId": chat_id, "inviteId": invite_id }))
        }
        "joinByInvite" => {
            let raw = req_str(payload, &["code", "inviteLink", "invite_link"], "code")?;
            let code = raw
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&raw)
                .trim_start_matches('+');
            to_json_val(client.join_invite(code).await?)
        }
        "listSharedMedia" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let filter = opt_str(payload, &["mediaType", "filter"]).unwrap_or_else(|| "media".into());
            let limit = opt_usize(payload, &["limit"]).unwrap_or(50);
            let res = client
                .search_messages("", Some(&filter), Some(chat_id), limit)
                .await?;
            to_json_val(res)
        }
        "getChannelStatistics" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            to_json_val(client.get_channel_statistics(chat_id).await?)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported inspector action '{other}'"),
        )),
    }
}

pub async fn handle_settings(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "listSections" => {
            let snap = engine.persisted_snapshot();
            let sections: Vec<Value> = ALL_26_SETTINGS_SECTIONS
                .iter()
                .enumerate()
                .map(|(idx, (id, title))| {
                    json!({
                        "index": idx + 1,
                        "id": id,
                        "title": title
                    })
                })
                .collect();
            Ok(json!({
                "sections": sections,
                "count": sections.len(),
                "themeId": snap.theme_id,
                "locale": snap.locale
            }))
        }
        "getSection" => {
            let sec = req_str(payload, &["sectionId", "section", "id"], "sectionId")?;
            let found = ALL_26_SETTINGS_SECTIONS
                .iter()
                .find(|(id, _)| *id == sec)
                .ok_or_else(|| {
                    CoreDispatchError::not_found(format!("Unknown settings section '{sec}'"))
                })?;
            let snap = engine.persisted_snapshot();
            let detail = match sec.as_str() {
                "profile" | "account" => to_json_val(client.get_my_profile().await.ok())?,
                "privacy" => to_json_val(client.get_my_settings().await.ok())?,
                "themes" => json!({ "themeId": snap.theme_id, "palette": theme_palette(&snap.theme_id) }),
                "language" => json!({ "locale": snap.locale, "supported": ["zh-CN", "en-US"] }),
                "business" => snap.business_settings,
                "network_proxy" => to_json_val(snap.proxy)?,
                _ => snap.preferences,
            };
            Ok(json!({
                "sectionId": found.0,
                "title": found.1,
                "data": detail
            }))
        }
        "updateProfile" => {
            let req = ProtoUpdateProfileRequest {
                first_name: opt_str(payload, &["firstName", "first_name"]),
                last_name: opt_str(payload, &["lastName", "last_name"]),
                username: opt_str(payload, &["username"]),
                phone: opt_str(payload, &["phone", "phoneNumber"]),
                bio: opt_str(payload, &["bio", "about"]),
                avatar_media_id: opt_str(payload, &["avatarMediaId", "avatar_media_id", "photoUrl", "photo_url", "avatarFileId"]),
                emoji_status: opt_str(payload, &["emojiStatus", "emoji_status"]),
            };
            to_json_val(client.update_profile(&req).await?)
        }
        "getPrivacy" => to_json_val(client.get_my_settings().await?),
        "updatePrivacy" => {
            let mut current = to_json_val(client.get_my_settings().await.unwrap_or_default())?;
            if let (Some(dst), Some(src)) = (current.as_object_mut(), payload.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }
            let dto: UserPrivacySettingsDto = serde_json::from_value(current)?;
            to_json_val(client.save_my_settings(&dto).await?)
        }
        "getPreferences" => Ok(engine.persisted_snapshot().preferences),
        "updatePreferences" => {
            let updated = engine.with_state_mut(|st| {
                if let (Some(dst), Some(src)) = (st.preferences.as_object_mut(), payload.as_object()) {
                    for (k, v) in src {
                        dst.insert(k.clone(), v.clone());
                    }
                }
                st.preferences.clone()
            })?;
            Ok(updated)
        }
        "setTheme" => {
            let raw = req_str(payload, &["themeId", "theme"], "themeId")?;
            let norm = normalize_theme_id(&raw)?;
            engine.with_state_mut(|st| {
                st.theme_id = norm.clone();
            })?;
            let palette = theme_palette(&norm);
            engine.emit_push("themeChanged", json!({ "themeId": norm, "palette": palette }));
            Ok(json!({ "themeId": norm, "palette": palette }))
        }
        "setLocale" => {
            let raw = req_str(payload, &["locale", "language"], "locale")?;
            let norm = normalize_locale_id(&raw)?;
            engine.with_state_mut(|st| {
                st.locale = norm.clone();
            })?;
            engine.emit_push("localeChanged", json!({ "locale": norm }));
            Ok(json!({ "locale": norm }))
        }
        "probeProxy" => {
            let snap = engine.persisted_snapshot();
            let rec = if payload.get("host").is_some() {
                ProxyEndpointRecord {
                    id: 1,
                    kind: opt_str(payload, &["kind", "type"]).unwrap_or_else(|| "SOCKS5".into()),
                    host: req_str(payload, &["host"], "host")?,
                    port: opt_u32(payload, &["port"]).unwrap_or(1080) as u16,
                    secret_or_user: opt_str(payload, &["secret"]).unwrap_or_default(),
                    username: opt_str(payload, &["username"]),
                    password: opt_str(payload, &["password"]),
                    ping_ms: 0,
                    enabled: true,
                }
            } else {
                snap.proxy.ok_or_else(|| {
                    CoreDispatchError::validation("No proxy configured and no host supplied")
                })?
            };
            let cfg = gpui_telegram_client::net::ClientProxyConfig::from_record(&rec)
                .ok_or_else(|| CoreDispatchError::validation("Proxy record is Direct or invalid"))?;
            let latency_ms = client.http_client.probe_proxy(&cfg).await?;
            Ok(json!({ "reachable": true, "latencyMs": latency_ms, "host": rec.host, "port": rec.port }))
        }
        "getStorageStats" => {
            let cfg = engine.init_config();
            let files_bytes = dir_size_bytes(Path::new(&cfg.files_dir));
            let cache_bytes = dir_size_bytes(Path::new(&cfg.cache_dir));
            let temp_bytes = dir_size_bytes(Path::new(&cfg.temp_dir));
            let db_bytes = dir_size_bytes(Path::new(&cfg.database_dir));
            Ok(json!({
                "filesBytes": files_bytes,
                "cacheBytes": cache_bytes,
                "tempBytes": temp_bytes,
                "databaseBytes": db_bytes,
                "totalBytes": files_bytes + cache_bytes + temp_bytes + db_bytes
            }))
        }
        "clearStorageCache" => {
            let cfg = engine.init_config();
            let freed_cache = clear_dir_contents(Path::new(&cfg.cache_dir));
            let freed_temp = clear_dir_contents(Path::new(&cfg.temp_dir));
            Ok(json!({
                "cleared": true,
                "freedBytes": freed_cache + freed_temp,
                "remainingCacheBytes": dir_size_bytes(Path::new(&cfg.cache_dir))
            }))
        }
        "exportChatHistory" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let format = opt_str(payload, &["format"]).unwrap_or_else(|| "json".into());
            if !matches!(format.as_str(), "json" | "html" | "markdown" | "md") {
                return Err(CoreDispatchError::validation(format!(
                    "Unsupported export format '{format}'; expected json, html, or markdown"
                )));
            }
            let exported = client.export_chat_history(chat_id, Some(&format)).await?;
            let files_dir = engine.init_config().files_dir;
            let file_path = if !files_dir.trim().is_empty() {
                let exports_dir = Path::new(&files_dir).join("exports");
                let _ = fs::create_dir_all(&exports_dir);
                let out = exports_dir.join(format!("chat_{chat_id}.{format}"));
                let _ = fs::write(&out, exported.as_bytes());
                Some(out.to_string_lossy().to_string())
            } else {
                None
            };
            Ok(json!({
                "chatId": chat_id,
                "format": format,
                "byteLength": exported.len(),
                "filePath": file_path,
                "content": exported
            }))
        }
        "setNotificationBadge" => {
            let count = opt_u32(payload, &["count", "badgeCount", "unreadCount"]).unwrap_or(0);
            let muted = opt_bool(payload, &["muted", "notificationsMuted"]);
            let prefs = engine.with_state_mut(|st| {
                st.preferences["badgeCount"] = json!(count);
                if let Some(m) = muted {
                    st.preferences["notificationsMuted"] = json!(m);
                }
                st.preferences.clone()
            })?;
            Ok(json!({ "badgeCount": count, "preferences": prefs }))
        }
        "updateBusinessSection" => {
            let updated = engine.with_state_mut(|st| {
                if let (Some(dst), Some(src)) =
                    (st.business_settings.as_object_mut(), payload.as_object())
                {
                    for (k, v) in src {
                        dst.insert(k.clone(), v.clone());
                    }
                    dst.insert("enabled".into(), Value::Bool(true));
                }
                st.business_settings.clone()
            })?;
            Ok(updated)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported settings action '{other}'"),
        )),
    }
}

pub async fn handle_wallet(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "getStarsBalance" => to_json_val(client.wallet_balance().await?),
        "listTransactions" => {
            let txs = client.wallet_transactions().await?;
            Ok(json!({ "transactions": txs, "count": txs.len() }))
        }
        "topUpStars" => {
            let amount = req_i64(payload, &["amountStars", "amount_stars", "amount", "stars"], "amountStars")?;
            if amount <= 0 {
                return Err(CoreDispatchError::validation("topUpStars amountStars must be > 0"));
            }
            to_json_val(client.wallet_topup(amount).await?)
        }
        "sendStarGift" => {
            let to_uid = req_u64(
                payload,
                &["recipientUserId", "recipient_user_id", "toUserId", "to_user_id", "userId"],
                "recipientUserId",
            )?;
            let stars = req_i64(payload, &["amountStars", "amount_stars", "stars", "amount"], "amountStars")?;
            if stars <= 0 {
                return Err(CoreDispatchError::validation("Gift stars amount must be > 0"));
            }
            let req = StarGiftRequest {
                to_user_id: to_uid,
                chat_id: opt_i64(payload, &["chatId", "chat_id"]),
                amount_stars: stars,
                gift_id: Some(opt_str(payload, &["giftId", "gift_id"]).unwrap_or_else(|| "star_rose".into())),
                message: opt_str(payload, &["message", "text"]),
            };
            to_json_val(client.wallet_gift_stars(&req).await?)
        }
        "redeemCode" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let code = req_str(payload, &["code", "redeemCode"], "code")?;
            let res: Value = client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/admin/use-redeem-code",
                    Some(&token),
                    Some(&json!({ "code": code })),
                )
                .await?;
            Ok(res)
        }
        "createTonWallet" => {
            let acct_id = opt_str(payload, &["accountId", "account_id"]).unwrap_or_else(|| "ton_primary".into());
            let addr = opt_str(payload, &["address"]).unwrap_or_else(|| {
                format!("UQ{}", &sha256_hex(acct_id.as_bytes())[..46])
            });
            let label = opt_str(payload, &["label"]).unwrap_or_else(|| "HarmonyOS TON Vault".into());
            let now = chrono::Utc::now().timestamp().max(0) as u64;
            let created = engine
                .ton_service
                .create_new_wallet(&acct_id, &addr, &label, now)
                .await
                .map_err(|e| CoreDispatchError::internal(e.to_string()))?;
            let updated = engine.with_state_mut(|st| {
                st.ton_wallet["activeAccountId"] = Value::String(created.account_id.clone());
                st.ton_wallet["address"] = Value::String(created.address.clone());
                st.ton_wallet["label"] = Value::String(created.label.clone());
                st.ton_wallet["balanceNanotons"] = json!(engine.ton_service.get_cached_balance_nanotons());
                st.ton_wallet.clone()
            })?;
            Ok(updated)
        }
        "sendTon" => {
            let send_nanos = req_u64(payload, &["sendAmountNanotons", "amountNanotons", "amount"], "amountNanotons")?;
            let recipient = req_str(payload, &["recipientAddress", "recipient"], "recipientAddress")?;
            let fee = opt_u64(payload, &["feeNanotons"]).unwrap_or(5_000_000);
            let tx_hash = engine
                .ton_service
                .send_transfer(&recipient, send_nanos, fee)
                .await
                .map_err(|e| CoreDispatchError::validation(e.to_string()))?;
            let new_bal = engine.ton_service.get_cached_balance_nanotons();
            let updated = engine.with_state_mut(|st| {
                st.ton_wallet["balanceNanotons"] = json!(new_bal);
                if let Some(arr) = st.ton_wallet["transactions"].as_array_mut() {
                    arr.push(json!({
                        "txHash": tx_hash,
                        "recipient": recipient,
                        "amountNanotons": send_nanos,
                        "feeNanotons": fee
                    }));
                }
                st.ton_wallet.clone()
            })?;
            Ok(updated)
        }
        "getTonWalletState" => {
            if opt_bool(payload, &["createIfMissing", "create"]).unwrap_or(false) {
                let acct_id = opt_str(payload, &["accountId"]).unwrap_or_else(|| "ton_primary".into());
                let addr = opt_str(payload, &["address"]).unwrap_or_else(|| {
                    format!("UQ{}", &sha256_hex(acct_id.as_bytes())[..46])
                });
                let label = opt_str(payload, &["label"]).unwrap_or_else(|| "HarmonyOS TON Vault".into());
                let now = chrono::Utc::now().timestamp().max(0) as u64;
                let created = engine
                    .ton_service
                    .create_new_wallet(&acct_id, &addr, &label, now)
                    .await
                    .map_err(|e| CoreDispatchError::internal(e.to_string()))?;
                engine.with_state_mut(|st| {
                    st.ton_wallet["activeAccountId"] = Value::String(created.account_id.clone());
                    st.ton_wallet["address"] = Value::String(created.address.clone());
                    st.ton_wallet["label"] = Value::String(created.label.clone());
                })?;
            }
            if let Some(send_nanos) = opt_u64(payload, &["sendAmountNanotons"]) {
                let recipient = req_str(payload, &["recipientAddress", "recipient"], "recipientAddress")?;
                let fee = opt_u64(payload, &["feeNanotons"]).unwrap_or(5_000_000);
                let tx_hash = engine
                    .ton_service
                    .send_transfer(&recipient, send_nanos, fee)
                    .await
                    .map_err(|e| CoreDispatchError::validation(e.to_string()))?;
                let new_bal = engine.ton_service.get_cached_balance_nanotons();
                let updated = engine.with_state_mut(|st| {
                    st.ton_wallet["balanceNanotons"] = json!(new_bal);
                    if let Some(arr) = st.ton_wallet["transactions"].as_array_mut() {
                        arr.push(json!({
                            "txHash": tx_hash,
                            "recipient": recipient,
                            "amountNanotons": send_nanos,
                            "feeNanotons": fee
                        }));
                    }
                    st.ton_wallet.clone()
                })?;
                return Ok(updated);
            }
            let mut snap = engine.persisted_snapshot().ton_wallet;
            snap["balanceNanotons"] = json!(engine.ton_service.get_cached_balance_nanotons());
            Ok(snap)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported wallet action '{other}'"),
        )),
    }
}

fn parse_passport_value_type(raw: &str) -> CoreResult<ValueType> {
    match raw.trim() {
        "PersonalDetails" | "personal_details" => Ok(ValueType::PersonalDetails),
        "Passport" | "passport" => Ok(ValueType::Passport),
        "DriverLicense" | "driver_license" => Ok(ValueType::DriverLicense),
        "IdentityCard" | "identity_card" => Ok(ValueType::IdentityCard),
        "InternalPassport" | "internal_passport" => Ok(ValueType::InternalPassport),
        "Address" | "address" => Ok(ValueType::Address),
        "UtilityBill" | "utility_bill" => Ok(ValueType::UtilityBill),
        "BankStatement" | "bank_statement" => Ok(ValueType::BankStatement),
        "RentalAgreement" | "rental_agreement" => Ok(ValueType::RentalAgreement),
        "PassportRegistration" | "passport_registration" => Ok(ValueType::PassportRegistration),
        "TemporaryRegistration" | "temporary_registration" => Ok(ValueType::TemporaryRegistration),
        "Phone" | "phone" => Ok(ValueType::Phone),
        "Email" | "email" => Ok(ValueType::Email),
        other => Err(CoreDispatchError::validation(format!(
            "Unsupported Passport document type '{other}'"
        ))),
    }
}

pub async fn handle_passport(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    match action {
        "getPassportState" => {
            let ctrl = engine.load_passport_controller()?;
            Ok(json!({
                "count": ctrl.form.values.len(),
                "values": ctrl.form.values,
                "requestedGroups": ctrl.form.requested_groups,
                "canSubmit": ctrl.can_submit(),
                "missingRequirements": ctrl.missing_requirements(),
                "encryptedAtRest": engine.persisted_snapshot().passport_cipher_b64.is_some()
            }))
        }
        "savePassportDocument" => {
            let vt_str = req_str(
                payload,
                &["valueType", "documentType", "type"],
                "documentType",
            )?;
            let vt = parse_passport_value_type(&vt_str)?;
            let mut fields = BTreeMap::new();
            if let Some(obj) = payload.get("fields").and_then(|f| f.as_object()) {
                for (k, v) in obj {
                    if let Some(s) = v.as_str() {
                        fields.insert(k.clone(), s.to_string());
                    } else {
                        fields.insert(k.clone(), v.to_string());
                    }
                }
            }
            let mut files = BTreeMap::new();
            if opt_bool(payload, &["hasScan", "includeScan"]).unwrap_or(false) {
                files.insert(
                    PassportFileType::Scan,
                    vec![PassportFile {
                        id: 1,
                        access_hash: 1001,
                        size: 4096,
                        dc_id: 2,
                        date: chrono::Utc::now().timestamp(),
                        hash: vec![0xAA; 32],
                        secret: vec![0xBB; 32],
                        encrypted_secret: vec![0xCC; 32],
                        status: LoadStatus::Done,
                        error: None,
                    }],
                );
            }
            if fields.is_empty() && files.is_empty() {
                return Err(CoreDispatchError::validation(
                    "Passport document requires at least one field or scan file",
                ));
            }
            let mut val = PassportValue::new(vt);
            val.fields = fields;
            val.files = files;
            val.selfie_required = opt_bool(payload, &["selfieRequired"]).unwrap_or(false);
            val.translation_required = opt_bool(payload, &["translationRequired"]).unwrap_or(false);

            let mut ctrl = engine.load_passport_controller()?;
            ctrl.add_value(val.clone());
            engine.save_passport_controller(&ctrl)?;
            Ok(json!({
                "saved": true,
                "documentType": format!("{vt:?}"),
                "isFilled": val.is_filled(),
                "encryptedAtRest": true
            }))
        }
        "deletePassportDocument" => {
            let vt_str = req_str(
                payload,
                &["valueType", "documentType", "type"],
                "documentType",
            )?;
            let vt = parse_passport_value_type(&vt_str)?;
            let mut ctrl = engine.load_passport_controller()?;
            let existed = ctrl.form.values.remove(&vt).is_some();
            engine.save_passport_controller(&ctrl)?;
            Ok(json!({ "deleted": existed, "documentType": format!("{vt:?}") }))
        }
        "authorizePassportRequest" => {
            let bot_id = req_u64(payload, &["botId", "bot_id"], "botId")?;
            let nonce = req_str(payload, &["nonce"], "nonce")?;
            let scope_types: Vec<ValueType> = if let Some(arr) = payload.get("scope").and_then(|v| v.as_array()) {
                let mut vts = Vec::with_capacity(arr.len());
                for item in arr {
                    let s = item.as_str().unwrap_or("");
                    vts.push(parse_passport_value_type(s)?);
                }
                vts
            } else {
                let scope_str = req_str(payload, &["scope"], "scope")?;
                let mut vts = Vec::new();
                for part in scope_str.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                    vts.push(parse_passport_value_type(part)?);
                }
                vts
            };
            if scope_types.is_empty() {
                return Err(CoreDispatchError::validation("Passport scope must not be empty"));
            }

            let mut ctrl = engine.load_passport_controller()?;
            ctrl.request = FormRequest {
                bot_id,
                scope: scope_types.iter().map(|v| format!("{v:?}")).collect::<Vec<_>>().join(","),
                callback_url: opt_str(payload, &["callbackUrl"]).unwrap_or_default(),
                public_key: opt_str(payload, &["publicKey"]).unwrap_or_else(|| "pk_default".into()),
                nonce: nonce.clone(),
            };
            ctrl.form.requested_groups = scope_types.iter().map(|vt| vec![*vt]).collect();
            if !ctrl.can_submit() {
                let missing = ctrl.missing_requirements();
                return Err(CoreDispatchError::new(
                    "PASSPORT_INCOMPLETE",
                    missing.join("; "),
                ));
            }
            ctrl.is_submitting = false;
            engine.save_passport_controller(&ctrl)?;
            let payload_hash = sha256_hex(format!("{bot_id}:{nonce}:{}", ctrl.request.scope).as_bytes());
            Ok(json!({
                "authorized": true,
                "botId": bot_id,
                "nonce": nonce,
                "authorizedTypes": scope_types,
                "encryptedPayloadDigest": payload_hash
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported passport action '{other}'"),
        )),
    }
}
