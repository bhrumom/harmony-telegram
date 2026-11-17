//! `telegram_ohos_napi` (`libtelegram_core.so`):
//! Production OpenHarmony N-API (`napi-ohos`) + Portable Rust Engine (`TelegramCoreEngine`)
//! unifying all 28 `harmony-telegram` client, E2EE, WebRTC/VAD, MiniApp, Fabushi, Hermes,
//! Magpie, Computer-Use, and Tailnet domains (`PROJECT.md § 4.1`).

pub mod domains;
pub mod engine;
pub mod helpers;
pub mod rtc_media;
pub mod ui_head;
pub mod updater;

pub use domains::ALL_28_DOMAINS;
pub use engine::{CoreEnvelopeDto, CorePushEventDto, EngineInitConfig, TelegramCoreEngine};

// ============================================================================
// OpenHarmony N-API Bindings (`target_env = "ohos"` -> `libtelegram_core.so`)
// ============================================================================
#[cfg(target_env = "ohos")]
mod ohos_napi_bindings {
    use std::sync::{Arc, OnceLock};

    use napi_derive_ohos::napi;
    use napi_ohos::bindgen_prelude::{AsyncTask, Result, Task, Uint8Array};
    use napi_ohos::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
    use napi_ohos::{Env, Status};

    use crate::engine::{CoreEnvelopeDto, CorePushEventDto, EngineInitConfig, TelegramCoreEngine};

    fn global_engine() -> &'static Arc<TelegramCoreEngine> {
        static ENGINE: OnceLock<Arc<TelegramCoreEngine>> = OnceLock::new();
        ENGINE.get_or_init(|| Arc::new(TelegramCoreEngine::new()))
    }

    fn dto_to_envelope(dto: CoreEnvelopeDto) -> CoreResponseEnvelope {
        CoreResponseEnvelope {
            ok: dto.ok,
            data_json: dto.data_json,
            error_code: dto.error_code,
            error_message: dto.error_message,
            generation: dto.generation,
        }
    }

    #[napi(object)]
    #[derive(Debug, Clone)]
    pub struct SandboxInitConfig {
        pub files_dir: String,
        pub cache_dir: String,
        pub temp_dir: String,
        pub database_dir: String,
        pub resource_dir: String,
        pub ca_cert_path: String,
        pub default_server_url: String,
    }

    #[napi(object)]
    #[derive(Debug, Clone)]
    pub struct CoreResponseEnvelope {
        pub ok: bool,
        pub data_json: String,
        pub error_code: String,
        pub error_message: String,
        pub generation: u32,
    }

    pub struct InitCoreTask {
        engine: Arc<TelegramCoreEngine>,
        cfg: EngineInitConfig,
    }

    #[napi]
    impl Task for InitCoreTask {
        type Output = CoreEnvelopeDto;
        type JsValue = CoreResponseEnvelope;

        fn compute(&mut self) -> Result<Self::Output> {
            let dto = match self.engine.init(self.cfg.clone()) {
                Ok(val) => CoreEnvelopeDto::ok_val(&val, self.engine.generation()),
                Err(err) => CoreEnvelopeDto::err_val(err, self.engine.generation()),
            };
            Ok(dto)
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
            Ok(dto_to_envelope(output))
        }
    }

    pub struct ShutdownCoreTask {
        engine: Arc<TelegramCoreEngine>,
    }

    #[napi]
    impl Task for ShutdownCoreTask {
        type Output = bool;
        type JsValue = bool;

        fn compute(&mut self) -> Result<Self::Output> {
            Ok(self.engine.shutdown().is_ok())
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
            Ok(output)
        }
    }

    pub struct InvokeActionTask {
        engine: Arc<TelegramCoreEngine>,
        domain: String,
        action: String,
        payload_json: String,
    }

    #[napi]
    impl Task for InvokeActionTask {
        type Output = CoreEnvelopeDto;
        type JsValue = CoreResponseEnvelope;

        fn compute(&mut self) -> Result<Self::Output> {
            Ok(self
                .engine
                .invoke_envelope(&self.domain, &self.action, &self.payload_json))
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
            Ok(dto_to_envelope(output))
        }
    }

    pub struct FeedVoiceRecorderTask {
        engine: Arc<TelegramCoreEngine>,
        session_id: String,
        pcm_bytes: Vec<u8>,
        sample_rate: u32,
    }

    #[napi]
    impl Task for FeedVoiceRecorderTask {
        type Output = CoreEnvelopeDto;
        type JsValue = CoreResponseEnvelope;

        fn compute(&mut self) -> Result<Self::Output> {
            Ok(self.engine.feed_voice_recorder_pcm(
                &self.session_id,
                &self.pcm_bytes,
                self.sample_rate,
            ))
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
            Ok(dto_to_envelope(output))
        }
    }

    pub struct UploadMediaChunkTask {
        engine: Arc<TelegramCoreEngine>,
        upload_id: String,
        part_index: u32,
        chunk_bytes: Vec<u8>,
    }

    #[napi]
    impl Task for UploadMediaChunkTask {
        type Output = CoreEnvelopeDto;
        type JsValue = CoreResponseEnvelope;

        fn compute(&mut self) -> Result<Self::Output> {
            Ok(self
                .engine
                .upload_media_chunk_bytes(&self.upload_id, self.part_index, &self.chunk_bytes))
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
            Ok(dto_to_envelope(output))
        }
    }

    #[napi(js_name = "initCore")]
    pub fn init_core(config: SandboxInitConfig) -> AsyncTask<InitCoreTask> {
        let cfg = EngineInitConfig {
            server_url: config.default_server_url,
            files_dir: config.files_dir,
            cache_dir: config.cache_dir,
            temp_dir: config.temp_dir,
            database_dir: config.database_dir,
            resource_dir: config.resource_dir,
            ca_cert_path: config.ca_cert_path,
            ..EngineInitConfig::default()
        };
        AsyncTask::new(InitCoreTask {
            engine: Arc::clone(global_engine()),
            cfg,
        })
    }

    #[napi(js_name = "shutdownCore")]
    pub fn shutdown_core() -> AsyncTask<ShutdownCoreTask> {
        AsyncTask::new(ShutdownCoreTask {
            engine: Arc::clone(global_engine()),
        })
    }

    #[napi(js_name = "invokeAction")]
    pub fn invoke_action(
        domain: String,
        action: String,
        payload_json: String,
    ) -> AsyncTask<InvokeActionTask> {
        AsyncTask::new(InvokeActionTask {
            engine: Arc::clone(global_engine()),
            domain,
            action,
            payload_json,
        })
    }

    #[napi(
        js_name = "subscribeDomainEvents",
        ts_args_type = "callback: (eventJson: string) => void"
    )]
    pub fn subscribe_domain_events(
        callback: ThreadsafeFunction<String, (), String, Status, false>,
    ) -> bool {
        let tsfn = Arc::new(callback);
        global_engine().set_event_sink(Arc::new(move |ev: CorePushEventDto| {
            let _ = tsfn.call(ev.payload_json, ThreadsafeFunctionCallMode::NonBlocking);
        }));
        true
    }

    #[napi(js_name = "encodeWaveform5Bit")]
    pub fn encode_waveform_5bit(pcm_i16_bytes: Uint8Array) -> Uint8Array {
        Uint8Array::new(global_engine().encode_waveform_5bit_bytes(pcm_i16_bytes.as_ref()))
    }

    #[napi(js_name = "decodeWaveform5Bit")]
    pub fn decode_waveform_5bit(packed63_bytes: Uint8Array) -> Vec<f64> {
        global_engine().decode_waveform_5bit_floats(packed63_bytes.as_ref())
    }

    #[napi(js_name = "feedVoiceRecorderPcm")]
    pub fn feed_voice_recorder_pcm(
        session_id: String,
        pcm_i16_bytes: Uint8Array,
        sample_rate: u32,
    ) -> AsyncTask<FeedVoiceRecorderTask> {
        AsyncTask::new(FeedVoiceRecorderTask {
            engine: Arc::clone(global_engine()),
            session_id,
            pcm_bytes: pcm_i16_bytes.to_vec(),
            sample_rate,
        })
    }

    #[napi(js_name = "processTalkVadFrame")]
    pub fn process_talk_vad_frame(
        pcm_i16_bytes: Uint8Array,
        sample_rate: u32,
    ) -> CoreResponseEnvelope {
        dto_to_envelope(global_engine().process_talk_vad_envelope(pcm_i16_bytes.as_ref(), sample_rate))
    }

    #[napi(js_name = "uploadMediaChunk")]
    pub fn upload_media_chunk(
        upload_id: String,
        part_index: u32,
        chunk_bytes: Uint8Array,
    ) -> AsyncTask<UploadMediaChunkTask> {
        AsyncTask::new(UploadMediaChunkTask {
            engine: Arc::clone(global_engine()),
            upload_id,
            part_index,
            chunk_bytes: chunk_bytes.to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn verify_28_domain_registry_count_and_waveform_vad_roundtrip() {
        assert_eq!(ALL_28_DOMAINS.len(), 28);
        let engine = TelegramCoreEngine::new();

        // 1. 100-bar 5-bit waveform packing -> 63 bytes & 100 floats (0.0..=1.0)
        let mut pcm_bytes = Vec::with_capacity(48_000 * 2);
        for i in 0..48_000usize {
            let sample = ((i as f64 * 0.05).sin() * 20_000.0) as i16;
            pcm_bytes.extend_from_slice(&sample.to_le_bytes());
        }
        let packed = engine.encode_waveform_5bit_bytes(&pcm_bytes);
        assert_eq!(packed.len(), 63);
        let floats = engine.decode_waveform_5bit_floats(&packed);
        assert_eq!(floats.len(), 100);
        assert!(floats.iter().any(|&v| v > 0.25 && v <= 1.0));

        // 2. <60ms VAD barge-in flushing buffered TTS chunks
        {
            let mut talk = engine.talk.lock();
            for _ in 0..4 {
                let _ = talk.coordinator.enqueue_audio(vec![1u8; 640]);
            }
        }
        let mut loud_frame = Vec::with_capacity(960 * 2);
        for _ in 0..960 {
            loud_frame.extend_from_slice(&14_000i16.to_le_bytes());
        }
        let mut aborted = false;
        for _ in 0..3 {
            let env = engine.process_talk_vad_envelope(&loud_frame, 48_000);
            assert!(env.ok);
            let vad: serde_json::Value = serde_json::from_str(&env.data_json).unwrap();
            let lat = vad["latencyMs"].as_f64().unwrap_or(999.0);
            assert!(lat < 60.0, "VAD frame exceeded 60ms budget: {lat}ms");
            if vad["shouldAbortPlayback"].as_bool() == Some(true) {
                aborted = true;
            }
        }
        assert!(aborted, "3 consecutive active frames must trigger VAD barge-in");
    }

    #[test]
    fn verify_passcode_lock_boundary_and_passport_encryption_at_rest() {
        let base = std::env::temp_dir().join(format!("ohos_napi_unit_{}", uuid::Uuid::new_v4()));
        let cfg = EngineInitConfig {
            server_url: "http://127.0.0.1:19999".to_string(),
            files_dir: base.join("files").to_string_lossy().to_string(),
            cache_dir: base.join("cache").to_string_lossy().to_string(),
            temp_dir: base.join("temp").to_string_lossy().to_string(),
            database_dir: base.join("db").to_string_lossy().to_string(),
            ..EngineInitConfig::default()
        };
        let engine = TelegramCoreEngine::new();
        engine.init(cfg.clone()).expect("init succeeds");

        // Feed & stop VoiceRecorder session
        let mut pcm = Vec::with_capacity(4800 * 2);
        for i in 0..4800usize {
            let s = ((i as f64 * 0.1).sin() * 12_000.0) as i16;
            pcm.extend_from_slice(&s.to_le_bytes());
        }
        let feed_env = engine.feed_voice_recorder_pcm("unit_rec_1", &pcm, 48_000);
        assert!(feed_env.ok);
        let note = engine
            .invoke_domain("media", "stop_voice_recorder", &json!({"sessionId": "unit_rec_1"}).to_string())
            .expect("stop_voice_recorder");
        assert!(note["byteSize"].as_u64().unwrap_or(0) > 44);

        // Save sensitive passport document and ensure plaintext never appears in persisted JSON
        let _ = engine
            .invoke_domain(
                "passport",
                "savePassportDocument",
                &json!({
                    "type": "passport",
                    "fields": { "document_number": "SECRET-DOC-998877", "full_name": "Alice Doe" }
                })
                .to_string(),
            )
            .expect("savePassportDocument");

        let raw_disk =
            std::fs::read_to_string(std::path::Path::new(&cfg.files_dir).join("ohos_core_state.json"))
                .expect("state file exists");
        assert!(
            !raw_disk.contains("SECRET-DOC-998877"),
            "Passport document number must be encrypted at rest"
        );

        // Enable Argon2id passcode lock and lock app
        engine
            .invoke_domain(
                "sessions",
                "set_passcode",
                &json!({ "passcode": "246810", "autoLockSeconds": 60 }).to_string(),
            )
            .expect("set_passcode");
        engine
            .invoke_domain("sessions", "lock_app", "{}")
            .expect("lock_app");

        let blocked = engine.invoke_domain("passport", "getPassportVault", "{}");
        assert!(blocked.is_err());
        assert_eq!(blocked.unwrap_err().code, "PASSCODE_LOCKED");

        let bad_unlock = engine.invoke_domain(
            "sessions",
            "verify_passcode",
            &json!({ "passcode": "000000" }).to_string(),
        );
        assert!(bad_unlock.is_err());

        engine
            .invoke_domain(
                "sessions",
                "verify_passcode",
                &json!({ "passcode": "246810" }).to_string(),
            )
            .expect("verify_passcode succeeds");

        let docs = engine
            .invoke_domain("passport", "getPassportVault", "{}")
            .expect("vault accessible after unlock");
        assert_eq!(docs["count"], 1);

        let _ = std::fs::remove_dir_all(&base);
    }
}
