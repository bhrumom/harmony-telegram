//! Domains 10–11: `media` (CAS upload, resumable chunked upload, HTTP 206 Range download,
//! 5-bit waveform, PCM WAV voice note recorder, native pixel media editor, stickers & GIFs)
//! and `e2ee` (X3DH + Double Ratchet 1:1 DM, Group Sender Keys, Safety Number Fingerprints).

use std::fs;
use std::io::Cursor;
use std::path::Path;

use gpui_telegram_client::e2ee::verify_signed_prekey;
use gpui_telegram_media::{
    compute_pcm_rms_level, decode_waveform_5bit, encode_wav_i16, encode_waveform_5bit,
    recommend_part_size, waveform_from_pcm_i16, TELEGRAM_WAVEFORM_BARS,
};
use gpui_telegram_proto::contracts::ChunkedUploadInitRequest;
use gpui_telegram_proto::e2ee::{DevicePreKeyBundle, EncryptedEnvelope};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde_json::{json, Value};

use crate::engine::{bytes_to_i16_le, TelegramCoreEngine};
use crate::helpers::{
    b64_decode, b64_encode, opt_bool, opt_i64, opt_str, opt_u32, opt_u64, opt_u64_vec, opt_usize,
    req_i64, req_str, req_u64, sha256_hex, to_json_val, CoreDispatchError, CoreResult,
};

fn read_input_bytes(payload: &Value) -> CoreResult<Vec<u8>> {
    if let Some(b64) = opt_str(
        payload,
        &["dataBase64", "data_base64", "bytesBase64", "chunkBase64", "imageBase64"],
    ) {
        return b64_decode(&b64);
    }
    if let Some(path) = opt_str(payload, &["filePath", "file_path", "path"]) {
        return fs::read(&path).map_err(|e| {
            CoreDispatchError::validation(format!("Failed reading input file '{path}': {e}"))
        });
    }
    if let Some(txt) = opt_str(payload, &["text", "contentUtf8"]) {
        return Ok(txt.into_bytes());
    }
    Err(CoreDispatchError::validation(
        "Expected 'dataBase64', 'filePath', or 'text' byte payload",
    ))
}

pub async fn handle_media(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "uploadFile" => {
            if let Some(file_path) = opt_str(payload, &["filePath", "file_path"]) {
                if opt_bool(payload, &["resumable"]).unwrap_or(false) && Path::new(&file_path).is_file() {
                    let mime = opt_str(payload, &["mimeType", "mime_type"])
                        .unwrap_or_else(|| "application/octet-stream".into());
                    let chat_id = opt_i64(payload, &["chatId", "chat_id"]);
                    let transfer_id = opt_str(payload, &["transferId", "transfer_id"]);
                    let res = client
                        .upload_file_resumable(&file_path, &mime, chat_id, transfer_id.as_deref())
                        .await?;
                    return to_json_val(res);
                }
            }
            let bytes = read_input_bytes(payload)?;
            if bytes.is_empty() {
                return Err(CoreDispatchError::validation("Cannot upload empty 0-byte payload"));
            }
            let filename = opt_str(payload, &["filename", "fileName"])
                .unwrap_or_else(|| "upload.bin".into());
            let mime = opt_str(payload, &["mimeType", "mime_type"])
                .unwrap_or_else(|| "application/octet-stream".into());
            let res = client.upload_media(&filename, &mime, bytes).await?;
            to_json_val(res)
        }
        "initChunkedUpload" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let total_size = req_u64(payload, &["totalSize", "total_size", "sizeBytes"], "totalSize")?;
            if total_size == 0 {
                return Err(CoreDispatchError::validation("totalSize must be > 0"));
            }
            let filename = opt_str(payload, &["filename", "fileName"])
                .unwrap_or_else(|| "chunked.bin".into());
            let mime = opt_str(payload, &["mimeType", "mime_type"])
                .unwrap_or_else(|| "application/octet-stream".into());
            let part_size = opt_u32(payload, &["partSize", "part_size", "chunkSize"])
                .unwrap_or_else(|| recommend_part_size(total_size) as u32);
            let total_parts = ((total_size + (part_size as u64) - 1) / (part_size as u64)).max(1) as u32;
            let mut map = serde_json::Map::new();
            map.insert("filename".into(), Value::String(filename));
            map.insert("mime_type".into(), Value::String(mime));
            map.insert("total_size".into(), json!(total_size));
            map.insert("size_bytes".into(), json!(total_size));
            map.insert("part_size".into(), json!(part_size));
            map.insert("chunk_size".into(), json!(part_size));
            map.insert("total_parts".into(), json!(total_parts));
            if let Some(sha) = opt_str(payload, &["sha256", "expectedSha256"]) {
                map.insert("sha256".into(), Value::String(sha));
            }
            let req: ChunkedUploadInitRequest = serde_json::from_value(Value::Object(map))?;
            to_json_val(client.http_client.init_chunked_upload(&token, &req).await?)
        }
        "uploadChunk" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let upload_id = req_str(payload, &["uploadId", "upload_id"], "uploadId")?;
            let part_index = opt_u32(payload, &["partIndex", "part_index", "index"])
                .ok_or_else(|| CoreDispatchError::validation("Missing required partIndex"))?;
            let bytes = read_input_bytes(payload)?;
            if bytes.is_empty() {
                return Err(CoreDispatchError::validation("Chunk bytes must not be empty"));
            }
            let len = bytes.len();
            client
                .http_client
                .upload_chunk_part(&token, &upload_id, part_index, bytes)
                .await?;
            Ok(json!({
                "uploaded": true,
                "uploadId": upload_id,
                "partIndex": part_index,
                "byteLength": len
            }))
        }
        "getUploadStatus" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let upload_id = req_str(payload, &["uploadId", "upload_id"], "uploadId")?;
            to_json_val(client.http_client.get_chunked_upload_status(&token, &upload_id).await?)
        }
        "completeChunkedUpload" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let upload_id = req_str(payload, &["uploadId", "upload_id"], "uploadId")?;
            let filename = opt_str(payload, &["filename", "fileName"]);
            let mime = opt_str(payload, &["mimeType", "mime_type"]);
            let chat_id = opt_i64(payload, &["chatId", "chat_id"]);
            to_json_val(
                client
                    .http_client
                    .complete_chunked_upload(
                        &token,
                        &upload_id,
                        filename.as_deref(),
                        mime.as_deref(),
                        chat_id,
                    )
                    .await?,
            )
        }
        "downloadRange" => {
            let file_id = req_str(payload, &["fileId", "file_id"], "fileId")?;
            let start = opt_u64(payload, &["start", "offset"]).unwrap_or(0);
            let end = opt_u64(payload, &["end", "endInclusive", "end_inclusive"]);
            if let Some(e) = end {
                if e < start {
                    return Err(CoreDispatchError::validation(format!(
                        "Invalid byte range: end ({e}) < start ({start})"
                    )));
                }
            }
            let (status, bytes, content_range) =
                client.download_media_range(&file_id, start, end).await?;
            if let Some(save_path) = opt_str(payload, &["savePath", "save_path"]) {
                fs::write(&save_path, &bytes).map_err(|e| {
                    CoreDispatchError::internal(format!("Failed writing '{save_path}': {e}"))
                })?;
            }
            Ok(json!({
                "fileId": file_id,
                "statusCode": status,
                "contentRange": content_range,
                "byteLength": bytes.len(),
                "sha256": sha256_hex(&bytes),
                "dataBase64": b64_encode(&bytes)
            }))
        }
        "encodeWaveform5Bit" => {
            let packed = if let Some(bars_arr) = payload.get("bars").and_then(|v| v.as_array()) {
                let bars: Vec<u8> = bars_arr
                    .iter()
                    .filter_map(|x| x.as_u64().map(|n| (n.min(31)) as u8))
                    .collect();
                encode_waveform_5bit(&bars)
            } else if let Some(pcm_b64) = opt_str(payload, &["pcmBase64", "pcm_base64"]) {
                let bytes = b64_decode(&pcm_b64)?;
                let samples = bytes_to_i16_le(&bytes);
                waveform_from_pcm_i16(&samples).1
            } else if let Some(samples_arr) = payload.get("samples").and_then(|v| v.as_array()) {
                let samples: Vec<i16> = samples_arr
                    .iter()
                    .filter_map(|x| x.as_i64().map(|n| n.clamp(-32768, 32767) as i16))
                    .collect();
                waveform_from_pcm_i16(&samples).1
            } else {
                return Err(CoreDispatchError::validation(
                    "encodeWaveform5Bit requires 'bars', 'pcmBase64', or 'samples'",
                ));
            };
            Ok(json!({
                "packedBase64": b64_encode(&packed),
                "byteLength": packed.len(),
                "barCount": TELEGRAM_WAVEFORM_BARS
            }))
        }
        "decodeWaveform5Bit" => {
            let packed_b64 = req_str(payload, &["packedBase64", "packed_base64", "packed"], "packedBase64")?;
            let packed = b64_decode(&packed_b64)?;
            let bar_count = opt_usize(payload, &["barCount", "bar_count"])
                .unwrap_or(TELEGRAM_WAVEFORM_BARS)
                .clamp(1, 256);
            let mut bars = decode_waveform_5bit(&packed);
            bars.resize(bar_count, 0);
            Ok(json!({
                "bars": bars,
                "barCount": bars.len()
            }))
        }
        "recordVoicePcm" => {
            let sample_rate = opt_u32(payload, &["sampleRate", "sample_rate"]).unwrap_or(48_000);
            let samples: Vec<i16> = if let Some(pcm_b64) = opt_str(payload, &["pcmBase64", "pcm_base64"]) {
                bytes_to_i16_le(&b64_decode(&pcm_b64)?)
            } else if let Some(arr) = payload.get("samples").and_then(|v| v.as_array()) {
                arr.iter()
                    .filter_map(|v| v.as_i64().map(|n| n.clamp(-32768, 32767) as i16))
                    .collect()
            } else {
                let duration_ms = opt_u64(payload, &["durationMs", "duration_ms"]).unwrap_or(500).clamp(20, 30_000);
                let freq = opt_u64(payload, &["frequencyHz", "freq"]).unwrap_or(440) as f64;
                let count = ((sample_rate as u64 * duration_ms) / 1000) as usize;
                (0..count)
                    .map(|i| {
                        let t = (i as f64) / (sample_rate as f64);
                        ((t * freq * std::f64::consts::TAU).sin() * 14_000.0) as i16
                    })
                    .collect()
            };
            if samples.is_empty() {
                return Err(CoreDispatchError::validation("Voice PCM samples cannot be empty"));
            }
            let wav_bytes = encode_wav_i16(&samples, sample_rate, 1)?;
            let (waveform_bars, waveform_packed) = waveform_from_pcm_i16(&samples);
            let rms = compute_pcm_rms_level(&samples);

            let cache_dir = engine.init_config().cache_dir;
            let saved_path = if !cache_dir.trim().is_empty() {
                let p = Path::new(&cache_dir).join(format!(
                    "voice_{}.wav",
                    chrono::Utc::now().timestamp_millis()
                ));
                let _ = fs::write(&p, &wav_bytes);
                Some(p.to_string_lossy().to_string())
            } else {
                None
            };

            let uploaded = if opt_bool(payload, &["upload"]).unwrap_or(false) {
                Some(
                    client
                        .upload_media("voice_note.wav", "audio/wav", wav_bytes.clone())
                        .await?,
                )
            } else {
                None
            };

            Ok(json!({
                "sampleRate": sample_rate,
                "sampleCount": samples.len(),
                "durationMs": (samples.len() as u64 * 1000) / (sample_rate as u64),
                "rmsLevel": rms,
                "wavByteLength": wav_bytes.len(),
                "wavSha256": sha256_hex(&wav_bytes),
                "waveformBase64": b64_encode(&waveform_packed),
                "waveformBars": waveform_bars,
                "savedPath": saved_path,
                "uploadResult": uploaded
            }))
        }
        "editMedia" => {
            let img: DynamicImage = if payload.get("imageBase64").is_some() || payload.get("filePath").is_some() || payload.get("dataBase64").is_some() {
                let raw = read_input_bytes(payload)?;
                image::load_from_memory(&raw).map_err(|e| {
                    CoreDispatchError::validation(format!("Failed decoding image bytes: {e}"))
                })?
            } else {
                // Allow synthetic RGBA test canvas when width/height passed explicitly
                let w = opt_u32(payload, &["sourceWidth", "width"]).unwrap_or(160).clamp(4, 4096);
                let h = opt_u32(payload, &["sourceHeight", "height"]).unwrap_or(120).clamp(4, 4096);
                let mut buf = image::RgbaImage::new(w, h);
                for (x, y, px) in buf.enumerate_pixels_mut() {
                    *px = image::Rgba([(x & 0xFF) as u8, (y & 0xFF) as u8, 180, 255]);
                }
                DynamicImage::ImageRgba8(buf)
            };

            let mut edited = img;
            if let Some(crop) = payload.get("crop").and_then(|c| c.as_object()) {
                let cx = crop.get("x").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let cy = crop.get("y").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let cw = crop.get("width").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
                let ch = crop.get("height").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
                let (iw, ih) = edited.dimensions();
                if cw == 0 || ch == 0 || cx + cw > iw || cy + ch > ih {
                    return Err(CoreDispatchError::validation(format!(
                        "Crop rectangle ({cx},{cy},{cw}x{ch}) exceeds image bounds ({iw}x{ih})"
                    )));
                }
                edited = edited.crop_imm(cx, cy, cw, ch);
            }
            match opt_i64(payload, &["rotateDegrees", "rotate"]).unwrap_or(0) {
                90 | -270 => edited = edited.rotate90(),
                180 | -180 => edited = edited.rotate180(),
                270 | -90 => edited = edited.rotate270(),
                0 => {}
                other => {
                    return Err(CoreDispatchError::validation(format!(
                        "Unsupported rotateDegrees '{other}'; expected 0, 90, 180, or 270"
                    )));
                }
            }
            if opt_bool(payload, &["flipHorizontal"]).unwrap_or(false) {
                edited = edited.fliph();
            }
            if opt_bool(payload, &["flipVertical"]).unwrap_or(false) {
                edited = edited.flipv();
            }
            if let Some(max_dim) = opt_u32(payload, &["maxDimension", "resizeMax"]) {
                let (w, h) = edited.dimensions();
                if w > max_dim || h > max_dim {
                    edited = edited.thumbnail(max_dim, max_dim);
                }
            }

            let (out_w, out_h) = edited.dimensions();
            let mut png_bytes = Vec::new();
            edited
                .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
                .map_err(|e| CoreDispatchError::internal(format!("PNG encode failed: {e}")))?;

            Ok(json!({
                "width": out_w,
                "height": out_h,
                "mimeType": "image/png",
                "byteLength": png_bytes.len(),
                "sha256": sha256_hex(&png_bytes),
                "dataBase64": b64_encode(&png_bytes)
            }))
        }
        "listStickers" => {
            let q = opt_str(payload, &["query", "q"]);
            let sets = client.list_sticker_sets(q.as_deref()).await?;
            Ok(json!({ "sets": sets, "count": sets.len() }))
        }
        "installStickerSet" => {
            let set_id = req_str(payload, &["setId", "set_id", "id"], "setId")?;
            let installed = opt_bool(payload, &["installed"]).unwrap_or(true);
            client.install_sticker_set(&set_id, installed).await?;
            Ok(json!({ "setId": set_id, "installed": installed }))
        }
        "searchGifs" => {
            let q = opt_str(payload, &["query", "q"]).unwrap_or_default();
            let limit = opt_usize(payload, &["limit"]).unwrap_or(25);
            let gifs = client.search_gifs(&q, limit).await?;
            Ok(json!({ "gifs": gifs, "count": gifs.len() }))
        }
        "startVoiceRecorder" => {
            let session_id = opt_str(payload, &["sessionId", "session_id"])
                .unwrap_or_else(|| format!("rec_{}", uuid::Uuid::new_v4().simple()));
            let sample_rate = opt_u32(payload, &["sampleRate", "sample_rate"]).unwrap_or(48_000);
            engine
                .voice_recorders
                .lock()
                .insert(session_id.clone(), gpui_telegram_media::VoiceRecorder::new(sample_rate));
            Ok(json!({ "sessionId": session_id, "sampleRate": sample_rate, "started": true }))
        }
        "stopVoiceRecorder" => {
            let session_id = req_str(payload, &["sessionId", "session_id"], "sessionId")?;
            let mut result = engine.stop_voice_recorder(&session_id)?;
            if opt_bool(payload, &["upload"]).unwrap_or(false) {
                if let Some(wav_path) = result.get("wavPath").and_then(|v| v.as_str()) {
                    let bytes = fs::read(wav_path)
                        .map_err(|e| CoreDispatchError::internal(format!("Failed reading WAV: {e}")))?;
                    let uploaded = client.upload_media("voice_note.wav", "audio/wav", bytes).await?;
                    result["uploadResult"] = to_json_val(uploaded)?;
                }
            }
            Ok(result)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported media action '{other}'"),
        )),
    }
}

fn read_plaintext(payload: &Value) -> CoreResult<Vec<u8>> {
    if let Some(b64) = opt_str(payload, &["plaintextBase64", "plaintext_base64"]) {
        return b64_decode(&b64);
    }
    let s = req_str(payload, &["plaintext", "text"], "plaintext")?;
    Ok(s.into_bytes())
}

pub async fn handle_e2ee(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "initIdentity" => {
            let id = client.e2ee_manager().identity()?;
            Ok(json!({
                "deviceId": client.device_id(),
                "ed25519PublicKeyB64": b64_encode(&id.ed25519_pub),
                "x25519PublicKeyB64": b64_encode(&id.x25519_pub)
            }))
        }
        "uploadPrekeys" => {
            let count = opt_usize(payload, &["count", "otpkBatchSize", "batchSize"])
                .unwrap_or(32)
                .clamp(1, 200);
            let resp = client.e2ee_init_and_publish_prekeys(count).await?;
            to_json_val(resp)
        }
        "fetchPrekeyBundle" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let user_id = req_u64(payload, &["userId", "user_id"], "userId")?;
            let device_id = opt_str(payload, &["deviceId", "device_id"]);
            let resp = client
                .http_client
                .fetch_user_prekey_bundles(&token, user_id, device_id.as_deref())
                .await?;
            for b in &resp.devices {
                verify_bundle_signature(b)?;
            }
            to_json_val(resp)
        }
        "establishX3dh" => {
            let bundle: DevicePreKeyBundle = if let Some(b_val) = payload.get("bundle") {
                serde_json::from_value(b_val.clone())?
            } else {
                let token = client
                    .token()
                    .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
                let user_id = req_u64(payload, &["userId", "user_id", "recipientUserId"], "userId")?;
                let resp = client
                    .http_client
                    .fetch_user_prekey_bundles(&token, user_id, None)
                    .await?;
                resp.devices.into_iter().next().ok_or_else(|| {
                    CoreDispatchError::not_found(format!(
                        "No E2EE prekey bundles published for user {user_id}"
                    ))
                })?
            };
            verify_bundle_signature(&bundle)?;
            let _session = client.e2ee_manager().establish_session_from_bundle(&bundle)?;
            Ok(json!({
                "established": true,
                "peerUserId": bundle.user_id,
                "peerDeviceId": bundle.device_id,
                "signedPrekeyId": bundle.signed_prekey.key_id,
                "usedOneTimePrekeyId": bundle.one_time_prekey.as_ref().map(|k| k.key_id)
            }))
        }
        "sendEncryptedDm" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let recipient_uid = req_u64(
                payload,
                &["recipientUserId", "recipient_user_id", "userId"],
                "recipientUserId",
            )?;
            let pt = read_plaintext(payload)?;
            let sent = client.send_encrypted_dm(chat_id, recipient_uid, &pt).await?;
            Ok(json!({ "sent": sent }))
        }
        "encryptDirect" => {
            let recipient_uid = req_u64(
                payload,
                &["recipientUserId", "recipient_user_id", "userId"],
                "recipientUserId",
            )?;
            let pt = read_plaintext(payload)?;
            if opt_bool(payload, &["send"]).unwrap_or(false) {
                let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
                let sent = client.send_encrypted_dm(chat_id, recipient_uid, &pt).await?;
                return Ok(json!({ "sent": sent }));
            }
            let env = client.e2ee_encrypt_dm(recipient_uid, &pt).await?;
            Ok(json!({ "envelope": env }))
        }
        "decryptDirect" => {
            let env_val = payload
                .get("envelope")
                .cloned()
                .unwrap_or_else(|| payload.clone());
            let env: EncryptedEnvelope = serde_json::from_value(env_val)?;
            let pt = client.e2ee_decrypt_envelope(&env)?;
            Ok(json!({
                "plaintext": String::from_utf8_lossy(&pt),
                "plaintextBase64": b64_encode(&pt),
                "byteLength": pt.len()
            }))
        }
        "initGroupSenderKey" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let members = opt_u64_vec(payload, &["memberUserIds", "member_user_ids", "userIds"]);
            let (dist_opt, probe_env) = client
                .e2ee_encrypt_group(chat_id, &members, b"__sender_key_bootstrap__")
                .await?;
            Ok(json!({
                "chatId": chat_id,
                "distributionEnvelope": dist_opt,
                "bootstrapEnvelope": probe_env
            }))
        }
        "sendEncryptedGroup" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let members = opt_u64_vec(payload, &["memberUserIds", "member_user_ids", "userIds"]);
            let pt = read_plaintext(payload)?;
            let sent = client.send_encrypted_group(chat_id, &members, &pt).await?;
            Ok(json!({ "sent": sent }))
        }
        "encryptGroup" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let members = opt_u64_vec(payload, &["memberUserIds", "member_user_ids", "userIds"]);
            let pt = read_plaintext(payload)?;
            if opt_bool(payload, &["send"]).unwrap_or(false) {
                let sent = client.send_encrypted_group(chat_id, &members, &pt).await?;
                return Ok(json!({ "sent": sent }));
            }
            let (dist_opt, msg_env) = client.e2ee_encrypt_group(chat_id, &members, &pt).await?;
            Ok(json!({
                "distributionEnvelope": dist_opt,
                "envelope": msg_env
            }))
        }
        "decryptGroup" => {
            if let Some(dist_val) = payload
                .get("distributionEnvelope")
                .or_else(|| payload.get("distribution_envelope"))
                .filter(|v| !v.is_null())
            {
                let dist_env: EncryptedEnvelope = serde_json::from_value(dist_val.clone())?;
                let _ = client.e2ee_decrypt_envelope(&dist_env)?;
            }
            let env_val = payload
                .get("envelope")
                .or_else(|| payload.get("messageEnvelope"))
                .cloned()
                .unwrap_or_else(|| payload.clone());
            let env: EncryptedEnvelope = serde_json::from_value(env_val)?;
            let pt = client.e2ee_decrypt_envelope(&env)?;
            Ok(json!({
                "plaintext": String::from_utf8_lossy(&pt),
                "plaintextBase64": b64_encode(&pt),
                "byteLength": pt.len()
            }))
        }
        "computeSafetyNumber" => {
            let remote_b64 = if let Some(k) = opt_str(
                payload,
                &["remoteIdentityKeyB64", "remote_identity_key_b64", "peerX25519PublicKeyB64"],
            ) {
                k
            } else {
                let peer_uid = req_u64(payload, &["peerUserId", "userId"], "remoteIdentityKeyB64")?;
                let token = client
                    .token()
                    .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
                let bundles = client
                    .http_client
                    .fetch_user_prekey_bundles(&token, peer_uid, None)
                    .await?;
                let b = bundles.devices.first().ok_or_else(|| {
                    CoreDispatchError::not_found("Peer has no published E2EE identity bundle")
                })?;
                b.identity_key.clone()
            };
            let emojis = client.e2ee_safety_fingerprint(&remote_b64)?;
            let local_id = client.e2ee_manager().identity()?;
            let mut canonical = [b64_encode(&local_id.x25519_pub), remote_b64.clone()];
            canonical.sort();
            let digest = sha256_hex(format!("{}:{}", canonical[0], canonical[1]).as_bytes());
            Ok(json!({
                "emojis": emojis,
                "numericFingerprint": &digest[..32],
                "localX25519PublicKeyB64": b64_encode(&local_id.x25519_pub),
                "remoteX25519PublicKeyB64": remote_b64
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported e2ee action '{other}'"),
        )),
    }
}

fn verify_bundle_signature(b: &DevicePreKeyBundle) -> CoreResult<()> {
    let sig_pub_vec = b64_decode(&b.identity_signing_key)?;
    let spk_pub_vec = b64_decode(&b.signed_prekey.public_key)?;
    let sig_vec = b64_decode(&b.signed_prekey.signature)?;
    let sig_pub: [u8; 32] = sig_pub_vec
        .try_into()
        .map_err(|_| CoreDispatchError::validation("Invalid 32-byte Ed25519 signing key"))?;
    let spk_pub: [u8; 32] = spk_pub_vec
        .try_into()
        .map_err(|_| CoreDispatchError::validation("Invalid 32-byte signed prekey"))?;
    let sig: [u8; 64] = sig_vec
        .try_into()
        .map_err(|_| CoreDispatchError::validation("Invalid 64-byte Ed25519 signature"))?;
    verify_signed_prekey(&sig_pub, &spk_pub, &sig).map_err(Into::into)
}
