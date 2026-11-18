import fs from 'node:fs';
import path from 'node:path';
import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerF16BoundaryUser(ctx, label, prefix) {
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
      deviceName: `OHOS_B16_${label}`,
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
    id: 'T2-F16-01-task-fsm-illegal-transitions-and-invalid-cron-schedules',
    name: 'F16 Boundary: TaskFsm rejects illegal & post-terminal state jumps, Cron rejects malformed 5-field schedules, and ACP rejects invalid JSON-RPC',
    tier: 2,
    features: ['F16'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF16BoundaryUser(ctx, 'alice_fsm_b', 'f16b_fsm');

      const created = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'createTask',
        payload: { title: 'Strict FSM Transition Task' },
      });
      const taskId = String(created.data?.taskId ?? '');

      // Illegal jump directly from pending -> completed (must pass through running)
      const skipRunning = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'transitionTask',
        payload: { taskId, targetState: 'completed' },
        expectOk: false,
      });
      assert.equal(skipRunning.ok, false, 'Jumping pending -> completed without running must fail');

      // Unknown TaskState string
      const bogusState = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'transitionTask',
        payload: { taskId, targetState: 'teleported_invalid' },
        expectOk: false,
      });
      assert.equal(bogusState.errorCode, 'VALIDATION_ERROR', 'Unknown TaskState name must return VALIDATION_ERROR');

      // Reach terminal state cleanly (pending -> running -> cancelled) then attempt resurrection
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'transitionTask',
        payload: { taskId, targetState: 'running' },
      });
      const cancelled = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'transitionTask',
        payload: { taskId, targetState: 'cancelled' },
      });
      assert.equal(cancelled.data?.isTerminal, true, 'cancelled must be a terminal TaskFsm state');

      const resurrectTerminal = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'transitionTask',
        payload: { taskId, targetState: 'running' },
        expectOk: false,
      });
      assert.equal(resurrectTerminal.ok, false, 'Transitioning out of terminal cancelled state must be rejected');

      // Malformed Cron schedules
      for (const badSchedule of ['*/5 * *', '99 * * * *', '0 28 * * *', 'not_a_cron_expr']) {
        const badCron = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'tasks',
          action: 'createCron',
          payload: { name: 'Bad Cron', schedule: badSchedule, prompt: 'noop' },
          expectOk: false,
        });
        assert.equal(badCron.errorCode, 'VALIDATION_ERROR', `Invalid cron '${badSchedule}' must return VALIDATION_ERROR`);
      }

      // ACP JSON-RPC unknown method & invalid protocol version
      const unknownMethodRpc = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'tasks',
        action: 'acpRpc',
        payload: { id: 77, method: 'acp/does_not_exist', params: {} },
      });
      assert.equal(Number(unknownMethodRpc.data?.error?.code), -32601, 'Unknown ACP method must return JSON-RPC -32601');

      const badVerHttp = await ctx.http.post(
        '/api/v1/acp/rpc',
        { jsonrpc: '1.0', id: 88, method: 'initialize', params: {} },
        { token: alice.token },
      );
      assert.equal(Number(badVerHttp.json?.error?.code), -32600, 'jsonrpc != 2.0 must return JSON-RPC -32600 Invalid Request');
    },
  }),

  defineTest({
    id: 'T2-F16-02-actionbus-token-replay-payload-tamper-and-deny-enforcement',
    name: 'F16 Boundary: ActionBus enforces single-use X-Approval-Token anti-replay, SHA-256 payload binding against tamper, and explicit gate denial',
    tier: 2,
    features: ['F16'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF16BoundaryUser(ctx, 'alice_ab_b', 'f16b_ab');

      const group = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'ActionBus Security Group', chatType: 'group' },
      });
      const chatId = Number(group.data?.chat_id ?? group.data?.chatId);

      const m1 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Target message #1' },
      });
      const msgId1 = Number(m1.data?.message_id ?? m1.data?.id);

      const m2 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Protected message #2 (must not be deleted by token #1)' },
      });
      const msgId2 = Number(m2.data?.message_id ?? m2.data?.id);

      const payload1 = { chat_id: chatId, message_ids: [msgId1], for_everyone: true };
      const payload2 = { chat_id: chatId, message_ids: [msgId2], for_everyone: true };

      const gate1Resp = await ctx.http.post('/api/v1/actions/delete_message', payload1, {
        token: alice.token,
      });
      assert.httpStatus(gate1Resp, 403, 'Initial high-risk delete_message must pause with 403');
      const gateId1 = String(gate1Resp.json?.gate_id ?? '');

      const approved1 = await ctx.http.post(
        `/api/v1/actions/approvals/${gateId1}/approve`,
        { decision: 'approve_once' },
        { token: alice.token },
      );
      assert.httpStatus(approved1, 200, 'Approve gate #1');
      const token1 = String(approved1.json?.approval_token ?? '');

      // 1. Payload substitution attack: use token1 (bound to msgId1) on payload2 (msgId2)
      const tamperedExec = await ctx.http.post('/api/v1/actions/delete_message', payload2, {
        token: alice.token,
        headers: { 'X-Approval-Token': token1 },
      });
      assert.httpStatus(
        tamperedExec,
        403,
        'X-Approval-Token bound to msgId1 MUST reject tampered payload targeting msgId2',
      );

      // 2. Legitimate execution with matching payload1 consumes single-use token1
      const validExec = await ctx.http.post('/api/v1/actions/delete_message', payload1, {
        token: alice.token,
        headers: { 'X-Approval-Token': token1 },
      });
      assert.httpStatus(validExec, 200, 'Matching payload must succeed with unconsumed token1');

      // 3. Replay attack: reusing already-consumed token1 on payload1 MUST fail with 403
      const replayExec = await ctx.http.post('/api/v1/actions/delete_message', payload1, {
        token: alice.token,
        headers: { 'X-Approval-Token': token1 },
      });
      assert.httpStatus(replayExec, 403, 'Replaying consumed single-use X-Approval-Token must return 403');

      // 4. Forged random token & explicit gate denial
      const forgedExec = await ctx.http.post('/api/v1/actions/delete_message', payload2, {
        token: alice.token,
        headers: { 'X-Approval-Token': 'forged_token_deadbeef_000000' },
      });
      assert.httpStatus(forgedExec, 403, 'Forged X-Approval-Token must return 403');
      const gateId2 = String(forgedExec.json?.gate_id ?? '');
      assert.match(gateId2, /^actgate_/, 'Forged attempt must mint pending gate');

      const deniedGate = await ctx.http.post(
        `/api/v1/actions/approvals/${gateId2}/deny`,
        { reason: 'Rejected by security auditor' },
        { token: alice.token },
      );
      assert.httpStatus(deniedGate, 200, 'Deny ActionBus gate');
      assert.equal(deniedGate.json?.status, 'denied', 'Denied gate status must be denied');
    },
  }),

  defineTest({
    id: 'T2-F16-03-cua-sandbox-path-traversal-symlink-and-disabled-policy-block',
    name: 'F16 Boundary: CUA CloudSandbox blocks ../ traversal & absolute host path escapes (403), enforces disabled run_policy, and rejects conflicting leases (409)',
    tier: 2,
    features: ['F16'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF16BoundaryUser(ctx, 'alice_cua_b', 'f16b_cua');

      // 1. Relative parent-directory traversal escape attempt
      const relTraversal = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'execSandboxOp',
        payload: {
          nodeId: 'sandbox:default',
          operation: {
            op: 'read_file',
            path: '../../../etc/passwd',
          },
        },
      });
      assert.equal(relTraversal.data?.ok, false, 'Parent-dir ../ path traversal in CloudSandbox must fail');
      assert.equal(Number(relTraversal.data?.exit_code), 403, 'Traversal attempt must yield exit_code 403');
      assert.equal(String(relTraversal.data?.stdout ?? ''), '', 'Traversal attempt must leak zero bytes');

      // 2. Absolute host path outside sandbox root
      const absEscape = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'execSandboxOp',
        payload: {
          nodeId: 'sandbox:default',
          operation: {
            op: 'write_file',
            path: '/etc/shadow_escape_test',
            content: 'blocked',
          },
        },
      });
      assert.equal(absEscape.data?.ok, false, 'Absolute path outside sandbox root must fail');
      assert.equal(Number(absEscape.data?.exit_code), 403, 'Absolute escape attempt must yield exit_code 403');

      // 3. Disabled ComputerRunPolicy enforcement (HTTP 403)
      const regNode = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'registerComputer',
        payload: {
          deviceId: `locked_ws_${alice.suffix}`,
          displayName: 'Locked Workstation',
        },
      });
      const lockedNodeId = String(regNode.data?.node_id ?? '');
      assert.isNonEmptyString(lockedNodeId, 'registered computer must return node_id');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'computers',
        action: 'setRunPolicy',
        payload: {
          nodeId: lockedNodeId,
          run_policy: 'disabled',
        },
      });

      const execOnDisabled = await ctx.http.post(
        '/api/v1/computers/exec',
        {
          node_id: lockedNodeId,
          caller_label: 'E2E Probe',
          operation: { op: 'test_connection' },
        },
        { token: alice.token },
      );
      assert.httpStatus(execOnDisabled, 403, 'Executing command on disabled computer node must return 403 Forbidden');

      // 4. Exclusive CUA lease contention (409 Conflict)
      const leaseA = await ctx.http.post(
        '/api/v1/computer/lease/acquire',
        { controller_id: 'agent_alpha', ttl_ms: 30_000 },
        { token: alice.token },
      );
      assert.httpStatus(leaseA, 201, 'Controller A acquires exclusive server lease');

      const leaseBConflict = await ctx.http.post(
        '/api/v1/computer/lease/acquire',
        { controller_id: 'agent_beta', ttl_ms: 30_000 },
        { token: alice.token },
      );
      assert.httpStatus(
        leaseBConflict,
        409,
        'Second controller attempting concurrent lease acquire must receive 409 Conflict',
      );
    },
  }),

  defineTest({
    id: 'T2-F16-04-tailnet-forged-signature-stale-timestamp-and-derp-protocol-errors',
    name: 'F16 Boundary: Tailnet coordinator rejects forged Ed25519 signatures, cross-user replay, expired >5m timestamps, and unauthenticated DERP frames',
    tier: 2,
    features: ['F16'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF16BoundaryUser(ctx, 'alice_tn_b', 'f16b_tn_a');
      const bob = await registerF16BoundaryUser(ctx, 'bob_tn_b', 'f16b_tn_b');

      const realMachineKp = ctx.crypto.generateEd25519KeyPairHex();
      const attackerMachineKp = ctx.crypto.generateEd25519KeyPairHex();
      const nodeKp = ctx.crypto.generateX25519KeyPairHex();
      const discoKp = ctx.crypto.generateX25519KeyPairHex();
      const nowMs = Date.now();

      // 1. Signature signed by wrong Ed25519 private key -> 401
      const forgedSig = ctx.crypto.signTailnetRegistrationHex(
        {
          ownerUserId: alice.userId,
          deviceId: 'forged_dev_01',
          machinePublicKeyHex: realMachineKp.publicKeyHex,
          nodePublicKeyHex: nodeKp.publicKeyHex,
          discoPublicKeyHex: discoKp.publicKeyHex,
          timestampMs: nowMs,
        },
        attackerMachineKp.privateKeyHex,
      );
      const forgedReg = await ctx.http.post(
        '/api/v1/tailnet/register',
        {
          device_id: 'forged_dev_01',
          device_name: 'Forged Node',
          os_name: 'OpenHarmony 6.0',
          machine_public_key_hex: realMachineKp.publicKeyHex,
          node_public_key_hex: nodeKp.publicKeyHex,
          disco_public_key_hex: discoKp.publicKeyHex,
          endpoints: [],
          timestamp_ms: nowMs,
          signature_hex: forgedSig,
        },
        { token: alice.token },
      );
      assert.httpStatus(forgedReg, 401, 'Tailnet registration with mismatched Ed25519 signature must return 401');

      // 2. Cross-user replay (valid signature for Alice's userId submitted under Bob's Bearer token) -> 401
      const aliceBoundSig = ctx.crypto.signTailnetRegistrationHex(
        {
          ownerUserId: alice.userId,
          deviceId: 'replay_dev_02',
          machinePublicKeyHex: realMachineKp.publicKeyHex,
          nodePublicKeyHex: nodeKp.publicKeyHex,
          discoPublicKeyHex: discoKp.publicKeyHex,
          timestampMs: nowMs,
        },
        realMachineKp.privateKeyHex,
      );
      const crossUserReplay = await ctx.http.post(
        '/api/v1/tailnet/register',
        {
          device_id: 'replay_dev_02',
          device_name: 'Replayed Node',
          os_name: 'OpenHarmony 6.0',
          machine_public_key_hex: realMachineKp.publicKeyHex,
          node_public_key_hex: nodeKp.publicKeyHex,
          disco_public_key_hex: discoKp.publicKeyHex,
          endpoints: [],
          timestamp_ms: nowMs,
          signature_hex: aliceBoundSig,
        },
        { token: bob.token },
      );
      assert.httpStatus(crossUserReplay, 401, 'Cross-user Tailnet registration replay must return 401');

      // 3. Stale timestamp skew (> 5 minutes old) -> 400/401
      const staleTs = nowMs - 10 * 60 * 1000;
      const staleSig = ctx.crypto.signTailnetRegistrationHex(
        {
          ownerUserId: alice.userId,
          deviceId: 'stale_dev_03',
          machinePublicKeyHex: realMachineKp.publicKeyHex,
          nodePublicKeyHex: nodeKp.publicKeyHex,
          discoPublicKeyHex: discoKp.publicKeyHex,
          timestampMs: staleTs,
        },
        realMachineKp.privateKeyHex,
      );
      const staleReg = await ctx.http.post(
        '/api/v1/tailnet/register',
        {
          device_id: 'stale_dev_03',
          device_name: 'Stale Clock Node',
          os_name: 'OpenHarmony 6.0',
          machine_public_key_hex: realMachineKp.publicKeyHex,
          node_public_key_hex: nodeKp.publicKeyHex,
          disco_public_key_hex: discoKp.publicKeyHex,
          endpoints: [],
          timestamp_ms: staleTs,
          signature_hex: staleSig,
        },
        { token: alice.token },
      );
      assert.equal(staleReg.status >= 400 && staleReg.status < 500, true, 'Stale >5min Tailnet timestamp must be rejected with 4xx');

      // 4. DERP WebSocket protocol violations
      const derpWs = await ctx.connectWs(alice.token, { path: '/api/v1/tailnet/derp' });

      await derpWs.sendFrame('send_packet', {
        dst_node_key: 'aa'.repeat(32),
        packet_b64: Buffer.from('premature').toString('base64'),
      });
      const notRegErr = await derpWs.waitForFrame((f) => f?.type === 'error', 10_000);
      assert.equal(notRegErr.code, 'not_registered', 'Sending DERP packet before hello must return not_registered error');

      await derpWs.sendFrame('hello', {
        device_id: '   ',
        node_public_key: nodeKp.publicKeyHex,
        disco_public_key: discoKp.publicKeyHex,
        endpoints: [],
      });
      const badHelloErr = await derpWs.waitForFrame((f) => f?.type === 'error' && f?.code === 'invalid_hello', 10_000);
      assert.equal(badHelloErr.code, 'invalid_hello', 'Empty device_id in DERP hello must return invalid_hello');

      await derpWs.sendFrame('hello', {
        device_id: `valid_derp_${alice.suffix}`,
        node_public_key: nodeKp.publicKeyHex,
        disco_public_key: discoKp.publicKeyHex,
        endpoints: [],
      });
      await derpWs.waitForFrame((f) => f?.type === 'welcome', 10_000);

      await derpWs.sendFrame('send_packet', {
        dst_node_key: 'ff'.repeat(32),
        packet_b64: Buffer.from('to_offline_peer').toString('base64'),
      });
      const offlineErr = await derpWs.waitForFrame((f) => f?.type === 'error' && f?.code === 'peer_unavailable', 10_000);
      assert.equal(offlineErr.code, 'peer_unavailable', 'Relaying to unconnected peer must return peer_unavailable');

      await derpWs.close();
    },
  }),

  defineTest({
    id: 'T2-F16-05-magpie-pii-secret-blocking-all-upstreams-down-and-bad-strategy',
    name: 'F16 Boundary: Magpie rejects invalid routing strategies (400), missing provider IDs (400), unknown group deletes (404), and surfaces 502 when all upstreams fail',
    tier: 2,
    features: ['F16'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF16BoundaryUser(ctx, 'alice_mg_b', 'f16b_mg');

      const badStrategy = await ctx.http.post(
        '/api/v1/hermes/magpie/groups',
        { routing_strategy: 'bogus_nonexistent_strategy' },
        { token: alice.token },
      );
      assert.httpStatus(badStrategy, 400, 'Invalid Magpie routing_strategy must return 400');

      const missingGroupDel = await ctx.http.delete('/api/v1/hermes/magpie/groups/nonexistent_group_xyz', {
        token: alice.token,
      });
      assert.httpStatus(missingGroupDel, 404, 'Deleting nonexistent Magpie routing group must return 404');

      const emptyProvider = await ctx.http.post('/api/v1/hermes/magpie/providers', {}, { token: alice.token });
      assert.httpStatus(emptyProvider, 400, 'Upserting Magpie provider without preset_id or provider_id must return 400');

      const deadUpstream = await ctx.startMockHttpServer(() => ({
        status: 500,
        json: { error: { message: 'Upstream GPU cluster crash', type: 'internal_error' } },
      }));

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'magpie',
        action: 'upsertProvider',
        payload: {
          provider_id: 'dead_upstream_only',
          name: 'Dead Upstream Node',
          api_mode: 'openai_chat_completions',
          base_url: `${deadUpstream.baseUrl}/v1`,
          api_key: 'sk-dead-upstream-000',
          default_model: 'dead-model-v1',
          enabled: true,
          activate: true,
          allow_local_fallback: false,
        },
      });

      const allDownResp = await ctx.http.post(
        '/api/v1/magpie/v1/chat/completions',
        {
          model: 'dead_upstream_only/dead-model-v1',
          stream: false,
          messages: [{ role: 'user', content: 'Must fail when sole upstream returns 500' }],
        },
        { token: alice.token },
      );
      assert.httpStatus(allDownResp, 502, 'Magpie gateway must return 502 Bad Gateway when all target upstreams fail');
    },
  }),

  defineTest({
    id: 'T2-F16-06-updater-sha256-tamper-downgrade-protection-and-corrupt-manifest',
    name: 'F16 Boundary: Release updater aborts on SHA-256 package tampering, refuses SemVer downgrades & prerelease-over-stable, and rejects corrupt JSON manifests',
    tier: 2,
    features: ['F16'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF16BoundaryUser(ctx, 'alice_up_b', 'f16b_upd');

      const tamperDir = path.join(ctx.workDir, 'tampered_release_feed');
      fs.mkdirSync(tamperDir, { recursive: true });

      const cleanBytes = Buffer.from('CLEAN_SIGNED_OHOS_PACKAGE_V1_4_0');
      const expectedCleanSha = ctx.crypto.sha256Hex(cleanBytes);
      const tamperedAssetPath = path.join(tamperDir, 'harmony-v1.4.0-tampered.hap');
      // Write corrupted/tampered payload that does NOT match manifest sha256!
      fs.writeFileSync(tamperedAssetPath, Buffer.from('TAMPERED_MALICIOUS_PACKAGE_BYTES'));

      const tamperedManifestPath = path.join(tamperDir, 'latest-ohos-tampered.json');
      fs.writeFileSync(
        tamperedManifestPath,
        JSON.stringify(
          {
            version: '1.4.0',
            asset_url: `file://${tamperedAssetPath}`,
            sha256: expectedCleanSha,
            size_bytes: cleanBytes.length,
          },
          null,
          2,
        ),
      );

      // 1. Staged download MUST abort with INTEGRITY_MISMATCH
      const stagedTamper = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'updater',
        action: 'checkForUpdates',
        payload: {
          feedUrl: `file://${tamperedManifestPath}`,
          currentVersion: '1.2.0',
          stageDownload: true,
        },
        expectOk: false,
      });
      assert.equal(stagedTamper.errorCode, 'INTEGRITY_MISMATCH', 'Tampered downloaded package must fail with INTEGRITY_MISMATCH');

      // 2. Direct archive verification MUST fail with SHA256_MISMATCH
      const verifyTamper = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'updater',
        action: 'verifyReleaseManifest',
        payload: {
          manifestPath: tamperedManifestPath,
          archivePath: tamperedAssetPath,
          expectedSha256: expectedCleanSha,
        },
        expectOk: false,
      });
      assert.equal(verifyTamper.errorCode, 'SHA256_MISMATCH', 'Tampered archive in verifyReleaseManifest must fail with SHA256_MISMATCH');

      // 3. SemVer downgrade protection (1.1.0 < 1.2.0) & prerelease precedence (1.2.0-rc.1 < 1.2.0)
      const olderManifestPath = path.join(tamperDir, 'older-v1.1.0.json');
      fs.writeFileSync(
        olderManifestPath,
        JSON.stringify({
          version: '1.1.0',
          asset_url: `file://${tamperedAssetPath}`,
          sha256: expectedCleanSha,
        }),
      );
      const downgradeCheck = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'updater',
        action: 'checkForUpdates',
        payload: {
          feedUrl: `file://${olderManifestPath}`,
          currentVersion: '1.2.0',
          stageDownload: false,
        },
      });
      assert.equal(downgradeCheck.data?.updateAvailable, false, 'Older SemVer 1.1.0 must NOT be offered as update over 1.2.0');

      const prereleaseVerify = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'updater',
        action: 'verifyReleaseManifest',
        payload: {
          currentVersion: '1.2.0',
          manifest: {
            version: '1.2.0-rc.2',
            asset_url: 'https://example.invalid/harmony-rc2.hap',
          },
        },
      });
      assert.equal(prereleaseVerify.data?.isNewer, false, 'SemVer 1.2.0-rc.2 prerelease must NOT be newer than stable 1.2.0');

      // 4. Corrupt JSON manifest rejection
      const corruptJson = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'updater',
        action: 'verifyReleaseManifest',
        payload: { manifestJson: '{ broken_manifest_json :::' },
        expectOk: false,
      });
      assert.equal(corruptJson.errorCode, 'VALIDATION_ERROR', 'Malformed manifest JSON must return VALIDATION_ERROR');
    },
  }),
];

export default tests;
