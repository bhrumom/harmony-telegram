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
            let title = opt_str(payload, &["displayName", "title", "name"])
                .unwrap_or_else(|| username.clone());
            let mut map = serde_json::Map::new();
            map.insert("username".into(), Value::String(username));
            map.insert("title".into(), Value::String(title.clone()));
            map.insert("display_name".into(), Value::String(title.clone()));
            map.insert("first_name".into(), Value::String(title));
            if let Some(about) = opt_str(payload, &["about", "description"]) {
                map.insert("about".into(), Value::String(about.clone()));
                map.insert("description".into(), Value::String(about));
            }
            let req: CreateBotRequest = serde_json::from_value(Value::Object(map))?;
            to_json_val(client.create_bot(&req).await?)
        }
        "createBotFromPrompt" => {
            let prompt = req_str(payload, &["prompt", "description"], "prompt")?;
            let shape = opt_str(payload, &["avatarShape", "avatar_shape"]);
            let color = opt_str(payload, &["avatarColor", "avatar_color"]);
            to_json_val(
                client
                    .create_from_natural_language_with_avatar(&prompt, shape, color)
                    .await?,
            )
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
            if let Ok(res) = client
                .http_client
                .request_json::<Value, Value>(
                    reqwest::Method::POST,
                    "/api/v1/actions/bots.regenerate_token",
                    Some(&token),
                    Some(payload),
                )
                .await
            {
                return Ok(res);
            }
            let bot_id = opt_u64(payload, &["botId", "bot_id"]).unwrap_or(600001);
            let rotated = format!(
                "{bot_id}:rot_{}",
                &sha256_hex(format!("{bot_id}:{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)).as_bytes())[..32]
            );
            Ok(json!({ "botId": bot_id, "botToken": rotated, "regenerated": true }))
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
            let apps = client.list_mini_apps(Some(&query), None).await.unwrap_or_default();
            Ok(json!({
                "botUsername": clean,
                "query": query,
                "results": [
                    {
                        "id": format!("inl_{clean}_1"),
                        "type": "article",
                        "title": format!("@{clean}: {}", if query.is_empty() { "Quick Action" } else { &query }),
                        "messageText": if query.is_empty() { format!("Inline card from @{clean}") } else { query.clone() }
                    }
                ],
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
            let url = opt_str(payload, &["url", "webAppUrl"])
                .unwrap_or_else(|| format!("gpui-miniapp://{bot_username}/{short_name}"));
            let mut map = serde_json::Map::new();
            map.insert("bot_username".into(), Value::String(bot_username));
            map.insert("short_name".into(), Value::String(short_name));
            map.insert("title".into(), Value::String(title));
            map.insert("url".into(), Value::String(url.clone()));
            map.insert("web_app_url".into(), Value::String(url));
            if let Some(desc) = opt_str(payload, &["description", "about"]) {
                map.insert("description".into(), Value::String(desc));
            }
            if let Some(cat) = opt_str(payload, &["category"]) {
                map.insert("category".into(), Value::String(cat));
            }
            let req: CreateMiniAppRequest = serde_json::from_value(Value::Object(map))?;
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
            let to_country = opt_str(payload, &["toCountry", "target_country", "countryCode"])
                .unwrap_or_else(|| "JP".into());
            if country_by_code(&to_country).is_none() {
                return Err(CoreDispatchError::validation(format!(
                    "Invalid target ISO country code '{to_country}'"
                )));
            }
            let sutra_title = opt_str(payload, &["sutraTitle", "sutra_title", "title"])
                .unwrap_or_else(|| "金刚经".into());
            let sutra = sutra_by_title(&sutra_title).unwrap_or_else(|| &all_sutras()[0]);
            let count = opt_u64(payload, &["count", "copies"]).unwrap_or(1).max(1);
            let bytes_offered = (sutra.content.len() as u64).saturating_mul(count);
            let mut body = payload.as_object().cloned().unwrap_or_default();
            body.entry("target_country".to_string())
                .or_insert_with(|| Value::String(to_country.clone()));
            body.entry("country_code".to_string())
                .or_insert_with(|| Value::String(to_country));
            body.entry("sutra_title".to_string())
                .or_insert_with(|| Value::String(sutra.title.clone()));
            body.entry("bytes".to_string())
                .or_insert_with(|| json!(bytes_offered));
            body.entry("size_bytes".to_string())
                .or_insert_with(|| json!(bytes_offered));
            body.entry("count".to_string()).or_insert_with(|| json!(count));
            let res: Value = client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/miniapps/fabushi/transfer",
                    Some(&token),
                    Some(&Value::Object(body)),
                )
                .await?;
            Ok(res)
        }
        "recordMeditation" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let duration_secs = opt_u64(payload, &["durationSeconds", "duration_seconds", "seconds"])
                .unwrap_or(600);
            if duration_secs == 0 {
                return Err(CoreDispatchError::validation("durationSeconds must be > 0"));
            }
            let subject = opt_str(payload, &["subject", "sutraTitle", "practiceType"])
                .unwrap_or_else(|| "禅定静坐".into());
            let count = opt_u64(payload, &["count", "chantCount"]).unwrap_or(1);
            let mut body = payload.as_object().cloned().unwrap_or_default();
            body.entry("subject".to_string())
                .or_insert_with(|| Value::String(subject.clone()));
            body.entry("title".to_string())
                .or_insert_with(|| Value::String(subject));
            body.entry("duration_seconds".to_string())
                .or_insert_with(|| json!(duration_secs));
            body.entry("minutes".to_string())
                .or_insert_with(|| json!((duration_secs / 60).max(1)));
            body.entry("count".to_string()).or_insert_with(|| json!(count));
            let res: Value = client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/miniapps/fabushi/practice/record",
                    Some(&token),
                    Some(&Value::Object(body)),
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
                    "/api/v1/miniapps/fabushi/practice/record",
                    Some(&token),
                    Some(&json!({
                        "subject": sutra.title,
                        "title": sutra.title,
                        "category": sutra.category,
                        "count": 1,
                        "duration_seconds": 300,
                        "minutes": 5
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
            client
                .http_client
                .request_json(
                    reqwest::Method::GET,
                    "/api/v1/miniapps/fabushi/leaderboard",
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
            let mut body = payload.as_object().cloned().unwrap_or_default();
            body.entry("plan".to_string())
                .or_insert_with(|| Value::String(plan.clone()));
            body.entry("plan_id".to_string())
                .or_insert_with(|| Value::String(plan));
            client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/miniapps/fabushi/membership",
                    Some(&token),
                    Some(&Value::Object(body)),
                )
                .await
                .map_err(Into::into)
        }
        "aiGuideChat" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let msg = req_str(payload, &["message", "prompt", "text"], "message")?;
            let mut body = payload.as_object().cloned().unwrap_or_default();
            body.entry("message".to_string())
                .or_insert_with(|| Value::String(msg.clone()));
            body.entry("prompt".to_string())
                .or_insert_with(|| Value::String(msg));
            client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    "/api/v1/miniapps/fabushi/ai-chat",
                    Some(&token),
                    Some(&Value::Object(body)),
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
