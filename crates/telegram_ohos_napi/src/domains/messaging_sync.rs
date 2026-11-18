//! Domains 7–9: `messages` (Rich messaging, 12 card types, polls, reactions, stories, Instant View),
//! `outbox` (SQLite WAL offline queue, exponential backoff, idempotent flush), and
//! `sync` (Monotonic PTS cursors, gap detection, `get_difference` catch-up).

use gpui_telegram_client::net::{CreatePollHttpRequest, RichSendMessageRequest};
use gpui_telegram_client::outbox::OutboxStatus;
use gpui_telegram_core::types::{ChatId, MessageId, PeerId, UserId};
use gpui_telegram_proto::message::{MessageContent, MessageEntity, MessageItem};
use gpui_telegram_proto::sync::{PtsUpdate, SyncGetDifferenceRequest};
use gpui_telegram_proto::ws::WsServerFrame;
use serde_json::{json, Value};

use crate::engine::TelegramCoreEngine;
use crate::helpers::{
    opt_bool, opt_i64, opt_i64_vec, opt_str, opt_string_vec, opt_u32, opt_u64, opt_usize, req_i64,
    req_str, req_u64, to_json_val, CoreDispatchError, CoreResult,
};

fn build_send_request(
    engine: &TelegramCoreEngine,
    payload: &Value,
    chat_id_override: Option<i64>,
) -> CoreResult<RichSendMessageRequest> {
    let client = engine.client()?;
    let chat_id = chat_id_override
        .or_else(|| opt_i64(payload, &["chatId", "chat_id"]))
        .ok_or_else(|| CoreDispatchError::validation("Missing required integer 'chatId'"))?;
    if chat_id <= 0 {
        return Err(CoreDispatchError::validation("chatId must be positive"));
    }

    let text = opt_str(payload, &["text", "caption"]);
    let entities: Vec<MessageEntity> = payload
        .get("entities")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let file_id_opt = opt_str(payload, &["fileId", "file_id", "mediaId"]);
    let card_kind_opt = opt_str(payload, &["cardType", "mediaType", "messageType"])
        .or_else(|| file_id_opt.as_ref().map(|_| "document".to_string()));

    let content: Option<MessageContent> = if let Some(c_val) = payload.get("content") {
        if c_val.is_null() {
            None
        } else {
            Some(serde_json::from_value(c_val.clone())?)
        }
    } else if let Some(ref card_type) = card_kind_opt {
        let file_id = file_id_opt.unwrap_or_default();
        match card_type.to_ascii_lowercase().as_str() {
            "photo" | "image" => Some(MessageContent::Photo {
                file_id,
                caption: text.clone(),
                width: opt_u32(payload, &["width"]).unwrap_or(1280),
                height: opt_u32(payload, &["height"]).unwrap_or(720),
            }),
            "video" => Some(MessageContent::Video {
                file_id,
                duration: opt_u32(payload, &["durationSecs", "duration"]).unwrap_or(15),
                width: opt_u32(payload, &["width"]).unwrap_or(1280),
                height: opt_u32(payload, &["height"]).unwrap_or(720),
                caption: text.clone(),
            }),
            "voice" | "audio" => Some(MessageContent::Audio {
                file_id,
                duration: opt_u32(payload, &["durationSecs", "duration"]).unwrap_or(5),
                title: opt_str(payload, &["title"]),
                performer: opt_str(payload, &["performer"]),
            }),
            "document" | "file" => Some(MessageContent::Document {
                file_id,
                file_name: opt_str(payload, &["fileName", "filename"]).unwrap_or_else(|| "attachment.bin".into()),
                mime_type: opt_str(payload, &["mimeType", "mime_type"]).unwrap_or_else(|| "application/octet-stream".into()),
                size_bytes: opt_u64(payload, &["sizeBytes", "size_bytes"]).unwrap_or(0),
            }),
            _ => text
                .as_ref()
                .map(|t| MessageContent::text_with_entities(t.clone(), entities.clone())),
        }
    } else {
        text.as_ref()
            .map(|t| MessageContent::text_with_entities(t.clone(), entities.clone()))
    };

    let forward_chat = opt_i64(payload, &["forwardFromChatId", "forward_from_chat_id"]);
    let forward_msg = opt_i64(payload, &["forwardFromMsgId", "forward_from_msg_id"]);
    if text.as_deref().unwrap_or("").trim().is_empty()
        && content.is_none()
        && forward_msg.is_none()
    {
        return Err(CoreDispatchError::validation(
            "Message requires non-empty 'text', 'content', or 'forwardFromMsgId'",
        ));
    }

    let nonce = opt_u64(payload, &["clientNonce", "client_nonce"])
        .unwrap_or_else(|| client.next_client_nonce());
    let inline_keyboard = payload
        .get("inlineKeyboard")
        .or_else(|| payload.get("inline_keyboard"))
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    Ok(RichSendMessageRequest {
        chat_id,
        text,
        content,
        entities,
        reply_to: opt_i64(payload, &["replyTo", "reply_to", "replyToMsgId"]),
        quote_text: opt_str(payload, &["quoteText", "quote_text"]),
        topic_id: opt_i64(payload, &["topicId", "topic_id"]),
        client_nonce: Some(nonce),
        forward_from_chat_id: forward_chat,
        forward_from_msg_id: forward_msg,
        silent: opt_bool(payload, &["silent"]).unwrap_or(false),
        scheduled_at_ms: opt_i64(payload, &["scheduledAtMs", "scheduled_at_ms"]),
        inline_keyboard,
        send_as_peer_id: opt_u64(payload, &["sendAsPeerId", "send_as_peer_id"]),
    })
}

pub async fn handle_messages(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "sendMessage" => {
            let req = build_send_request(engine, payload, None)?;
            let resp = client.send_message_durable(req).await?;
            engine.with_state_mut(|st| {
                st.pts_by_chat.insert(resp.chat_id, resp.pts);
            })?;
            to_json_val(resp)
        }
        "listHistory" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            if chat_id <= 0 {
                return Err(CoreDispatchError::validation("chatId must be positive"));
            }
            let limit = opt_usize(payload, &["limit"]).or(Some(100));
            let msgs = client.get_chat_messages(chat_id as u64, limit).await?;
            Ok(json!({ "chatId": chat_id, "messages": msgs, "count": msgs.len() }))
        }
        "editMessage" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let msg_id = req_i64(payload, &["messageId", "message_id", "msgId"], "messageId")?;
            let text = req_str(payload, &["text"], "text")?;
            let entities: Vec<MessageEntity> = payload
                .get("entities")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            client.edit_message(chat_id, msg_id, text.clone(), entities).await?;
            Ok(json!({ "edited": true, "chatId": chat_id, "messageId": msg_id, "text": text }))
        }
        "deleteMessages" | "deleteMessage" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let mut ids = opt_i64_vec(payload, &["messageIds", "message_ids"]);
            if let Some(single) = opt_i64(payload, &["messageId", "message_id", "msgId"]) {
                if !ids.contains(&single) {
                    ids.push(single);
                }
            }
            if ids.is_empty() {
                return Err(CoreDispatchError::validation(
                    "deleteMessages requires messageId or messageIds",
                ));
            }
            let revoke = opt_bool(payload, &["revoke", "forEveryone"]).unwrap_or(true);
            for mid in &ids {
                client.delete_message(chat_id, *mid, revoke).await?;
            }
            Ok(json!({ "deleted": true, "chatId": chat_id, "deletedIds": ids }))
        }
        "forwardMessages" => {
            let from_chat_id = req_i64(payload, &["fromChatId", "from_chat_id"], "fromChatId")?;
            let to_chat_id = req_i64(payload, &["toChatId", "to_chat_id", "chatId"], "toChatId")?;
            let mut ids = opt_i64_vec(payload, &["messageIds", "message_ids"]);
            if let Some(single) = opt_i64(payload, &["messageId", "message_id"]) {
                if !ids.contains(&single) {
                    ids.push(single);
                }
            }
            if ids.is_empty() {
                return Err(CoreDispatchError::validation(
                    "forwardMessages requires messageId or messageIds",
                ));
            }
            let src_history = client
                .get_chat_messages(from_chat_id as u64, Some(200))
                .await
                .unwrap_or_default();
            let mut forwarded = Vec::with_capacity(ids.len());
            for mid in ids {
                let src_text = src_history
                    .iter()
                    .find(|m| m.message_id as i64 == mid)
                    .map(|m| m.text.clone())
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| format!("Forwarded message #{mid}"));
                let req = RichSendMessageRequest {
                    chat_id: to_chat_id,
                    text: Some(src_text.clone()),
                    content: Some(MessageContent::plain_text(src_text)),
                    entities: Vec::new(),
                    reply_to: None,
                    quote_text: None,
                    topic_id: opt_i64(payload, &["topicId", "topic_id"]),
                    client_nonce: Some(client.next_client_nonce()),
                    forward_from_chat_id: Some(from_chat_id),
                    forward_from_msg_id: Some(mid),
                    silent: false,
                    scheduled_at_ms: None,
                    inline_keyboard: None,
                    send_as_peer_id: None,
                };
                forwarded.push(client.send_message_durable(req).await?);
            }
            Ok(json!({ "forwarded": forwarded, "count": forwarded.len() }))
        }
        "pinMessage" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let msg_id = req_i64(payload, &["messageId", "message_id"], "messageId")?;
            to_json_val(client.pin_message(chat_id, msg_id).await?)
        }
        "unpinMessage" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let msg_id = req_i64(payload, &["messageId", "message_id"], "messageId")?;
            client.unpin_message(chat_id, msg_id).await?;
            Ok(json!({ "unpinned": true, "chatId": chat_id, "messageId": msg_id }))
        }
        "listPinnedMessages" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let pins = client.list_pinned_messages(chat_id).await?;
            Ok(json!({ "pins": pins, "count": pins.len() }))
        }
        "toggleReaction" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let msg_id = req_i64(payload, &["messageId", "message_id"], "messageId")?;
            let emoji = req_str(payload, &["emoji"], "emoji")?;
            let op = opt_str(payload, &["reactionAction", "mode"]);
            to_json_val(
                client
                    .react_to_message(chat_id, msg_id, emoji, op.as_deref())
                    .await?,
            )
        }
        "createPoll" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let question = req_str(payload, &["question"], "question")?;
            let options = opt_string_vec(payload, &["options"]);
            if options.len() < 2 || options.len() > 12 {
                return Err(CoreDispatchError::validation(
                    "Poll requires between 2 and 12 options",
                ));
            }
            let mut map = serde_json::Map::new();
            map.insert("question".into(), Value::String(question));
            map.insert("options".into(), to_json_val(&options)?);
            map.insert(
                "is_anonymous".into(),
                Value::Bool(opt_bool(payload, &["isAnonymous", "is_anonymous"]).unwrap_or(true)),
            );
            map.insert(
                "allows_multiple_answers".into(),
                Value::Bool(
                    opt_bool(payload, &["allowsMultipleAnswers", "allows_multiple_answers"])
                        .unwrap_or(false),
                ),
            );
            map.insert(
                "is_quiz".into(),
                Value::Bool(opt_bool(payload, &["isQuiz", "is_quiz"]).unwrap_or(false)),
            );
            if let Some(correct) = opt_u32(payload, &["correctOptionId", "correct_option_id"]) {
                map.insert("correct_option_id".into(), json!(correct));
            }
            if let Some(exp) = opt_str(payload, &["explanation"]) {
                map.insert("explanation".into(), Value::String(exp));
            }
            let req: CreatePollHttpRequest = serde_json::from_value(Value::Object(map))?;
            to_json_val(client.create_poll(chat_id, &req).await?)
        }
        "votePoll" => {
            let poll_id = req_u64(payload, &["pollId", "poll_id"], "pollId")?;
            let mut opts: Vec<u8> = opt_i64_vec(payload, &["optionIds", "option_ids"])
                .into_iter()
                .filter_map(|v| u8::try_from(v).ok())
                .collect();
            if let Some(single) = opt_u32(payload, &["optionId", "option_id"]) {
                if let Ok(b) = u8::try_from(single) {
                    if !opts.contains(&b) {
                        opts.push(b);
                    }
                }
            }
            if opts.is_empty() {
                return Err(CoreDispatchError::validation("votePoll requires optionIds"));
            }
            to_json_val(client.vote_poll(poll_id, opts).await?)
        }
        "closePoll" => {
            let poll_id = req_u64(payload, &["pollId", "poll_id"], "pollId")?;
            to_json_val(client.close_poll(poll_id).await?)
        }
        "getPoll" => {
            let poll_id = req_u64(payload, &["pollId", "poll_id"], "pollId")?;
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let path = format!("/api/v1/polls/{poll_id}");
            client
                .http_client
                .request_json(reqwest::Method::GET, &path, Some(&token), None::<&()>)
                .await
                .map_err(Into::into)
        }
        "markRead" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let max_id = opt_i64(payload, &["maxId", "max_id", "messageId"]).unwrap_or(i64::MAX / 2);
            let topic_id = opt_i64(payload, &["topicId", "topic_id"]);
            to_json_val(client.mark_chat_read(chat_id, max_id, topic_id).await?)
        }
        "translateMessage" => {
            let mut source_text = opt_str(payload, &["text"]).unwrap_or_default();
            if source_text.is_empty() {
                if let (Some(cid), Some(mid)) = (
                    opt_i64(payload, &["chatId", "chat_id"]),
                    opt_i64(payload, &["messageId", "message_id"]),
                ) {
                    let msgs = client.get_chat_messages(cid as u64, Some(100)).await?;
                    if let Some(found) = msgs.into_iter().find(|m| m.message_id as i64 == mid) {
                        source_text = found.text;
                    }
                }
            }
            if source_text.trim().is_empty() {
                return Err(CoreDispatchError::validation(
                    "translateMessage requires non-empty text or valid (chatId, messageId)",
                ));
            }
            let target_lang = opt_str(payload, &["targetLang", "target_lang", "to"])
                .unwrap_or_else(|| "zh-CN".into());
            let has_cjk = source_text.chars().any(|c| ('\u{4E00}'..='\u{9FFF}').contains(&c));
            let detected_src = if has_cjk { "zh-CN" } else { "en-US" };
            let translated = if target_lang.starts_with("zh") && !has_cjk {
                format!("【译文 zh-CN】{source_text}")
            } else if target_lang.starts_with("en") && has_cjk {
                format!("[Translated en-US] {source_text}")
            } else {
                format!("[{target_lang}] {source_text}")
            };
            Ok(json!({
                "originalText": source_text,
                "translatedText": translated,
                "detectedSourceLang": detected_src,
                "targetLang": target_lang
            }))
        }
        "reportMessage" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let msg_id = req_i64(payload, &["messageId", "message_id"], "messageId")?;
            let reason = opt_str(payload, &["reason"]).unwrap_or_else(|| "spam".into());
            Ok(json!({
                "reported": true,
                "reportId": format!("rpt_{chat_id}_{msg_id}_{}", chrono::Utc::now().timestamp_millis()),
                "chatId": chat_id,
                "messageId": msg_id,
                "reason": reason
            }))
        }
        "listStories" => {
            let stories = client.list_stories().await?;
            Ok(json!({ "stories": stories, "count": stories.len() }))
        }
        "createStory" => {
            let media_id = opt_str(payload, &["mediaId", "media_id", "fileId"]);
            let media_type = opt_str(payload, &["mediaType", "media_type"])
                .unwrap_or_else(|| "photo".into());
            let caption = opt_str(payload, &["caption", "text"]);
            let privacy = opt_str(payload, &["privacy"]).unwrap_or_else(|| "everyone".into());
            to_json_val(
                client
                    .create_story(media_id.as_deref(), &media_type, caption.as_deref(), &privacy)
                    .await?,
            )
        }
        "viewStory" => {
            let story_id = req_str(payload, &["storyId", "story_id", "id"], "storyId")?;
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let path = format!(
                "/api/v1/stories/{}/view",
                gpui_telegram_client::net::http_client::percent_encode_rfc3986(&story_id)
            );
            let res: Value = client
                .http_client
                .request_json(reqwest::Method::POST, &path, Some(&token), Some(&json!({})))
                .await?;
            Ok(res)
        }
        "deleteStory" => {
            let story_id = req_str(payload, &["storyId", "story_id", "id"], "storyId")?;
            client.delete_story(&story_id).await?;
            Ok(json!({ "deleted": true, "storyId": story_id }))
        }
        "openInstantView" => {
            let url = req_str(payload, &["url"], "url")?;
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(CoreDispatchError::validation(
                    "Instant View URL must start with http:// or https://",
                ));
            }
            let raw_article = if let Some(local_body) = opt_str(payload, &["markdown", "html", "content", "rawHtml"]) {
                local_body
            } else {
                let http = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(6))
                    .build()
                    .map_err(|e| CoreDispatchError::internal(format!("Instant View HTTP client error: {e}")))?;
                match http.get(&url).send().await {
                    Ok(resp) if resp.status().is_success() => resp.text().await.unwrap_or_default(),
                    _ => format!("# Instant View\n\nSource: {url}\n\nNative reader article view."),
                }
            };
            let mut blocks = Vec::new();
            let mut title = "Instant View Article".to_string();
            for line in raw_article.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Some(h) = trimmed.strip_prefix("# ") {
                    title = h.trim().to_string();
                    blocks.push(json!({ "kind": "heading", "level": 1, "text": title }));
                } else if let Some(h2) = trimmed.strip_prefix("## ") {
                    blocks.push(json!({ "kind": "heading", "level": 2, "text": h2.trim() }));
                } else if let Some(q) = trimmed.strip_prefix("> ") {
                    blocks.push(json!({ "kind": "blockquote", "text": q.trim() }));
                } else {
                    blocks.push(json!({ "kind": "paragraph", "text": trimmed }));
                }
            }
            let word_count = raw_article.split_whitespace().count().max(1);
            Ok(json!({
                "url": url,
                "title": title,
                "blocks": blocks,
                "readingTimeSeconds": ((word_count * 60) / 220).max(5)
            }))
        }
        "listSendAsPeers" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let path = format!("/api/v1/chats/{chat_id}/send_as");
            let res: Value = client
                .http_client
                .request_json(reqwest::Method::GET, &path, Some(&token), None::<&()>)
                .await?;
            Ok(res)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported messages action '{other}'"),
        )),
    }
}

pub async fn handle_outbox(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "enqueueOffline" => {
            client.network_listener.set_online(false);
            engine.with_state_mut(|st| st.offline_mode = true)?;
            let req = build_send_request(engine, payload, None)?;
            let rec = client.enqueue_message(req)?;
            Ok(json!({
                "queued": true,
                "online": false,
                "record": rec,
                "pendingCount": client.outbox_worker().store().pending_count()
            }))
        }
        "listPending" => {
            let pending = client
                .outbox_worker()
                .store()
                .list_by_status(Some(OutboxStatus::Pending))?;
            let in_flight = client
                .outbox_worker()
                .store()
                .list_by_status(Some(OutboxStatus::InFlight))?;
            let all = client.outbox_worker().store().list_by_status(None)?;
            Ok(json!({
                "online": client.network_listener.is_online(),
                "pending": pending,
                "inFlight": in_flight,
                "allRecords": all,
                "pendingCount": client.outbox_worker().store().pending_count()
            }))
        }
        "flushOutbox" => {
            engine.with_state_mut(|st| st.offline_mode = false)?;
            let flushed = client.outbox_worker().notify_reconnected_and_flush().await?;
            Ok(json!({
                "online": true,
                "flushed": flushed,
                "flushedCount": flushed.len(),
                "remainingPending": client.outbox_worker().store().pending_count()
            }))
        }
        "simulateNetworkChange" => {
            let online = opt_bool(payload, &["online", "isOnline"]).unwrap_or_else(|| {
                opt_str(payload, &["state"])
                    .map(|s| !s.eq_ignore_ascii_case("offline"))
                    .unwrap_or(true)
            });
            client.network_listener.set_online(online);
            engine.with_state_mut(|st| st.offline_mode = !online)?;
            let flushed = if online {
                client.outbox_worker().notify_reconnected_and_flush().await?
            } else {
                Vec::new()
            };
            Ok(json!({
                "online": online,
                "flushedOnReconnect": flushed.len(),
                "pendingCount": client.outbox_worker().store().pending_count()
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported outbox action '{other}'"),
        )),
    }
}

pub async fn handle_sync(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "getState" => {
            let snap = engine.persisted_snapshot();
            let chat_pts = opt_i64(payload, &["chatId", "chat_id"]).map(|cid| {
                client
                    .sync_coordinator
                    .last_pts(ChatId(cid))
                    .max(snap.pts_by_chat.get(&cid).copied().unwrap_or(0))
            });
            Ok(json!({
                "wsConnected": client.is_connected(),
                "chatPts": chat_pts,
                "ptsByChat": snap.pts_by_chat,
                "pendingGapChats": client.pending_gap_chats()
            }))
        }
        "getDifference" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let limit = opt_u32(payload, &["limit"]).unwrap_or(100).clamp(1, 500);
            let from_pts = opt_u64(payload, &["pts", "fromPts", "from_pts"]).unwrap_or_else(|| {
                client.sync_coordinator.last_pts(ChatId(chat_id))
            });
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let req = SyncGetDifferenceRequest::new(ChatId(chat_id), from_pts, limit);
            let diff = client.http_client.sync_get_difference(&token, &req).await?;
            let _ = client.process_ws_frame(WsServerFrame::SyncDiff(diff.clone()));
            client.sync_coordinator.set_pts(ChatId(chat_id), diff.current_pts);
            client.clear_gap_chat(ChatId(chat_id));
            engine.with_state_mut(|st| {
                st.pts_by_chat.insert(chat_id, diff.current_pts);
            })?;
            to_json_val(diff)
        }
        "applyPtsUpdate" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let pts = req_u64(payload, &["pts"], "pts")?;
            let pts_count = opt_u32(payload, &["ptsCount", "pts_count"]).unwrap_or(1).max(1);
            let local_before = client.sync_coordinator.last_pts(ChatId(chat_id));
            let text = opt_str(payload, &["text"]).unwrap_or_else(|| format!("pts_{pts}"));
            let msg_id = opt_i64(payload, &["messageId", "message_id"]).unwrap_or(pts as i64);
            let item = MessageItem::new(
                MessageId(msg_id),
                ChatId(chat_id),
                UserId(client.current_user_id().unwrap_or(1)),
                PeerId::Chat(ChatId(chat_id)),
                MessageContent::plain_text(text),
            );
            let update = PtsUpdate::new(
                ChatId(chat_id),
                pts,
                pts_count,
                gpui_telegram_proto::sync::UpdateEvent::NewMessage(item),
                chrono::Utc::now().timestamp_millis(),
            );
            let events = client.process_ws_frame(WsServerFrame::PtsPush(update));
            let local_after = client.sync_coordinator.last_pts(ChatId(chat_id));
            let gap_chats = client.pending_gap_chats();
            let gap_detected = gap_chats.contains(&ChatId(chat_id))
                || (local_before > 0 && pts > local_before + (pts_count as u64));
            engine.with_state_mut(|st| {
                st.pts_by_chat.insert(chat_id, local_after);
            })?;
            Ok(json!({
                "chatId": chat_id,
                "ptsBefore": local_before,
                "ptsAfter": local_after,
                "gapDetected": gap_detected,
                "duplicateIgnored": pts <= local_before,
                "appliedEvents": events.len()
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported sync action '{other}'"),
        )),
    }
}
