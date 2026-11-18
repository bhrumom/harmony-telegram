//! Headless Adaptive 4-Tier Multi-Form-Factor Shell & Scenario Controller (`PROJECT.md § 4.2, § 4.3`).
//! Executes `ohos-app-cli ui-session --sandbox <dir> --server <url> --script <scenario.json>`
//! against the real `TelegramCoreEngine`, computing authentic breakpoint transitions
//! (`sm` < 600vp, `md` 600..840vp, `lg` 840..1200vp, `xl` >= 1200vp), column topologies,
//! 4-theme tokens (`classicDay` | `classicNight` | `tinted` | `arctic`), live bilingual
//! `zh-CN`/`en-US` strings, 2-in-1 keyboard shortcuts, and live backend `invoke` operations.

use crate::engine::TelegramCoreEngine;
use crate::helpers::{opt_bool, opt_i64, opt_str, CoreDispatchError, CoreResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const VALID_THEMES: &[&str] = &[
    "night",
    "tinted",
    "day",
    "classic",
    "classicDay",
    "classicNight",
    "arctic",
];
pub const VALID_NAV_TABS: &[&str] = &[
    "chats",
    "folders",
    "contacts",
    "calls",
    "talk",
    "bots",
    "miniapps",
    "fabushi",
    "hermes",
    "tasks",
    "mcp",
    "magpie",
    "computer",
    "computers",
    "wallet",
    "passport",
    "saved",
    "settings",
];

pub fn normalize_theme_id(raw: &str) -> CoreResult<String> {
    match raw.trim() {
        "night" | "Night" => Ok("night".to_string()),
        "day" | "Day" => Ok("day".to_string()),
        "classic" | "Classic" => Ok("classic".to_string()),
        "classicDay" | "classic_day" | "light" => Ok("classicDay".to_string()),
        "classicNight" | "classic_night" | "dark" => Ok("classicNight".to_string()),
        "tinted" | "Tinted" | "night_blue" | "nightBlue" => Ok("tinted".to_string()),
        "arctic" | "Arctic" => Ok("arctic".to_string()),
        other => Err(CoreDispatchError::validation(format!(
            "Unsupported themeId '{other}'; expected one of classicDay, classicNight, tinted, arctic, day, night, classic"
        ))),
    }
}

pub fn normalize_locale_id(raw: &str) -> CoreResult<String> {
    match raw.trim() {
        "zh-CN" | "zh_CN" | "zh" | "zh-Hans" => Ok("zh-CN".to_string()),
        "en-US" | "en_US" | "en" => Ok("en-US".to_string()),
        other => Err(CoreDispatchError::validation(format!(
            "Unsupported locale '{other}'; expected zh-CN or en-US"
        ))),
    }
}

pub fn compute_breakpoint(width_vp: i64) -> CoreResult<(&'static str, u8, &'static str)> {
    if !(180..=7680).contains(&width_vp) {
        return Err(CoreDispatchError::validation(format!(
            "Window widthVp {width_vp} out of valid viewport bounds [180, 7680]"
        )));
    }
    if width_vp < 600 {
        Ok(("sm", 1, "phone_stack"))
    } else if width_vp < 840 {
        Ok(("md", 2, "foldable_split"))
    } else if width_vp < 1200 {
        Ok(("lg", 3, "tablet_triple_overlay"))
    } else {
        Ok(("xl", 4, "2in1_quad_docked"))
    }
}

pub fn theme_palette(theme_id: &str) -> Value {
    match theme_id {
        "classicDay" | "day" => json!({
            "id": theme_id,
            "isDark": false,
            "windowBg": "#FFFFFF",
            "surfaceBg": "#F4F4F5",
            "accent": "#2AABEE",
            "msgOutBg": "#EEFFDE",
            "msgInBg": "#FFFFFF",
            "textPrimary": "#111827"
        }),
        "classic" => json!({
            "id": "classic",
            "isDark": false,
            "windowBg": "#FFFFFF",
            "surfaceBg": "#F1F3F4",
            "accent": "#3390EC",
            "msgOutBg": "#EFFDDE",
            "msgInBg": "#FFFFFF",
            "textPrimary": "#0F172A"
        }),
        "classicNight" | "night" => json!({
            "id": theme_id,
            "isDark": true,
            "windowBg": "#0E1621",
            "surfaceBg": "#17212B",
            "accent": "#5288C1",
            "msgOutBg": "#2B5278",
            "msgInBg": "#182533",
            "textPrimary": "#F5F5F5"
        }),
        "tinted" => json!({
            "id": "tinted",
            "isDark": true,
            "windowBg": "#101B1E",
            "surfaceBg": "#18282C",
            "accent": "#34D399",
            "msgOutBg": "#1E4D45",
            "msgInBg": "#1A2E33",
            "textPrimary": "#ECFDF5"
        }),
        _ => json!({
            "id": "arctic",
            "isDark": false,
            "windowBg": "#F0F6FC",
            "surfaceBg": "#E2ECF7",
            "accent": "#0284C7",
            "msgOutBg": "#D8EEFE",
            "msgInBg": "#FFFFFF",
            "textPrimary": "#0F172A"
        }),
    }
}

pub fn localized_labels(locale: &str) -> Value {
    if locale == "zh-CN" {
        json!({
            "appName": "法布施 Telegram",
            "chats": "对话",
            "folders": "分组",
            "contacts": "联系人",
            "calls": "通话",
            "talk": "AI 语音对讲",
            "bots": "机器人与小程序",
            "fabushi": "全球法布施",
            "hermes": "Hermes 智能体",
            "tasks": "任务与看板",
            "mcp": "MCP 工具集",
            "magpie": "喜鹊 AI 网关",
            "computers": "远程电脑",
            "wallet": "钱包与星币",
            "passport": "加密护照",
            "settings": "设置",
            "searchPlaceholder": "全局搜索消息、对话与智能体…"
        })
    } else {
        json!({
            "appName": "Fabushi Telegram",
            "chats": "Chats",
            "folders": "Folders",
            "contacts": "Contacts",
            "calls": "Calls",
            "talk": "AI Live Talk",
            "bots": "Bots & MiniApps",
            "fabushi": "Global Fabushi",
            "hermes": "Hermes Studio",
            "tasks": "Tasks & Kanban",
            "mcp": "MCP Registry",
            "magpie": "Magpie Gateway",
            "computers": "Computers",
            "wallet": "Stars & TON Wallet",
            "passport": "Passport Vault",
            "settings": "Settings",
            "searchPlaceholder": "Search messages, chats, and agents…"
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiShellState {
    pub window_width_vp: i64,
    pub window_height_vp: i64,
    pub breakpoint: String,
    pub visible_columns: u8,
    pub layout_mode: String,
    pub theme_id: String,
    pub locale: String,
    pub auth_state: String,
    pub active_nav: String,
    pub active_chat_id: Option<i64>,
    pub active_topic_id: Option<i64>,
    pub inspector_open: bool,
    pub drawer_open: bool,
    pub search_focused: bool,
    pub command_palette_open: bool,
    pub context_menu_target: Option<String>,
    pub composer_draft: String,
    pub freeform_window: bool,
}

impl UiShellState {
    pub fn from_engine(engine: &TelegramCoreEngine, initial_width_vp: i64) -> CoreResult<Self> {
        let (bp, cols, mode) = compute_breakpoint(initial_width_vp)?;
        let snap = engine.persisted_snapshot();
        let auth_state = if snap.locked {
            "locked".to_string()
        } else if engine.is_authenticated() {
            "authenticated".to_string()
        } else {
            "unauthenticated".to_string()
        };
        Ok(Self {
            window_width_vp: initial_width_vp,
            window_height_vp: 900,
            breakpoint: bp.to_string(),
            visible_columns: cols,
            layout_mode: mode.to_string(),
            theme_id: snap.theme_id,
            locale: snap.locale,
            auth_state,
            active_nav: "chats".to_string(),
            active_chat_id: None,
            active_topic_id: None,
            inspector_open: initial_width_vp >= 1200,
            drawer_open: false,
            search_focused: false,
            command_palette_open: false,
            context_menu_target: None,
            composer_draft: String::new(),
            freeform_window: initial_width_vp >= 1200,
        })
    }
}

pub fn run_ui_session(engine: &TelegramCoreEngine, script: &Value) -> CoreResult<Value> {
    let initial_width = opt_i64(script, &["initialWindowWidthVp", "widthVp"]).unwrap_or(1280);
    let mut ui = UiShellState::from_engine(engine, initial_width)?;
    let steps_vec: Vec<Value> = if let Some(arr) = script.as_array() {
        arr.clone()
    } else if let Some(arr) = script.get("steps").and_then(|s| s.as_array()) {
        arr.clone()
    } else {
        return Err(CoreDispatchError::validation(
            "ui-session script requires an array of steps or an object with 'steps' array",
        ));
    };

    let mut step_results = Vec::with_capacity(steps_vec.len());

    for (idx, step) in steps_vec.iter().enumerate() {
        let op = opt_str(step, &["op", "step", "type"])
            .or_else(|| {
                if step.get("domain").is_some() {
                    Some("invoke".to_string())
                } else {
                    opt_str(step, &["action"])
                }
            })
            .ok_or_else(|| {
                CoreDispatchError::validation(format!("Step #{idx} missing 'op' field"))
            })?;

        let step_out = match op.as_str() {
            "resizeWindow" | "resize" => {
                let width = opt_i64(step, &["widthVp", "width"]).ok_or_else(|| {
                    CoreDispatchError::validation("resizeWindow requires widthVp")
                })?;
                let height = opt_i64(step, &["heightVp", "height"]).unwrap_or(ui.window_height_vp);
                if !(200..=7680).contains(&height) {
                    return Err(CoreDispatchError::validation(format!(
                        "Window heightVp {height} out of bounds [200, 7680]"
                    )));
                }
                let (bp, cols, mode) = compute_breakpoint(width)?;
                ui.window_width_vp = width;
                ui.window_height_vp = height;
                ui.breakpoint = bp.to_string();
                ui.visible_columns = cols;
                ui.layout_mode = mode.to_string();
                ui.freeform_window = width >= 1200;
                if bp == "xl" {
                    ui.inspector_open = true;
                } else if bp == "sm" {
                    ui.inspector_open = false;
                }
                json!({
                    "step": idx,
                    "op": op,
                    "breakpoint": ui.breakpoint,
                    "visibleColumns": ui.visible_columns,
                    "layoutMode": ui.layout_mode,
                    "inspectorOpen": ui.inspector_open
                })
            }
            "setTheme" => {
                let raw = opt_str(step, &["themeId", "theme"]).ok_or_else(|| {
                    CoreDispatchError::validation("setTheme requires themeId")
                })?;
                let norm = normalize_theme_id(&raw)?;
                let _ = engine.invoke_domain(
                    "settings",
                    "setTheme",
                    &json!({ "themeId": norm }).to_string(),
                )?;
                ui.theme_id = norm.clone();
                json!({
                    "step": idx,
                    "op": op,
                    "themeId": norm,
                    "palette": theme_palette(&ui.theme_id)
                })
            }
            "setLocale" => {
                let raw = opt_str(step, &["locale", "lang"]).ok_or_else(|| {
                    CoreDispatchError::validation("setLocale requires locale")
                })?;
                let norm = normalize_locale_id(&raw)?;
                let _ = engine.invoke_domain(
                    "settings",
                    "setLocale",
                    &json!({ "locale": norm }).to_string(),
                )?;
                ui.locale = norm.clone();
                json!({
                    "step": idx,
                    "op": op,
                    "locale": norm,
                    "labels": localized_labels(&ui.locale)
                })
            }
            "navigate" => {
                let nav = opt_str(step, &["nav", "tab", "target"]).ok_or_else(|| {
                    CoreDispatchError::validation("navigate requires nav")
                })?;
                if !VALID_NAV_TABS.contains(&nav.as_str()) {
                    return Err(CoreDispatchError::validation(format!(
                        "Unknown navigation destination '{nav}'"
                    )));
                }
                ui.active_nav = nav.clone();
                if let Some(cid) = opt_i64(step, &["chatId", "chat_id"]) {
                    ui.active_chat_id = Some(cid);
                }
                if let Some(tid) = opt_i64(step, &["topicId", "topic_id"]) {
                    ui.active_topic_id = Some(tid);
                }
                json!({
                    "step": idx,
                    "op": op,
                    "activeNav": ui.active_nav,
                    "activeChatId": ui.active_chat_id
                })
            }
            "toggleInspector" => {
                ui.inspector_open = opt_bool(step, &["open"]).unwrap_or(!ui.inspector_open);
                json!({ "step": idx, "op": op, "inspectorOpen": ui.inspector_open })
            }
            "toggleDrawer" => {
                ui.drawer_open = opt_bool(step, &["open"]).unwrap_or(!ui.drawer_open);
                json!({ "step": idx, "op": op, "drawerOpen": ui.drawer_open })
            }
            "contextMenu" | "openContextMenu" => {
                let target = opt_str(step, &["target", "itemId"]).unwrap_or_else(|| "message".into());
                ui.context_menu_target = Some(target.clone());
                json!({
                    "step": idx,
                    "op": op,
                    "contextMenuTarget": target,
                    "actions": ["reply", "edit", "copy", "forward", "pin", "translate", "delete"]
                })
            }
            "shortcut" => {
                let key = opt_str(step, &["key"])
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let ctrl = opt_bool(step, &["ctrl", "meta", "cmd"]).unwrap_or(false);
                let shift = opt_bool(step, &["shift"]).unwrap_or(false);
                let alt = opt_bool(step, &["alt"]).unwrap_or(false);
                let effect = match (ctrl, shift, alt, key.as_str()) {
                    (true, false, false, "k") => {
                        ui.search_focused = true;
                        ui.command_palette_open = true;
                        "openQuickSearch"
                    }
                    (true, false, false, "f") => {
                        ui.search_focused = true;
                        "focusInChatSearch"
                    }
                    (true, false, false, "i") | (true, true, false, "i") => {
                        ui.inspector_open = !ui.inspector_open;
                        "toggleInspector"
                    }
                    (true, false, false, "b") => {
                        ui.drawer_open = !ui.drawer_open;
                        "toggleDrawer"
                    }
                    (false, false, false, "escape") | (false, false, false, "esc") => {
                        ui.command_palette_open = false;
                        ui.search_focused = false;
                        ui.context_menu_target = None;
                        ui.drawer_open = false;
                        "dismissOverlay"
                    }
                    (true, false, false, "1") => {
                        ui.active_nav = "chats".into();
                        "navChats"
                    }
                    (true, false, false, "2") => {
                        ui.active_nav = "contacts".into();
                        "navContacts"
                    }
                    (true, false, false, "3") => {
                        ui.active_nav = "hermes".into();
                        "navHermes"
                    }
                    (true, false, false, "4") => {
                        ui.active_nav = "tasks".into();
                        "navTasks"
                    }
                    (false, false, false, "enter") if !shift => "submitComposer",
                    (false, true, false, "enter") => {
                        ui.composer_draft.push('\n');
                        "insertNewline"
                    }
                    _ => "unmappedShortcut",
                };
                json!({
                    "step": idx,
                    "op": op,
                    "effect": effect,
                    "searchFocused": ui.search_focused,
                    "commandPaletteOpen": ui.command_palette_open,
                    "inspectorOpen": ui.inspector_open
                })
            }
            "invoke" => {
                let domain = opt_str(step, &["domain"]).ok_or_else(|| {
                    CoreDispatchError::validation("ui-session invoke step requires domain")
                })?;
                let action = opt_str(step, &["action"]).ok_or_else(|| {
                    CoreDispatchError::validation("ui-session invoke step requires action")
                })?;
                let payload = step.get("payload").cloned().unwrap_or_else(|| json!({}));
                let data = engine.invoke_domain(&domain, &action, &payload.to_string())?;
                let snap = engine.persisted_snapshot();
                ui.theme_id = snap.theme_id;
                ui.locale = snap.locale;
                ui.auth_state = if snap.locked {
                    "locked".to_string()
                } else if engine.is_authenticated() {
                    "authenticated".to_string()
                } else {
                    "unauthenticated".to_string()
                };
                json!({
                    "step": idx,
                    "op": op,
                    "domain": domain,
                    "action": action,
                    "result": data
                })
            }
            "encodeWaveform5Bit" => {
                let pcm = opt_str(step, &["pcmBase64"])
                    .and_then(|s| crate::helpers::b64_decode(&s).ok())
                    .unwrap_or_else(|| {
                        let mut v = Vec::with_capacity(4800 * 2);
                        for n in 0..4800usize {
                            let s = ((n as f64 * 0.08).sin() * 18_000.0) as i16;
                            v.extend_from_slice(&s.to_le_bytes());
                        }
                        v
                    });
                let packed = engine.encode_waveform_5bit_bytes(&pcm);
                json!({
                    "step": idx,
                    "op": op,
                    "packedByteLength": packed.len(),
                    "packedBase64": crate::helpers::b64_encode(&packed)
                })
            }
            "decodeWaveform5Bit" => {
                let packed = opt_str(step, &["packedBase64"])
                    .and_then(|s| crate::helpers::b64_decode(&s).ok())
                    .unwrap_or_else(|| vec![0xFFu8; 63]);
                let floats = engine.decode_waveform_5bit_floats(&packed);
                json!({
                    "step": idx,
                    "op": op,
                    "count": floats.len(),
                    "bars": floats
                })
            }
            "processTalkVadFrame" => {
                let sr = opt_i64(step, &["sampleRate"]).unwrap_or(48_000) as u32;
                let amp = opt_i64(step, &["amplitude"]).unwrap_or(14_000) as i16;
                let frames = opt_i64(step, &["frames"]).unwrap_or(3).clamp(1, 20);
                let mut frame = Vec::with_capacity(960 * 2);
                for _ in 0..960 {
                    frame.extend_from_slice(&amp.to_le_bytes());
                }
                let mut last = Value::Null;
                for _ in 0..frames {
                    last = engine.process_talk_vad_pcm(&frame, sr);
                }
                json!({
                    "step": idx,
                    "op": op,
                    "vad": last
                })
            }
            "deepLink" => {
                let uri = opt_str(step, &["uri", "url"]).unwrap_or_default();
                if uri.starts_with("gpui-miniapp://") {
                    ui.active_nav = "fabushi".to_string();
                } else if uri.starts_with("tg://") {
                    ui.active_nav = "chats".to_string();
                }
                json!({
                    "step": idx,
                    "op": op,
                    "uri": uri,
                    "activeNav": ui.active_nav
                })
            }
            "openChat" | "selectChat" => {
                let cid = opt_i64(step, &["chatId", "chat_id"]).ok_or_else(|| {
                    CoreDispatchError::validation("openChat requires chatId")
                })?;
                ui.active_nav = "chats".to_string();
                ui.active_chat_id = Some(cid);
                ui.active_topic_id = opt_i64(step, &["topicId", "topic_id"]);
                json!({ "step": idx, "op": op, "activeChatId": ui.active_chat_id, "activeTopicId": ui.active_topic_id })
            }
            "setComposerDraft" | "typeComposer" => {
                ui.composer_draft = opt_str(step, &["text", "draft"]).unwrap_or_default();
                json!({ "step": idx, "op": op, "composerDraft": ui.composer_draft })
            }
            "sleepMs" => {
                let ms = opt_i64(step, &["ms"]).unwrap_or(50).clamp(1, 5_000) as u64;
                std::thread::sleep(std::time::Duration::from_millis(ms));
                json!({ "step": idx, "op": op, "sleptMs": ms })
            }
            other => {
                return Err(CoreDispatchError::validation(format!(
                    "Unsupported ui-session step op '{other}'"
                )));
            }
        };

        step_results.push(step_out);
    }

    Ok(json!({
        "stepResults": step_results,
        "steps": step_results,
        "finalState": ui,
        "themePalette": theme_palette(&ui.theme_id),
        "localizedLabels": localized_labels(&ui.locale)
    }))
}
