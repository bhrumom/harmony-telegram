//! Core multi-account, sandbox-persisted, generation-fenced engine backing both
//! `TelegramOhosCore` (`libtelegram_core.so`) and `telegram_ohos_cli` (`ohos-app-cli`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use gpui_telegram_agent::{TalkCoordinator, VadBargeInDetector};
use gpui_telegram_client::config::ClientConfig;
use gpui_telegram_client::net::{AuthResponse, ClientProxyConfig};
use gpui_telegram_client::session_persistence::ProxyEndpointRecord;
use gpui_telegram_client::wallet::service::ton_wallet_service::TonWalletService;
use gpui_telegram_client::TelegramClient;
use gpui_telegram_core::passport::passport_form_controller::{FormRequest, PassportFormController};
use gpui_telegram_core::types::ChatId;
use gpui_telegram_client::ClientDomainEvent;
#[allow(unused_imports)]
use crate::rtc_media::{AiMediaTap, DefaultAiMediaTap, SfuBridge};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::domains;
use crate::helpers::{b64_decode, b64_encode, parse_payload, CoreDispatchError, CoreResult};

pub const MAX_MULTI_ACCOUNTS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInitConfig {
    #[serde(default, alias = "defaultServerUrl")]
    pub server_url: String,
    #[serde(default)]
    pub files_dir: String,
    #[serde(default)]
    pub cache_dir: String,
    #[serde(default)]
    pub temp_dir: String,
    #[serde(default)]
    pub database_dir: String,
    #[serde(default)]
    pub resource_dir: String,
    #[serde(default)]
    pub ca_cert_path: String,
    #[serde(default = "default_app_ver")]
    pub app_version: String,
    #[serde(default = "default_dev_model")]
    pub device_model: String,
    #[serde(default = "default_os_name")]
    pub os_full_name: String,
    #[serde(default = "default_locale")]
    pub locale: String,
}

fn default_app_ver() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn default_dev_model() -> String {
    "HarmonyOS NEXT Device".to_string()
}

fn default_os_name() -> String {
    "OpenHarmony 6.0 API 20".to_string()
}

impl Default for EngineInitConfig {
    fn default() -> Self {
        Self {
            server_url: "http://34.46.77.133:8080".to_string(),
            files_dir: String::new(),
            cache_dir: String::new(),
            temp_dir: String::new(),
            database_dir: String::new(),
            resource_dir: String::new(),
            ca_cert_path: "/etc/ssl/certs/cacert.pem".to_string(),
            app_version: default_app_ver(),
            device_model: default_dev_model(),
            os_full_name: default_os_name(),
            locale: "zh-CN".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorePushEventDto {
    pub generation: u32,
    pub account_id: String,
    pub kind: String,
    pub payload_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreEnvelopeDto {
    pub ok: bool,
    pub data_json: String,
    pub error_code: String,
    pub error_message: String,
    pub generation: u32,
}

impl CoreEnvelopeDto {
    pub fn ok_val(val: &Value, generation: u32) -> Self {
        Self {
            ok: true,
            data_json: val.to_string(),
            error_code: String::new(),
            error_message: String::new(),
            generation,
        }
    }

    pub fn err_val(err: CoreDispatchError, generation: u32) -> Self {
        Self {
            ok: false,
            data_json: "{}".to_string(),
            error_code: err.code,
            error_message: err.message,
            generation,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccountSlot {
    pub account_id: String,
    pub slot_name: String,
    pub user_id: u64,
    pub username: String,
    pub display_name: String,
    pub session_id: String,
    pub token: String,
    pub server_url: String,
    pub asset_token: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetVaultStore {
    pub master_key_b64: String,
    #[serde(default)]
    pub tokens_by_account: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedOhosState {
    pub generation: u32,
    pub server_url: String,
    pub active_slot: String,
    pub active_account_id: Option<String>,
    #[serde(default)]
    pub accounts: Vec<StoredAccountSlot>,
    #[serde(default)]
    pub passcode_enabled: bool,
    #[serde(default)]
    pub passcode_salt_hex: Option<String>,
    #[serde(default)]
    pub passcode_hash_hex: Option<String>,
    #[serde(default = "default_auto_lock_secs")]
    pub auto_lock_seconds: u32,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub failed_unlock_attempts: u32,
    #[serde(default)]
    pub offline_mode: bool,
    #[serde(default = "default_theme_id")]
    pub theme_id: String,
    #[serde(default = "default_locale")]
    pub locale: String,
    #[serde(default)]
    pub proxy: Option<ProxyEndpointRecord>,
    #[serde(default)]
    pub pts_by_chat: BTreeMap<i64, u64>,
    #[serde(default = "default_preferences")]
    pub preferences: Value,
    #[serde(default = "default_business")]
    pub business_settings: Value,
    #[serde(default)]
    pub passport_cipher_b64: Option<String>,
    #[serde(default)]
    pub passport_nonce_b64: Option<String>,
    #[serde(default = "default_ton_wallet")]
    pub ton_wallet: Value,
    #[serde(default)]
    pub active_calls: BTreeMap<String, Value>,
    #[serde(default = "default_voip_task")]
    pub voip_background_task: Value,
    #[serde(default = "default_talk_meta")]
    pub talk_meta: Value,
    #[serde(default)]
    pub task_fsms: BTreeMap<String, String>,
    #[serde(default)]
    pub mcp_approvals: BTreeMap<String, Value>,
}

fn default_auto_lock_secs() -> u32 {
    300
}
fn default_theme_id() -> String {
    "classicNight".to_string()
}
fn default_locale() -> String {
    "zh-CN".to_string()
}
fn default_preferences() -> Value {
    json!({
        "sendWithEnter": true,
        "fontSizePx": 15,
        "bubbleRadiusPx": 14,
        "powerSaving": false,
        "autoDownloadMedia": true,
        "showTranslateBar": true,
        "badgeCount": 0,
        "notificationsMuted": false
    })
}
fn default_business() -> Value {
    json!({
        "enabled": false,
        "greetingMessage": "",
        "awayMessage": "",
        "quickReplies": [],
        "businessHours": "09:00-18:00",
        "location": ""
    })
}
fn default_ton_wallet() -> Value {
    json!({
        "activeAccountId": null,
        "accounts": [],
        "balanceNanotons": 5_000_000_000u64,
        "transactions": []
    })
}
fn default_voip_task() -> Value {
    json!({
        "active": false,
        "callId": null,
        "mode": "voip"
    })
}
fn default_talk_meta() -> Value {
    json!({
        "sessionId": null,
        "state": "idle",
        "generation": 0,
        "signalSeq": 0,
        "bufferedChunks": 0,
        "flushedChunks": 0,
        "energyThreshold": 300.0,
        "sampleRate": 48000
    })
}

impl Default for PersistedOhosState {
    fn default() -> Self {
        Self {
            generation: 1,
            server_url: "http://127.0.0.1:8080".to_string(),
            active_slot: "slot_1".to_string(),
            active_account_id: None,
            accounts: Vec::new(),
            passcode_enabled: false,
            passcode_salt_hex: None,
            passcode_hash_hex: None,
            auto_lock_seconds: 300,
            locked: false,
            failed_unlock_attempts: 0,
            offline_mode: false,
            theme_id: default_theme_id(),
            locale: default_locale(),
            proxy: None,
            pts_by_chat: BTreeMap::new(),
            preferences: default_preferences(),
            business_settings: default_business(),
            passport_cipher_b64: None,
            passport_nonce_b64: None,
            ton_wallet: default_ton_wallet(),
            active_calls: BTreeMap::new(),
            voip_background_task: default_voip_task(),
            talk_meta: default_talk_meta(),
            task_fsms: BTreeMap::new(),
            mcp_approvals: BTreeMap::new(),
        }
    }
}

pub type PushEventSink = Arc<dyn Fn(CorePushEventDto) + Send + Sync>;

pub struct TalkRuntime {
    pub coordinator: TalkCoordinator,
    pub vad: VadBargeInDetector,
    pub media_tap: Arc<DefaultAiMediaTap>,
}

impl Default for TalkRuntime {
    fn default() -> Self {
        Self {
            coordinator: TalkCoordinator::new(),
            vad: VadBargeInDetector::default(),
            media_tap: Arc::new(DefaultAiMediaTap::new(48_000, 1, 0.02)),
        }
    }
}

pub struct TelegramCoreEngine {
    init_cfg: RwLock<EngineInitConfig>,
    state: Arc<RwLock<PersistedOhosState>>,
    asset_vault: RwLock<AssetVaultStore>,
    client: RwLock<Option<Arc<TelegramClient>>>,
    pub ton_service: TonWalletService,
    pub talk: Mutex<TalkRuntime>,
    pub sfu_bridge: Mutex<SfuBridge>,
    pub voice_recorders: Mutex<BTreeMap<String, gpui_telegram_media::VoiceRecorder>>,
    generation: Arc<AtomicU32>,
    initialized: AtomicBool,
    event_sink: Arc<RwLock<Option<PushEventSink>>>,
    event_broadcast: tokio::sync::broadcast::Sender<String>,
    push_broadcast: tokio::sync::broadcast::Sender<CorePushEventDto>,
    ws_pump_stop: Arc<AtomicBool>,
    ws_pump_epoch: Arc<AtomicU64>,
}

impl Default for TelegramCoreEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl TelegramCoreEngine {
    pub fn new() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut init_vault_key = [0u8; 32];
        let _ = getrandom::getrandom(&mut init_vault_key);
        let (event_tx, _) = tokio::sync::broadcast::channel(512);
        let (push_tx, _) = tokio::sync::broadcast::channel(512);
        Self {
            init_cfg: RwLock::new(EngineInitConfig::default()),
            state: Arc::new(RwLock::new(PersistedOhosState::default())),
            asset_vault: RwLock::new(AssetVaultStore {
                master_key_b64: b64_encode(&init_vault_key),
                tokens_by_account: BTreeMap::new(),
            }),
            client: RwLock::new(None),
            ton_service: TonWalletService::new(),
            talk: Mutex::new(TalkRuntime::default()),
            sfu_bridge: Mutex::new(SfuBridge::new()),
            voice_recorders: Mutex::new(BTreeMap::new()),
            generation: Arc::new(AtomicU32::new(1)),
            initialized: AtomicBool::new(false),
            event_sink: Arc::new(RwLock::new(None)),
            event_broadcast: event_tx,
            push_broadcast: push_tx,
            ws_pump_stop: Arc::new(AtomicBool::new(false)),
            ws_pump_epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn generation(&self) -> u32 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn bump_generation(&self) -> u32 {
        let next = self.generation.fetch_add(1, Ordering::SeqCst).saturating_add(1);
        self.state.write().generation = next;
        let _ = self.save_state();
        next
    }

    pub fn init(&self, mut cfg: EngineInitConfig) -> CoreResult<Value> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        if cfg.server_url.trim().is_empty() {
            cfg.server_url = "http://34.46.77.133:8080".to_string();
        }
        cfg.server_url = cfg.server_url.trim().trim_end_matches('/').to_string();

        for dir in [
            &cfg.files_dir,
            &cfg.cache_dir,
            &cfg.temp_dir,
            &cfg.database_dir,
            &cfg.resource_dir,
        ] {
            if !dir.trim().is_empty() {
                fs::create_dir_all(dir).map_err(|e| {
                    CoreDispatchError::internal(format!("Failed to create sandbox dir '{dir}': {e}"))
                })?;
            }
        }

        // Do not mutate process-global TMPDIR / GPUI_TELEGRAM_CONFIG_DIR env vars here so
        // concurrent multi-engine instances remain strictly isolated in their own sandboxes.
        if !cfg.ca_cert_path.trim().is_empty()
            && Path::new(&cfg.ca_cert_path).is_file()
            && std::env::var_os("SSL_CERT_FILE").is_none()
        {
            unsafe {
                std::env::set_var("SSL_CERT_FILE", &cfg.ca_cert_path);
            }
        }

        let state_path = Path::new(&cfg.files_dir).join("ohos_core_state.json");
        let asset_path = Path::new(&cfg.files_dir).join("ohos_asset_store.json");

        let vault = if asset_path.is_file() {
            fs::read_to_string(&asset_path)
                .ok()
                .and_then(|s| serde_json::from_str::<AssetVaultStore>(&s).ok())
                .unwrap_or_else(|| self.asset_vault.read().clone())
        } else {
            let v = self.asset_vault.read().clone();
            if !cfg.files_dir.trim().is_empty() {
                let _ = fs::write(
                    &asset_path,
                    serde_json::to_string_pretty(&v).unwrap_or_default(),
                );
            }
            v
        };
        *self.asset_vault.write() = vault;

        let mut loaded = if state_path.is_file() {
            fs::read_to_string(&state_path)
                .ok()
                .and_then(|s| serde_json::from_str::<PersistedOhosState>(&s).ok())
                .unwrap_or_default()
        } else {
            PersistedOhosState {
                server_url: cfg.server_url.clone(),
                locale: if cfg.locale.trim().is_empty() {
                    "zh-CN".to_string()
                } else {
                    cfg.locale.clone()
                },
                ..Default::default()
            }
        };

        if !cfg.server_url.trim().is_empty()
            && (loaded.server_url.trim().is_empty() || cfg.server_url != "http://127.0.0.1:8080")
        {
            loaded.server_url = cfg.server_url.clone();
        }
        if loaded.generation == 0 {
            loaded.generation = 1;
        }
        self.generation.store(loaded.generation, Ordering::SeqCst);

        let balance_nanos = loaded
            .ton_wallet
            .get("balanceNanotons")
            .and_then(|v| v.as_u64())
            .unwrap_or(5_000_000_000);
        self.ton_service.set_balance_nanotons(balance_nanos);

        // Rehydrate talk runtime from persisted metadata
        {
            let mut talk = self.talk.lock();
            if let Some(sid) = loaded.talk_meta.get("sessionId").and_then(|v| v.as_str()) {
                talk.coordinator.session_id = sid.to_string();
            }
            if let Some(st) = loaded.talk_meta.get("state").and_then(|v| v.as_str()) {
                if let Ok(parsed) = serde_json::from_value(Value::String(st.to_string())) {
                    talk.coordinator.state = parsed;
                }
            }
            let buffered = loaded
                .talk_meta
                .get("bufferedChunks")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
            talk.coordinator.audio_buffer_queue.clear();
            for _ in 0..buffered.min(320) {
                let _ = talk.coordinator.enqueue_audio(vec![0u8; 640]);
            }
            talk.coordinator.total_flushed_chunks = loaded
                .talk_meta
                .get("flushedChunks")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize;
        }

        *self.init_cfg.write() = cfg.clone();
        *self.state.write() = loaded.clone();

        self.rebuild_client_for_slot(&loaded.active_slot)?;
        self.initialized.store(true, Ordering::SeqCst);
        self.save_state()?;

        Ok(json!({
            "initialized": true,
            "serverUrl": loaded.server_url,
            "activeSlot": loaded.active_slot,
            "activeAccountId": loaded.active_account_id,
            "generation": self.generation(),
            "themeId": loaded.theme_id,
            "locale": loaded.locale,
            "locked": loaded.locked
        }))
    }

    pub fn shutdown(&self) -> CoreResult<Value> {
        self.ws_pump_stop.store(true, Ordering::SeqCst);
        self.ws_pump_epoch.fetch_add(1, Ordering::SeqCst);
        self.voice_recorders.lock().clear();
        if let Some(client) = self.client.write().take() {
            client.outbox_worker().stop();
            client.stop_tailnet_mesh();
            client.disconnect_ws();
            if tokio::runtime::Handle::try_current().is_ok() {
                std::thread::spawn(move || drop(client));
            }
        }
        let _ = self.save_state();
        self.initialized.store(false, Ordering::SeqCst);
        Ok(json!({
            "shutdown": true,
            "generation": self.generation()
        }))
    }

    pub fn subscribe_broadcast(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.event_broadcast.subscribe()
    }

    pub fn set_event_sink(&self, sink: PushEventSink) {
        *self.event_sink.write() = Some(sink);
    }

    fn spawn_ws_event_pump_for_client(&self, client: Arc<TelegramClient>) {
        self.ws_pump_stop.store(false, Ordering::SeqCst);
        let my_epoch = self.ws_pump_epoch.fetch_add(1, Ordering::SeqCst).saturating_add(1);
        let epoch_ref = Arc::clone(&self.ws_pump_epoch);
        let stop = Arc::clone(&self.ws_pump_stop);
        let sink_lock = Arc::clone(&self.event_sink);
        let state_lock = Arc::clone(&self.state);
        let gen_atom = Arc::clone(&self.generation);
        let bcast = self.event_broadcast.clone();
        let push_bcast = self.push_broadcast.clone();
        let mut outbox_rx = client.outbox_worker().subscribe_events();
        let handle = client.runtime().handle().clone();
        let weak_client = Arc::downgrade(&client);
        drop(client);

        handle.spawn(async move {
            while !stop.load(Ordering::Relaxed) && epoch_ref.load(Ordering::Relaxed) == my_epoch {
                let cur_gen = gen_atom.load(Ordering::SeqCst);
                let cur_acct = state_lock
                    .read()
                    .active_account_id
                    .clone()
                    .unwrap_or_default();

                while let Ok(ob_ev) = outbox_rx.try_recv() {
                    let ev_json = json!({
                        "type": "OutboxState",
                        "generation": cur_gen,
                        "accountId": cur_acct,
                        "payload": {
                            "clientNonce": ob_ev.client_nonce,
                            "chatId": ob_ev.chat_id,
                            "status": format!("{:?}", ob_ev.status),
                            "serverMessageId": ob_ev.server_message_id,
                            "retryCount": ob_ev.retry_count,
                            "lastError": ob_ev.last_error,
                        }
                    });
                    let ev_str = ev_json.to_string();
                    let _ = bcast.send(ev_str.clone());
                    let dto = CorePushEventDto {
                        generation: cur_gen,
                        account_id: cur_acct.clone(),
                        kind: "OutboxState".to_string(),
                        payload_json: ev_str,
                    };
                    let _ = push_bcast.send(dto.clone());
                    if let Some(sink) = sink_lock.read().clone() {
                        sink(dto);
                    }
                }

                let events = if let Some(c) = weak_client.upgrade() {
                    let evs = c.poll_events();
                    if Arc::strong_count(&c) <= 1 {
                        std::thread::spawn(move || drop(c));
                    } else {
                        drop(c);
                    }
                    evs
                } else {
                    break;
                };
                for ev in events {
                    let (kind, payload_val) = match &ev {
                        ClientDomainEvent::NewMessage(m) => (
                            "PtsUpdate",
                            json!({ "event": "NewMessage", "chatId": m.chat_id.0, "messageId": m.id.0 }),
                        ),
                        ClientDomainEvent::EditMessage(m) => (
                            "PtsUpdate",
                            json!({ "event": "MessageEdited", "chatId": m.chat_id.0, "messageId": m.id.0 }),
                        ),
                        ClientDomainEvent::DeleteMessages { chat_id, message_ids, .. } => (
                            "PtsUpdate",
                            json!({ "event": "MessageDeleted", "chatId": chat_id.0, "count": message_ids.len() }),
                        ),
                        ClientDomainEvent::ReactionsUpdated { chat_id, message_id, .. } => (
                            "PtsUpdate",
                            json!({ "event": "ReactionsUpdated", "chatId": chat_id.0, "messageId": message_id.0 }),
                        ),
                        ClientDomainEvent::ReadHistory { chat_id, max_id, .. } => (
                            "PtsUpdate",
                            json!({ "event": "ReadHistory", "chatId": chat_id.0, "maxId": max_id.0 }),
                        ),
                        ClientDomainEvent::SyncGapDetected { chat_id, from_pts, .. } => (
                            "PtsUpdate",
                            json!({ "event": "SyncGapDetected", "chatId": chat_id.0, "fromPts": from_pts }),
                        ),
                        ClientDomainEvent::Typing(t) => (
                            "TypingUpdate",
                            serde_json::to_value(t).unwrap_or_default(),
                        ),
                        ClientDomainEvent::CallUpdated { call_id, state, .. } => (
                            "CallSignal",
                            json!({ "callId": call_id, "state": state }),
                        ),
                        other => ("DomainEvent", json!({ "summary": format!("{other:?}") })),
                    };
                    let ev_json = json!({
                        "type": kind,
                        "generation": cur_gen,
                        "accountId": cur_acct,
                        "payload": payload_val
                    });
                    let ev_str = ev_json.to_string();
                    let _ = bcast.send(ev_str.clone());
                    let dto = CorePushEventDto {
                        generation: cur_gen,
                        account_id: cur_acct.clone(),
                        kind: kind.to_string(),
                        payload_json: ev_str,
                    };
                    let _ = push_bcast.send(dto.clone());
                    if let Some(sink) = sink_lock.read().clone() {
                        sink(dto);
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        });
    }

    pub fn emit_push(&self, kind: &str, payload: Value) {
        let acct = self
            .state
            .read()
            .active_account_id
            .clone()
            .unwrap_or_default();
        let cur_gen = self.generation();
        let wrapped = json!({
            "type": kind,
            "generation": cur_gen,
            "accountId": acct,
            "payload": payload
        });
        let wrapped_str = wrapped.to_string();
        let _ = self.event_broadcast.send(wrapped_str.clone());
        let dto = CorePushEventDto {
            generation: cur_gen,
            account_id: acct,
            kind: kind.to_string(),
            payload_json: wrapped_str,
        };
        let _ = self.push_broadcast.send(dto.clone());
        if let Some(sink) = self.event_sink.read().clone() {
            sink(dto);
        }
    }

    pub fn subscribe_push(&self) -> tokio::sync::broadcast::Receiver<CorePushEventDto> {
        self.push_broadcast.subscribe()
    }

    pub fn init_config(&self) -> EngineInitConfig {
        self.init_cfg.read().clone()
    }

    pub fn persisted_snapshot(&self) -> PersistedOhosState {
        self.state.read().clone()
    }

    pub fn with_state_mut<F, R>(&self, f: F) -> CoreResult<R>
    where
        F: FnOnce(&mut PersistedOhosState) -> R,
    {
        let out = {
            let mut guard = self.state.write();
            f(&mut guard)
        };
        self.save_state()?;
        Ok(out)
    }

    pub fn save_state(&self) -> CoreResult<()> {
        let files_dir = self.init_cfg.read().files_dir.clone();
        if files_dir.trim().is_empty() {
            return Ok(());
        }
        fs::create_dir_all(&files_dir)
            .map_err(|e| CoreDispatchError::internal(format!("Failed creating files_dir: {e}")))?;
        let state_path = Path::new(&files_dir).join("ohos_core_state.json");
        let asset_path = Path::new(&files_dir).join("ohos_asset_store.json");

        let state_json = serde_json::to_string_pretty(&*self.state.read())?;
        fs::write(&state_path, state_json)
            .map_err(|e| CoreDispatchError::internal(format!("Failed saving core state: {e}")))?;

        let asset_json = serde_json::to_string_pretty(&*self.asset_vault.read())?;
        fs::write(&asset_path, asset_json)
            .map_err(|e| CoreDispatchError::internal(format!("Failed saving asset vault: {e}")))?;
        Ok(())
    }

    pub fn slot_db_dir(&self, slot_name: &str) -> Option<PathBuf> {
        let db_root = self.init_cfg.read().database_dir.clone();
        if db_root.trim().is_empty() {
            None
        } else {
            let p = Path::new(&db_root).join(slot_name);
            let _ = fs::create_dir_all(&p);
            Some(p)
        }
    }

    pub fn rebuild_client_for_slot(&self, slot_name: &str) -> CoreResult<Arc<TelegramClient>> {
        let snap = self.state.read().clone();
        let proxy_cfg = snap
            .proxy
            .as_ref()
            .filter(|p| p.enabled)
            .and_then(ClientProxyConfig::from_record);
        let client_cfg = ClientConfig {
            server_url: snap.server_url.clone(),
            proxy: proxy_cfg,
            ..Default::default()
        };

        let tg_client = if let Some(slot_dir) = self.slot_db_dir(slot_name) {
            let c = TelegramClient::open_with_dir(client_cfg, &slot_dir)?;
            c.bind_persistent_identity_dir(&slot_dir);
            c
        } else {
            TelegramClient::new(client_cfg)
        };

        if snap.offline_mode {
            tg_client.network_listener.set_online(false);
        } else {
            tg_client.network_listener.set_online(true);
        }

        // Restore persisted PTS cursors into ClientSyncCoordinator
        for (&cid, &pts) in &snap.pts_by_chat {
            tg_client.sync_coordinator.set_pts(ChatId(cid), pts);
        }

        // Restore active account session if bound to this slot
        if let Some(ref active_id) = snap.active_account_id {
            if let Some(acct) = snap
                .accounts
                .iter()
                .find(|a| &a.account_id == active_id && a.slot_name == slot_name)
                .or_else(|| snap.accounts.iter().find(|a| &a.account_id == active_id))
            {
                let auth = AuthResponse {
                    user_id: acct.user_id,
                    username: acct.username.clone(),
                    session_id: acct.session_id.clone(),
                    token: acct.token.clone(),
                    first_name: Some(acct.display_name.clone()),
                    created_at: None,
                    expires_at: None,
                };
                tg_client.set_auth_session(auth);
                if !snap.offline_mode {
                    tg_client.connect_ws();
                }
            }
        }

        if let Some(prev) = self.client.write().take() {
            prev.outbox_worker().stop();
            prev.stop_tailnet_mesh();
            prev.disconnect_ws();
            if tokio::runtime::Handle::try_current().is_ok() {
                std::thread::spawn(move || drop(prev));
            }
        }
        let arc = Arc::new(tg_client);
        *self.client.write() = Some(Arc::clone(&arc));
        self.spawn_ws_event_pump_for_client(Arc::clone(&arc));
        Ok(arc)
    }

    pub fn client(&self) -> CoreResult<Arc<TelegramClient>> {
        if let Some(c) = self.client.read().clone() {
            return Ok(c);
        }
        let slot = self.state.read().active_slot.clone();
        self.rebuild_client_for_slot(&slot)
    }

    pub fn is_authenticated(&self) -> bool {
        self.client
            .read()
            .as_ref()
            .and_then(|c| c.token())
            .is_some_and(|t| !t.trim().is_empty())
    }

    pub fn compute_asset_token(&self, account_id: &str, session_id: &str) -> CoreResult<String> {
        let master_b64 = self.asset_vault.read().master_key_b64.clone();
        let key_bytes = b64_decode(&master_b64)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key_bytes)
            .map_err(|e| CoreDispatchError::internal(format!("HMAC init failed: {e}")))?;
        mac.update(b"ohos-asset-vault-v1:");
        mac.update(account_id.as_bytes());
        mac.update(b":");
        mac.update(session_id.as_bytes());
        let tag = mac.finalize().into_bytes();
        Ok(format!("ohos_asset_{}", b64_encode(&tag)))
    }

    pub fn record_authenticated_session(&self, auth: &AuthResponse) -> CoreResult<StoredAccountSlot> {
        let account_id = auth.user_id.to_string();
        let asset_token = self.compute_asset_token(&account_id, &auth.session_id)?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        let mut switch_to_new_slot: Option<String> = None;
        let slot_record = {
            let mut st = self.state.write();
            if let Some(existing_idx) = st.accounts.iter().position(|a| a.user_id == auth.user_id) {
                let slot_name = st.accounts[existing_idx].slot_name.clone();
                let updated = StoredAccountSlot {
                    account_id: account_id.clone(),
                    slot_name: slot_name.clone(),
                    user_id: auth.user_id,
                    username: auth.username.clone(),
                    display_name: auth
                        .first_name
                        .clone()
                        .unwrap_or_else(|| auth.username.clone()),
                    session_id: auth.session_id.clone(),
                    token: auth.token.clone(),
                    server_url: st.server_url.clone(),
                    asset_token: asset_token.clone(),
                    created_at_ms: now_ms,
                };
                st.accounts[existing_idx] = updated.clone();
                st.active_account_id = Some(account_id.clone());
                if st.active_slot != slot_name {
                    st.active_slot = slot_name.clone();
                    switch_to_new_slot = Some(slot_name);
                }
                updated
            } else {
                if st.accounts.len() >= MAX_MULTI_ACCOUNTS {
                    return Err(CoreDispatchError::validation(format!(
                        "Maximum multi-account limit ({MAX_MULTI_ACCOUNTS}) reached"
                    )));
                }
                let current_slot_taken = st
                    .accounts
                    .iter()
                    .any(|a| a.slot_name == st.active_slot && a.user_id != auth.user_id);
                let slot_name = if current_slot_taken {
                    let next_idx = st.accounts.len() + 1;
                    let s = format!("slot_{next_idx}_{}", auth.user_id);
                    st.active_slot = s.clone();
                    switch_to_new_slot = Some(s.clone());
                    s
                } else {
                    st.active_slot.clone()
                };
                let rec = StoredAccountSlot {
                    account_id: account_id.clone(),
                    slot_name,
                    user_id: auth.user_id,
                    username: auth.username.clone(),
                    display_name: auth
                        .first_name
                        .clone()
                        .unwrap_or_else(|| auth.username.clone()),
                    session_id: auth.session_id.clone(),
                    token: auth.token.clone(),
                    server_url: st.server_url.clone(),
                    asset_token: asset_token.clone(),
                    created_at_ms: now_ms,
                };
                st.accounts.push(rec.clone());
                st.active_account_id = Some(account_id.clone());
                rec
            }
        };

        self.asset_vault
            .write()
            .tokens_by_account
            .insert(account_id, asset_token);
        self.save_state()?;

        let is_offline = self.state.read().offline_mode;
        if let Some(ref target_slot) = switch_to_new_slot {
            let client = self.rebuild_client_for_slot(target_slot)?;
            client.set_auth_session(auth.clone());
            if !is_offline {
                client.connect_ws();
            }
        } else if let Ok(client) = self.client() {
            client.set_auth_session(auth.clone());
            if !is_offline {
                client.connect_ws();
            }
        }

        Ok(slot_record)
    }

    pub fn verify_asset_token(&self, account_id: &str, token_candidate: &str) -> bool {
        let vault = self.asset_vault.read();
        vault
            .tokens_by_account
            .get(account_id)
            .is_some_and(|stored| stored == token_candidate && !token_candidate.is_empty())
    }

    fn passport_aead_key(&self) -> CoreResult<Key> {
        let master = b64_decode(&self.asset_vault.read().master_key_b64)?;
        let hk = Hkdf::<Sha256>::new(Some(b"ohos-passport-salt-v1"), &master);
        let mut okm = [0u8; 32];
        hk.expand(b"telegram-passport-at-rest", &mut okm)
            .map_err(|e| CoreDispatchError::internal(format!("HKDF expand failed: {e}")))?;
        Ok(*Key::from_slice(&okm))
    }

    pub fn load_passport_controller(&self) -> CoreResult<PassportFormController> {
        let snap = self.state.read().clone();
        if let (Some(ct_b64), Some(nonce_b64)) =
            (snap.passport_cipher_b64.as_ref(), snap.passport_nonce_b64.as_ref())
        {
            let ct = b64_decode(ct_b64)?;
            let nonce_bytes = b64_decode(nonce_b64)?;
            if nonce_bytes.len() != 12 {
                return Err(CoreDispatchError::internal("Corrupted passport AEAD nonce"));
            }
            let cipher = ChaCha20Poly1305::new(&self.passport_aead_key()?);
            let plaintext = cipher
                .decrypt(Nonce::from_slice(&nonce_bytes), ct.as_ref())
                .map_err(|_| {
                    CoreDispatchError::new(
                        "PASSPORT_DECRYPT_FAILED",
                        "Passport encrypted vault failed AEAD authentication",
                    )
                })?;
            let ctrl: PassportFormController = serde_json::from_slice(&plaintext)?;
            return Ok(ctrl);
        }
        Ok(PassportFormController::new(FormRequest {
            bot_id: 0,
            scope: String::new(),
            callback_url: String::new(),
            public_key: String::new(),
            nonce: String::new(),
        }))
    }

    pub fn save_passport_controller(&self, ctrl: &PassportFormController) -> CoreResult<()> {
        let plaintext = serde_json::to_vec(ctrl)?;
        let mut nonce_bytes = [0u8; 12];
        getrandom::getrandom(&mut nonce_bytes)
            .map_err(|e| CoreDispatchError::internal(format!("CSPRNG failed: {e}")))?;
        let cipher = ChaCha20Poly1305::new(&self.passport_aead_key()?);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
            .map_err(|_| CoreDispatchError::internal("Passport AEAD encryption failed"))?;
        self.with_state_mut(|st| {
            st.passport_cipher_b64 = Some(b64_encode(&ct));
            st.passport_nonce_b64 = Some(b64_encode(&nonce_bytes));
        })
    }

    pub fn encode_waveform_5bit_bytes(&self, pcm_i16_le: &[u8]) -> Vec<u8> {
        let samples = bytes_to_i16_le(pcm_i16_le);
        let mut packed = if samples.is_empty() {
            gpui_telegram_media::encode_waveform_5bit(&[0u8; 100])
        } else {
            gpui_telegram_media::waveform_from_pcm_i16(&samples).1
        };
        packed.resize(gpui_telegram_media::TELEGRAM_WAVEFORM_BYTES, 0);
        packed
    }

    pub fn decode_waveform_5bit_bars(&self, packed: &[u8], bar_count: usize) -> Vec<u8> {
        let mut bars = gpui_telegram_media::decode_waveform_5bit(packed);
        bars.resize(bar_count.clamp(1, 256), 0);
        bars
    }

    pub fn decode_waveform_5bit_floats(&self, packed: &[u8]) -> Vec<f64> {
        gpui_telegram_media::decode_waveform_to_floats(
            packed,
            gpui_telegram_media::TELEGRAM_WAVEFORM_BARS,
        )
        .into_iter()
        .map(|f| f as f64)
        .collect()
    }

    pub fn feed_voice_recorder_pcm(
        &self,
        session_id: &str,
        pcm_i16_le: &[u8],
        sample_rate: u32,
    ) -> CoreEnvelopeDto {
        let sr = sample_rate.max(8_000);
        let samples = bytes_to_i16_le(pcm_i16_le);
        let mut recorders = self.voice_recorders.lock();
        let rec = recorders
            .entry(session_id.to_string())
            .or_insert_with(|| gpui_telegram_media::VoiceRecorder::new(sr));
        rec.feed_external_pcm_i16(&samples);
        let upd = rec.poll_update();
        let duration_ms = ((upd.samples as i64) * 1_000) / (sr as i64);
        drop(recorders);
        let data = json!({
            "sessionId": session_id,
            "samples": upd.samples,
            "level": upd.level,
            "finished": upd.finished,
            "durationMs": duration_ms,
            "sampleRate": sr
        });
        CoreEnvelopeDto::ok_val(&data, self.generation())
    }

    pub fn stop_voice_recorder(&self, session_id: &str) -> CoreResult<Value> {
        let mut recorders = self.voice_recorders.lock();
        let mut rec = recorders
            .remove(session_id)
            .ok_or_else(|| CoreDispatchError::not_found(format!("Voice recorder session '{session_id}' not found")))?;
        drop(recorders);
        let note = rec
            .stop()
            .map_err(|e| CoreDispatchError::internal(format!("Failed stopping voice recorder: {e}")))?;
        let cfg = self.init_config();
        let out_dir = if !cfg.temp_dir.is_empty() {
            PathBuf::from(&cfg.temp_dir)
        } else {
            PathBuf::from(&cfg.cache_dir)
        };
        let _ = fs::create_dir_all(&out_dir);
        let wav_path = out_dir.join(format!("voice_{session_id}.wav"));
        fs::write(&wav_path, &note.wav_bytes)
            .map_err(|e| CoreDispatchError::internal(format!("Failed writing WAV '{wav_path:?}': {e}")))?;
        Ok(json!({
            "sessionId": session_id,
            "wavPath": wav_path.to_string_lossy(),
            "byteSize": note.wav_bytes.len(),
            "sampleRate": note.sample_rate,
            "durationMs": note.duration_ms,
            "waveformBars": note.waveform_bars,
            "waveformB64": b64_encode(&note.waveform_5bit)
        }))
    }

    pub fn upload_media_chunk_bytes(
        &self,
        upload_id: &str,
        part_index: u32,
        chunk_bytes: &[u8],
    ) -> CoreEnvelopeDto {
        let res: CoreResult<Value> = (|| {
            let client = self.client()?;
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let rt = Arc::clone(client.runtime());
            let bytes_vec = chunk_bytes.to_vec();
            let size = bytes_vec.len();
            if tokio::runtime::Handle::try_current().is_ok() {
                std::thread::scope(|s| {
                    s.spawn(|| {
                        rt.block_on(client.http_client.upload_chunk_part(
                            &token,
                            upload_id,
                            part_index,
                            bytes_vec,
                        ))
                    })
                    .join()
                    .map_err(|_| CoreDispatchError::internal("Chunk upload worker panicked"))?
                    .map_err(CoreDispatchError::from)
                })?;
            } else {
                rt.block_on(client.http_client.upload_chunk_part(
                    &token,
                    upload_id,
                    part_index,
                    bytes_vec,
                ))?;
            }
            let progress = json!({
                "uploadId": upload_id,
                "partIndex": part_index,
                "byteLength": size
            });
            self.emit_push("TransferProgress", progress.clone());
            Ok(progress)
        })();
        match res {
            Ok(val) => CoreEnvelopeDto::ok_val(&val, self.generation()),
            Err(err) => CoreEnvelopeDto::err_val(err, self.generation()),
        }
    }

    pub fn process_talk_vad_pcm(&self, pcm_i16_le: &[u8], sample_rate: u32) -> Value {
        let start = std::time::Instant::now();
        let samples = bytes_to_i16_le(pcm_i16_le);
        let sr = sample_rate.max(8_000);

        let mut sum_sq = 0.0f64;
        for &s in &samples {
            let norm = (s as f64) / 32768.0;
            sum_sq += norm * norm;
        }
        let rms_unit = if samples.is_empty() {
            0.0
        } else {
            (sum_sq / (samples.len() as f64)).sqrt()
        };
        let rms_db = if rms_unit <= 1e-9 {
            -96.0
        } else {
            (20.0 * rms_unit.log10()).clamp(-96.0, 0.0)
        };

        let mut talk = self.talk.lock();
        talk.media_tap.on_incoming_pcm_frame(&samples, sr, 1);
        let vad_triggered = talk.vad.process_pcm_frame(&samples);
        let tap_triggered = talk.media_tap.trigger_vad_barge_in();
        let should_abort = vad_triggered || tap_triggered;
        let speech_detected = talk.vad.consecutive_speech_frames > 0;
        let silence_completed = talk.vad.is_silence_detected();

        let flushed = if should_abort {
            talk.coordinator.handle_barge_in()
        } else {
            0
        };
        let state_str = serde_json::to_value(talk.coordinator.state)
            .ok()
            .and_then(|v| v.as_str().map(ToString::to_string))
            .unwrap_or_else(|| "idle".to_string());
        let consec = talk.vad.consecutive_speech_frames;
        let buffered = talk.coordinator.buffered_chunks_count();
        let total_flushed = talk.coordinator.total_flushed_chunks;
        drop(talk);

        let _ = self.with_state_mut(|st| {
            st.talk_meta["state"] = Value::String(state_str.clone());
            st.talk_meta["bufferedChunks"] = json!(buffered);
            st.talk_meta["flushedChunks"] = json!(total_flushed);
        });

        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        let out = json!({
            "speechDetected": speech_detected,
            "rmsDb": (rms_db * 100.0).round() / 100.0,
            "consecutiveSpeechFrames": consec,
            "shouldAbortPlayback": should_abort,
            "flushedChunks": flushed,
            "silenceCompleted": silence_completed,
            "talkState": state_str,
            "latencyMs": (elapsed_ms * 1000.0).round() / 1000.0
        });
        if should_abort {
            self.emit_push("TalkVadBargeIn", out.clone());
        }
        out
    }

    pub fn process_talk_vad_envelope(&self, pcm_i16_le: &[u8], sample_rate: u32) -> CoreEnvelopeDto {
        let out = self.process_talk_vad_pcm(pcm_i16_le, sample_rate);
        CoreEnvelopeDto::ok_val(&out, self.generation())
    }

    pub fn invoke_domain(
        &self,
        domain: &str,
        action: &str,
        payload_json: &str,
    ) -> CoreResult<Value> {
        let payload = parse_payload(payload_json)?;

        if self.state.read().locked && !Self::is_allowed_when_locked(domain, action) {
            return Err(CoreDispatchError::passcode_locked());
        }

        let client = self.client()?;
        let rt = Arc::clone(client.runtime());

        if tokio::runtime::Handle::try_current().is_ok() {
            std::thread::scope(|s| {
                s.spawn(|| rt.block_on(domains::dispatch_async(self, domain, action, &payload)))
                    .join()
                    .map_err(|_| CoreDispatchError::internal("Domain worker thread panicked"))?
            })
        } else {
            rt.block_on(domains::dispatch_async(self, domain, action, &payload))
        }
    }

    pub async fn invoke_domain_async(
        &self,
        domain: &str,
        action: &str,
        payload_json: &str,
    ) -> CoreResult<Value> {
        let payload = parse_payload(payload_json)?;
        if self.state.read().locked && !Self::is_allowed_when_locked(domain, action) {
            return Err(CoreDispatchError::passcode_locked());
        }
        domains::dispatch_async(self, domain, action, &payload).await
    }

    fn is_allowed_when_locked(domain: &str, action: &str) -> bool {
        let (norm_domain, norm_action) = domains::normalize_domain_and_action(domain, action);
        matches!(
            (norm_domain.as_str(), norm_action.as_str()),
            ("sessions", "unlockApp")
                | ("sessions", "passcodeStatus")
                | ("sessions", "listAccounts")
                | ("sessions", "checkGenerationFence")
                | ("sessions", "verifyAssetToken")
                | ("auth", "checkHealth")
        )
    }

    pub fn invoke_envelope(&self, domain: &str, action: &str, payload_json: &str) -> CoreEnvelopeDto {
        match self.invoke_domain(domain, action, payload_json) {
            Ok(val) => CoreEnvelopeDto::ok_val(&val, self.generation()),
            Err(err) => CoreEnvelopeDto::err_val(err, self.generation()),
        }
    }

    pub fn invoke_envelope_json(
        &self,
        domain: &str,
        action: &str,
        payload_json: &str,
    ) -> String {
        serde_json::to_string(&self.invoke_envelope(domain, action, payload_json)).unwrap_or_default()
    }
}

pub fn bytes_to_i16_le(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}
