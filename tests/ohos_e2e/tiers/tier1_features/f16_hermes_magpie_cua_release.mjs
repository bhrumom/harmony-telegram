import fs from 'node:fs';
import path from 'node:path';
import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerAgentUser(ctx, label, prefix) {
  const sandbox = ctx.createClientSandbox(label);
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const username = `${prefix}_${suffix}`;
  const reg = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: 'registerPassword',
    payload: {
      username,
      password: 'Password123!',
      firstName: prefix.toUpperCase(),
      deviceName: `OHOS_F16_${label}`,
    },
  });
  assert.equal(reg.ok, true, `registerPassword must succeed for ${username}`);
  const userId = Number(reg.data?.userId ?? reg.data?.user_id ?? reg.data?.session?.user_id);
  const token = String(reg.data?.token ?? reg.data?.session?.token ?? '');
  assert.greaterThan(userId, 0, 'userId must be positive');
  assert.isNonEmptyString(token, 'token must be non-empty');
  return { sandbox, username, suffix, userId, token };
}

export const tests = [
  defineTest({
    id: 'T1-F16-01-hermes-studio-turns-sse-sessions-memory-soul-skills',
    name: 'F16: Hermes Studio >=28 toolsets, SSE turn streaming, slash commands, session branch & secret-redacted export, MEMORY/SOUL/Honcho, and Skills',
    tier: 1,
    features: ['F16'],
    timeoutMs: 50_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerAgentUser(ctx, 'alice_hermes', 'f16_hermes');

      const statusRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'getStatus',
        payload: {},
      });
      const toolsetsCount = Number(statusRes.data?.toolsets_count ?? statusRes.data?.toolsetsCount ?? 0);
      assert.greaterThanOrEqual(toolsetsCount, 28, 'Hermes Studio must expose >= 28 built-in toolsets');

      const fakeSecretKey = 'sk-proj-99887766554433221100aabbccddeeff';
      const startedTurn = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'startTurn',
        payload: {
          prompt: `Store token ${fakeSecretKey} and explain OpenHarmony Stage V2 reactivity.`,
        },
      });
      const turnId = String(startedTurn.data?.turn_id ?? startedTurn.data?.turnId ?? startedTurn.data?.id ?? '');
      const sessionId = String(startedTurn.data?.session_id ?? startedTurn.data?.sessionId ?? '');
      assert.isNonEmptyString(turnId, 'hermes.startTurn must return turn_id');
      assert.isNonEmptyString(sessionId, 'hermes.startTurn must return session_id');

      const sseRes = await ctx.http.readSseEvents(`/api/v1/hermes/turns/${encodeURIComponent(turnId)}/events`, {
        token: alice.token,
        maxEvents: 12,
        timeoutMs: 10_000,
        stopWhen: (ev) =>
          ev.data === '[DONE]' ||
          ev.event === 'done' ||
          ev.event === 'turn_completed' ||
          ev.json?.done === true ||
          ev.json?.type === 'done',
      });
      assert.httpStatus(sseRes, 200, 'GET /api/v1/hermes/turns/{id}/events SSE');

      const cliStream = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'streamTurnEvents',
        payload: { turnId },
      });
      assert.isObject(cliStream.data, 'hermes.streamTurnEvents must return turn event snapshot');

      const cmds = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'listCommands',
        payload: {},
      });
      assert.isArray(cmds.data?.commands ?? cmds.data, 'hermes.listCommands must return slash command list');

      const slashHelp = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'runSlashCommand',
        payload: { command: '/help', sessionId },
      });
      assert.isObject(slashHelp.data, 'hermes.runSlashCommand(/help) must succeed');

      const sessionsRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'listSessions',
        payload: {},
      });
      assert.greaterThanOrEqual(Number(sessionsRes.data?.count), 1, 'listSessions must include active Hermes session');

      const branched = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'branchSession',
        payload: { sessionId, title: 'Forked Harmony Investigation' },
      });
      assert.isObject(branched.data, 'branchSession must fork Hermes conversation tree');

      const exported = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'exportSession',
        payload: { sessionId, format: 'markdown' },
      });
      const exportedRaw = JSON.stringify(exported.data);
      assert.notIncludes(exportedRaw, fakeSecretKey, 'exportSession MUST redact sk-... API secrets');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'updateMemory',
        payload: {
          memoryMarkdown: '# Project Memory\n- Target OS: OpenHarmony 6.0 API 20\n',
        },
      });
      const mem = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'getMemory',
        payload: {},
      });
      assert.includes(JSON.stringify(mem.data), 'OpenHarmony 6.0 API 20', 'getMemory must persist MEMORY.md content');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'updateSoul',
        payload: {
          persona_name: 'Hermes Harmony Architect',
          markdown: '# Soul\nRigorous, concise systems engineer.',
        },
      });
      const soul = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'getSoul',
        payload: {},
      });
      assert.includes(JSON.stringify(soul.data), 'Systems', 'getSoul/updateSoul must round-trip SOUL configuration');

      const honcho = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'getHoncho',
        payload: { observation: 'User prefers native ArkUI V2 state management.' },
      });
      assert.isObject(honcho.data, 'getHoncho must record dialectical user observation');

      const proposedSkill = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'proposeSkill',
        payload: {
          name: 'ohos-hvigor-audit',
          description: 'Checks hvigor dual-product build-profile invariants',
          category: 'harmonyos',
          content: '# OHOS Hvigor Audit\n1. Inspect build-profile.json5\n2. Verify arm64-v8a & x86_64 libs\n',
        },
      });
      assert.isObject(proposedSkill.data, 'proposeSkill must save SKILL.md entry');

      const approvedSkill = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'approveSkill',
        payload: { name: 'ohos-hvigor-audit', approved: true },
      });
      assert.isObject(approvedSkill.data, 'approveSkill must mark proposed skill approved');

      const toolsets = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'hermes',
        action: 'listToolsets',
        payload: {},
      });
      assert.greaterThanOrEqual(Number(toolsets.data?.count), 28, 'listToolsets must return >= 28 toolsets');
    },
  }),

  defineTest({
    id: 'T1-F16-02-tasks-fsm-kanban-cron-acp-and-actionbus-approval-gate',
    name: 'F16: 7-state TaskFsm, Kanban board/card move, 5-field Cron, ACP JSON-RPC 2.0, MCP ToolPermissionDock, and ActionBus X-Approval-Token gate',
    tier: 1,
    features: ['F16'],
    timeoutMs: 50_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerAgentUser(ctx, 'alice_tasks', 'f16_tasks');

      const taskCreated = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'createTask',
        payload: { title: 'Cross-compile libtelegram_core.so for arm64-v8a' },
      });
      const taskId = String(taskCreated.data?.taskId ?? '');
      assert.isNonEmptyString(taskId, 'tasks.createTask must return taskId');
      assert.equal(taskCreated.data?.state, 'pending', 'initial TaskFsm state must be pending');

      for (const nextState of ['running', 'waiting_auth', 'running', 'completed']) {
        const tr = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'tasks',
          action: 'transitionTask',
          payload: { taskId, targetState: nextState },
        });
        assert.equal(tr.data?.state, nextState, `TaskFsm must transition to ${nextState}`);
      }

      const board = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'createKanbanBoard',
        payload: { title: 'Harmony M4 Sprint Board' },
      });
      const boardId = String(board.data?.board_id ?? board.data?.boardId ?? '');
      assert.isNonEmptyString(boardId, 'createKanbanBoard must return board_id');

      const card = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'createKanbanCard',
        payload: {
          boardId,
          title: 'Ship WebRTC VAD Barge-In',
          column: 'todo',
          priority: 'high',
        },
      });
      const cardId = String(card.data?.card_id ?? card.data?.cardId ?? '');
      assert.isNonEmptyString(cardId, 'createKanbanCard must return card_id');

      const movedCard = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'moveKanbanCard',
        payload: { cardId, targetColumn: 'done' },
      });
      assert.equal(movedCard.data?.column, 'done', 'moveKanbanCard must move card into done column');

      const cronCreated = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'createCron',
        payload: {
          name: 'Quarter-Hour PTS Health Check',
          schedule: '*/15 * * * *',
          prompt: 'Verify outbox queue depth',
        },
      });
      const jobId = String(cronCreated.data?.job_id ?? cronCreated.data?.jobId ?? cronCreated.data?.id ?? '');
      assert.isNonEmptyString(jobId, 'createCron with valid 5-field schedule must return job_id');

      const cronRan = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'runCronNow',
        payload: { jobId },
      });
      assert.isObject(cronRan.data, 'runCronNow must trigger immediate execution');

      const cronDeleted = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'deleteCron',
        payload: { jobId },
      });
      assert.equal(cronDeleted.data?.deleted, true, 'deleteCron must delete routine');

      for (const rpcMethod of ['initialize', 'session/new', 'tools/list']) {
        const rpcRes = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'tasks',
          action: 'acpRpc',
          payload: { id: 1, method: rpcMethod, params: {} },
        });
        assert.equal(rpcRes.data?.jsonrpc, '2.0', `ACP ${rpcMethod} response must speak JSON-RPC 2.0`);
        assert.hasOwn(rpcRes.data, 'result', `ACP ${rpcMethod} must return result object`);
      }

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'mcp',
        action: 'registerServer',
        payload: {
          server_id: 'ohos_ci_mcp',
          name: 'ohos_ci_mcp',
          tool_name: 'purge_release_bucket',
          risk_level: 'critical',
          description: 'Destructive artifact purge',
        },
      });

      const gatedTool = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'mcp',
        action: 'invokeTool',
        payload: {
          serverId: 'ohos_ci_mcp',
          toolName: 'purge_release_bucket',
          riskLevel: 'critical',
        },
      });
      assert.equal(gatedTool.data?.requiresApproval, true, 'critical MCP tool must pause at ToolPermissionDock');
      const mcpReqId = String(gatedTool.data?.approval?.requestId ?? gatedTool.data?.request_id ?? '');
      assert.isNonEmptyString(mcpReqId, 'ToolPermissionDock must issue approval request_id');

      const mcpApproved = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'mcp',
        action: 'decideApproval',
        payload: { approvalId: mcpReqId, approved: true },
      });
      assert.equal(mcpApproved.data?.status, 'approved', 'mcp.decideApproval must mark request approved');

      const group = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'ActionBus Gate Group', chatType: 'group' },
      });
      const chatId = Number(group.data?.chat_id ?? group.data?.chatId);
      const sentMsg = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Message protected by ActionBus approval gate' },
      });
      const messageId = Number(sentMsg.data?.message_id ?? sentMsg.data?.id);

      const actionPayload = {
        chat_id: chatId,
        message_ids: [messageId],
        for_everyone: true,
      };

      const unapprovedDel = await ctx.http.post('/api/v1/actions/delete_message', actionPayload, {
        token: alice.token,
      });
      assert.httpStatus(unapprovedDel, 403, 'delete_message without X-Approval-Token must return 403');
      const gateId = String(unapprovedDel.json?.gate_id ?? '');
      assert.match(gateId, /^actgate_/, 'ActionBus must mint actgate_* approval gate_id');

      const approveOnce = await ctx.http.post(
        `/api/v1/actions/approvals/${gateId}/approve`,
        { decision: 'approve_once' },
        { token: alice.token },
      );
      assert.httpStatus(approveOnce, 200, 'approve_once on ActionBus gate');
      const approvalToken = String(approveOnce.json?.approval_token ?? '');
      assert.isNonEmptyString(approvalToken, 'approve_once must mint cryptographic X-Approval-Token');

      const approvedDel = await ctx.http.post('/api/v1/actions/delete_message', actionPayload, {
        token: alice.token,
        headers: { 'X-Approval-Token': approvalToken },
      });
      assert.httpStatus(approvedDel, 200, 'delete_message with valid single-use X-Approval-Token');
      assert.equal(approvedDel.json?.success, true, 'ActionBus delete_message must succeed with matching token');
      assert.equal(Number(approvedDel.json?.result?.deleted_count), 1, 'deleted_count must equal 1');
    },
  }),

  defineTest({
    id: 'T1-F16-03-magpie-40plus-presets-failover-routing-masking-rosetta',
    name: 'F16: Magpie AI Gateway >=40 presets, ordered mock-upstream failover routing group, PII {{...}} masking, and Rosetta proxy',
    tier: 1,
    features: ['F16'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerAgentUser(ctx, 'alice_magpie', 'f16_magpie');

      const magpieState = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'magpie',
        action: 'getState',
        payload: {},
      });
      const presets = magpieState.data?.presets || [];
      assert.greaterThanOrEqual(presets.length, 40, 'Magpie AI Gateway must ship >= 40 built-in provider presets');

      const primaryMock = await ctx.startMockHttpServer(() => ({
        status: 503,
        json: { error: { message: 'Primary upstream overloaded', type: 'server_error' } },
      }));

      const backupMock = await ctx.startMockHttpServer((recorded) => ({
        status: 200,
        json: {
          id: 'chatcmpl_magpie_backup_01',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: recorded.bodyJson?.model || 'backup-gpt-4o',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Failover handled cleanly by backup Magpie node.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27 },
        },
      }));

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'magpie',
        action: 'upsertProvider',
        payload: {
          provider_id: 'mock_primary_down',
          name: 'Mock Primary (503)',
          api_mode: 'openai_chat_completions',
          base_url: `${primaryMock.baseUrl}/v1`,
          api_key: 'sk-mock-primary-111111',
          default_model: 'primary-model-v1',
          enabled: true,
          activate: false,
        },
      });

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'magpie',
        action: 'upsertProvider',
        payload: {
          provider_id: 'mock_backup_healthy',
          name: 'Mock Backup (200)',
          api_mode: 'openai_chat_completions',
          base_url: `${backupMock.baseUrl}/v1`,
          api_key: 'sk-mock-backup-222222',
          default_model: 'backup-gpt-4o',
          enabled: true,
          activate: true,
        },
      });

      const groupUpsert = await ctx.http.post(
        '/api/v1/hermes/magpie/groups',
        {
          id: 'ha_failover_pool',
          name: 'HA Failover Pool',
          strategy: 'order',
          members: [
            { target: 'mock_primary_down/primary-model-v1', weight: 1, enabled: true },
            { target: 'mock_backup_healthy/backup-gpt-4o', weight: 1, enabled: true },
          ],
        },
        { token: alice.token },
      );
      assert.httpStatus(groupUpsert, 200, 'POST /api/v1/hermes/magpie/groups');

      const maskPreview = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'magpie',
        action: 'previewMasking',
        payload: {
          text: 'Reach ops at devops.lead@example.org with key sk-abcdef1234567890abcdef1234567890',
          config: {
            enabled: true,
            mask_emails: true,
            mask_phones: true,
            mask_secrets: true,
          },
        },
      });
      assert.greaterThanOrEqual(Number(maskPreview.data?.hitCount ?? maskPreview.data?.hit_count), 1, 'PII masking must detect sensitive entities');
      const maskedStr = String(maskPreview.data?.maskedText ?? maskPreview.data?.masked_text ?? '');
      assert.includes(maskedStr, '{{', 'PII masking must substitute {{...}} placeholder tokens');
      assert.notIncludes(maskedStr, 'devops.lead@example.org', 'raw email must be masked out');

      const proxied = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'magpie',
        action: 'proxyChatCompletion',
        payload: {
          model: 'group/ha_failover_pool',
          stream: false,
          messages: [{ role: 'user', content: 'Ping HA routing group' }],
        },
      });
      assert.greaterThanOrEqual(primaryMock.requests.length, 1, 'Ordered failover must attempt primary upstream first');
      assert.greaterThanOrEqual(backupMock.requests.length, 1, 'Ordered failover must fall back to backup upstream on 503');
      const assistantContent = String(proxied.data?.choices?.[0]?.message?.content ?? '');
      assert.includes(assistantContent, 'Failover handled cleanly', 'Proxy response must return backup upstream completion');

      const anthropicRosetta = await ctx.http.post(
        '/api/v1/magpie/v1/messages',
        {
          model: 'group/ha_failover_pool',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'Test Anthropic Rosetta inbound wire translation' }],
        },
        { token: alice.token },
      );
      assert.httpStatus(anthropicRosetta, 200, 'POST /api/v1/magpie/v1/messages Rosetta translation');
      assert.equal(anthropicRosetta.json?.type, 'message', 'Rosetta /v1/messages must emit Anthropic message envelope');
    },
  }),

  defineTest({
    id: 'T1-F16-04-cua-computer-sandbox-ops-and-sub10ms-lease-takeover',
    name: 'F16: CUA Computer registration, contained workspace file/screen sandbox ops, exclusive control lease, and <10ms emergency takeover',
    tier: 1,
    features: ['F16'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerAgentUser(ctx, 'alice_cua', 'f16_cua');

      const cuaWorkDir = path.join(ctx.workDir, 'cua_contained_sandbox');
      fs.mkdirSync(cuaWorkDir, { recursive: true });

      const regLocal = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'registerComputer',
        payload: {
          deviceId: `ohos_2in1_${alice.suffix}`,
          displayName: 'MateBook Pro HarmonyOS NEXT',
          ipAddress: '100.64.0.10',
          osName: 'OpenHarmony 6.0 API 20',
          resolution: '3120x2080',
        },
      });
      assert.equal(regLocal.data?.display_name, 'MateBook Pro HarmonyOS NEXT', 'registerComputer must save workstation node');

      const listNodes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'listComputers',
        payload: {},
      });
      const nodeIds = (listNodes.data || []).map((n) => n.node_id);
      assert.includes(nodeIds, 'sandbox:default', 'listComputers must include built-in CloudSandbox node');

      const writeOp = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'execSandboxOp',
        payload: {
          nodeId: 'sandbox:default',
          workdir: cuaWorkDir,
          operation: {
            op: 'write_file',
            path: 'notes/cua_probe.txt',
            content: 'HarmonyOS CUA sandbox verified',
            create_dirs: true,
          },
        },
      });
      assert.equal(writeOp.data?.ok, true, 'sandbox write_file op must succeed');
      assert.equal(Number(writeOp.data?.exit_code), 0, 'sandbox write_file exit_code must be 0');

      const readOp = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'execSandboxOp',
        payload: {
          nodeId: 'sandbox:default',
          workdir: cuaWorkDir,
          operation: {
            op: 'read_file',
            path: 'notes/cua_probe.txt',
          },
        },
      });
      assert.equal(readOp.data?.ok, true, 'sandbox read_file op must succeed');
      assert.includes(String(readOp.data?.stdout ?? ''), 'HarmonyOS CUA sandbox verified', 'read_file stdout must match written file');

      const screenOp = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'execSandboxOp',
        payload: {
          nodeId: 'sandbox:default',
          workdir: cuaWorkDir,
          operation: { op: 'capture_screen' },
        },
      });
      assert.equal(screenOp.data?.ok, true, 'capture_screen op must succeed');
      assert.match(String(screenOp.data?.frame_data_url ?? ''), /^data:image\/png;base64,/, 'capture_screen must return PNG data URL');

      const leaseRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'acquireLease',
        payload: {
          controllerId: `agent_ctrl_${alice.suffix}`,
          deviceId: `ohos_2in1_${alice.suffix}`,
          runId: 'cua_run_01',
          origin: 'ai',
          ttlMs: 30_000,
        },
      });
      assert.isObject(leaseRes.data?.localLease, 'acquireLease must return localLease snapshot');
      assert.isNonEmptyString(leaseRes.data?.leaseId, 'acquireLease must acquire server lease_id');

      const takeover = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'emergencyTakeover',
        payload: {
          controllerId: `human_esc_${alice.suffix}`,
          deviceId: `ohos_2in1_${alice.suffix}`,
        },
      });
      assert.equal(takeover.data?.preempted, true, 'emergencyTakeover must preempt active AI lease');
      assert.equal(takeover.data?.withinTenMsSla, true, 'local takeover preemption must complete in < 10ms');
      assert.lessThan(Number(takeover.data?.takeoverLatencyMs), 10, 'takeoverLatencyMs must be strictly < 10ms');
      assert.equal(takeover.data?.serverTakeover?.latency_sub_10ms, true, 'server lease broker must confirm sub-10ms fence');

      const released = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'releaseLease',
        payload: {
          controllerId: `human_esc_${alice.suffix}`,
          runId: 'emergency_takeover',
        },
      });
      assert.isObject(released.data, 'releaseLease must cleanly release control lease');
    },
  }),

  defineTest({
    id: 'T1-F16-05-tailnet-ed25519-registration-stun-and-derp-ws-relay',
    name: 'F16: Tailnet Ed25519 signed registration (100.64.x.y CGNAT IP), STUN probe, and live /api/v1/tailnet/derp WebSocket packet relay',
    tier: 1,
    features: ['F16'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerAgentUser(ctx, 'alice_tailnet', 'f16_mesh');

      function buildSignedTailnetDevice(deviceId) {
        const machineKp = ctx.crypto.generateEd25519KeyPairHex();
        const nodeKp = ctx.crypto.generateX25519KeyPairHex();
        const discoKp = ctx.crypto.generateX25519KeyPairHex();
        const timestampMs = Date.now();
        const signatureHex = ctx.crypto.signTailnetRegistrationHex(
          {
            ownerUserId: alice.userId,
            deviceId,
            machinePublicKeyHex: machineKp.publicKeyHex,
            nodePublicKeyHex: nodeKp.publicKeyHex,
            discoPublicKeyHex: discoKp.publicKeyHex,
            timestampMs,
          },
          machineKp.privateKeyHex,
        );
        return { deviceId, machineKp, nodeKp, discoKp, timestampMs, signatureHex };
      }

      const devA = buildSignedTailnetDevice(`ohos_phone_${alice.suffix}`);
      const devB = buildSignedTailnetDevice(`ohos_tablet_${alice.suffix}`);

      for (const dev of [devA, devB]) {
        const regHttp = await ctx.http.post(
          '/api/v1/tailnet/register',
          {
            device_id: dev.deviceId,
            device_name: dev.deviceId,
            os_name: 'OpenHarmony 6.0',
            machine_public_key_hex: dev.machineKp.publicKeyHex,
            node_public_key_hex: dev.nodeKp.publicKeyHex,
            disco_public_key_hex: dev.discoKp.publicKeyHex,
            endpoints: ['127.0.0.1:51820'],
            timestamp_ms: dev.timestampMs,
            signature_hex: dev.signatureHex,
          },
          { token: alice.token },
        );
        assert.httpStatus(regHttp, 200, `POST /api/v1/tailnet/register for ${dev.deviceId}`);
        const assignedIp = String(regHttp.json?.self_node?.tailnet_ip ?? regHttp.json?.tailnet_ip ?? JSON.stringify(regHttp.json));
        assert.includes(assignedIp, '100.64.', 'Tailnet coordinator must assign deterministic 100.64.x.y CGNAT address');
      }

      const cliReg = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tailnet',
        action: 'registerDevice',
        payload: {},
      });
      assert.isNonEmptyString(cliReg.data?.deviceId, 'tailnet.registerDevice must register sandbox client node');

      const stunRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tailnet',
        action: 'stunProbe',
        payload: {},
      });
      assert.isNonEmptyString(stunRes.data?.stun?.observed_ip, 'STUN probe must return observed_ip');

      const derpTest = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tailnet',
        action: 'derpRelayTest',
        payload: {},
      });
      assert.equal(derpTest.data?.forceDerpOnly, true, 'derpRelayTest must verify forced DERP relay mode');
      assert.equal(derpTest.data?.encryptedE2e, true, 'derpRelayTest must preserve end-to-end encryption');

      const derpWsA = await ctx.connectWs(alice.token, { path: '/api/v1/tailnet/derp' });
      const derpWsB = await ctx.connectWs(alice.token, { path: '/api/v1/tailnet/derp' });

      await derpWsA.sendFrame('hello', {
        device_id: devA.deviceId,
        node_public_key: devA.nodeKp.publicKeyHex,
        disco_public_key: devA.discoKp.publicKeyHex,
        endpoints: ['127.0.0.1:41641'],
      });
      const welcomeA = await derpWsA.waitForFrame((f) => f?.type === 'welcome', 10_000);
      assert.equal(welcomeA.derp_region, 'primary', 'DERP server must reply with welcome frame');

      await derpWsB.sendFrame('hello', {
        device_id: devB.deviceId,
        node_public_key: devB.nodeKp.publicKeyHex,
        disco_public_key: devB.discoKp.publicKeyHex,
        endpoints: ['127.0.0.1:41642'],
      });
      const welcomeB = await derpWsB.waitForFrame((f) => f?.type === 'welcome', 10_000);
      assert.equal(welcomeB.derp_region, 'primary', 'Peer B DERP socket must receive welcome frame');

      const encryptedWireFrameB64 = Buffer.from('TSWG_ENCRYPTED_PAYLOAD_OHOS_V1').toString('base64');
      await derpWsA.sendFrame('send_packet', {
        dst_node_key: devB.nodeKp.publicKeyHex,
        packet_b64: encryptedWireFrameB64,
      });

      const recvOnB = await derpWsB.waitForFrame((f) => f?.type === 'recv_packet', 10_000);
      assert.equal(recvOnB.src_node_key, devA.nodeKp.publicKeyHex, 'DERP recv_packet must carry sender node_public_key');
      assert.equal(recvOnB.packet_b64, encryptedWireFrameB64, 'DERP recv_packet must relay ciphertext verbatim');

      const clientTimeMs = Date.now();
      await derpWsA.sendFrame('keep_alive', {
        client_time_ms: clientTimeMs,
        endpoints: ['127.0.0.1:41641'],
      });
      const kaAck = await derpWsA.waitForFrame((f) => f?.type === 'keep_alive_ack', 10_000);
      assert.equal(Number(kaAck.client_time_ms), clientTimeMs, 'keep_alive_ack must echo client_time_ms');

      await derpWsA.close();
      await derpWsB.close();
    },
  }),

  defineTest({
    id: 'T1-F16-06-semver-release-updater-manifest-and-sha256-staging',
    name: 'F16: SemVer release updater offline file:// feed check, SHA-256 package staging, and release manifest verification',
    tier: 1,
    features: ['F16'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerAgentUser(ctx, 'alice_updater', 'f16_upd');

      const releaseDir = path.join(ctx.workDir, 'release_feed_v130');
      fs.mkdirSync(releaseDir, { recursive: true });

      const hapPayload = Buffer.from('OHOS_SIGNED_HAP_RELEASE_BINARY_V1_3_0_PAYLOAD');
      const hapSha256 = ctx.crypto.sha256Hex(hapPayload);
      const hapAssetPath = path.join(releaseDir, 'harmony-telegram-v1.3.0-signed.hap');
      fs.writeFileSync(hapAssetPath, hapPayload);

      const manifestObj = {
        version: '1.3.0',
        tag_name: 'v1.3.0',
        release_notes: 'OpenHarmony 6.0 Stage V2 performance & WebRTC SFU upgrade',
        asset_url: `file://${hapAssetPath}`,
        sha256: hapSha256,
        size_bytes: hapPayload.length,
      };
      const manifestPath = path.join(releaseDir, 'latest-ohos.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2));

      const updateCheck = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'updater',
        action: 'checkForUpdates',
        payload: {
          feedUrl: `file://${manifestPath}`,
          currentVersion: '1.2.0',
          stageDownload: true,
        },
      });
      assert.equal(updateCheck.data?.updateAvailable, true, '1.3.0 must be detected as newer than 1.2.0');
      assert.equal(updateCheck.data?.latest?.version, '1.3.0', 'latest.version must be 1.3.0');
      assert.equal(updateCheck.data?.stagedAsset?.sha256, hapSha256, 'staged asset SHA-256 must match manifest');
      assert.equal(
        fs.existsSync(String(updateCheck.data?.stagedAsset?.stagedPath ?? '')),
        true,
        'staged release package must exist inside sandbox tempDir',
      );

      const verifiedManifest = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'updater',
        action: 'verifyReleaseManifest',
        payload: {
          manifestPath,
          currentVersion: '1.2.0',
          archivePath: hapAssetPath,
          expectedSha256: hapSha256,
        },
      });
      assert.equal(verifiedManifest.data?.valid, true, 'verifyReleaseManifest must return valid: true');
      assert.equal(verifiedManifest.data?.isNewer, true, 'verifyReleaseManifest must confirm 1.3.0 > 1.2.0');
      assert.equal(verifiedManifest.data?.sha256Verified, true, 'verifyReleaseManifest must confirm SHA-256 integrity');
    },
  }),
];

export default tests;
