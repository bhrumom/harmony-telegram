//! Domains 3–6: `dialogs`, `folders`, `topics`, and `search`.

use gpui_telegram_client::net::{ChatFolderDto, CreateChatRequest, DraftDto};
use serde_json::{json, Value};

use crate::engine::TelegramCoreEngine;
use crate::helpers::{
    opt_bool, opt_i64, opt_i64_vec, opt_str, opt_u32, opt_u64_vec, opt_usize, req_i64, req_str,
    to_json_val, CoreDispatchError, CoreResult,
};

pub async fn handle_dialogs(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "listChats" => {
            let chats = client.get_chats().await?;
            Ok(json!({ "chats": chats, "count": chats.len() }))
        }
        "createChat" => {
            let title = opt_str(payload, &["title", "name"]).unwrap_or_else(|| "Direct Chat".into());
            let chat_type = opt_str(payload, &["chatType", "chat_type", "type", "kind"])
                .unwrap_or_else(|| "group".into());
            let mut members = opt_u64_vec(payload, &["memberIds", "member_ids", "userIds", "user_ids"]);
            if let Some(peer_uid) = opt_i64(payload, &["peerUserId", "peer_user_id", "userId"]) {
                if peer_uid > 0 && !members.contains(&(peer_uid as u64)) {
                    members.push(peer_uid as u64);
                }
            }
            let is_forum = opt_bool(payload, &["isForum", "is_forum"]).unwrap_or(chat_type == "forum");
            let about = opt_str(payload, &["about", "description"]);

            let mut map = serde_json::Map::new();
            map.insert("title".into(), Value::String(title));
            map.insert(
                "chat_type".into(),
                Value::String(if chat_type == "forum" {
                    "supergroup".into()
                } else {
                    chat_type
                }),
            );
            map.insert("member_ids".into(), to_json_val(&members)?);
            map.insert("is_forum".into(), Value::Bool(is_forum));
            if let Some(ab) = about {
                map.insert("about".into(), Value::String(ab));
            }
            let req: CreateChatRequest = serde_json::from_value(Value::Object(map))?;
            let chat = client.create_chat(&req).await?;
            to_json_val(chat)
        }
        "getChat" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            to_json_val(client.get_chat(chat_id).await?)
        }
        "updateChat" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let title = opt_str(payload, &["title", "name"]);
            let about = opt_str(payload, &["about", "description"]);
            let updated = client
                .update_chat_info(chat_id, title.as_deref(), about.as_deref())
                .await?;
            Ok(json!({ "updated": updated, "chatId": chat_id }))
        }
        "deleteChat" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            client.delete_chat(chat_id).await?;
            Ok(json!({ "deleted": true, "chatId": chat_id }))
        }
        "clearHistory" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            client.clear_chat_history(chat_id).await?;
            Ok(json!({ "cleared": true, "chatId": chat_id }))
        }
        "leaveChat" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            client.leave_or_delete_chat(chat_id).await?;
            Ok(json!({ "left": true, "chatId": chat_id }))
        }
        "setArchive" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let archived = opt_bool(payload, &["archived"]).unwrap_or(true);
            client.set_chat_archived(chat_id, archived).await?;
            Ok(json!({ "chatId": chat_id, "archived": archived }))
        }
        "setPin" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let pinned = opt_bool(payload, &["pinned"]).unwrap_or(true);
            client.set_chat_pinned(chat_id, pinned).await?;
            Ok(json!({ "chatId": chat_id, "pinned": pinned }))
        }
        "setMute" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let muted = opt_bool(payload, &["muted"]).unwrap_or(true);
            let until = opt_i64(payload, &["muteUntilMs", "mute_until_ms"]);
            client.set_chat_muted(chat_id, muted, until).await?;
            Ok(json!({ "chatId": chat_id, "muted": muted, "muteUntilMs": until }))
        }
        "setTtl" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let ttl = opt_u32(payload, &["ttlSeconds", "ttl_seconds", "ttl"]).unwrap_or(0);
            let applied = client.set_chat_ttl(chat_id, ttl).await?;
            Ok(json!({ "chatId": chat_id, "ttlSeconds": applied }))
        }
        "getDraft" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let draft = client.get_draft(chat_id).await?;
            Ok(json!({ "chatId": chat_id, "draft": draft }))
        }
        "saveDraft" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let text = req_str(payload, &["text"], "text")?;
            let reply_to = opt_i64(payload, &["replyToMsgId", "reply_to_msg_id", "replyTo"]);
            let mut map = serde_json::Map::new();
            map.insert("chat_id".into(), json!(chat_id));
            map.insert("text".into(), Value::String(text));
            if let Some(r) = reply_to {
                map.insert("reply_to_msg_id".into(), json!(r));
            }
            let dto: DraftDto = serde_json::from_value(Value::Object(map))?;
            to_json_val(client.save_draft(chat_id, &dto).await?)
        }
        "clearDraft" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            client.clear_draft(chat_id).await?;
            Ok(json!({ "cleared": true, "chatId": chat_id }))
        }
        "provisionWelcomeChat" => to_json_val(client.provision_welcome_chat().await?),
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported dialogs action '{other}'"),
        )),
    }
}

fn build_folder_dto(payload: &Value, id_override: Option<i64>) -> CoreResult<ChatFolderDto> {
    let title = req_str(payload, &["title", "name"], "title")?;
    let included = opt_i64_vec(payload, &["includedChatIds", "included_chat_ids", "includeChats", "include_chats"]);
    let excluded = opt_i64_vec(payload, &["excludedChatIds", "excluded_chat_ids", "excludeChats", "exclude_chats"]);
    let pinned = opt_i64_vec(payload, &["pinnedChatIds", "pinned_chat_ids", "pinnedChats", "pinned_chats"]);
    Ok(ChatFolderDto {
        id: id_override
            .or_else(|| opt_i64(payload, &["folderId", "folder_id", "id"]))
            .unwrap_or(0),
        title,
        emoticon: opt_str(payload, &["icon", "emoticon"]).or_else(|| Some("📁".into())),
        include_chats: included,
        exclude_chats: excluded,
        pinned_chats: pinned,
        include_contacts: opt_bool(payload, &["includeContacts", "include_contacts"]).unwrap_or(false),
        include_non_contacts: opt_bool(payload, &["includeNonContacts", "include_non_contacts"]).unwrap_or(false),
        include_groups: opt_bool(payload, &["includeGroups", "include_groups"]).unwrap_or(true),
        include_channels: opt_bool(payload, &["includeChannels", "include_channels"]).unwrap_or(true),
        include_bots: opt_bool(payload, &["includeBots", "include_bots"]).unwrap_or(false),
        exclude_muted: opt_bool(payload, &["excludeMuted", "exclude_muted"]).unwrap_or(false),
        exclude_read: opt_bool(payload, &["excludeRead", "exclude_read"]).unwrap_or(false),
        exclude_archived: opt_bool(payload, &["excludeArchived", "exclude_archived"]).unwrap_or(false),
        sort_order: opt_i64(payload, &["sortOrder", "sort_order"]).unwrap_or(0) as i32,
    })
}

pub async fn handle_folders(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "listFolders" => {
            let folders = client.list_folders().await?;
            Ok(json!({ "folders": folders, "count": folders.len() }))
        }
        "createFolder" => {
            let dto = build_folder_dto(payload, None)?;
            to_json_val(client.save_folder(&dto).await?)
        }
        "updateFolder" => {
            let fid = req_i64(payload, &["folderId", "folder_id", "id"], "folderId")?;
            let dto = build_folder_dto(payload, Some(fid))?;
            to_json_val(client.update_folder(fid, &dto).await?)
        }
        "deleteFolder" => {
            let fid = req_i64(payload, &["folderId", "folder_id", "id"], "folderId")?;
            client.delete_folder(fid).await?;
            Ok(json!({ "deleted": true, "folderId": fid }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported folders action '{other}'"),
        )),
    }
}

pub async fn handle_topics(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "listTopics" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let topics = client.list_forum_topics(chat_id).await?;
            Ok(json!({ "topics": topics, "count": topics.len() }))
        }
        "createTopic" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let title = req_str(payload, &["title", "name"], "title")?;
            let color = opt_i64(payload, &["iconColor", "icon_color"]).unwrap_or(0x6FB9F0) as i32;
            let emoji_id = opt_i64(payload, &["iconEmojiId", "icon_emoji_id"]);
            to_json_val(
                client
                    .create_forum_topic(chat_id, &title, color, emoji_id)
                    .await?,
            )
        }
        "updateTopic" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let topic_id = req_i64(payload, &["topicId", "topic_id"], "topicId")?;
            let title = opt_str(payload, &["title", "name"]);
            let is_pinned = opt_bool(payload, &["isPinned", "is_pinned", "pinned"]);
            let is_closed = opt_bool(payload, &["isClosed", "is_closed", "closed"]);
            let ok = client
                .update_forum_topic(chat_id, topic_id, title.as_deref(), is_pinned, is_closed)
                .await?;
            Ok(json!({ "updated": ok, "chatId": chat_id, "topicId": topic_id }))
        }
        "deleteTopic" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let topic_id = req_i64(payload, &["topicId", "topic_id"], "topicId")?;
            let ok = client.delete_forum_topic(chat_id, topic_id).await?;
            Ok(json!({ "deleted": ok, "chatId": chat_id, "topicId": topic_id }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported topics action '{other}'"),
        )),
    }
}

pub async fn handle_search(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    let query = opt_str(payload, &["query", "q"]).unwrap_or_default();
    let limit = opt_usize(payload, &["limit"]).unwrap_or(50).clamp(1, 200);

    match action {
        "searchAll" => {
            let msg_res = client.search_messages(&query, None, None, limit).await?;
            let catalog = client.search_global_catalog(&query, None).await.ok();
            let q_lower = query.to_lowercase();
            let chats: Vec<_> = client
                .get_chats()
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|c| q_lower.is_empty() || c.title.to_lowercase().contains(&q_lower))
                .take(limit)
                .collect();
            Ok(json!({
                "query": query,
                "chats": chats,
                "messages": msg_res,
                "catalog": catalog
            }))
        }
        "searchChats" => {
            let q_lower = query.to_lowercase();
            let chats: Vec<_> = client
                .get_chats()
                .await?
                .into_iter()
                .filter(|c| q_lower.is_empty() || c.title.to_lowercase().contains(&q_lower))
                .take(limit)
                .collect();
            Ok(json!({ "query": query, "chats": chats, "count": chats.len() }))
        }
        "searchMessages" => {
            let filter = opt_str(payload, &["filter", "mediaFilter"]);
            let chat_id = opt_i64(payload, &["chatId", "chat_id"]);
            to_json_val(
                client
                    .search_messages(&query, filter.as_deref(), chat_id, limit)
                    .await?,
            )
        }
        "searchHybrid" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let chat_id = opt_i64(payload, &["chatId", "chat_id"]);
            let filter = opt_str(payload, &["filter"]);
            let encoded_q = gpui_telegram_client::net::http_client::percent_encode_rfc3986(&query);
            let mut path = format!("/api/v1/search?q={encoded_q}&mode=hybrid&limit={limit}");
            if let Some(cid) = chat_id {
                path.push_str(&format!("&chat_id={cid}"));
            }
            if let Some(ref f) = filter {
                let ef = gpui_telegram_client::net::http_client::percent_encode_rfc3986(f);
                path.push_str(&format!("&filter={ef}"));
            }
            let res: Value = client
                .http_client
                .request_json(reqwest::Method::GET, &path, Some(&token), None::<&()>)
                .await?;
            Ok(res)
        }
        "searchGlobalCatalog" => {
            let cat = opt_str(payload, &["category"]);
            to_json_val(client.search_global_catalog(&query, cat.as_deref()).await?)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported search action '{other}'"),
        )),
    }
}
