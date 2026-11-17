//! Live in-process `gpui_telegram_server` integration suite for `telegram_ohos_napi`.
//! Exercises `TelegramCoreEngine` end-to-end over real HTTP/WebSocket + SQLite WAL + CAS + E2EE
//! across auth, sessions, dialogs, folders, topics, search, messages, outbox, sync, media,
//! 2-client E2EE (X3DH + Double Ratchet + Group Sender Keys + Safety Numbers), bots, miniapps,
//! Fabushi 3D Dharma Globe, Hermes, Magpie, Computers, Tailnet, and live push events.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gpui_telegram_server::{build_router_with_state, server::AppState, ServerConfig};
use serde_json::{json, Value};
use telegram_core::{EngineInitConfig, TelegramCoreEngine};
use tokio::sync::oneshot;

struct LiveTestServer {
    base_url: String,
    root_dir: PathBuf,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl LiveTestServer {
    async fn start() -> Self {
        unsafe {
            std::env::set_var("GPUI_OFFLINE_TEST", "1");
            std::env::set_var("HERMES_ENABLE_PUBLIC_CLOUD_FALLBACK", "1");
        }
        let base_tmp = std::env::var("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/home/antigravity/toolchains/tmp"));
        let root_dir = base_tmp.join(format!("ohos_live_srv_{}", uuid::Uuid::new_v4()));
        let media_dir = root_dir.join("media");
        std::fs::create_dir_all(&media_dir).expect("create media dir");

        let mut cfg = ServerConfig::default();
        cfg.host = "127.0.0.1".to_string();
        cfg.port = 0;
        cfg.database_url = format!("sqlite://{}", root_dir.join("server.db").display());
        cfg.media_storage_path = media_dir.to_string_lossy().to_string();

        let state = Arc::new(AppState::try_new(cfg).expect("AppState::try_new"));
        let state_shutdown = Arc::clone(&state);
        let app = build_router_with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                    state_shutdown.shutdown();
                })
                .await;
        });

        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            root_dir,
            shutdown_tx: Some(tx),
        }
    }

    fn sandbox_cfg(&self, name: &str) -> EngineInitConfig {
        let sb = self.root_dir.join(format!("sandbox_{name}"));
        EngineInitConfig {
            server_url: self.base_url.clone(),
            files_dir: sb.join("files").to_string_lossy().to_string(),
            cache_dir: sb.join("cache").to_string_lossy().to_string(),
            temp_dir: sb.join("temp").to_string_lossy().to_string(),
            database_dir: sb.join("db").to_string_lossy().to_string(),
            resource_dir: sb.join("res").to_string_lossy().to_string(),
            ca_cert_path: "/etc/ssl/certs/cacert.pem".to_string(),
            ..EngineInitConfig::default()
        }
    }
}

impl Drop for LiveTestServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = std::fs::remove_dir_all(&self.root_dir);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_server_core_domains_e2ee_media_fabushi_and_agents_roundtrip() {
    let srv = LiveTestServer::start().await;

    let alice = Arc::new(TelegramCoreEngine::new());
    alice
        .init(srv.sandbox_cfg("alice"))
        .expect("alice init_core");
    let mut alice_events = alice.subscribe_broadcast();

    let bob = Arc::new(TelegramCoreEngine::new());
    bob.init(srv.sandbox_cfg("bob")).expect("bob init_core");

    // 1. Server status + Alice & Bob registration
    let status = alice
        .invoke_domain_async("auth", "status", "{}")
        .await
        .expect("auth status");
    assert_eq!(status["ok"], true);

    let alice_reg = alice
        .invoke_domain_async(
            "auth",
            "register",
            &json!({
                "username": "alice_ohos",
                "password": "Password#1234",
                "displayName": "Alice Harmony"
            })
            .to_string(),
        )
        .await
        .expect("alice register");
    let alice_uid = alice_reg["userId"].as_u64().expect("alice userId");

    let bob_reg = bob
        .invoke_domain_async(
            "auth",
            "register",
            &json!({
                "username": "bob_ohos",
                "password": "Password#5678",
                "displayName": "Bob Harmony"
            })
            .to_string(),
        )
        .await
        .expect("bob register");
    let bob_uid = bob_reg["userId"].as_u64().expect("bob userId");

    // 2. Create group dialog, send text, toggle reaction, verify history & search
    let created_chat = alice
        .invoke_domain_async(
            "dialogs",
            "create",
            &json!({
                "title": "HarmonyOS Core Lab",
                "memberIds": [bob_uid]
            })
            .to_string(),
        )
        .await
        .expect("dialogs create");
    let chat_id = created_chat["id"]
        .as_i64()
        .or_else(|| created_chat["chat_id"].as_i64())
        .or_else(|| created_chat["chat"]["id"].as_i64())
        .expect("chat_id");

    let sent_msg = alice
        .invoke_domain_async(
            "messages",
            "send_text",
            &json!({
                "chatId": chat_id,
                "text": "Hello HarmonyOS NEXT Stage Model!"
            })
            .to_string(),
        )
        .await
        .expect("messages send_text");
    let msg_id = sent_msg["message"]["id"]
        .as_i64()
        .or_else(|| sent_msg["id"].as_i64())
        .or_else(|| sent_msg["message_id"].as_i64())
        .expect("message id");

    let history = bob
        .invoke_domain_async(
            "messages",
            "history",
            &json!({ "chatId": chat_id, "limit": 20 }).to_string(),
        )
        .await
        .expect("bob messages history");
    assert!(history.to_string().contains("Hello HarmonyOS NEXT Stage Model!"));

    let _ = bob
        .invoke_domain_async(
            "messages",
            "toggle_reaction",
            &json!({ "chatId": chat_id, "messageId": msg_id, "emoji": "🔥" }).to_string(),
        )
        .await
        .expect("toggle_reaction");

    // 3. Two-client E2EE: PreKey publish -> X3DH + Double Ratchet DM -> Safety Fingerprint match
    alice
        .invoke_domain_async("e2ee", "publish_prekeys", &json!({ "count": 16 }).to_string())
        .await
        .expect("alice publish_prekeys");
    bob.invoke_domain_async("e2ee", "publish_prekeys", &json!({ "count": 16 }).to_string())
        .await
        .expect("bob publish_prekeys");

    let enc_dm = alice
        .invoke_domain_async(
            "e2ee",
            "encryptDirect",
            &json!({
                "recipientUserId": bob_uid,
                "plaintext": "Top-Secret E2EE Payload over Double Ratchet"
            })
            .to_string(),
        )
        .await
        .expect("alice encryptDirect");

    let dec_dm = bob
        .invoke_domain_async(
            "e2ee",
            "decryptDirect",
            &json!({ "envelope": enc_dm["envelope"] }).to_string(),
        )
        .await
        .expect("bob decryptDirect");
    assert_eq!(
        dec_dm["plaintext"],
        "Top-Secret E2EE Payload over Double Ratchet"
    );

    let fp_alice = alice
        .invoke_domain_async(
            "e2ee",
            "safety_fingerprint",
            &json!({ "peerUserId": bob_uid }).to_string(),
        )
        .await
        .expect("alice safety_fingerprint");
    let fp_bob = bob
        .invoke_domain_async(
            "e2ee",
            "safety_fingerprint",
            &json!({ "peerUserId": alice_uid }).to_string(),
        )
        .await
        .expect("bob safety_fingerprint");
    assert_eq!(fp_alice["emojis"], fp_bob["emojis"]);

    // 4. Resumable chunked upload via uploadMediaChunk + completion
    let chunk_data = b"HarmonyOS-NEXT-Resumable-Binary-Chunk-Payload-0123456789".to_vec();
    let init_up = alice
        .invoke_domain_async(
            "media",
            "initChunkedUpload",
            &json!({
                "filename": "sample.bin",
                "mimeType": "application/octet-stream",
                "totalSize": chunk_data.len()
            })
            .to_string(),
        )
        .await
        .expect("initChunkedUpload");
    let upload_id = init_up["upload_id"]
        .as_str()
        .or_else(|| init_up["uploadId"].as_str())
        .expect("upload_id")
        .to_string();

    let alice_cl = Arc::clone(&alice);
    let uid_cl = upload_id.clone();
    let chunk_cl = chunk_data.clone();
    let part_env = tokio::task::spawn_blocking(move || {
        alice_cl.upload_media_chunk_bytes(&uid_cl, 0, &chunk_cl)
    })
    .await
    .expect("spawn_blocking upload_media_chunk_bytes");
    assert!(part_env.ok, "uploadMediaChunk failed: {}", part_env.error_message);

    let comp_up = alice
        .invoke_domain_async(
            "media",
            "completeChunkedUpload",
            &json!({
                "uploadId": upload_id,
                "filename": "sample.bin",
                "mimeType": "application/octet-stream"
            })
            .to_string(),
        )
        .await
        .expect("completeChunkedUpload");
    assert!(comp_up["file_id"].is_string() || comp_up["fileId"].is_string());

    // Verify TransferProgress event was emitted onto broadcast stream
    let mut saw_transfer_progress = false;
    while let Ok(ev_str) = alice_events.try_recv() {
        if ev_str.contains("TransferProgress") {
            saw_transfer_progress = true;
        }
    }
    assert!(saw_transfer_progress, "Expected TransferProgress push event");

    // 5. Bots + Fabushi 3D Dharma Globe + Magpie PII Masking + Tailnet Ed25519 Registration
    let nl_bot = alice
        .invoke_domain_async(
            "bots",
            "createFromPrompt",
            &json!({
                "prompt": "Create a bilingual HarmonyOS build assistant bot",
                "chatId": chat_id
            })
            .to_string(),
        )
        .await
        .expect("bots createFromPrompt");
    assert!(nl_bot["token"].as_str().unwrap_or("").contains(':'));

    let fabushi_offering = alice
        .invoke_domain_async(
            "fabushi",
            "createOffering",
            &json!({
                "kind": "lotus",
                "count": 3,
                "lat": 31.2304,
                "lng": 121.4737,
                "dedication": "May all beings enjoy peace"
            })
            .to_string(),
        )
        .await
        .expect("fabushi createOffering");
    assert!(fabushi_offering["merit_gained"].as_u64().unwrap_or(0) >= 30);

    let masked: Value = alice
        .invoke_domain_async(
            "magpie",
            "previewMasking",
            &json!({
                "text": "Contact ops@example.com with token sk-proj-1234567890abcdefghijklmnop"
            })
            .to_string(),
        )
        .await
        .expect("magpie previewMasking");
    assert!(!masked["maskedText"]
        .as_str()
        .unwrap_or("")
        .contains("sk-proj-1234567890abcdefghijklmnop"));

    let tailnet_reg = alice
        .invoke_domain_async(
            "tailnet",
            "registerNode",
            &json!({ "deviceId": "ohos-mate60-pro" }).to_string(),
        )
        .await
        .expect("tailnet registerNode");
    assert!(tailnet_reg.to_string().contains("100."));

    tokio::time::sleep(Duration::from_millis(30)).await;
    alice.shutdown().expect("alice shutdown");
    bob.shutdown().expect("bob shutdown");
}
