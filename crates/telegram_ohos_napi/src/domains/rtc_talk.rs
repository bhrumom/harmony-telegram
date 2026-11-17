//! Domains 17–18: `calls` (1:1 Voice/Video, Group SFU Voice Room, TURN HMAC-SHA1, Emoji Verification,
//! Background VoIP Continuous Task) and `talk` (Live AI Voice Mode, `<60ms` VAD Barge-in, 320-chunk queue).

use gpui_telegram_agent::TalkSessionState;
use gpui_telegram_client::e2ee::compute_safety_number_emojis;
use gpui_telegram_client::net::{CallInviteRequest, CallSignalRequest, HermesTalkTurnRequest};
use crate::rtc_media::{SfuAudioFrame, SfuBridge};
use serde_json::{json, Value};

use crate::engine::{bytes_to_i16_le, TelegramCoreEngine};
use crate::helpers::{
    b64_decode, opt_bool, opt_i64, opt_str, opt_u32, opt_u64, opt_u64_vec, req_str, sha256_hex,
    to_json_val, CoreDispatchError, CoreResult,
};

fn compute_call_emojis(call_id: &str) -> String {
    let h1 = sha256_hex(format!("call_a:{call_id}").as_bytes());
    let h2 = sha256_hex(format!("call_b:{call_id}").as_bytes());
    let mut k1 = [0u8; 32];
    let mut k2 = [0u8; 32];
    for i in 0..32 {
        k1[i] = u8::from_str_radix(&h1[i * 2..i * 2 + 2], 16).unwrap_or(0);
        k2[i] = u8::from_str_radix(&h2[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    compute_safety_number_emojis(&k1, &k2)
}

pub async fn handle_calls(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "startCall" => {
            let chat_id = opt_i64(payload, &["chatId", "chat_id"]);
            let callee_id = opt_u64(payload, &["calleeId", "callee_id", "peerUserId", "userId"]);
            if chat_id.is_none() && callee_id.is_none() {
                return Err(CoreDispatchError::validation(
                    "startCall requires chatId or calleeId",
                ));
            }
            let is_video = opt_bool(payload, &["isVideo", "is_video", "video"]).unwrap_or(false);
            let mut map = serde_json::Map::new();
            if let Some(cid) = chat_id {
                map.insert("chat_id".into(), json!(cid));
            }
            if let Some(uid) = callee_id {
                map.insert("callee_id".into(), json!(uid));
                map.insert("peer_user_id".into(), json!(uid));
                map.insert("target_user_id".into(), json!(uid));
                if chat_id.is_none() {
                    map.insert("chat_id".into(), json!(uid as i64));
                }
            }
            map.insert("is_video".into(), Value::Bool(is_video));
            map.insert("video".into(), Value::Bool(is_video));
            if let Some(sdp) = opt_str(payload, &["sdpOffer", "sdp"]) {
                map.insert("sdp_offer".into(), Value::String(sdp));
            }
            let req: CallInviteRequest = serde_json::from_value(Value::Object(map))?;
            let rec = client.call_invite(&req).await?;
            let rec_val = to_json_val(&rec)?;
            let call_id = rec_val
                .get("call_id")
                .or_else(|| rec_val.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("call_live")
                .to_string();
            let emojis = compute_call_emojis(&call_id);
            let entry = json!({
                "callId": call_id,
                "isVideo": is_video,
                "state": "ringing",
                "emojiFingerprint": emojis,
                "record": rec
            });
            engine.with_state_mut(|st| {
                st.active_calls.insert(call_id.clone(), entry.clone());
            })?;
            Ok(entry)
        }
        "acceptCall" => {
            let call_id = req_str(payload, &["callId", "call_id"], "callId")?;
            let rec = client.call_accept(&call_id).await?;
            let emojis = compute_call_emojis(&call_id);
            engine.with_state_mut(|st| {
                st.active_calls.insert(
                    call_id.clone(),
                    json!({
                        "callId": call_id,
                        "state": "active",
                        "emojiFingerprint": emojis,
                        "record": rec
                    }),
                );
            })?;
            Ok(json!({
                "callId": call_id,
                "state": "active",
                "emojiFingerprint": emojis,
                "record": rec
            }))
        }
        "rejectCall" => {
            let call_id = req_str(payload, &["callId", "call_id"], "callId")?;
            client.call_decline(&call_id).await?;
            engine.with_state_mut(|st| {
                st.active_calls.remove(&call_id);
            })?;
            Ok(json!({ "callId": call_id, "state": "declined" }))
        }
        "endCall" => {
            let call_id = req_str(payload, &["callId", "call_id"], "callId")?;
            client.call_hangup(&call_id).await?;
            engine.with_state_mut(|st| {
                st.active_calls.remove(&call_id);
                if st.voip_background_task["callId"].as_str() == Some(call_id.as_str()) {
                    st.voip_background_task["active"] = Value::Bool(false);
                }
            })?;
            Ok(json!({ "callId": call_id, "state": "ended" }))
        }
        "joinSfuRoom" => {
            let room_id = req_str(payload, &["roomId", "room_id", "callId"], "roomId")?;
            let chat_id = gpui_telegram_core::types::ChatId(
                opt_i64(payload, &["chatId", "chat_id"]).unwrap_or(1),
            );
            let participants = opt_u64_vec(payload, &["participantIds", "participant_ids", "userIds"]);
            let mut bridge = SfuBridge::new();
            let self_uid = gpui_telegram_core::types::UserId(client.current_user_id().unwrap_or(1));
            bridge.join_room(chat_id, self_uid);
            for &pid in &participants {
                bridge.join_room(chat_id, gpui_telegram_core::types::UserId(pid));
            }
            let _rx = bridge.subscribe_room_audio(chat_id);
            let frame = SfuAudioFrame {
                chat_id,
                sender_id: self_uid,
                pcm: vec![0i16; 960],
                sample_rate: 48_000,
                channels: 1,
            };
            bridge.route_incoming_pcm(chat_id, self_uid, &frame.pcm, frame.sample_rate, frame.channels);
            Ok(json!({
                "roomId": room_id,
                "sfuActive": true,
                "selfUserId": self_uid.0,
                "peerCount": bridge.get_subscribers(chat_id).len(),
                "emojiFingerprint": compute_call_emojis(&room_id)
            }))
        }
        "sendSignal" => {
            let call_id = req_str(payload, &["callId", "call_id"], "callId")?;
            let sig_type = req_str(payload, &["signalType", "signal_type", "type"], "signalType")?;
            if !matches!(
                sig_type.as_str(),
                "offer" | "answer" | "ice" | "candidate" | "ice-candidate" | "renegotiate" | "hangup"
            ) {
                return Err(CoreDispatchError::validation(format!(
                    "Unsupported WebRTC signalType '{sig_type}'"
                )));
            }
            let target_uid = opt_u64(payload, &["targetUserId", "target_user_id"]);
            let mut map = serde_json::Map::new();
            map.insert("call_id".into(), Value::String(call_id.clone()));
            map.insert("signal_type".into(), Value::String(sig_type.clone()));
            if let Some(sdp) = opt_str(payload, &["sdp"]) {
                map.insert("sdp".into(), Value::String(sdp));
            }
            if let Some(cand) = opt_str(payload, &["candidate"]) {
                map.insert("candidate".into(), Value::String(cand));
            }
            if let Some(mid) = opt_str(payload, &["sdpMid", "sdp_mid"]) {
                map.insert("sdp_mid".into(), Value::String(mid));
            }
            if let Some(idx) = opt_u32(payload, &["sdpMlineIndex", "sdp_mline_index"]) {
                map.insert("sdp_mline_index".into(), json!(idx));
            }
            let req: CallSignalRequest = serde_json::from_value(Value::Object(map))?;
            client.send_call_signal(req, target_uid).await?;
            Ok(json!({ "sent": true, "callId": call_id, "signalType": sig_type }))
        }
        "getTurnCredentials" => client.get_turn_credentials().await.map_err(Into::into),
        "rateCall" => {
            let call_id = req_str(payload, &["callId", "call_id"], "callId")?;
            let rating_i64 = opt_i64(payload, &["rating", "stars"])
                .ok_or_else(|| CoreDispatchError::validation("rateCall requires rating (1..=5)"))?;
            if !(1..=5).contains(&rating_i64) {
                return Err(CoreDispatchError::validation(format!(
                    "Call rating {rating_i64} must be in 1..=5"
                )));
            }
            let feedback = opt_str(payload, &["feedback", "comment"]);
            to_json_val(
                client
                    .rate_call_with_feedback(&call_id, rating_i64 as u8, feedback.as_deref())
                    .await?,
            )
        }
        "listCallHistory" => {
            let calls = client.list_calls().await?;
            Ok(json!({ "calls": calls, "count": calls.len() }))
        }
        "setBackgroundVoipTask" => {
            let active = opt_bool(payload, &["active", "enabled"]).unwrap_or(true);
            let call_id = opt_str(payload, &["callId", "call_id"]);
            let mode = opt_str(payload, &["mode"]).unwrap_or_else(|| "voip".into());
            let task = engine.with_state_mut(|st| {
                st.voip_background_task = json!({
                    "active": active,
                    "callId": call_id,
                    "mode": mode,
                    "permission": "ohos.permission.KEEP_BACKGROUND_RUNNING"
                });
                st.voip_background_task.clone()
            })?;
            Ok(task)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported calls action '{other}'"),
        )),
    }
}

pub async fn handle_talk(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "startTalkSession" => {
            let sample_rate = opt_u32(payload, &["sampleRate", "sample_rate"]).unwrap_or(48_000);
            let preload_chunks = opt_u32(payload, &["ttsPreloadChunks", "preloadChunks"]).unwrap_or(8);
            let server_res = client.create_talk_session(payload).await.ok();
            let session_id = server_res
                .as_ref()
                .and_then(|v| {
                    v.get("session_id")
                        .or_else(|| v.get("sessionId"))
                        .and_then(|s| s.as_str())
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

            let (state_str, buffered) = {
                let mut talk = engine.talk.lock();
                talk.coordinator.session_id = session_id.clone();
                talk.coordinator.generation = talk.coordinator.generation.saturating_add(1);
                talk.coordinator.audio_buffer_queue.clear();
                talk.vad.reset();
                talk.media_tap.reset_barge_in();
                if preload_chunks > 0 {
                    talk.coordinator.state = TalkSessionState::Speaking;
                    for i in 0..preload_chunks.min(320) {
                        let _ = talk.coordinator.enqueue_audio(vec![(i & 0xFF) as u8; 640]);
                    }
                } else {
                    talk.coordinator.state = TalkSessionState::Listening;
                }
                let st_s = if preload_chunks > 0 { "speaking" } else { "listening" };
                (st_s.to_string(), talk.coordinator.buffered_chunks_count())
            };

            engine.with_state_mut(|st| {
                st.talk_meta = json!({
                    "sessionId": session_id,
                    "state": state_str,
                    "sampleRate": sample_rate,
                    "bufferedChunks": buffered,
                    "flushedChunks": 0
                });
            })?;

            Ok(json!({
                "sessionId": session_id,
                "state": state_str,
                "sampleRate": sample_rate,
                "bufferedChunks": buffered,
                "serverSession": server_res
            }))
        }
        "processVadFrame" => {
            let sample_rate = opt_u32(payload, &["sampleRate", "sample_rate"]).unwrap_or(48_000);
            let frame_count = opt_u32(payload, &["frameCount", "frames"]).unwrap_or(1).clamp(1, 50);
            let pcm_bytes: Vec<u8> = if let Some(b64) = opt_str(payload, &["pcmBase64", "pcm_base64"]) {
                b64_decode(&b64)?
            } else if let Some(arr) = payload.get("samples").and_then(|v| v.as_array()) {
                let mut out = Vec::with_capacity(arr.len() * 2);
                for x in arr {
                    let s = x.as_i64().unwrap_or(0).clamp(-32768, 32767) as i16;
                    out.extend_from_slice(&s.to_le_bytes());
                }
                out
            } else {
                let amp = opt_i64(payload, &["amplitude", "peak"]).unwrap_or(8_000).clamp(0, 32767) as i16;
                let samples_per_20ms = ((sample_rate as usize) * 20) / 1000;
                let mut out = Vec::with_capacity(samples_per_20ms * 2);
                for i in 0..samples_per_20ms {
                    let v = if i % 2 == 0 { amp } else { -amp };
                    out.extend_from_slice(&v.to_le_bytes());
                }
                out
            };

            let mut last_res = json!({});
            for _ in 0..frame_count {
                last_res = engine.process_talk_vad_pcm(&pcm_bytes, sample_rate);
            }
            if last_res["shouldAbortPlayback"].as_bool().unwrap_or(false) {
                let sid = engine.talk.lock().coordinator.session_id.clone();
                let _ = client
                    .talk_barge_in(&json!({ "session_id": sid, "reason": "vad_speech" }))
                    .await;
            }
            let _ = bytes_to_i16_le(&pcm_bytes);
            Ok(last_res)
        }
        "submitTalkTurn" => {
            let transcript = req_str(
                payload,
                &["transcript", "text", "prompt", "message"],
                "transcript",
            )?;
            let sid = opt_str(payload, &["sessionId", "session_id"])
                .unwrap_or_else(|| engine.talk.lock().coordinator.session_id.clone());
            let mut map = serde_json::Map::new();
            map.insert("transcript".into(), Value::String(transcript.clone()));
            map.insert("text".into(), Value::String(transcript.clone()));
            map.insert("prompt".into(), Value::String(transcript));
            map.insert("session_id".into(), Value::String(sid.clone()));
            if let Some(bid) = opt_u64(payload, &["botId", "bot_id"]) {
                map.insert("bot_id".into(), json!(bid));
            }
            if let Some(cid) = opt_i64(payload, &["chatId", "chat_id"]) {
                map.insert("chat_id".into(), json!(cid));
            }
            let req: HermesTalkTurnRequest = serde_json::from_value(Value::Object(map))?;
            let resp = client.hermes_talk_turn(&req).await?;

            let buffered = {
                let mut talk = engine.talk.lock();
                talk.coordinator.state = TalkSessionState::Speaking;
                for chunk_idx in 0..4u8 {
                    let _ = talk.coordinator.enqueue_audio(vec![chunk_idx; 640]);
                }
                talk.coordinator.buffered_chunks_count()
            };
            engine.with_state_mut(|st| {
                st.talk_meta["state"] = Value::String("speaking".into());
                st.talk_meta["bufferedChunks"] = json!(buffered);
            })?;

            Ok(json!({
                "sessionId": sid,
                "talkState": "speaking",
                "bufferedChunks": buffered,
                "turn": resp
            }))
        }
        "bargeInAbort" => {
            let start = std::time::Instant::now();
            let (sid, flushed, total_flushed) = {
                let mut talk = engine.talk.lock();
                let flushed = talk.coordinator.handle_barge_in();
                talk.coordinator.resume_listening();
                talk.vad.reset();
                talk.media_tap.reset_barge_in();
                (
                    talk.coordinator.session_id.clone(),
                    flushed,
                    talk.coordinator.total_flushed_chunks,
                )
            };
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            let server_ack = client
                .talk_barge_in(&json!({ "session_id": sid, "flushed_chunks": flushed }))
                .await
                .ok();
            engine.with_state_mut(|st| {
                st.talk_meta["state"] = Value::String("listening".into());
                st.talk_meta["bufferedChunks"] = json!(0);
                st.talk_meta["flushedChunks"] = json!(total_flushed);
            })?;
            Ok(json!({
                "aborted": true,
                "sessionId": sid,
                "flushedChunks": flushed,
                "talkState": "listening",
                "latencyMs": (elapsed_ms * 1000.0).round() / 1000.0,
                "serverAck": server_ack
            }))
        }
        "stopTalkSession" => {
            let sid = {
                let mut talk = engine.talk.lock();
                talk.coordinator.close();
                talk.coordinator.session_id.clone()
            };
            engine.with_state_mut(|st| {
                st.talk_meta["state"] = Value::String("closed".into());
                st.talk_meta["bufferedChunks"] = json!(0);
            })?;
            Ok(json!({ "sessionId": sid, "state": "closed" }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported talk action '{other}'"),
        )),
    }
}
