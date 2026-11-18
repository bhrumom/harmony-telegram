//! Domains 22–28: `hermes`, `tasks` (7-state `TaskFsm` + Kanban + Cron + ACP JSON-RPC),
//! `mcp` (Registry + `ToolPermissionDock` + Action Bus), `magpie` (Multi-Provider Gateway + PII Masking),
//! `computers` (CUA Lease Broker + `<10ms` Emergency Takeover + Cloud Sandbox),
//! `tailnet` (Mesh Coordination, STUN & DERP Relay), and `updater` (SemVer + SHA-256).

use std::fs;
use std::time::Instant;

use gpui_telegram_agent::{compile_cron_matcher, parse_every_interval_ms, TaskFsm, TaskState};
use gpui_telegram_client::net::{
    HermesApprovalDecisionRequest, HermesCommandRequest, HermesCreateKanbanBoardRequest,
    HermesCreateKanbanCardRequest, HermesHonchoRequest, HermesMemoryMutationRequest,
    HermesMoveKanbanCardRequest, HermesRollbackRequest, HermesSaveCronRequest,
    HermesSaveSkillRequest, HermesSessionBranchRequest, HermesSoulDto, HermesTurnRequest,
    HermesUpdateToolsetsRequest, MagpieGroupsRequest, MagpieImportRequest, MagpieMaskingConfigDto,
    MagpieMaskingPreviewRequest, MagpieProbeRequest, MagpieSaveProviderRequest,
    RegisterLocalComputerRequest, RemoteComputerCommandRequest, RemoteComputerOp,
    UpdateComputerPolicyRequest, UpsertCloudComputerRequest,
};
use mahayana_computer::{
    acquire_control_lease, release_control_lease, ComputerControlLeaseRequest,
    ComputerControlLeaseSnapshot,
};
use mahayana_host_protocol::ComputerControlOrigin;
use serde_json::{json, Value};

use crate::engine::TelegramCoreEngine;
use crate::helpers::{
    b64_decode, opt_bool, opt_i64, opt_str, opt_string_vec, opt_u64, req_str, sha256_hex,
    to_json_val, CoreDispatchError, CoreResult,
};
use crate::updater::{
    is_newer_version, parse_any_release_payload, ReleaseUpdater, CURRENT_APP_VERSION,
};

pub async fn handle_hermes(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    let bot_id = opt_u64(payload, &["botId", "bot_id"]);
    match action {
        "getStatus" => to_json_val(client.hermes_status_for_bot(bot_id).await?),
        "startTurn" => {
            let prompt = req_str(payload, &["prompt", "message", "text"], "prompt")?;
            let req = HermesTurnRequest {
                prompt,
                session_id: opt_str(payload, &["sessionId", "session_id"]),
                chat_id: opt_i64(payload, &["chatId", "chat_id"]),
                bot_id,
                model: opt_str(payload, &["model"]),
                provider: opt_str(payload, &["provider"]),
                system_prompt: opt_str(payload, &["systemPrompt", "system_prompt"]),
                yolo_mode: opt_bool(payload, &["yoloMode", "yolo_mode"]),
            };
            let turn = client.hermes_run_turn(&req).await?;
            let val = to_json_val(&turn)?;
            engine.emit_push("AgentStreamDelta", val.clone());
            Ok(val)
        }
        "streamTurnEvents" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let turn_id = req_str(payload, &["turnId", "turn_id", "id"], "turnId")?;
            let path = format!(
                "/api/v1/hermes/turns/{}/events",
                gpui_telegram_client::net::http_client::percent_encode_rfc3986(&turn_id)
            );
            let (_, bytes, _) = client
                .http_client
                .request_bytes(reqwest::Method::GET, &path, Some(&token), None)
                .await?;
            let raw = String::from_utf8_lossy(&bytes);
            if let Ok(json_val) = serde_json::from_str::<Value>(&raw) {
                return Ok(json_val);
            }
            let events: Vec<Value> = raw
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim))
                .filter(|d| !d.is_empty() && *d != "[DONE]")
                .map(|d| serde_json::from_str::<Value>(d).unwrap_or_else(|_| Value::String(d.into())))
                .collect();
            Ok(json!({ "turnId": turn_id, "events": events, "count": events.len() }))
        }
        "runSlashCommand" => {
            let cmd = req_str(payload, &["command", "input"], "command")?;
            let mut map = serde_json::Map::new();
            map.insert("command".into(), Value::String(cmd));
            if let Some(sid) = opt_str(payload, &["sessionId", "session_id"]) {
                map.insert("session_id".into(), Value::String(sid));
            }
            if let Some(cid) = opt_i64(payload, &["chatId", "chat_id"]) {
                map.insert("chat_id".into(), json!(cid));
            }
            if let Some(bid) = bot_id {
                map.insert("bot_id".into(), json!(bid));
            }
            let req: HermesCommandRequest = serde_json::from_value(Value::Object(map))?;
            to_json_val(client.hermes_run_command(&req).await?)
        }
        "listCommands" => {
            let prefix = opt_str(payload, &["prefix"]);
            to_json_val(client.hermes_list_commands(prefix.as_deref()).await?)
        }
        "listSessions" => {
            let sessions = client.hermes_list_sessions_for_bot(bot_id).await?;
            Ok(json!({ "sessions": sessions, "count": sessions.len() }))
        }
        "branchSession" => {
            let sid = req_str(payload, &["sessionId", "session_id", "id"], "sessionId")?;
            let req: HermesSessionBranchRequest = serde_json::from_value(payload.clone())?;
            to_json_val(client.hermes_branch_session(&sid, &req).await?)
        }
        "undoSession" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            if let Some(sid) = opt_str(payload, &["sessionId", "session_id"]) {
                let path = format!(
                    "/api/v1/hermes/sessions/{}/undo",
                    gpui_telegram_client::net::http_client::percent_encode_rfc3986(&sid)
                );
                if let Ok(res) = client
                    .http_client
                    .request_json::<Value, Value>(reqwest::Method::POST, &path, Some(&token), Some(payload))
                    .await
                {
                    return Ok(res);
                }
            }
            let req: HermesRollbackRequest = serde_json::from_value(payload.clone())?;
            to_json_val(client.hermes_rollback_turn(&req).await?)
        }
        "exportSession" => {
            let sid = req_str(payload, &["sessionId", "session_id", "id"], "sessionId")?;
            let fmt = opt_str(payload, &["format"]);
            to_json_val(client.hermes_export_session(&sid, fmt.as_deref()).await?)
        }
        "getMemory" => to_json_val(client.hermes_get_memory_for_bot(bot_id).await?),
        "updateMemory" => {
            if let Some(md) = opt_str(payload, &["memoryMarkdown", "memory_markdown", "content"]) {
                let user_md = opt_str(payload, &["userMarkdown", "user_markdown"]);
                return to_json_val(
                    client
                        .hermes_save_memory_for_bot(bot_id, &md, user_md.as_deref())
                        .await?,
                );
            }
            let req: HermesMemoryMutationRequest = serde_json::from_value(payload.clone())?;
            to_json_val(client.hermes_mutate_memory_for_bot(bot_id, &req).await?)
        }
        "getSoul" => to_json_val(client.hermes_get_soul(bot_id).await?),
        "updateSoul" => {
            let current = client.hermes_get_soul(bot_id).await.ok();
            let mut merged = to_json_val(current).unwrap_or_else(|_| json!({}));
            if !merged.is_object() {
                merged = json!({});
            }
            if let (Some(dst), Some(src)) = (merged.as_object_mut(), payload.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }
            let dto: HermesSoulDto = serde_json::from_value(merged)?;
            to_json_val(client.hermes_save_soul(&dto).await?)
        }
        "getHoncho" => {
            if payload.get("observation").is_some() || payload.get("query").is_some() {
                let req: HermesHonchoRequest = serde_json::from_value(payload.clone())?;
                return to_json_val(client.hermes_post_honcho_for_bot(bot_id, &req).await?);
            }
            to_json_val(client.hermes_get_honcho_for_bot(bot_id).await?)
        }
        "listSkills" => {
            let skills = client.hermes_list_skills_for_bot(bot_id).await?;
            Ok(json!({ "skills": skills, "count": skills.len() }))
        }
        "proposeSkill" => {
            let name = req_str(payload, &["name", "skillName"], "name")?;
            let content = req_str(payload, &["content", "markdown", "body"], "content")?;
            let tags = opt_string_vec(payload, &["tags"]);
            let req = HermesSaveSkillRequest {
                name,
                description: opt_str(payload, &["description"]),
                category: opt_str(payload, &["category"]),
                content,
                enabled: opt_bool(payload, &["enabled"]),
                tags: if tags.is_empty() { None } else { Some(tags) },
            };
            to_json_val(client.hermes_save_skill_for_bot(bot_id, &req).await?)
        }
        "approveSkill" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let name = req_str(payload, &["name", "skillName"], "name")?;
            let approved = opt_bool(payload, &["approved"]).unwrap_or(true);
            let path = format!(
                "/api/v1/hermes/skills/{}/approve",
                gpui_telegram_client::net::http_client::percent_encode_rfc3986(&name)
            );
            client
                .http_client
                .request_json(
                    reqwest::Method::POST,
                    &path,
                    Some(&token),
                    Some(&json!({ "approved": approved })),
                )
                .await
                .map_err(Into::into)
        }
        "listToolsets" => {
            let toolsets = client.hermes_list_toolsets_for_bot(bot_id).await?;
            Ok(json!({ "toolsets": toolsets, "count": toolsets.len() }))
        }
        "setToolsetPreset" => {
            let enabled = opt_string_vec(payload, &["enabledToolsets", "enabled_toolsets", "toolsets"]);
            let req = HermesUpdateToolsetsRequest {
                preset: opt_str(payload, &["preset"]),
                enabled_toolsets: if enabled.is_empty() { None } else { Some(enabled) },
                toolset: opt_str(payload, &["toolset"]),
                enabled: opt_bool(payload, &["enabled"]),
            };
            let updated = client.hermes_update_toolsets_for_bot(bot_id, &req).await?;
            Ok(json!({ "toolsets": updated, "count": updated.len() }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported hermes action '{other}'"),
        )),
    }
}

pub async fn handle_tasks(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "createTask" => {
            let title = req_str(payload, &["title", "name", "prompt"], "title")?;
            let mut body = payload.as_object().cloned().unwrap_or_default();
            body.insert("title".into(), Value::String(title));
            let created = client.create_task(&Value::Object(body)).await?;
            let task_id = created
                .get("task_id")
                .or_else(|| created.get("id"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let fsm = TaskFsm::new(task_id.clone());
            engine.with_state_mut(|st| {
                st.task_fsms
                    .insert(task_id.clone(), serde_json::to_string(&fsm).unwrap_or_default());
            })?;
            Ok(json!({
                "taskId": task_id,
                "state": fsm.state.as_str(),
                "task": created
            }))
        }
        "transitionTask" => {
            let task_id = req_str(payload, &["taskId", "task_id", "id"], "taskId")?;
            let target_str = req_str(payload, &["targetState", "state", "to"], "targetState")?;
            let target = TaskState::from_str(&target_str).ok_or_else(|| {
                CoreDispatchError::validation(format!(
                    "Unknown TaskState '{target_str}'; expected pending, running, waiting_auth, waiting_connection, completed, failed, or cancelled"
                ))
            })?;
            let snap = engine.persisted_snapshot();
            let mut fsm: TaskFsm = snap
                .task_fsms
                .get(&task_id)
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_else(|| TaskFsm::new(task_id.clone()));

            fsm.transition_to(target)?;
            engine.with_state_mut(|st| {
                st.task_fsms
                    .insert(task_id.clone(), serde_json::to_string(&fsm).unwrap_or_default());
            })?;

            if let Some(approved) = opt_bool(payload, &["approved"]) {
                let _ = client.approve_task(&task_id, approved).await;
            }
            Ok(json!({
                "taskId": task_id,
                "state": fsm.state.as_str(),
                "isTerminal": fsm.is_terminal(),
                "historyLength": fsm.state_history.len()
            }))
        }
        "listTasks" => {
            let mut server_tasks = client.list_tasks().await?;
            let fsms = engine.persisted_snapshot().task_fsms;
            for item in &mut server_tasks {
                if let Some(tid) = item.get("task_id").or_else(|| item.get("id")).and_then(|v| v.as_str()) {
                    if let Some(raw_fsm) = fsms.get(tid) {
                        if let Ok(fsm) = serde_json::from_str::<TaskFsm>(raw_fsm) {
                            item["state"] = Value::String(fsm.state.as_str().to_string());
                        }
                    }
                }
            }
            Ok(json!({
                "tasks": server_tasks,
                "localFsms": fsms,
                "count": server_tasks.len()
            }))
        }
        "listKanban" => {
            let mut boards = client.hermes_kanban_boards().await?;
            if boards.is_empty() && opt_bool(payload, &["ensureDefaultBoard"]).unwrap_or(false) {
                let req = HermesCreateKanbanBoardRequest {
                    name: "Default Board".into(),
                    columns: None,
                };
                boards.push(client.hermes_kanban_create_board(&req).await?);
            }
            Ok(json!({ "boards": boards, "count": boards.len() }))
        }
        "createKanbanBoard" => {
            let title = req_str(payload, &["title", "name"], "title")?;
            let cols = opt_string_vec(payload, &["columns"]);
            let req = HermesCreateKanbanBoardRequest {
                name: title,
                columns: if cols.is_empty() { None } else { Some(cols) },
            };
            to_json_val(client.hermes_kanban_create_board(&req).await?)
        }
        "createKanbanCard" => {
            let board_id = req_str(payload, &["boardId", "board_id"], "boardId")?;
            let title = req_str(payload, &["title", "name"], "title")?;
            let req = HermesCreateKanbanCardRequest {
                board_id,
                title,
                description: opt_str(payload, &["description"]),
                column: opt_str(payload, &["column", "columnId", "column_id", "status"]),
                priority: opt_str(payload, &["priority"]),
                assigned_agent: opt_str(payload, &["assignedAgent", "assigned_agent"]),
            };
            to_json_val(client.hermes_kanban_create_card(&req).await?)
        }
        "moveKanbanCard" => {
            let card_id = if let Some(cid) = opt_str(payload, &["cardId", "card_id", "id"]) {
                cid
            } else {
                let board_title = opt_str(payload, &["boardTitle"]).unwrap_or_else(|| "Sprint Board".into());
                let boards = client.hermes_kanban_boards().await?;
                let board_id = if let Some(b) = boards.first() {
                    b.board_id.clone()
                } else {
                    let b_req = HermesCreateKanbanBoardRequest {
                        name: board_title,
                        columns: None,
                    };
                    client.hermes_kanban_create_board(&b_req).await?.board_id
                };
                let c_title = req_str(payload, &["title"], "cardId")?;
                let c_req = HermesCreateKanbanCardRequest {
                    board_id,
                    title: c_title,
                    description: opt_str(payload, &["description"]),
                    column: Some("todo".into()),
                    priority: opt_str(payload, &["priority"]),
                    assigned_agent: opt_str(payload, &["assignedAgent", "assigned_agent"]),
                };
                client.hermes_kanban_create_card(&c_req).await?.card_id
            };
            let target_col = req_str(
                payload,
                &["targetColumn", "column", "columnId", "column_id", "status"],
                "targetColumn",
            )?;
            let req = HermesMoveKanbanCardRequest {
                column: Some(target_col),
                title: opt_str(payload, &["title"]),
                description: opt_str(payload, &["description"]),
                priority: opt_str(payload, &["priority"]),
                assigned_agent: opt_str(payload, &["assignedAgent", "assigned_agent"]),
                position: opt_i64(payload, &["position"]).map(|p| p as i32),
            };
            to_json_val(client.hermes_kanban_move_card(&card_id, &req).await?)
        }
        "createCron" => {
            let name = req_str(payload, &["name", "title"], "name")?;
            let schedule = req_str(payload, &["schedule", "cronExpr", "expression"], "schedule")?;
            let valid_cron = compile_cron_matcher(&schedule).is_some()
                || parse_every_interval_ms(&schedule).is_some();
            if !valid_cron {
                return Err(CoreDispatchError::validation(format!(
                    "Invalid cron schedule or @every interval '{schedule}'"
                )));
            }
            let prompt = opt_str(payload, &["prompt", "command"]).unwrap_or_else(|| name.clone());
            let req = HermesSaveCronRequest {
                job_id: opt_str(payload, &["jobId", "job_id"]),
                name,
                schedule,
                prompt,
                chat_id: opt_i64(payload, &["chatId", "chat_id"]),
                bot_id: opt_u64(payload, &["botId", "bot_id"]),
                enabled: Some(opt_bool(payload, &["enabled"]).unwrap_or(true)),
            };
            to_json_val(client.hermes_save_cron(&req).await?)
        }
        "listCrons" => {
            let jobs = client.hermes_list_cron().await?;
            Ok(json!({ "jobs": jobs, "count": jobs.len() }))
        }
        "runCronNow" => {
            let job_id = req_str(payload, &["jobId", "job_id", "id"], "jobId")?;
            client.hermes_run_cron(&job_id).await.map_err(Into::into)
        }
        "deleteCron" => {
            let job_id = req_str(payload, &["jobId", "job_id", "id"], "jobId")?;
            client.hermes_delete_cron(&job_id).await?;
            Ok(json!({ "deleted": true, "jobId": job_id }))
        }
        "acpRpc" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let method = req_str(payload, &["method"], "method")?;
            let rpc_body = json!({
                "jsonrpc": "2.0",
                "id": payload.get("id").cloned().unwrap_or_else(|| json!(1)),
                "method": method,
                "params": payload.get("params").cloned().unwrap_or_else(|| json!({}))
            });
            client.hermes().acp_rpc(&token, &rpc_body).await.map_err(Into::into)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported tasks action '{other}'"),
        )),
    }
}

pub async fn handle_mcp(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "listServers" => {
            let servers = client.list_mcp_servers().await?;
            Ok(json!({ "servers": servers, "count": servers.len() }))
        }
        "registerServer" => {
            let name = req_str(payload, &["name", "serverName", "id"], "name")?;
            let mut body = payload.as_object().cloned().unwrap_or_default();
            body.insert("name".into(), Value::String(name));
            client.register_mcp_server(&Value::Object(body)).await.map_err(Into::into)
        }
        "listTools" => {
            let tools = client.list_mcp_tools().await?;
            Ok(json!({ "tools": tools, "count": tools.len() }))
        }
        "invokeTool" => {
            let tool_name = req_str(payload, &["toolName", "tool_name", "name"], "toolName")?;
            let risk = opt_str(payload, &["riskLevel", "risk_level", "risk"]);
            if let Some(ref r) = risk {
                if matches!(r.to_ascii_lowercase().as_str(), "high" | "destructive" | "critical" | "critical_destructive")
                    && !opt_bool(payload, &["approved"]).unwrap_or(false)
                {
                    // Ensure tool is registered on server with its high/critical risk level so server ToolPermissionDock gates it
                    let _ = client
                        .register_mcp_server(&json!({
                            "server_id": opt_str(payload, &["serverId", "server_id"]).unwrap_or_else(|| "ohos_mcp".into()),
                            "name": "ohos_mcp",
                            "tool_name": tool_name,
                            "risk_level": r,
                            "description": opt_str(payload, &["description"]).unwrap_or_else(|| format!("Gated tool {tool_name}")),
                        }))
                        .await;
                }
            }
            let mut body = payload.as_object().cloned().unwrap_or_default();
            body.insert("tool_name".into(), Value::String(tool_name.clone()));
            body.insert("name".into(), Value::String(tool_name.clone()));
            let mut server_res = client.call_mcp_tool(&Value::Object(body)).await?;
            if server_res.get("status").and_then(|v| v.as_str()) == Some("pending_approval") {
                let req_id = server_res
                    .get("request_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let gate = json!({
                    "approvalId": req_id,
                    "requestId": req_id,
                    "toolName": tool_name,
                    "riskLevel": server_res.get("risk_level").cloned().unwrap_or_else(|| json!("high")),
                    "status": "pending",
                });
                if !req_id.is_empty() {
                    engine.with_state_mut(|st| {
                        st.mcp_approvals.insert(req_id, gate.clone());
                    })?;
                }
                server_res["requiresApproval"] = Value::Bool(true);
                server_res["approval"] = gate;
            }
            Ok(server_res)
        }
        "listApprovals" => {
            let hermes_approvals = client.hermes_list_approvals().await.unwrap_or_default();
            let tracked_gates: Vec<Value> = engine
                .persisted_snapshot()
                .mcp_approvals
                .into_values()
                .collect();
            Ok(json!({
                "hermesApprovals": hermes_approvals,
                "mcpGates": tracked_gates,
                "count": hermes_approvals.len() + tracked_gates.len()
            }))
        }
        "decideApproval" => {
            let approval_id = req_str(payload, &["approvalId", "approval_id", "requestId", "request_id"], "approvalId")?;
            let approved = opt_bool(payload, &["approved", "allow"]).unwrap_or(true);
            if let Ok(mut mcp_res) = client
                .approve_mcp_permission(&json!({
                    "request_id": approval_id,
                    "approval_id": approval_id,
                    "allow": approved,
                    "approved": approved
                }))
                .await
            {
                let status_str = if approved { "approved" } else { "denied" };
                engine.with_state_mut(|st| {
                    if let Some(entry) = st.mcp_approvals.get_mut(&approval_id) {
                        entry["status"] = Value::String(status_str.into());
                    }
                })?;
                mcp_res["status"] = Value::String(status_str.into());
                mcp_res["approvalId"] = Value::String(approval_id);
                return Ok(mcp_res);
            }
            let req: HermesApprovalDecisionRequest = serde_json::from_value(json!({
                "approved": approved,
                "decision": if approved { "approve" } else { "deny" }
            }))?;
            to_json_val(client.hermes_decide_approval(&approval_id, &req).await?)
        }
        "listActions" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            client
                .http_client
                .request_json(reqwest::Method::GET, "/api/v1/actions", Some(&token), None::<&()>)
                .await
                .map_err(Into::into)
        }
        "invokeActionBus" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let action_name = req_str(payload, &["actionName", "action_name", "name"], "actionName")?;
            let params = payload.get("params").unwrap_or(payload);
            let path = format!(
                "/api/v1/actions/{}",
                gpui_telegram_client::net::http_client::percent_encode_rfc3986(&action_name)
            );
            client
                .http_client
                .request_json(reqwest::Method::POST, &path, Some(&token), Some(params))
                .await
                .map_err(Into::into)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported mcp action '{other}'"),
        )),
    }
}

pub async fn handle_magpie(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    let token = client
        .token()
        .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
    match action {
        "getState" => to_json_val(client.hermes().magpie_state(&token).await?),
        "listProviders" => {
            let res: Value = client
                .http_client
                .request_json(
                    reqwest::Method::GET,
                    "/api/v1/hermes/magpie/providers",
                    Some(&token),
                    None::<&()>,
                )
                .await?;
            Ok(res)
        }
        "upsertProvider" => {
            let req: MagpieSaveProviderRequest = serde_json::from_value(payload.clone())?;
            to_json_val(client.hermes().magpie_save_provider(&token, &req).await?)
        }
        "deleteProvider" => {
            let pid = req_str(payload, &["providerId", "provider_id", "id"], "providerId")?;
            to_json_val(client.hermes().magpie_delete_provider(&token, &pid).await?)
        }
        "probeProvider" => {
            let pid = req_str(payload, &["providerId", "provider_id", "id"], "providerId")?;
            let probe_req: Option<MagpieProbeRequest> =
                serde_json::from_value(payload.clone()).ok();
            to_json_val(
                client
                    .hermes()
                    .magpie_probe_provider(&token, &pid, probe_req.as_ref())
                    .await?,
            )
        }
        "scanSubscriptions" => to_json_val(client.hermes().magpie_scan_subscriptions(&token).await?),
        "upsertRoutingGroup" => {
            let req: MagpieGroupsRequest = if payload.get("group").is_some() {
                serde_json::from_value(payload.clone())?
            } else {
                serde_json::from_value(json!({
                    "group": payload,
                    "routing_strategy": opt_str(payload, &["strategy", "routingStrategy"])
                }))?
            };
            to_json_val(client.hermes().magpie_upsert_group(&token, &req).await?)
        }
        "previewMasking" => {
            let text = req_str(payload, &["text", "input"], "text")?;
            let config = payload
                .get("config")
                .and_then(|v| serde_json::from_value::<MagpieMaskingConfigDto>(v.clone()).ok());
            let req = MagpieMaskingPreviewRequest { text, config };
            let mut val = to_json_val(client.hermes().magpie_preview_masking(&token, &req).await?)?;
            if let Some(mt) = val.get("masked_text").cloned() {
                val["maskedText"] = mt;
            }
            if let Some(hc) = val.get("hit_count").cloned() {
                val["hitCount"] = hc;
            }
            Ok(val)
        }
        "updateMasking" => {
            let cfg: MagpieMaskingConfigDto = serde_json::from_value(payload.clone())?;
            to_json_val(client.hermes().magpie_update_masking(&token, &cfg).await?)
        }
        "importConfig" => {
            let req: MagpieImportRequest = serde_json::from_value(payload.clone())?;
            to_json_val(client.hermes().magpie_import(&token, &req).await?)
        }
        "proxyChatCompletion" => {
            let endpoint = match opt_str(payload, &["endpoint", "protocol"]).as_deref() {
                Some("responses") => "/api/v1/magpie/v1/responses",
                Some("messages") | Some("anthropic") => "/api/v1/magpie/v1/messages",
                _ => "/api/v1/magpie/v1/chat/completions",
            };
            client
                .http_client
                .request_json(reqwest::Method::POST, endpoint, Some(&token), Some(payload))
                .await
                .map_err(Into::into)
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported magpie action '{other}'"),
        )),
    }
}

pub async fn handle_computers(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "listComputers" => to_json_val(client.list_computers_async().await?),
        "registerComputer" => {
            let kind = opt_str(payload, &["kind", "type"]).unwrap_or_else(|| "local".into());
            if kind == "cloud" {
                let req: UpsertCloudComputerRequest = serde_json::from_value(payload.clone())?;
                return to_json_val(client.upsert_cloud_computer_async(&req).await?);
            }
            if payload.as_object().map(|m| m.is_empty()).unwrap_or(true) {
                return to_json_val(client.register_current_host_computer_async().await?);
            }
            let req = RegisterLocalComputerRequest {
                device_id: opt_str(payload, &["deviceId", "device_id", "nodeId", "node_id"])
                    .unwrap_or_else(|| client.device_id()),
                display_name: opt_str(payload, &["displayName", "display_name", "label", "name"])
                    .unwrap_or_else(|| "HarmonyOS Workstation".into()),
                ip_address: opt_str(payload, &["ipAddress", "ip_address", "host"])
                    .unwrap_or_else(|| "100.64.0.2".into()),
                os_name: opt_str(payload, &["osName", "os_name", "os"])
                    .unwrap_or_else(|| "OpenHarmony 6.0".into()),
                resolution: opt_str(payload, &["resolution"])
                    .unwrap_or_else(|| "2880x1920".into()),
            };
            to_json_val(client.register_local_computer_async(&req).await?)
        }
        "setRunPolicy" => {
            let node_id = req_str(payload, &["nodeId", "node_id", "id"], "nodeId")?;
            let req: UpdateComputerPolicyRequest = serde_json::from_value(payload.clone())?;
            to_json_val(client.update_computer_policy_async(&node_id, &req).await?)
        }
        "execSandboxOp" => {
            let node_id = req_str(payload, &["nodeId", "node_id"], "nodeId")?;
            let op: RemoteComputerOp = if let Some(op_val) = payload.get("operation") {
                serde_json::from_value(op_val.clone())?
            } else {
                RemoteComputerOp::TestConnection
            };
            let req = RemoteComputerCommandRequest {
                node_id,
                caller_device_id: Some(client.device_id()),
                caller_bot_id: opt_u64(payload, &["callerBotId", "botId"]),
                caller_label: opt_str(payload, &["callerLabel"])
                    .unwrap_or_else(|| format!("HarmonyOS {}", client.device_id())),
                operation: op,
            };
            to_json_val(client.execute_remote_computer_op_async(&req).await?)
        }
        "acquireLease" => {
            let controller_id = opt_str(payload, &["controllerId", "controller_id"])
                .unwrap_or_else(|| client.device_id());
            let run_id = opt_str(payload, &["runId", "run_id"])
                .unwrap_or_else(|| "default_run".to_string());
            let device_id = opt_str(payload, &["deviceId", "device_id", "nodeId"])
                .unwrap_or_else(|| client.device_id());
            let origin = match opt_str(payload, &["origin"]).as_deref() {
                Some("ai") => ComputerControlOrigin::Ai,
                Some("remote_mobile") | Some("remote") => ComputerControlOrigin::RemoteMobile,
                _ => ComputerControlOrigin::LocalUi,
            };
            let mut lease_req = ComputerControlLeaseRequest::new(
                controller_id.clone(),
                run_id.clone(),
                device_id.clone(),
                origin,
                "exclusive",
            );
            if let Some(ttl) = opt_i64(payload, &["ttlMs", "ttl_ms"]) {
                lease_req.ttl_ms = ttl;
            }
            let local_lease = acquire_control_lease(&lease_req)
                .map_err(|e| CoreDispatchError::new("LEASE_BUSY", e.to_string()))?;
            let server_lease = client
                .acquire_computer_lease(&json!({
                    "controller_id": controller_id,
                    "device_id": device_id,
                    "run_id": run_id,
                    "origin": origin,
                    "ttl_ms": lease_req.ttl_ms
                }))
                .await
                .ok();
            let server_lease_id = server_lease
                .as_ref()
                .and_then(|v| v.get("lease").and_then(|l| l.get("lease_id")).and_then(|s| s.as_str()))
                .map(ToString::to_string);
            if let Some(ref slid) = server_lease_id {
                let _ = engine.with_state_mut(|st| {
                    st.preferences["activeServerLeaseId"] = Value::String(slid.clone());
                });
            }
            Ok(json!({
                "leaseId": server_lease_id,
                "localLease": lease_snapshot_to_json(&local_lease),
                "serverLease": server_lease
            }))
        }
        "emergencyTakeover" => {
            let controller_id = opt_str(payload, &["controllerId", "controller_id"])
                .unwrap_or_else(|| format!("human_override_{}", client.device_id()));
            let device_id = opt_str(payload, &["deviceId", "device_id", "nodeId"])
                .unwrap_or_else(|| client.device_id());
            let t0 = Instant::now();
            let mut lease_req = ComputerControlLeaseRequest::new(
                controller_id.clone(),
                "emergency_takeover",
                device_id.clone(),
                ComputerControlOrigin::LocalUi,
                "exclusive",
            );
            lease_req.ttl_ms = 30_000;
            let local_lease = acquire_control_lease(&lease_req)
                .map_err(|e| CoreDispatchError::internal(e.to_string()))?;
            let takeover_us = t0.elapsed().as_micros() as u64;
            let takeover_ms = (takeover_us as f64) / 1000.0;

            let token = client.token();
            let server_res = if let Some(ref t) = token {
                client
                    .http_client
                    .request_json::<Value, Value>(
                        reqwest::Method::POST,
                        "/api/v1/computer/lease/emergency_takeover",
                        Some(t),
                        Some(&json!({ "controller_id": controller_id })),
                    )
                    .await
                    .ok()
            } else {
                None
            };
            engine.emit_push(
                "LeaseRevoked",
                json!({
                    "controllerId": controller_id,
                    "deviceId": device_id,
                    "takeoverLatencyMs": takeover_ms
                }),
            );

            Ok(json!({
                "preempted": true,
                "takeoverLatencyUs": takeover_us,
                "takeoverLatencyMs": takeover_ms,
                "withinTenMsSla": takeover_ms < 10.0,
                "localLease": lease_snapshot_to_json(&local_lease),
                "serverTakeover": server_res
            }))
        }
        "releaseLease" => {
            let controller_id = opt_str(payload, &["controllerId", "controller_id"])
                .unwrap_or_else(|| client.device_id());
            let run_id = opt_str(payload, &["runId", "run_id"])
                .unwrap_or_else(|| "default_run".to_string());
            let released = release_control_lease(&controller_id, &run_id);
            let lease_id = opt_str(payload, &["leaseId", "lease_id"]).or_else(|| {
                engine
                    .persisted_snapshot()
                    .preferences
                    .get("activeServerLeaseId")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
            });
            let mut server_released = None;
            if let Some(ref t) = client.token() {
                server_released = client
                    .http_client
                    .request_json::<_, Value>(
                        reqwest::Method::POST,
                        "/api/v1/computer/lease/release",
                        Some(t),
                        Some(&json!({ "lease_id": lease_id })),
                    )
                    .await
                    .ok();
            }
            Ok(json!({
                "released": released,
                "controllerId": controller_id,
                "runId": run_id,
                "serverRelease": server_released
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported computers action '{other}'"),
        )),
    }
}

pub async fn handle_tailnet(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    let client = engine.client()?;
    match action {
        "registerDevice" => {
            let netmap = client.register_tailnet_async().await?;
            client.start_tailnet_mesh();
            Ok(json!({
                "deviceId": client.device_id(),
                "netmap": netmap,
                "status": client.tailnet_status()
            }))
        }
        "getNetMap" => {
            let netmap = client.get_tailnet_netmap_async().await?;
            Ok(json!({
                "netmap": netmap,
                "status": client.tailnet_status()
            }))
        }
        "stunProbe" => {
            let token = client
                .token()
                .ok_or_else(|| CoreDispatchError::unauthorized("No active session token"))?;
            let t0 = Instant::now();
            let stun: Value = client
                .http_client
                .request_json(
                    reqwest::Method::GET,
                    "/api/v1/tailnet/stun",
                    Some(&token),
                    None::<&()>,
                )
                .await?;
            let rtt_ms = t0.elapsed().as_secs_f64() * 1000.0;
            Ok(json!({
                "stun": stun,
                "rttMs": (rtt_ms * 100.0).round() / 100.0,
                "status": client.tailnet_status()
            }))
        }
        "derpRelayTest" => {
            client.set_tailnet_force_derp_only(true);
            client.start_tailnet_mesh();
            let netmap = client.register_tailnet_async().await?;
            let target_node = opt_str(payload, &["targetNodeId", "peerDeviceId", "nodeId"]);
            let peer_probe = if let Some(ref nid) = target_node {
                client.test_computer_connection_async(nid).await.ok()
            } else {
                None
            };
            Ok(json!({
                "forceDerpOnly": true,
                "encryptedE2e": true,
                "deviceId": client.device_id(),
                "peerCount": netmap.peers.len(),
                "status": client.tailnet_status(),
                "peerProbe": peer_probe
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported tailnet action '{other}'"),
        )),
    }
}

pub async fn handle_updater(
    engine: &TelegramCoreEngine,
    action: &str,
    payload: &Value,
) -> CoreResult<Value> {
    match action {
        "checkForUpdates" => {
            let feed = opt_str(payload, &["feedUrl", "manifestUrl", "url"]);
            let current = opt_str(payload, &["currentVersion", "current_version"])
                .unwrap_or_else(|| {
                    let v = engine.init_config().app_version;
                    if v.trim().is_empty() {
                        CURRENT_APP_VERSION.to_string()
                    } else {
                        v
                    }
                });
            let (info, update_available) = ReleaseUpdater::check_for_updates(feed.as_deref(), &current)
                .await
                .map_err(CoreDispatchError::validation)?;

            let mut staged = Value::Null;
            if opt_bool(payload, &["stageDownload", "download"]).unwrap_or(false) && update_available {
                let temp_dir = engine.init_config().temp_dir;
                let dest_dir = if temp_dir.trim().is_empty() {
                    std::env::temp_dir()
                } else {
                    std::path::PathBuf::from(temp_dir)
                };
                let (path, actual_sha, size) =
                    ReleaseUpdater::download_and_verify_asset(&info, &dest_dir)
                        .await
                        .map_err(|e| CoreDispatchError::new("INTEGRITY_MISMATCH", e))?;
                staged = json!({
                    "stagedPath": path.to_string_lossy(),
                    "sha256": actual_sha,
                    "sizeBytes": size
                });
            }

            Ok(json!({
                "currentVersion": current,
                "updateAvailable": update_available,
                "latest": info,
                "stagedAsset": staged
            }))
        }
        "verifyReleaseManifest" => {
            let current = opt_str(payload, &["currentVersion"]).unwrap_or_else(|| CURRENT_APP_VERSION.into());
            let raw_manifest = if let Some(m) = payload.get("manifest") {
                if let Some(s) = m.as_str() {
                    s.to_string()
                } else {
                    m.to_string()
                }
            } else if let Some(s) = opt_str(payload, &["manifestJson", "manifest_json"]) {
                s
            } else {
                let p = req_str(payload, &["manifestPath", "filePath"], "manifestJson/manifestPath")?;
                fs::read_to_string(&p)
                    .map_err(|e| CoreDispatchError::validation(format!("Failed reading '{p}': {e}")))?
            };
            let info = parse_any_release_payload(&raw_manifest)
                .map_err(CoreDispatchError::validation)?;

            let mut sha_verified: Option<bool> = None;
            if let Some(asset_b64) = opt_str(payload, &["archiveBase64", "assetBase64", "dataBase64"]) {
                let bytes = b64_decode(&asset_b64)?;
                let actual = sha256_hex(&bytes);
                let expected = opt_str(payload, &["expectedSha256"])
                    .or_else(|| info.sha256.clone())
                    .ok_or_else(|| CoreDispatchError::validation("Missing expectedSha256"))?;
                if !actual.eq_ignore_ascii_case(&expected) {
                    return Err(CoreDispatchError::new(
                        "SHA256_MISMATCH",
                        format!("Expected SHA-256 {expected}, actual {actual}"),
                    ));
                }
                sha_verified = Some(true);
            } else if let Some(asset_path) = opt_str(payload, &["archivePath", "assetPath"]) {
                let bytes = fs::read(&asset_path).map_err(|e| {
                    CoreDispatchError::validation(format!("Failed reading '{asset_path}': {e}"))
                })?;
                let actual = sha256_hex(&bytes);
                let expected = opt_str(payload, &["expectedSha256"])
                    .or_else(|| info.sha256.clone())
                    .ok_or_else(|| CoreDispatchError::validation("Missing expectedSha256"))?;
                if !actual.eq_ignore_ascii_case(&expected) {
                    return Err(CoreDispatchError::new(
                        "SHA256_MISMATCH",
                        format!("Expected SHA-256 {expected}, actual {actual}"),
                    ));
                }
                sha_verified = Some(true);
            }

            Ok(json!({
                "valid": true,
                "sha256Verified": sha_verified,
                "isNewer": is_newer_version(&current, &info.version),
                "release": info
            }))
        }
        other => Err(CoreDispatchError::new(
            "UNKNOWN_ACTION",
            format!("Unsupported updater action '{other}'"),
        )),
    }
}

fn lease_snapshot_to_json(snap: &ComputerControlLeaseSnapshot) -> Value {
    json!({
        "controllerId": snap.controller_id,
        "runId": snap.run_id,
        "deviceId": snap.device_id,
        "origin": snap.origin,
        "mode": snap.mode,
        "acquiredAtMs": snap.acquired_at_ms,
        "expiresAtMs": snap.expires_at_ms
    })
}

