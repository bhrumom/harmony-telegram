//! Domains 19–21: `bots` (BotFather, NL Bot Builder, Bot API, Inline/Callback Queries),
//! `miniapps` (Catalog, WASM Verification, HMAC-SHA256 InitData, CloudStorage, A2UI/GenUI),
//! and `fabushi` (全球法布施 3D Globe, Zen Room, 8 Sutras, Leaderboard, Dharma AI Guide).

use std::collections::BTreeMap;
use std::fs;

use fabushi_miniapp::countries::{all_countries, country_by_code};
use fabushi_miniapp::scene_math::{project_lat_lng_3d, GlobeSceneState};
use fabushi_miniapp::sutras::{all_dharma_packages, all_sutras, sutra_by_title};
use gpui_telegram_client::net::{
    CreateBotRequest, CreateMiniAppRequest, MiniAppLaunchMode,
};
use gpui_telegram_proto::miniapp_contracts::{
    CreateFabushiBotRequest, PatchFabushiBotRequest,
};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::engine::TelegramCoreEngine;
use crate::helpers::{
    b64_decode, opt_bool, opt_i64, opt_str, opt_u64, req_i64, req_str, req_u64, sha256_hex,
    to_json_val, CoreDispatchError, CoreResult,
};

fn compute_webapp_init_data_hash(data_check_string: &str, bot_token: &str) -> String {
    let mut secret_mac =
        <Hmac<Sha256> as Mac>::new_from_slice(b"WebAppData").expect("HMAC accepts any key size");
    secret_mac.update(bot_token.as_bytes());
    let secret_key = secret_mac.finalize().into_bytes();

    let mut data_mac =
        <Hmac<Sha256> as Mac>::new_from_slice(&secret_key).expect("HMAC accepts 32-byte key");
    data_mac.update(data_check_string.as_bytes());
    let digest = data_mac.finalize().into_bytes();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn verify_local_init_data_hmac(init_data: &str, bot_token: &str) -> CoreResult<bool> {
    let mut pairs: BTreeMap<String, String> = BTreeMap::new();
    let mut provided_hash: Option<String> = None;
    for seg in init_data.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = seg.split_once('=').unwrap_or((seg, ""));
        if k == "hash" {
            provided_hash = Some(v.to_ascii_lowercase());
        } else {
            pairs.insert(k.to_string(), v.to_string());
        }
    }
    let Some(expected_hex) = provided_hash else {
        return Err(CoreDispatchError::validation(
            "initData is missing required 'hash' parameter",
        ));
    };
    let check_string = pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n");
    let computed = compute_webapp_init_data_hash(&check_string, bot_token);
    Ok(computed == expected_hex)
}

pub async fn handle_bots(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "createBot" => {
            if opt_bool(payload, &["isAiCompanion", "isFabushiBot"]).unwrap_or(false)
                || payload.get("systemPrompt").is_some()
            {
                let name = req_str(payload, &["displayName", "title", "name", "username"], "name")?;
                let uname = opt_str(payload, &["username"]).unwrap_or_else(|| {
                    format!(
                        "{}_bot",
                        name.to_ascii_lowercase()
                            .replace(|c: char| !c.is_ascii_alphanumeric(), "_")
                    )
                });
                let mut map = serde_json::Map::new();
                map.insert("username".into(), Value::String(uname));
                map.insert("display_name".into(), Value::String(name.clone()));
                map.insert("title".into(), Value::String(name));
                if let Some(sp) = opt_str(payload, &["systemPrompt", "system_prompt"]) {
                    map.insert("system_prompt".into(), Value::String(sp));
                }
                if let Some(model) = opt_str(payload, &["model"]) {
                    map.insert("model".into(), Value::String(model));
                }
                let req: CreateFabushiBotRequest = serde_json::from_value(Value::Object(map))?;
                return to_json_val(client.create_fabushi_bot(&req).await?);
            }

            let username = req_str(payload, &["username"], "username")?;
            let title = opt_str(payload, &["displayName", "display_name", "title", "name"])
                .unwrap_or_else(|| username.clone());
            let about = opt_str(payload, &["about", "description"]).unwrap_or_default();
            let req = CreateBotRequest {
                display_name: title,
                username,
                description: about.clone(),
                about,
                ai_persona: opt_str(payload, &["aiPersona", "ai_persona"]).unwrap_or_default(),
                menu_button_text: opt_str(payload, &["menuButtonText", "menu_button_text"]),
                menu_button_url: opt_str(payload, &["menuButtonUrl", "menu_button_url"]),
                allow_attach_menu: opt_bool(payload, &["allowAttachMenu", "allow_attach_menu"]).unwrap_or(false),
                ..CreateBotRequest::default()
            };
            let created = client.create_bot(&req).await?;
            let mut val = to_json_val(&created)?;
            if let Some(bt) = val.get("bot_token").cloned() {
                val["token"] = bt.clone();
                val["botToken"] = bt;
            }
            Ok(val)
        }
        "createBotFromPrompt" => {
            let prompt = req_str(payload, &["prompt", "description"], "prompt")?;
            let shape = opt_str(payload, &["avatarShape", "avatar_shape"]);
            let color = opt_str(payload, &["avatarColor", "avatar_color"]);
            let created = client
                .create_from_natural_language_with_avatar(&prompt, shape, color)
                .await?;
            let mut val = to_json_val(&created)?;
            val["token"] = Value::String(created.bot_token.clone());
            val["botToken"] = Value::String(created.bot_token);
            Ok(val)
        }
        "listBots" => {
            let my_bots = client.list_my_bots().await?;
            let fabushi_bots = client.list_fabushi_bots().await.unwrap_or_default();
            let attach_menu = client.list_attach_menu_bots().await.unwrap_or_default();
            Ok(json!({
                "bots": my_bots,
                "fabushiBots": fabushi_bots,
                "attachMenuBots": attach_menu
            }))
        }
        "getBotProfile" => {
            if let Some(bid) = opt_u64(payload, &["botId", "bot_id"]) {
                if let Ok(fb) = client.get_fabushi_bot(bid).await {
                    return to_json_val(fb);
                }
                return to_json_val(client.get_bot_public_profile(&bid.to_string()).await?);
            }
            let target = req_str(payload, &["target", "username"], "target")?;
            to_json_val(client.get_bot_public_profile(target.trim_start_matches('@')).await?)
        }
        "updateBotProfile" => {
            if let Some(bot_token) = opt_str(payload, &["botToken", "bot_token"]) {
                if let Some(desc) = opt_str(payload, &["description", "about"]) {
                    let path = format!("/bot/{bot_token}/setMyDescription");
                    let _: Value = client
                        .http_client
                        .request_json(
                            reqwest::Method::POST,
                            &path,
                            None,
                            Some(&json!({ "description": desc })),
                        )
                        .await?;
                }
                if let Some(name) = opt_str(payload, &["displayName", "name"]) {
                    let path = format!("/bot/{bot_token}/setMyName");
                    let _: Value = client
                        .http_client
                        .request_json(
                            reqwest::Method::POST,
                            &path,
                            None,
                            Some(&json!({ "name": name })),
                        )
                        .await?;
                }
                return Ok(json!({ "updated": true }));
            }
            let bot_id = req_u64(payload, &["botId", "bot_id"], "botId")?;
            let req: PatchFabushiBotRequest = serde_json::from_value(payload.clone())?;
            to_json_val(client.patch_fabushi_bot(bot_id, &req).await?)
        }
        "setBotCommands" => {
            let bot_token = req_str(payload, &["botToken", "bot_token"], "botToken")?;
            let commands = payload
                .get("commands")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let path = format!("/bot/{bot_token}/setMyCommands");
            let res: Value = client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    &path,
                    None,
                    Some(&json!({ "commands": commands })),
                )
                .await?;
            Ok(res)
        }
        "regenerateToken" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let bot_id = if let Some(id) = opt_u64(payload, &["botId", "bot_id", "botUserId", "bot_user_id"]) {
                id as i64
            } else {
                let uname = req_str(payload, &["botUsername", "username"], "botId")?;
                let prof = client.get_bot_public_profile(uname.trim_start_matches('@')).await?;
                prof.bot.bot_user_id
            };
            let path = format!("/api/v1/bots/{bot_id}/regenerate-token");
            let res: Value = client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    &path,
                    Some(&token),
                    Some(&json!({})),
                )
                .await?;
            Ok(res)
        }
        "addBotToChat" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let bot_uid = if let Some(id) = opt_u64(payload, &["botUserId", "bot_user_id", "botId"]) {
                id
            } else {
                let uname = req_str(payload, &["botUsername", "username"], "botUserId/botUsername")?;
                let prof = client.resolve_peer(uname.trim_start_matches('@')).await?;
                let pv = to_json_val(prof)?;
                pv.get("user_id")
                    .or_else(|| pv.get("id"))
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| CoreDispatchError::not_found("Resolved bot missing user_id"))?
            };
            let added = client.add_chat_members(chat_id, &[bot_uid]).await?;
            Ok(json!({ "added": added, "chatId": chat_id, "botUserId": bot_uid }))
        }
        "sendCallbackQuery" => {
            let chat_id = req_i64(payload, &["chatId", "chat_id"], "chatId")?;
            let msg_id = req_i64(payload, &["messageId", "message_id", "msgId"], "messageId")?;
            let data = req_str(payload, &["callbackData", "callback_data", "data"], "callbackData")?;
            to_json_val(client.send_chat_callback(chat_id, msg_id, &data).await?)
        }
        "inlineQuery" => {
            let bot_username = req_str(payload, &["botUsername", "bot_username", "username"], "botUsername")?;
            let query = opt_str(payload, &["query", "q"]).unwrap_or_default();
            let clean = bot_username.trim_start_matches('@');
            let bot_prof = client.get_bot_public_profile(clean).await?;
            let apps = client.list_mini_apps(Some(&query), None).await?;
            let q_lower = query.to_lowercase();
            let mut results: Vec<Value> = Vec::new();
            for cmd in &bot_prof.bot.commands {
                if q_lower.is_empty()
                    || cmd.command.to_lowercase().contains(&q_lower)
                    || cmd.description.to_lowercase().contains(&q_lower)
                {
                    results.push(json!({
                        "id": format!("cmd_{}_{}", bot_prof.bot.bot_user_id, cmd.command),
                        "type": "article",
                        "title": format!("/{} — {}", cmd.command, bot_prof.bot.display_name),
                        "description": cmd.description,
                        "messageText": format!("/{} {}", cmd.command, query).trim().to_string()
                    }));
                }
            }
            for app in &apps {
                if app.bot_username.eq_ignore_ascii_case(clean) || q_lower.is_empty() || app.title.to_lowercase().contains(&q_lower) {
                    results.push(json!({
                        "id": format!("app_{}_{}", app.bot_username, app.short_name),
                        "type": "web_app",
                        "title": app.title,
                        "description": app.description,
                        "url": format!("gpui-miniapp://{}/{}", app.bot_username, app.short_name)
                    }));
                }
            }
            if results.is_empty() {
                results.push(json!({
                    "id": format!("bot_{}_profile", bot_prof.bot.bot_user_id),
                    "type": "article",
                    "title": bot_prof.bot.display_name,
                    "description": bot_prof.bot.description,
                    "messageText": if query.is_empty() { bot_prof.bot.description.clone() } else { query.clone() }
                }));
            }
            Ok(json!({
                "botId": bot_prof.bot.bot_user_id,
                "botUsername": bot_prof.bot.username,
                "query": query,
                "results": results,
                "matchingMiniApps": apps
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported bots action '{other}'"),
        )),
    }
}

fn validate_a2ui_node(node: &Value, depth: usize) -> CoreResult<usize> {
    if depth > 16 {
        return Err(CoreDispatchError::validation(
            "A2UI schema exceeds maximum component nesting depth (16)",
        ));
    }
    let obj = node
        .as_object()
        .ok_or_else(|| CoreDispatchError::validation("A2UI node must be a JSON object"))?;
    let kind = obj
        .get("type")
        .or_else(|| obj.get("component"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreDispatchError::validation("A2UI node missing 'type' or 'component'"))?;
    const ALLOWED: &[&str] = &[
        "Card", "Column", "Row", "Text", "Button", "Image", "Input", "Badge", "Divider", "List",
        "Stat", "Progress",
    ];
    if !ALLOWED.contains(&kind) {
        return Err(CoreDispatchError::validation(format!(
            "Disallowed A2UI component type '{kind}'"
        )));
    }
    if let Some(url) = obj.get("url").or_else(|| obj.get("href")).and_then(|v| v.as_str()) {
        if url.trim().to_ascii_lowercase().starts_with("javascript:") {
            return Err(CoreDispatchError::validation(
                "Blocked unsafe javascript: URI in A2UI component",
            ));
        }
    }
    let mut total = 1usize;
    if let Some(children) = obj.get("children").and_then(|c| c.as_array()) {
        for child in children {
            total += validate_a2ui_node(child, depth + 1)?;
        }
    }
    Ok(total)
}

pub async fn handle_miniapps(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "listCatalog" => {
            let query = opt_str(payload, &["query", "q"]);
            let category = opt_str(payload, &["category"]);
            let catalog = client
                .list_mini_apps(query.as_deref(), category.as_deref())
                .await?;
            let installed = client.list_installed_mini_apps().await.unwrap_or_default();
            Ok(json!({
                "apps": catalog,
                "installed": installed,
                "count": catalog.len()
            }))
        }
        "registerMiniApp" => {
            let bot_username = req_str(payload, &["botUsername", "bot_username"], "botUsername")?;
            let short_name = req_str(payload, &["shortName", "short_name"], "shortName")?;
            let title = opt_str(payload, &["title", "name"]).unwrap_or_else(|| short_name.clone());
            let url = opt_str(payload, &["webUrl", "web_url", "url", "webAppUrl"])
                .unwrap_or_else(|| format!("gpui-miniapp://{bot_username}/{short_name}"));
            let req = CreateMiniAppRequest {
                bot_username: bot_username.trim_start_matches('@').to_string(),
                short_name,
                title,
                description: opt_str(payload, &["description", "about"]).unwrap_or_default(),
                category: opt_str(payload, &["category"]).unwrap_or_else(|| "utilities".into()),
                icon_emoji: opt_str(payload, &["iconEmoji", "icon_emoji"]).unwrap_or_else(|| "🧩".into()),
                web_url: Some(url),
                ..CreateMiniAppRequest::default()
            };
            to_json_val(client.create_mini_app(&req).await?)
        }
        "uploadWasm" => {
            let bytes = if let Some(b64) = opt_str(payload, &["wasmBase64", "wasm_base64", "dataBase64"]) {
                b64_decode(&b64)?
            } else {
                let p = req_str(payload, &["filePath", "file_path"], "wasmBase64/filePath")?;
                fs::read(&p).map_err(|e| CoreDispatchError::validation(format!("Read error: {e}")))?
            };
            if bytes.len() < 8 || &bytes[..8] != b"\0asm\x01\x00\x00\x00" {
                return Err(CoreDispatchError::validation(
                    "Invalid WebAssembly binary: missing \\0asm version 1 magic header",
                ));
            }
            let fname = opt_str(payload, &["filename"]).unwrap_or_else(|| "miniapp.wasm".into());
            let uploaded = client
                .upload_media(&fname, "application/wasm", bytes.clone())
                .await?;
            Ok(json!({
                "validWasm": true,
                "sha256": sha256_hex(&bytes),
                "sizeBytes": bytes.len(),
                "upload": uploaded
            }))
        }
        "launchMiniApp" => {
            let (bot_username, short_name) = if let Some(uri) = opt_str(payload, &["uri", "schemeUrl"]) {
                let rest = uri
                    .strip_prefix("gpui-miniapp://")
                    .ok_or_else(|| CoreDispatchError::validation("URI must use gpui-miniapp://"))?;
                let path_part = rest.split('?').next().unwrap_or(rest);
                let (b, s) = path_part.split_once('/').ok_or_else(|| {
                    CoreDispatchError::validation("gpui-miniapp:// URI requires <bot>/<short_name>")
                })?;
                (b.to_string(), s.to_string())
            } else {
                (
                    req_str(payload, &["botUsername", "bot_username"], "botUsername")?,
                    req_str(payload, &["shortName", "short_name"], "shortName")?,
                )
            };
            let chat_id = opt_i64(payload, &["chatId", "chat_id"]);
            let start_param = opt_str(payload, &["startParam", "start_param"]);
            let custom_url = opt_str(payload, &["customUrl", "custom_url"]);
            let mode: MiniAppLaunchMode = payload
                .get("launchMode")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let ctx = client
                .launch_mini_app_with_url(
                    bot_username.trim_start_matches('@'),
                    &short_name,
                    chat_id,
                    mode,
                    start_param.as_deref(),
                    custom_url.as_deref(),
                )
                .await?;
            to_json_val(ctx)
        }
        "verifyInitDataHmac" => {
            let init_data = req_str(payload, &["initData", "init_data"], "initData")?;
            if let Some(bot_token) = opt_str(payload, &["botToken", "bot_token"]) {
                let ok = verify_local_init_data_hmac(&init_data, &bot_token)?;
                if !ok {
                    return Err(CoreDispatchError::unauthorized(
                        "Telegram WebApp initData HMAC-SHA256 signature mismatch",
                    ));
                }
                return Ok(json!({ "valid": true, "verifiedLocally": true }));
            }
            let bot_username = req_str(payload, &["botUsername", "bot_username"], "botUsername")?;
            let short_name = req_str(payload, &["shortName", "short_name"], "shortName")?;
            let res = client
                .validate_mini_app_init_data(&bot_username, &short_name, &init_data)
                .await?;
            let res_val = to_json_val(&res)?;
            if res_val.get("valid").and_then(|v| v.as_bool()) == Some(false) {
                return Err(CoreDispatchError::unauthorized(
                    "Server rejected MiniApp initData signature",
                ));
            }
            Ok(res_val)
        }
        "cloudStorageSet" => {
            let bot_username = req_str(payload, &["botUsername", "bot_username"], "botUsername")?;
            let short_name = req_str(payload, &["shortName", "short_name"], "shortName")?;
            let key = req_str(payload, &["key"], "key")?;
            if key.len() > 128 {
                return Err(CoreDispatchError::validation("CloudStorage key exceeds 128 bytes"));
            }
            let value = opt_str(payload, &["value"]).unwrap_or_default();
            if value.len() > 4096 {
                return Err(CoreDispatchError::validation("CloudStorage value exceeds 4096 bytes"));
            }
            to_json_val(
                client
                    .set_cloud_storage_item(&bot_username, &short_name, &key, &value)
                    .await?,
            )
        }
        "cloudStorageGet" => {
            let bot_username = req_str(payload, &["botUsername", "bot_username"], "botUsername")?;
            let short_name = req_str(payload, &["shortName", "short_name"], "shortName")?;
            let items = client.get_cloud_storage(&bot_username, &short_name).await?;
            if let Some(filter_key) = opt_str(payload, &["key"]) {
                let item = items.into_iter().find(|i| i.key == filter_key);
                return Ok(json!({ "key": filter_key, "item": item }));
            }
            Ok(json!({ "items": items, "count": items.len() }))
        }
        "cloudStorageDelete" => {
            let bot_username = req_str(payload, &["botUsername", "bot_username"], "botUsername")?;
            let short_name = req_str(payload, &["shortName", "short_name"], "shortName")?;
            let key = req_str(payload, &["key"], "key")?;
            let ok = client
                .delete_cloud_storage_item(&bot_username, &short_name, &key)
                .await?;
            Ok(json!({ "deleted": ok, "key": key }))
        }
        "renderUiSchema" => {
            let root = payload
                .get("schema")
                .or_else(|| payload.get("root"))
                .unwrap_or(payload);
            let node_count = validate_a2ui_node(root, 0)?;
            Ok(json!({
                "valid": true,
                "renderedNodeCount": node_count,
                "schema": root
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported miniapps action '{other}'"),
        )),
    }
}

pub async fn handle_fabushi(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "bootstrap" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let boot: Value = client
                .http_client
                .request_json(
                    reqwest::Method::GET,
                    "/api/v1/miniapps/fabushi/bootstrap",
                    Some(&token),
                    None::<&()>,
                )
                .await?;
            Ok(json!({
                "bootstrap": boot,
                "countryCount": all_countries().len(),
                "sutraCount": all_sutras().len(),
                "packageCount": all_dharma_packages().len(),
                "theme": {
                    "spaceDeepBlue": fabushi_miniapp::theme::SPACE_DEEP_BLUE,
                    "cosmicGold": fabushi_miniapp::theme::COSMIC_GOLD,
                    "zenGold": fabushi_miniapp::theme::ZEN_GOLD
                }
            }))
        }
        "getProfile" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            client
                .http_client
                .request_json(
                    reqwest::Method::GET,
                    "/api/v1/miniapps/fabushi/profile",
                    Some(&token),
                    None::<&()>,
                )
                .await
                .map_err(Into::into)
        }
        "updateProfile" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            client
                .http_client
                .request_json(
                    reqwest::Method::PUT,
                    "/api/v1/miniapps/fabushi/profile",
                    Some(&token),
                    Some(payload),
                )
                .await
                .map_err(Into::into)
        }
        "getGlobe" => {
            let from_code = opt_str(payload, &["fromCountry", "originCountry"]).unwrap_or_else(|| "CN".into());
            let to_code = opt_str(payload, &["toCountry", "targetCountry"]).unwrap_or_else(|| "US".into());
            let from_node = country_by_code(&from_code)
                .ok_or_else(|| CoreDispatchError::validation(format!("Unknown ISO country '{from_code}'")))?;
            let to_node = country_by_code(&to_code)
                .ok_or_else(|| CoreDispatchError::validation(format!("Unknown ISO country '{to_code}'")))?;
            let mut globe = GlobeSceneState::default();
            globe.add_beam(
                from_node.latitude,
                from_node.longitude,
                to_node.latitude,
                to_node.longitude,
                Some(to_node.name_zh.clone()),
                0.0,
                2000.0,
            );
            let p_from = project_lat_lng_3d(
                from_node.latitude,
                from_node.longitude,
                200.0,
                200.0,
                160.0,
                globe.rotation_lon_deg,
                globe.tilt_lat_deg,
                -1.0,
            );
            let p_to = project_lat_lng_3d(
                to_node.latitude,
                to_node.longitude,
                200.0,
                200.0,
                160.0,
                globe.rotation_lon_deg,
                globe.tilt_lat_deg,
                -1.0,
            );
            Ok(json!({
                "totalCountries": all_countries().len(),
                "beamCount": globe.beams.len(),
                "from": {
                    "code": from_node.code,
                    "nameZh": from_node.name_zh,
                    "lat": from_node.latitude,
                    "lng": from_node.longitude,
                    "projected": p_from.map(|p| json!({ "x": p.x, "y": p.y, "z": p.z }))
                },
                "to": {
                    "code": to_node.code,
                    "nameZh": to_node.name_zh,
                    "lat": to_node.latitude,
                    "lng": to_node.longitude,
                    "projected": p_to.map(|p| json!({ "x": p.x, "y": p.y, "z": p.z }))
                }
            }))
        }
        "createOffering" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let to_country = opt_str(payload, &["toCountry", "targetCountry", "target_country", "countryCode"])
                .unwrap_or_else(|| "JP".into());
            if to_country != "ALL" && country_by_code(&to_country).is_none() {
                return Err(CoreDispatchError::validation(format!(
                    "Invalid target ISO country code '{to_country}'"
                )));
            }
            let sutra_title = opt_str(payload, &["contentTitle", "content_title", "sutraTitle", "sutra_title", "title"])
                .unwrap_or_else(|| "金刚经".into());
            let sutra = sutra_by_title(&sutra_title).unwrap_or_else(|| &all_sutras()[0]);
            let count = opt_u64(payload, &["beamCount", "beam_count", "count", "copies"]).unwrap_or(1).max(1);
            let bytes_offered = opt_u64(payload, &["bytesSent", "bytes_sent", "bytes"])
                .unwrap_or_else(|| (sutra.content.len() as u64).saturating_mul(count));
            let kind = opt_str(payload, &["contentKind", "content_kind", "offeringType", "kind"])
                .unwrap_or_else(|| "sutra".into());
            let req_body = json!({
                "content_title": sutra.title,
                "content_kind": kind,
                "target_countries": [to_country],
                "bytes_sent": bytes_offered,
                "beam_count": count as u32
            });
            let mut res: Value = client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/miniapps/fabushi/transfer",
                    Some(&token),
                    Some(&req_body),
                )
                .await?;
            let merit_gained = (count.saturating_mul(10)).max(10);
            res["merit_gained"] = json!(merit_gained);
            res["meritGained"] = json!(merit_gained);
            res["bytesOffered"] = json!(bytes_offered);
            res["targetCountry"] = json!(to_country);
            Ok(res)
        }
        "recordMeditation" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let duration_secs = opt_u64(payload, &["durationSeconds", "duration_seconds", "seconds"])
                .unwrap_or_else(|| opt_u64(payload, &["durationMinutes", "duration_minutes"]).unwrap_or(10) * 60);
            if duration_secs == 0 {
                return Err(CoreDispatchError::validation("durationSeconds must be > 0"));
            }
            let duration_mins = ((duration_secs + 59) / 60).max(1) as u32;
            let subject = opt_str(payload, &["sutra", "sutraName", "sutra_name", "subject", "sutraTitle", "practiceType"])
                .unwrap_or_else(|| "禅定静坐".into());
            let count = opt_u64(payload, &["chantCount", "chant_count", "count"]).unwrap_or(1) as u32;
            let notes = opt_str(payload, &["notes", "dedication"]);
            let req_body = json!({
                "sutra": subject,
                "duration_minutes": duration_mins,
                "chant_count": count,
                "notes": notes
            });
            let res: Value = client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/miniapps/fabushi/practice/session",
                    Some(&token),
                    Some(&req_body),
                )
                .await?;
            Ok(res)
        }
        "listPracticeRecords" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            client
                .http_client
                .request_json(
                    reqwest::Method::GET,
                    "/api/v1/miniapps/fabushi/practice/record",
                    Some(&token),
                    None::<&()>,
                )
                .await
                .map_err(Into::into)
        }
        "listSutras" => {
            let sutras = all_sutras();
            let packages = all_dharma_packages();
            Ok(json!({
                "sutras": sutras,
                "packages": packages,
                "count": sutras.len()
            }))
        }
        "completeSutra" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let title = req_str(payload, &["sutraTitle", "sutraId", "title", "id"], "sutraTitle")?;
            let sutra = sutra_by_title(&title).ok_or_else(|| {
                CoreDispatchError::not_found(format!("Unknown canonical sutra '{title}'"))
            })?;
            let rec: Value = client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/miniapps/fabushi/practice/session",
                    Some(&token),
                    Some(&json!({
                        "sutra": sutra.title,
                        "chant_count": 1,
                        "duration_minutes": 5
                    })),
                )
                .await?;
            Ok(json!({
                "completed": true,
                "sutraId": sutra.id,
                "sutraTitle": sutra.title,
                "byteCount": sutra.content.len(),
                "record": rec
            }))
        }
        "getLeaderboard" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let kind = opt_str(payload, &["kind"]).unwrap_or_else(|| "global".into());
            let limit = opt_u64(payload, &["limit"]).unwrap_or(50).clamp(1, 100);
            let path = format!("/api/v1/miniapps/fabushi/leaderboard?kind={kind}&limit={limit}");
            client
                .http_client
                .request_json(
                    reqwest::Method::GET,
                    &path,
                    Some(&token),
                    None::<&()>,
                )
                .await
                .map_err(Into::into)
        }
        "subscribeVip" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let plan = opt_str(payload, &["plan", "planId", "tier"]).unwrap_or_else(|| "monthly".into());
            client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/miniapps/fabushi/membership",
                    Some(&token),
                    Some(&json!({ "plan": plan })),
                )
                .await
                .map_err(Into::into)
        }
        "aiGuideChat" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let msg = req_str(payload, &["message", "prompt", "text"], "message")?;
            let history = payload.get("history").cloned().unwrap_or_else(|| json!([]));
            client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/miniapps/fabushi/ai-chat",
                    Some(&token),
                    Some(&json!({ "message": msg, "history": history })),
                )
                .await
                .map_err(Into::into)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported fabushi action '{other}'"),
        )),
    }
}
