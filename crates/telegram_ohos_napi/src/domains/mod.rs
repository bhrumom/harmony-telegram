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

pub fn normalize_domain_and_action(domain: &str, action: &str) -> (String, String) {
    let d = match domain.trim() {
        "session" => "sessions",
        "dialog" | "chats" | "chat" => "dialogs",
        "folder" => "folders",
        "topic" => "topics",
        "message" => "messages",
        "contact" => "contacts",
        "setting" => "settings",
        "call" | "webrtc" => "calls",
        "bot" | "botfather" => "bots",
        "miniapp" | "mini_apps" => "miniapps",
        "task" | "kanban" | "cron" => "tasks",
        "computer" => "computers",
        "update" | "updates" => "updater",
        other => other,
    };

    let camel = snake_to_camel(action.trim());
    let a = match (d, camel.as_str()) {
        // 1. auth
        ("auth", "status" | "serverStatus" | "getServerStatus" | "health" | "checkHealth") => "checkHealth",
        ("auth", "setServerUrl") => "setServerConfig",
        ("auth", "setProxy") => "setProxyConfig",
        ("auth", "register" | "registerPassword") => "registerPassword",
        ("auth", "login" | "loginPassword") => "loginPassword",
        ("auth", "phoneSendCode") => "sendPhoneCode",
        ("auth", "phoneVerify" | "verifyPhoneOtp") => "verifyPhoneCode",
        ("auth", "twoFactorStatus") => "get2faStatus",
        ("auth", "twoFactorSet" | "set2fa" | "enable2fa") => "setup2fa",
        ("auth", "twoFactorDisable") => "disable2fa",
        ("auth", "twoFactorVerify") => "verify2fa",
        ("auth", "emailSendCode" | "sendEmailOtp") => "sendEmailCode",
        ("auth", "emailRegister" | "verifyEmailOtp") => "registerEmail",
        ("auth", "alipayStart" | "startAlipayAuth") => "startAlipayQr",
        ("auth", "alipayPoll" | "pollAlipayAuth") => "pollAlipayQr",
        ("auth", "alipaySimulateScan") => "simulateAlipayScan",
        ("auth", "qrPairInit" | "initQrPair" | "startQrLogin") => "startQrPairing",
        ("auth", "qrPairAccept" | "acceptQrPair" | "confirmQrLogin") => "approveQrPairing",
        ("auth", "qrPairPoll" | "pollQrPair" | "pollQrLogin") => "pollQrPairing",
        ("auth", "startPasskeyChallenge") => "passkeyChallenge",
        ("auth", "passkeyRegister") => "registerPasskey",
        ("auth", "passkeyVerify" | "finishPasskeyAssertion") => "verifyPasskey",
        ("auth", "passkeyList") => "listPasskeys",
        ("auth", "me") => "getMe",

        // 2. sessions
        ("sessions", "list" | "current" | "getCurrentSession") => "listAccounts",
        ("sessions", "add") => "addAccount",
        ("sessions", "switch") => "switchAccount",
        ("sessions", "remove") => "removeAccount",
        ("sessions", "listSessions" | "devices") => "listDeviceSessions",
        ("sessions", "revokeSession") => "revokeDeviceSession",
        ("sessions", "setPasscode") => "setPasscodeLock",
        ("sessions", "lock") => "lockApp",
        ("sessions", "unlock" | "verifyPasscode") => "unlockApp",
        ("sessions", "getPasscodeStatus") => "passcodeStatus",
        ("sessions", "assetStatus") => "verifyAssetToken",
        ("sessions", "fence" | "generation") => "checkGenerationFence",

        // 3. dialogs
        ("dialogs", "list" | "listDialogs" | "listCached" | "listCachedDialogs") => "listChats",
        ("dialogs", "create" | "createGroup") => "createChat",
        ("dialogs", "get" | "getDialog") => "getChat",
        ("dialogs", "update" | "updateDialog") => "updateChat",
        ("dialogs", "delete" | "deleteDialog") => "deleteChat",
        ("dialogs", "leave" | "leaveDialog") => "leaveChat",
        ("dialogs", "archive" | "archiveChat" | "setArchived") => "setArchive",
        ("dialogs", "pin" | "pinChat" | "pinDialog" | "setPinned") => "setPin",
        ("dialogs", "mute" | "muteChat" | "setMuted") => "setMute",
        ("dialogs", "ttl") => "setTtl",
        ("dialogs", "setDraft") => "saveDraft",
        ("dialogs", "deleteDraft") => "clearDraft",
        ("dialogs", "welcome") => "provisionWelcomeChat",

        // 4. folders
        ("folders", "list") => "listFolders",
        ("folders", "create" | "saveFolder") => "createFolder",
        ("folders", "update") => "updateFolder",
        ("folders", "delete") => "deleteFolder",

        // 5. topics
        ("topics", "list") => "listTopics",
        ("topics", "create") => "createTopic",
        ("topics", "update") => "updateTopic",
        ("topics", "delete") => "deleteTopic",

        // 6. search
        ("search", "global" | "all" | "categorized") => "searchAll",
        ("search", "chats") => "searchChats",
        ("search", "messages" | "inChat" | "searchInChat") => "searchMessages",
        ("search", "hybrid") => "searchHybrid",
        ("search", "catalog" | "globalCatalog" | "searchCatalog") => "searchGlobalCatalog",

        // 7. messages
        ("messages", "send" | "sendText") => "sendMessage",
        ("messages", "history" | "getHistory" | "list" | "cached" | "getCachedMessages") => "listHistory",
        ("messages", "edit") => "editMessage",
        ("messages", "delete" | "deleteMessage") => "deleteMessages",
        ("messages", "forward" | "forwardMessage") => "forwardMessages",
        ("messages", "pin") => "pinMessage",
        ("messages", "unpin") => "unpinMessage",
        ("messages", "listPins" | "pins") => "listPinnedMessages",
        ("messages", "react") => "toggleReaction",
        ("messages", "read") => "markRead",
        ("messages", "translate") => "translateMessage",
        ("messages", "report") => "reportMessage",
        ("messages", "stories") => "listStories",
        ("messages", "postStory") => "createStory",
        ("messages", "instantView") => "openInstantView",
        ("messages", "sendAs") => "listSendAsPeers",

        // 8. outbox
        ("outbox", "enqueue" | "enqueueMessage") => "enqueueOffline",
        ("outbox", "list" | "pending" | "listOutbox" | "pendingCount") => "listPending",
        ("outbox", "flush" | "flushNow" | "reconnectAndFlush") => "flushOutbox",
        ("outbox", "setOnline" | "setOfflineMode") => "simulateNetworkChange",

        // 9. sync
        ("sync", "state" | "getPtsState") => "getState",
        ("sync", "difference") => "getDifference",
        ("sync", "applyPts") => "applyPtsUpdate",

        // 10. media
        ("media", "upload" | "uploadBytes") => "uploadFile",
        ("media", "initChunked") => "initChunkedUpload",
        ("media", "uploadStatus") => "getUploadStatus",
        ("media", "completeChunked") => "completeChunkedUpload",
        ("media", "download" | "downloadFile") => "downloadRange",
        ("media", "metadata") => "getMetadata",
        ("media", "encodeWaveform") => "encodeWaveform5Bit",
        ("media", "decodeWaveform") => "decodeWaveform5Bit",
        ("media", "recordVoice") => "recordVoicePcm",
        ("media", "edit" | "editImage") => "editMedia",
        ("media", "stickers" | "listStickerSets") => "listStickers",
        ("media", "gifs") => "searchGifs",
        ("media", "startVoice") => "startVoiceRecorder",
        ("media", "stopVoice") => "stopVoiceRecorder",

        // 11. e2ee
        ("e2ee", "init" | "identity" | "generateIdentity") => "initIdentity",
        ("e2ee", "publishPrekeys" | "publishPreKeyBundle") => "uploadPrekeys",
        ("e2ee", "fetchPrekeys" | "fetchPreKeyBundle") => "fetchPrekeyBundle",
        ("e2ee", "establish") => "establishX3dh",
        ("e2ee", "sendDm") => "sendEncryptedDm",
        ("e2ee", "encryptDm") => "encryptDirect",
        ("e2ee", "decryptDm" | "decryptEnvelope" | "decryptMessage") => "decryptDirect",
        ("e2ee", "initSenderKey") => "initGroupSenderKey",
        ("e2ee", "sendGroup") => "sendEncryptedGroup",
        ("e2ee", "safetyFingerprint" | "computeSafetyNumbers") => "computeSafetyNumber",

        // 12. contacts
        ("contacts", "list") => "listContacts",
        ("contacts", "add") => "addContact",
        ("contacts", "delete" | "remove") => "deleteContact",
        ("contacts", "resolve" | "resolvePeer") => "resolveUsername",
        ("contacts", "block") => "blockUser",
        ("contacts", "unblock") => "unblockUser",
        ("contacts", "blocked") => "listBlocked",

        // 13. inspector
        ("inspector", "profile" | "getProfile") => "getPeerProfile",
        ("inspector", "members") => "listMembers",
        ("inspector", "addMember") => "addMembers",
        ("inspector", "updateRole") => "updateMemberRole",
        ("inspector", "invites") => "listInvites",
        ("inspector", "joinInvite") => "joinByInvite",
        ("inspector", "sharedMedia") => "listSharedMedia",
        ("inspector", "stats" | "statistics") => "getChannelStatistics",

        // 14. settings
        ("settings", "sections") => "listSections",
        ("settings", "get") => "getPreferences",
        ("settings", "update") => "updatePreferences",
        ("settings", "theme") => "setTheme",
        ("settings", "locale") => "setLocale",
        ("settings", "storage") => "getStorageStats",
        ("settings", "clearCache") => "clearStorageCache",
        ("settings", "exportChat") => "exportChatHistory",
        ("settings", "setBadge") => "setNotificationBadge",
        ("settings", "updateBusiness") => "updateBusinessSection",

        // 15. wallet
        ("wallet", "balance" | "starsBalance" | "getBalance") => "getStarsBalance",
        ("wallet", "transactions") => "listTransactions",
        ("wallet", "topup" | "topUp" | "topupStars") => "topUpStars",
        ("wallet", "gift" | "sendGift") => "sendStarGift",
        ("wallet", "redeem") => "redeemCode",
        ("wallet", "tonState" | "tonWallet") => "getTonWalletState",
        ("wallet", "createTon") => "createTonWallet",

        // 16. passport
        ("passport", "get" | "state" | "getState" | "vault" | "getPassportVault" | "listDocuments") => "getPassportState",
        ("passport", "saveDocument" | "upsertDocument") => "savePassportDocument",
        ("passport", "deleteDocument") => "deletePassportDocument",
        ("passport", "authorize") => "authorizePassportRequest",

        // 17. calls
        ("calls", "invite" | "start") => "startCall",
        ("calls", "accept") => "acceptCall",
        ("calls", "decline" | "reject") => "rejectCall",
        ("calls", "hangup" | "end") => "endCall",
        ("calls", "joinSfu") => "joinSfuRoom",
        ("calls", "signal") => "sendSignal",
        ("calls", "turnCredentials") => "getTurnCredentials",
        ("calls", "rate") => "rateCall",
        ("calls", "list" | "history" | "listCalls") => "listCallHistory",
        ("calls", "setVoipTask") => "setBackgroundVoipTask",

        // 18. talk
        ("talk", "start" | "startSession") => "startTalkSession",
        ("talk", "vad" | "processVad") => "processVadFrame",
        ("talk", "turn" | "submitTurn") => "submitTalkTurn",
        ("talk", "bargeIn" | "abort") => "bargeInAbort",
        ("talk", "stop" | "stopSession") => "stopTalkSession",

        // 19. bots
        ("bots", "create") => "createBot",
        ("bots", "nlCreate" | "createFromPrompt") => "createBotFromPrompt",
        ("bots", "list" | "myBots") => "listBots",
        ("bots", "profile") => "getBotProfile",
        ("bots", "update") => "updateBotProfile",
        ("bots", "setCommands") => "setBotCommands",
        ("bots", "addToChat") => "addBotToChat",
        ("bots", "callback") => "sendCallbackQuery",
        ("bots", "inline") => "inlineQuery",

        // 20. miniapps
        ("miniapps", "list" | "catalog" | "listApps") => "listCatalog",
        ("miniapps", "register" | "create") => "registerMiniApp",
        ("miniapps", "launch") => "launchMiniApp",
        ("miniapps", "validateInitData") => "verifyInitDataHmac",
        ("miniapps", "storageSet") => "cloudStorageSet",
        ("miniapps", "storageGet") => "cloudStorageGet",
        ("miniapps", "storageDelete") => "cloudStorageDelete",
        ("miniapps", "renderA2ui") => "renderUiSchema",

        // 21. fabushi
        ("fabushi", "init") => "bootstrap",
        ("fabushi", "profile") => "getProfile",
        ("fabushi", "globe") => "getGlobe",
        ("fabushi", "offer" | "offering") => "createOffering",
        ("fabushi", "meditate") => "recordMeditation",
        ("fabushi", "records") => "listPracticeRecords",
        ("fabushi", "sutras") => "listSutras",
        ("fabushi", "leaderboard") => "getLeaderboard",
        ("fabushi", "vip") => "subscribeVip",
        ("fabushi", "aiGuide" | "aiChat") => "aiGuideChat",

        // 22. hermes
        ("hermes", "status") => "getStatus",
        ("hermes", "turn" | "runTurn") => "startTurn",
        ("hermes", "streamEvents") => "streamTurnEvents",
        ("hermes", "command" | "slash") => "runSlashCommand",
        ("hermes", "commands") => "listCommands",
        ("hermes", "sessions") => "listSessions",
        ("hermes", "branch") => "branchSession",
        ("hermes", "undo" | "rollback") => "undoSession",
        ("hermes", "export") => "exportSession",
        ("hermes", "memory") => "getMemory",
        ("hermes", "saveMemory") => "updateMemory",
        ("hermes", "soul") => "getSoul",
        ("hermes", "saveSoul") => "updateSoul",
        ("hermes", "honcho") => "getHoncho",
        ("hermes", "skills") => "listSkills",
        ("hermes", "saveSkill") => "proposeSkill",
        ("hermes", "toolsets") => "listToolsets",
        ("hermes", "updateToolsets") => "setToolsetPreset",

        // 23. tasks
        ("tasks", "create") => "createTask",
        ("tasks", "transition") => "transitionTask",
        ("tasks", "list") => "listTasks",
        ("tasks", "kanbanBoards") => "listKanban",
        ("tasks", "createBoard") => "createKanbanBoard",
        ("tasks", "createCard") => "createKanbanCard",
        ("tasks", "moveCard") => "moveKanbanCard",
        ("tasks", "crons") => "listCrons",
        ("tasks", "saveCron") => "createCron",
        ("tasks", "runCron") => "runCronNow",
        ("tasks", "acp") => "acpRpc",

        // 24. mcp
        ("mcp", "servers") => "listServers",
        ("mcp", "tools") => "listTools",
        ("mcp", "call" | "callTool") => "invokeTool",
        ("mcp", "approvals") => "listApprovals",
        ("mcp", "approve") => "decideApproval",
        ("mcp", "actions") => "listActions",
        ("mcp", "invokeAction") => "invokeActionBus",

        // 25. magpie
        ("magpie", "state") => "getState",
        ("magpie", "providers") => "listProviders",
        ("magpie", "saveProvider") => "upsertProvider",
        ("magpie", "probe") => "probeProvider",
        ("magpie", "upsertGroup") => "upsertRoutingGroup",
        ("magpie", "import") => "importConfig",
        ("magpie", "chatCompletion") => "proxyChatCompletion",

        // 26. computers
        ("computers", "list") => "listComputers",
        ("computers", "registerLocal" | "register") => "registerComputer",
        ("computers", "setPolicy") => "setRunPolicy",
        ("computers", "exec") => "execSandboxOp",
        ("computers", "takeover") => "emergencyTakeover",

        // 27. tailnet
        ("tailnet", "register" | "registerNode") => "registerDevice",
        ("tailnet", "netmap" | "getNetmap") => "getNetMap",
        ("tailnet", "stun") => "stunProbe",
        ("tailnet", "derp") => "derpRelayTest",

        // 28. updater
        ("updater", "check") => "checkForUpdates",
        ("updater", "verify" | "verifyManifest") => "verifyReleaseManifest",

        (_, other) => other,
    };

    (d.to_string(), a.to_string())
}

pub fn normalize_action(domain: &str, action: &str) -> String {
    normalize_domain_and_action(domain, action).1
}

pub async fn dispatch_async(
    engine: &TelegramCoreEngine,
    domain: &str,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let (norm_domain, norm_action) = normalize_domain_and_action(domain, action);
    let act = norm_action.as_str();
    match norm_domain.as_str() {
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
