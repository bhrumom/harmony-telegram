//! Cross-target RTC SFU & `<60ms` VAD Media Tap bridge.
//! On host targets (`not(target_env = "ohos")`), re-exports `gpui_telegram_webrtc` directly.
//! On `target_env = "ohos"` (OpenHarmony musl NDK, where `@kit.AudioKit` & `@kit.CameraKit`
//! drive hardware capture and `webrtc-util v0.9 -> nix v0.26.4` lacks `target_env = "ohos"`),
//! provides the identical pure-Rust `DefaultAiMediaTap` and `SfuBridge` implementations.

#[cfg(not(target_env = "ohos"))]
pub use gpui_telegram_webrtc::media::{AiMediaTap, DefaultAiMediaTap};
#[cfg(not(target_env = "ohos"))]
pub use gpui_telegram_webrtc::{SfuAudioFrame, SfuBridge};

#[cfg(target_env = "ohos")]
mod ohos_pure_rtc {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;

    use gpui_telegram_core::types::{ChatId, UserId};
    use tokio::sync::{broadcast, Notify};

    pub trait AiMediaTap: Send + Sync {
        fn on_incoming_pcm_frame(&self, samples: &[i16], sample_rate: u32, channels: u16);
        fn reset_barge_in(&self);
        fn trigger_vad_barge_in(&self) -> bool;
    }

    pub struct DefaultAiMediaTap {
        vad_energy_threshold: f32,
        required_consecutive_frames: u32,
        consecutive_active_frames: AtomicU32,
        barge_in_triggered: AtomicBool,
        barge_in_notify: Arc<Notify>,
    }

    impl DefaultAiMediaTap {
        pub fn new(_sample_rate: u32, _channels: u16, vad_threshold: f32) -> Self {
            let safe_threshold = if vad_threshold.is_nan() {
                0.05
            } else {
                vad_threshold.clamp(0.001, 1.0)
            };
            Self {
                vad_energy_threshold: safe_threshold,
                required_consecutive_frames: 3, // 3 * 20ms = 60ms max latency
                consecutive_active_frames: AtomicU32::new(0),
                barge_in_triggered: AtomicBool::new(false),
                barge_in_notify: Arc::new(Notify::new()),
            }
        }

        pub fn on_incoming_pcm_frame(&self, samples: &[i16], _sample_rate: u32, _channels: u16) {
            if samples.is_empty() {
                return;
            }
            let sum_sq: f64 = samples
                .iter()
                .map(|&s| {
                    let norm = (s as f64) / 32768.0;
                    norm * norm
                })
                .sum();
            let rms = (sum_sq / (samples.len() as f64)).sqrt() as f32;
            if rms >= self.vad_energy_threshold {
                let prev = self.consecutive_active_frames.fetch_add(1, Ordering::SeqCst);
                if prev + 1 >= self.required_consecutive_frames
                    && !self.barge_in_triggered.swap(true, Ordering::SeqCst)
                {
                    self.barge_in_notify.notify_waiters();
                }
            } else {
                self.consecutive_active_frames.store(0, Ordering::SeqCst);
            }
        }

        pub fn reset_barge_in(&self) {
            self.consecutive_active_frames.store(0, Ordering::SeqCst);
            self.barge_in_triggered.store(false, Ordering::SeqCst);
        }

        pub fn trigger_vad_barge_in(&self) -> bool {
            self.barge_in_triggered.load(Ordering::SeqCst)
        }
    }

    impl AiMediaTap for DefaultAiMediaTap {
        fn on_incoming_pcm_frame(&self, samples: &[i16], sample_rate: u32, channels: u16) {
            DefaultAiMediaTap::on_incoming_pcm_frame(self, samples, sample_rate, channels);
        }

        fn reset_barge_in(&self) {
            DefaultAiMediaTap::reset_barge_in(self);
        }

        fn trigger_vad_barge_in(&self) -> bool {
            DefaultAiMediaTap::trigger_vad_barge_in(self)
        }
    }

    #[derive(Clone, Debug)]
    pub struct SfuAudioFrame {
        pub chat_id: ChatId,
        pub sender_id: UserId,
        pub pcm: Vec<i16>,
        pub sample_rate: u32,
        pub channels: u16,
    }

    #[derive(Default)]
    pub struct SfuBridge {
        pub room_subscribers: HashMap<ChatId, Vec<UserId>>,
        room_audio_channels: HashMap<ChatId, broadcast::Sender<SfuAudioFrame>>,
    }

    impl SfuBridge {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn join_room(&mut self, chat_id: ChatId, user_id: UserId) {
            let subs = self.room_subscribers.entry(chat_id).or_default();
            if !subs.contains(&user_id) {
                subs.push(user_id);
            }
        }

        pub fn get_subscribers(&self, chat_id: ChatId) -> &[UserId] {
            self.room_subscribers
                .get(&chat_id)
                .map(|v| v.as_slice())
                .unwrap_or(&[])
        }

        pub fn subscribe_room_audio(&mut self, chat_id: ChatId) -> broadcast::Receiver<SfuAudioFrame> {
            let tx = self
                .room_audio_channels
                .entry(chat_id)
                .or_insert_with(|| broadcast::channel(64).0);
            tx.subscribe()
        }

        pub fn route_incoming_pcm(
            &self,
            chat_id: ChatId,
            sender_id: UserId,
            pcm: &[i16],
            sample_rate: u32,
            channels: u16,
        ) {
            if let Some(tx) = self.room_audio_channels.get(&chat_id) {
                let _ = tx.send(SfuAudioFrame {
                    chat_id,
                    sender_id,
                    pcm: pcm.to_vec(),
                    sample_rate,
                    channels,
                });
            }
        }
    }
}

#[cfg(target_env = "ohos")]
pub use ohos_pure_rtc::{AiMediaTap, DefaultAiMediaTap, SfuAudioFrame, SfuBridge};
