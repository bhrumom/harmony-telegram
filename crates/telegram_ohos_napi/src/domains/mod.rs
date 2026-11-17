//! Unified 28-domain command & query dispatcher (`PROJECT.md § 4.1`, `TEST_INFRA.md § 3.1`).

pub mod agentic_infra;
pub mod auth_sessions;
pub mod bots_fabushi;
pub mod dialogs_search;
pub mod media_e2ee;
pub mod messaging_sync;
pub mod rtc_talk;
pub mod social_settings;

use serde_json::Value;

use crate::engine::TelegramCoreEngine;
use crate::helpers::{CoreDispatchError, CoreResult};

pub const ALL_28_DOMAINS: &[&str] = &[
    "auth",
    "sessions",
    "dialogs",
    "folders",
    "topics",
    "search",
    "messages",
    "outbox",
    "sync",
    "media",
    "e2ee",
    "contacts",
    "inspector",
    "settings",
    "wallet",
    "passport",
    "calls",
    "talk",
    "bots",
    "miniapps",
    "fabushi",
    "hermes",
    "tasks",
    "mcp",
    "magpie",
    "computers",
    "tailnet",
    "updater",
];

fn snake_to_camel(s: &str) -> String {
    if !s.contains('_') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut upper_next = false;
    for ch in s.chars() {
        if ch == '_' {
            upper_next = true;
        } else if upper_next {
            for up in ch.to_uppercase() {
                out.push(up);
            }
            upper_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}

pub fn normalize_action(domain: &str, action: &str) -> String {
    match (domain, action) {
        ("auth", "status") | ("auth", "server_status") | ("auth", "getServerStatus") => "checkHealth".into(),
        ("auth", "phone_send_code") | ("auth", "phoneSendCode") => "sendPhoneCode".into(),
        ("auth", "phone_verify") | ("auth", "phoneVerify") => "verifyPhoneOtp".into(),
        ("auth", "two_factor_status") | ("auth", "twoFactorStatus") => "get2faStatus".into(),
        ("auth", "two_factor_set") | ("auth", "twoFactorSet") => "enable2fa".into(),
        ("auth", "two_factor_disable") | ("auth", "twoFactorDisable") => "disable2fa".into(),
        ("auth", "two_factor_verify") | ("auth", "twoFactorVerify") => "verify2fa".into(),
        ("auth", "email_send_code") | ("auth", "emailSendCode") => "sendEmailOtp".into(),
        ("auth", "email_register") | ("auth", "emailRegister") => "verifyEmailOtp".into(),
        ("auth", "alipay_start") | ("auth", "alipayStart") => "startAlipayAuth".into(),
        ("auth", "alipay_poll") | ("auth", "alipayPoll") => "pollAlipayAuth".into(),
        ("auth", "qr_pair_init") | ("auth", "qrPairInit") => "startQrLogin".into(),
        ("auth", "qr_pair_accept") | ("auth", "qrPairAccept") => "confirmQrLogin".into(),
        ("auth", "qr_pair_poll") | ("auth", "qrPairPoll") => "pollQrLogin".into(),
        ("auth", "passkey_challenge") | ("auth", "passkeyChallenge") => "startPasskeyChallenge".into(),
        ("auth", "passkey_register") | ("auth", "passkeyRegister") => "registerPasskey".into(),
        ("auth", "passkey_verify") | ("auth", "passkeyVerify") => "finishPasskeyAssertion".into(),

        ("sessions", "current") => "getCurrentSession".into(),
        ("sessions", "set_passcode") | ("sessions", "setPasscode") => "setPasscodeLock".into(),
        ("sessions", "verify_passcode") | ("sessions", "verifyPasscode") => "unlockApp".into(),
        ("sessions", "passcode_status") | ("sessions", "passcodeStatus") => "getPasscodeStatus".into(),

        ("dialogs", "list") => "listDialogs".into(),
        ("dialogs", "list_cached") | ("dialogs", "listCached") => "listCachedDialogs".into(),
        ("dialogs", "get") => "getDialog".into(),
        ("dialogs", "create") => "createGroup".into(),
        ("dialogs", "update") => "updateDialog".into(),
        ("dialogs", "delete") => "deleteDialog".into(),
        ("dialogs", "leave") => "leaveDialog".into(),
        ("dialogs", "archive") => "setArchived".into(),
        ("dialogs", "pin_dialog") | ("dialogs", "pinDialog") => "setPinned".into(),
        ("dialogs", "mute") => "setMuted".into(),

        ("folders", "list") => "listFolders".into(),
        ("folders", "create") => "createFolder".into(),
        ("folders", "update") => "updateFolder".into(),
        ("folders", "delete") => "deleteFolder".into(),

        ("topics", "list") => "listTopics".into(),
        ("topics", "create") => "createTopic".into(),
        ("topics", "update") => "updateTopic".into(),
        ("topics", "delete") => "deleteTopic".into(),

        ("search", "messages") => "searchMessages".into(),
        ("search", "global_catalog") | ("search", "globalCatalog") => "searchCatalog".into(),
        ("search", "categorized") => "searchAll".into(),

        ("messages", "history") => "getHistory".into(),
        ("messages", "cached") => "getCachedMessages".into(),
        ("messages", "edit") => "editMessage".into(),
        ("messages", "delete") => "deleteMessage".into(),
        ("messages", "forward") => "forwardMessages".into(),
        ("messages", "translate") => "translateMessage".into(),
        ("messages", "report") => "reportMessage".into(),

        ("outbox", "list") => "listOutbox".into(),
        ("outbox", "pending_count") | ("outbox", "pendingCount") => "pendingCount".into(),
        ("outbox", "flush") | ("outbox", "reconnect_and_flush") => "flushOutbox".into(),
        ("outbox", "set_online") | ("outbox", "setOnline") => "setOfflineMode".into(),

        ("sync", "get_state") | ("sync", "getState") => "getPtsState".into(),

        ("media", "upload_bytes") | ("media", "uploadBytes") => "uploadFile".into(),
        ("media", "download") => "downloadFile".into(),
        ("media", "metadata") => "getMetadata".into(),
        ("media", "list_sticker_sets") | ("media", "listStickerSets") => "listStickers".into(),

        ("e2ee", "identity") | ("e2ee", "generateIdentity") => "initIdentity".into(),
        ("e2ee", "publish_prekeys") | ("e2ee", "publishPreKeyBundle") | ("e2ee", "publishPrekeys") => "uploadPrekeys".into(),
        ("e2ee", "fetch_prekey_bundle") | ("e2ee", "fetchPreKeyBundle") => "fetchPrekeyBundle".into(),
        ("e2ee", "safety_fingerprint") | ("e2ee", "safetyFingerprint") | ("e2ee", "computeSafetyNumbers") => "computeSafetyNumber".into(),
        ("e2ee", "decrypt_message") | ("e2ee", "decryptMessage") | ("e2ee", "decryptDm") => "decryptDirect".into(),
        ("e2ee", "encryptDm") => "encryptDirect".into(),

        ("contacts", "list") => "listContacts".into(),
        ("contacts", "add") => "addContact".into(),
        ("contacts", "delete") => "deleteContact".into(),
        ("contacts", "block") => "blockUser".into(),
        ("contacts", "unblock") => "unblockUser".into(),
        ("contacts", "list_blocked") | ("contacts", "listBlocked") => "listBlocked".into(),

        ("wallet", "balance") => "getBalance".into(),
        ("wallet", "transactions") => "listTransactions".into(),
        ("wallet", "topup_stars") | ("wallet", "topupStars") => "topupStars".into(),

        ("tailnet", "register") | ("tailnet", "registerNode") | ("tailnet", "register_node") => "registerDevice".into(),
        ("tailnet", "netmap") | ("tailnet", "get_netmap") => "getNetMap".into(),

        _ => snake_to_camel(action),
    }
}

pub async fn dispatch_async(
    engine: &TelegramCoreEngine,
    domain: &str,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let norm = normalize_action(domain, action);
    let act = norm.as_str();
    match domain {
        "auth" => auth_sessions::handle_auth(engine, act, payload).await,
        "sessions" => auth_sessions::handle_sessions(engine, act, payload).await,
        "dialogs" => dialogs_search::handle_dialogs(engine, act, payload).await,
        "folders" => dialogs_search::handle_folders(engine, act, payload).await,
        "topics" => dialogs_search::handle_topics(engine, act, payload).await,
        "search" => dialogs_search::handle_search(engine, act, payload).await,
        "messages" => messaging_sync::handle_messages(engine, act, payload).await,
        "outbox" => messaging_sync::handle_outbox(engine, act, payload).await,
        "sync" => messaging_sync::handle_sync(engine, act, payload).await,
        "media" => media_e2ee::handle_media(engine, act, payload).await,
        "e2ee" => media_e2ee::handle_e2ee(engine, act, payload).await,
        "contacts" => social_settings::handle_contacts(engine, act, payload).await,
        "inspector" => social_settings::handle_inspector(engine, act, payload).await,
        "settings" => social_settings::handle_settings(engine, act, payload).await,
        "wallet" => social_settings::handle_wallet(engine, act, payload).await,
        "passport" => social_settings::handle_passport(engine, act, payload).await,
        "calls" => rtc_talk::handle_calls(engine, act, payload).await,
        "talk" => rtc_talk::handle_talk(engine, act, payload).await,
        "bots" => bots_fabushi::handle_bots(engine, act, payload).await,
        "miniapps" => bots_fabushi::handle_miniapps(engine, act, payload).await,
        "fabushi" => bots_fabushi::handle_fabushi(engine, act, payload).await,
        "hermes" => agentic_infra::handle_hermes(engine, act, payload).await,
        "tasks" => agentic_infra::handle_tasks(engine, act, payload).await,
        "mcp" => agentic_infra::handle_mcp(engine, act, payload).await,
        "magpie" => agentic_infra::handle_magpie(engine, act, payload).await,
        "computers" => agentic_infra::handle_computers(engine, act, payload).await,
        "tailnet" => agentic_infra::handle_tailnet(engine, act, payload).await,
        "updater" => agentic_infra::handle_updater(engine, act, payload).await,
        other => Err(CoreDispatchError::new(
            "UNKNOWN_DOMAIN",
            format!("Unsupported domain '{other}'"),
        )),
    }
}
