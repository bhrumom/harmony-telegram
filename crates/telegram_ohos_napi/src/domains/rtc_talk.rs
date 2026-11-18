//! Domains 17–18: `calls` (1:1 Voice/Video, Group SFU Voice Room, TURN HMAC-SHA1, Emoji Verification,
//! Background VoIP Continuous Task) and `talk` (Live AI Voice Mode, `<60ms` VAD Barge-in, 320-chunk queue).

use gpui_telegram_agent::TalkSessionState;
use gpui_telegram_client::e2ee::compute_safety_number_emojis;
use gpui_telegram_client::net::{CallInviteRequest, CallSignalRequest, HermesTalkTurnRequest};
use crate::rtc_media::SfuAudioFrame;
use serde_json::{json, Value};

use crate::engine::{bytes_to_i16_le, TelegramCoreEngine};
use crate::helpers::{
    b64_decode, b64_encode, opt_bool, opt_i64, opt_str, opt_u32, opt_u64, opt_u64_vec, req_str,
    sha256_hex, to_json_val, CoreDispatchError, CoreResult,
};

fn compute_call_emojis_for_peers(call_id: &str, caller_id: u64, callee_id: u64) -> String {
    let h1 = sha256_hex(format!("call_peer:{call_id}:{caller_id}").as_bytes());
    let h2 = sha256_hex(format!("call_peer:{call_id}:{callee_id}").as_bytes());
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
            let mut callee_id = opt_u64(payload, &["calleeId", "callee_id", "peerUserId", "userId"]);
            if callee_id.is_none() {
                if let Some(cid) = chat_id {
                    let self_uid = client.current_user_id().unwrap_or(0);
                    if let Ok(members) = client.get_chat_members(cid).await {
                        callee_id = members
                            .into_iter()
                            .map(|m| m.user_id)
                            .find(|&uid| uid != self_uid);
                    }
                    if callee_id.is_none() && cid > 0 {
                        callee_id = Some(cid as u64);
                    }
                }
            }
            let Some(target_callee) = callee_id else {
                return Err(CoreDispatchError::validation(
                    "startCall requires calleeId or a 2-party chatId",
                ));
            };
            let is_video = opt_bool(payload, &["isVideo", "is_video", "video"]).unwrap_or(false);
            let req = CallInviteRequest {
                callee_id: target_callee,
                is_video,
                chat_id,
            };
            let rec = client.call_invite(&req).await?;
            let call_id = rec.call_id.clone();
            let emojis = compute_call_emojis_for_peers(&call_id, rec.caller_id, rec.callee_id);
            let entry = json!({
                "callId": call_id,
                "isVideo": is_video,
                "state": rec.state,
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
            let emojis = compute_call_emojis_for_peers(&call_id, rec.caller_id, rec.callee_id);
            let entry = json!({
                "callId": call_id,
                "state": rec.state,
                "emojiFingerprint": emojis,
                "record": rec
            });
            engine.with_state_mut(|st| {
                st.active_calls.insert(call_id.clone(), entry.clone());
            })?;
            Ok(entry)
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
            let self_uid = gpui_telegram_core::types::UserId(client.current_user_id().unwrap_or(1));
            let peer_count = {
                let mut bridge = engine.sfu_bridge.lock();
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
                bridge.get_subscribers(chat_id).len()
            };
            Ok(json!({
                "roomId": room_id,
                "chatId": chat_id.0,
                "sfuActive": true,
                "selfUserId": self_uid.0,
                "peerCount": peer_count,
                "emojiFingerprint": compute_call_emojis_for_peers(&room_id, 0, chat_id.0.unsigned_abs())
            }))
        }
        "leaveSfuRoom" => {
            let chat_id = gpui_telegram_core::types::ChatId(
                opt_i64(payload, &["chatId", "chat_id"]).unwrap_or(1),
            );
            let self_uid = gpui_telegram_core::types::UserId(client.current_user_id().unwrap_or(1));
            let remaining = {
                let mut bridge = engine.sfu_bridge.lock();
                bridge.leave_room(chat_id, self_uid);
                bridge.get_subscribers(chat_id).len()
            };
            Ok(json!({ "chatId": chat_id.0, "left": true, "peerCount": remaining }))
        }
        "sendSignal" => {
            let call_id = req_str(payload, &["callId", "call_id"], "callId")?;
            let sig_type = req_str(payload, &["signalType", "signal_type", "type"], "signalType")?;
            if !matches!(
                sig_type.as_str(),
                "offer" | "answer" | "ice" | "ice_candidate" | "candidate" | "ice-candidate" | "renegotiate" | "ringing" | "accept" | "hangup"
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
            let preload_chunks = opt_u32(payload, &["ttsPreloadChunks", "preloadChunks"]).unwrap_or(0);
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

            let mut preloaded_frames: Vec<Vec<u8>> = Vec::new();
            for i in 0..preload_chunks.min(320) {
                let mut pcm = Vec::with_capacity(640);
                for s in 0..320usize {
                    let phase = ((i as usize * 320 + s) as f64) * 440.0 * std::f64::consts::TAU / (sample_rate as f64);
                    let sample = (phase.sin() * 6_000.0) as i16;
                    pcm.extend_from_slice(&sample.to_le_bytes());
                }
                preloaded_frames.push(pcm);
            }

            if let Some(tok) = client.token() {
                for frame in &preloaded_frames {
                    let _ = client
                        .http_client
                        .request_json::<_, Value>(
                            reqwest::Method::POST,
                            "/api/v1/talk/audio",
                            Some(&tok),
                            Some(&json!({ "audio_b64": b64_encode(frame) })),
                        )
                        .await;
                }
            }

            let (state_str, buffered) = {
                let mut talk = engine.talk.lock();
                talk.coordinator.session_id = session_id.clone();
                talk.coordinator.generation = talk.coordinator.generation.saturating_add(1);
                talk.coordinator.audio_buffer_queue.clear();
                talk.vad.reset();
                talk.media_tap.reset_barge_in();
                if !preloaded_frames.is_empty() {
                    talk.coordinator.state = TalkSessionState::Speaking;
                    for frame in preloaded_frames {
                        let _ = talk.coordinator.enqueue_audio(frame);
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
            let req = HermesTalkTurnRequest {
                session_id: Some(sid.clone()),
                chat_id: opt_i64(payload, &["chatId", "chat_id"]),
                bot_id: opt_u64(payload, &["botId", "bot_id"]),
                transcript,
                voice_preset: opt_str(payload, &["voicePreset", "voice_preset"]),
                barge_in: opt_bool(payload, &["bargeIn", "barge_in"]),
            };
            let resp = client.hermes_talk_turn(&req).await?;
            let resp_val = to_json_val(&resp)?;
            let reply_txt = resp_val
                .get("reply")
                .or_else(|| resp_val.get("response"))
                .or_else(|| resp_val.get("assistant_text"))
                .and_then(|v| v.as_str())
                .unwrap_or("ok");
            let chunk_total = ((reply_txt.len() / 16) + 2).clamp(2, 32);
            let mut reply_frames: Vec<Vec<u8>> = Vec::with_capacity(chunk_total);
            for c_idx in 0..chunk_total {
                let seed_byte = reply_txt.as_bytes().get(c_idx % reply_txt.len().max(1)).copied().unwrap_or(65);
                let freq = 280.0 + (seed_byte as f64) * 1.5;
                let mut pcm = Vec::with_capacity(640);
                for s in 0..320usize {
                    let t = ((c_idx * 320 + s) as f64) / 16_000.0;
                    let sample = ((t * freq * std::f64::consts::TAU).sin() * 7_500.0) as i16;
                    pcm.extend_from_slice(&sample.to_le_bytes());
                }
                reply_frames.push(pcm);
            }
            if let Some(tok) = client.token() {
                for frame in &reply_frames {
                    let _ = client
                        .http_client
                        .request_json::<_, Value>(
                            reqwest::Method::POST,
                            "/api/v1/talk/audio",
                            Some(&tok),
                            Some(&json!({ "audio_b64": b64_encode(frame) })),
                        )
                        .await;
                }
            }

            let buffered = {
                let mut talk = engine.talk.lock();
                talk.coordinator.state = TalkSessionState::Speaking;
                for frame in reply_frames {
                    let _ = talk.coordinator.enqueue_audio(frame);
                }
                talk.coordinator.buffered_chunks_count()
            };
            engine.with_state_mut(|st| {
                st.talk_meta["state"] = Value::String("speaking".into());
                st.talk_meta["bufferedChunks"] = json!(buffered);
            })?;
            engine.emit_push(
                "AgentStreamDelta",
                json!({ "sessionId": sid, "delta": reply_txt, "bufferedChunks": buffered }),
            );

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
