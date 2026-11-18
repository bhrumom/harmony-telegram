import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerBoundaryUser(ctx, label, prefix) {
  const sandbox = ctx.createClientSandbox(label);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const username = `${prefix}_${suffix}`;
  const res = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: 'registerPassword',
    payload: { username, password: 'StageBoundPass#2026!', displayName: prefix.toUpperCase() },
    expectOk: true,
  });
  const userId = Number(res.data?.account?.userId ?? res.data?.session?.user_id);
  const token = res.data?.account?.token ?? res.data?.session?.token;
  assert.greaterThan(userId, 0, 'userId must be positive');
  assert.isNonEmptyString(token, 'token must be non-empty');
  return { sandbox, username, userId, token };
}

async function invokeEngine(ctx, opts) {
  const res = await ctx.cli.uiSession({
    sandbox: opts.sandbox,
    serverUrl: opts.serverUrl,
    script: {
      steps: [
        { op: 'sleepMs', ms: 8 },
        { op: 'invoke', domain: opts.domain, action: opts.action, payload: opts.payload ?? {} },
      ],
    },
    expectOk: opts.expectOk,
  });
  if (res.ok) {
    return {
      ...res,
      data: res.data?.stepResults?.[1]?.result ?? null,
    };
  }
  return res;
}

async function createBoundaryGroup(ctx, owner, title, memberIds) {
  const res = await ctx.cli.invoke({
    sandbox: owner.sandbox,
    domain: 'dialogs',
    action: 'createChat',
    payload: { title, chatType: 'group', memberIds },
    expectOk: true,
  });
  const chatId = Number(res.data?.chat_id ?? res.data?.id ?? 0);
  assert.greaterThan(chatId, 0, 'chatId must be positive');
  return chatId;
}

export const tests = [
  defineTest({
    id: 'T2-F09-01-out-of-order-pts-gap-detection-and-recovery',
    name: 'F9 Boundary: Out-of-order PTS gap (pts > local_pts + pts_count) triggers gap detection, lossless recovery, and pruned journal floor snapshot flag',
    tier: 2,
    features: ['F9'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'f09_t2_01_alice', 'alice_f09_b1');
      const bob = await registerBoundaryUser(ctx, 'f09_t2_01_bob', 'bob_f09_b1');
      const chatId = await createBoundaryGroup(ctx, alice, 'F9 Gap Recovery Boundary', [bob.userId]);

      const m1 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Msg #1 baseline' },
        expectOk: true,
      });
      assert.equal(Number(m1.data?.pts), 1, 'Initial message must establish local PTS=1');

      for (let i = 2; i <= 4; i++) {
        const bSend = await ctx.http.post(
          `/api/v1/chats/${chatId}/messages`,
          { text: `Gap message #${i}` },
          { token: bob.token },
        );
        assert.httpStatus(bSend, 201, `Bob send #${i}`);
      }

      const gapProbe = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'sync',
        action: 'applyPtsUpdate',
        payload: { chatId, pts: 4, ptsCount: 1, text: 'Gap message #4' },
        expectOk: true,
      });
      assert.equal(Number(gapProbe.data?.ptsBefore), 1, 'Local cursor before gap frame must be 1');
      assert.equal(gapProbe.data?.gapDetected, true, 'Jumping from PTS=1 to PTS=4 must flag gapDetected=true');

      const recovered = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'sync',
        action: 'getDifference',
        payload: { chatId, pts: 1, limit: 20 },
        expectOk: true,
      });
      const recoveredNewMsgs = (recovered.data?.updates ?? []).filter((u) => u.event?.type === 'NewMessage');
      assert.equal(recoveredNewMsgs.length, 3, 'Recovery must fetch all 3 missed NewMessage updates (PTS 2..4)');
      assert.equal(Number(recovered.data?.current_pts), 4, 'Recovered current_pts must equal 4');
      assert.equal(recovered.data?.has_more, false, 'Gap recovery must complete with has_more=false');

      await ctx.http.post(`/api/v1/chats/${chatId}/messages`, { text: 'Msg #5' }, { token: bob.token });
      await ctx.http.post(`/api/v1/chats/${chatId}/messages`, { text: 'Msg #6' }, { token: bob.token });

      const dbPath = path.join(server.dataDir, 'gpui_telegram.db');
      const sqlDb = new DatabaseSync(dbPath);
      try {
        sqlDb.prepare('DELETE FROM pts_updates WHERE chat_id = ? AND pts <= 4').run(chatId);
      } finally {
        sqlDb.close();
      }

      const prunedRes = await ctx.http.post(
        '/api/v1/sync/get_difference',
        { chat_id: chatId, pts: 1, limit: 20 },
        { token: alice.token },
      );
      assert.httpStatus(prunedRes, 200, 'pruned journal get_difference');
      assert.equal(prunedRes.json?.snapshot_required, true, 'Cursor behind journal floor must set snapshot_required=true');
      assert.equal(prunedRes.json?.has_more, true, 'Snapshot fallback must report has_more=true');
    },
  }),

  defineTest({
    id: 'T2-F09-02-identical-client-nonce-retry-zero-pts-advance',
    name: 'F9 Boundary: Identical (sender_id, client_nonce) retry returns duplicate=true and pts_count=0 without advancing PTS',
    tier: 2,
    features: ['F9'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'f09_t2_02_alice', 'alice_f09_b2');
      const bob = await registerBoundaryUser(ctx, 'f09_t2_02_bob', 'bob_f09_b2');
      const chatId = await createBoundaryGroup(ctx, alice, 'F9 Nonce Zero PTS Advance', [bob.userId]);

      const nonce = 910_001;
      const first = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'Idempotent boundary payload', client_nonce: nonce },
        { token: alice.token },
      );
      assert.httpStatus(first, 201, 'first send');
      const basePts = Number(first.json?.pts);
      const baseMsgId = Number(first.json?.message_id);

      for (let attempt = 1; attempt <= 3; attempt++) {
        const retry = await ctx.http.post(
          attempt % 2 === 0 ? '/api/v1/messages/send' : `/api/v1/chats/${chatId}/messages`,
          { chat_id: chatId, text: 'Idempotent boundary payload', client_nonce: nonce },
          { token: alice.token },
        );
        assert.oneOf(retry.status, [200, 201], `retry #${attempt} status`);
        assert.equal(retry.json?.duplicate, true, `retry #${attempt} must return duplicate=true`);
        assert.equal(retry.json?.pts_count, 0, `retry #${attempt} must return pts_count=0`);
        assert.equal(Number(retry.json?.pts), basePts, `retry #${attempt} must not advance PTS`);
        assert.equal(Number(retry.json?.message_id), baseMsgId, `retry #${attempt} must preserve message_id`);
      }

      const nextDistinct = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'Next fresh message', client_nonce: nonce + 1 },
        { token: alice.token },
      );
      assert.httpStatus(nextDistinct, 201, 'next distinct send');
      assert.equal(Number(nextDistinct.json?.pts), basePts + 1, 'Next distinct message must get basePts + 1');
    },
  }),

  defineTest({
    id: 'T2-F09-03-conflicting-client-nonce-payload-reuse-rejected',
    name: 'F9 Boundary: Reusing (sender_id, client_nonce) with a mutated payload is rejected alongside invalid client_nonce bounds',
    tier: 2,
    features: ['F9'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'f09_t2_03_alice', 'alice_f09_b3');
      const bob = await registerBoundaryUser(ctx, 'f09_t2_03_bob', 'bob_f09_b3');
      const chatId = await createBoundaryGroup(ctx, alice, 'F9 Nonce Conflict Boundary', [bob.userId]);

      const nonce = 910_555;
      const orig = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'Original immutable text', client_nonce: nonce },
        { token: alice.token },
      );
      assert.httpStatus(orig, 201, 'initial message');

      const conflictHttp = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'Mutated conflicting text', client_nonce: nonce },
        { token: alice.token },
      );
      assert.oneOf(conflictHttp.status, [400, 409], 'Conflicting payload on same nonce must fail with 409/400');
      assert.equal(conflictHttp.json?.error, 'nonce_conflict', 'Error code must identify nonce_conflict');

      const conflictCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Another mutated payload', clientNonce: nonce },
        expectOk: false,
      });
      assert.equal(conflictCli.errorCode, 'CONFLICT', 'CLI must map nonce reuse conflict to CONFLICT');

      const zeroNonce = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'Zero nonce', client_nonce: 0 },
        { token: alice.token },
      );
      assert.httpStatus(zeroNonce, 400, 'client_nonce=0 must fail with HTTP 400');

      const negNonce = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'Negative nonce', client_nonce: -42 },
        { token: alice.token },
      );
      assert.httpStatus(negNonce, 400, 'negative client_nonce must fail with HTTP 400');

      const overflowBody = `{"chat_id":${chatId},"text":"Overflow nonce","client_nonce":9223372036854775808}`;
      const overflowNonce = await ctx.http.post('/api/v1/messages/send', overflowBody, {
        token: alice.token,
        headers: { 'Content-Type': 'application/json' },
      });
      assert.httpStatus(overflowNonce, 400, 'client_nonce > i64::MAX must fail with HTTP 400');
    },
  }),

  defineTest({
    id: 'T2-F09-04-mutually-exclusive-before-and-after-pagination-rejected',
    name: 'F9 Boundary: History queries with both before_id and after_id, conflicting offset_id, or out-of-range limit are rejected with HTTP 400',
    tier: 2,
    features: ['F9'],
    timeoutMs: 25_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'f09_t2_04_alice', 'alice_f09_b4');
      const bob = await registerBoundaryUser(ctx, 'f09_t2_04_bob', 'bob_f09_b4');
      const chatId = await createBoundaryGroup(ctx, alice, 'F9 Pagination Bounds', [bob.userId]);

      const bothCursors = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, {
        token: alice.token,
        query: { before_id: 10, after_id: 2 },
      });
      assert.httpStatus(bothCursors, 400, 'before_id + after_id must return HTTP 400');
      assert.equal(
        bothCursors.json?.error,
        'conflicting_pagination',
        'Error code must be conflicting_pagination',
      );

      const mismatchOffset = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, {
        token: alice.token,
        query: { before_id: 10, offset_id: 5 },
      });
      assert.httpStatus(mismatchOffset, 400, 'conflicting before_id and offset_id must return HTTP 400');
      assert.equal(mismatchOffset.json?.error, 'conflicting_pagination', 'Conflicting offset_id error code');

      const zeroLimit = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, {
        token: alice.token,
        query: { limit: 0 },
      });
      assert.httpStatus(zeroLimit, 400, 'limit=0 must return HTTP 400');

      const overLimit = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, {
        token: alice.token,
        query: { limit: 101 },
      });
      assert.httpStatus(overLimit, 400, 'limit=101 (>100) must return HTTP 400');

      const badChatQuery = await ctx.http.get('/api/v1/messages/history', {
        token: alice.token,
        query: { chat_id: 0 },
      });
      assert.httpStatus(badChatQuery, 400, 'chat_id=0 must return HTTP 400');
    },
  }),

  defineTest({
    id: 'T2-F09-05-overlong-4097-char-and-empty-whitespace-message-rejected',
    name: 'F9 Boundary: Empty, whitespace-only, and >4096-character messages are rejected with HTTP 400 while exact 4096-char boundary succeeds',
    tier: 2,
    features: ['F9'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'f09_t2_05_alice', 'alice_f09_b5');
      const bob = await registerBoundaryUser(ctx, 'f09_t2_05_bob', 'bob_f09_b5');
      const chatId = await createBoundaryGroup(ctx, alice, 'F9 Length Bounds', [bob.userId]);

      const emptyHttp = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: '' },
        { token: alice.token },
      );
      assert.httpStatus(emptyHttp, 400, 'Empty text must be rejected with HTTP 400');

      const wsOnlyHttp = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: '   \n\t   ' },
        { token: alice.token },
      );
      assert.httpStatus(wsOnlyHttp, 400, 'Whitespace-only text must be rejected with HTTP 400');

      const cliEmpty = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: '   ' },
        expectOk: false,
      });
      assert.equal(cliEmpty.errorCode, 'VALIDATION_ERROR', 'CLI whitespace message must fail validation');

      const exact4096 = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'm'.repeat(4096) },
        { token: alice.token },
      );
      assert.httpStatus(exact4096, 201, 'Exact 4096-character message must succeed');
      const msgId = Number(exact4096.json?.message_id);

      const over4097 = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'm'.repeat(4097) },
        { token: alice.token },
      );
      assert.httpStatus(over4097, 400, '4097-character message must fail with HTTP 400');

      const editOver4097 = await ctx.http.put(
        `/api/v1/chats/${chatId}/messages/${msgId}`,
        { text: 'e'.repeat(4097) },
        { token: alice.token },
      );
      assert.httpStatus(editOver4097, 400, 'Editing message to 4097 characters must fail with HTTP 400');
    },
  }),

  defineTest({
    id: 'T2-F09-06-outbox-permanent-4xx-vs-transient-5xx-retry-classification',
    name: 'F9 Boundary: OutboxWorker classifies HTTP 403/400 as permanent Failed without retry while retrying transient HTTP 503 to Delivered',
    tier: 2,
    features: ['F9'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'f09_t2_06_alice', 'alice_f09_b6');

      let mockMode = 'perm_403';
      const mockServer = await ctx.startMockHttpServer((req) => {
        if (req.path === '/api/v1/messages/send' && req.method === 'POST') {
          if (mockMode === 'perm_403') {
            return { status: 403, json: { error: 'forbidden', message: 'Permanent ACL ban' } };
          }
          if (mockMode === 'transient_503') {
            return { status: 503, json: { error: 'unavailable', message: 'Upstream maintenance' } };
          }
          return {
            status: 200,
            json: {
              message_id: 901,
              id: 901,
              pts: 12,
              pts_count: 1,
              duplicate: false,
              date_ms: Date.now(),
              date: new Date().toISOString(),
              sender_id: alice.userId,
              chat_id: 77,
              text: req.bodyJson?.text ?? 'ok',
              status: 'sent',
            },
          };
        }
        return { status: 200, json: { status: 'healthy' } };
      });

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        serverUrl: mockServer.baseUrl,
        domain: 'auth',
        action: 'setServerConfig',
        payload: { serverUrl: mockServer.baseUrl },
        expectOk: true,
      });

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        serverUrl: mockServer.baseUrl,
        domain: 'outbox',
        action: 'enqueueOffline',
        payload: { chatId: 77, text: 'Blocked permanent message', clientNonce: 960_001 },
        expectOk: true,
      });

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        serverUrl: mockServer.baseUrl,
        domain: 'outbox',
        action: 'flushOutbox',
        payload: {},
        expectOk: true,
      });

      const afterPerm = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        serverUrl: mockServer.baseUrl,
        domain: 'outbox',
        action: 'listPending',
        payload: {},
        expectOk: true,
      });
      const failedRec = (afterPerm.data?.allRecords ?? []).find((r) => Number(r.client_nonce) === 960_001);
      assert.equal(failedRec?.status, 'Failed', 'HTTP 403 must transition outbox record permanently to Failed');
      assert.equal(afterPerm.data?.pendingCount, 0, 'Permanent Failed record must not remain Pending');

      mockServer.clearRequests();
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        serverUrl: mockServer.baseUrl,
        domain: 'outbox',
        action: 'flushOutbox',
        payload: {},
        expectOk: true,
      });
      const sendReqsAfterFailed = mockServer.requests.filter((r) => r.path === '/api/v1/messages/send');
      assert.equal(sendReqsAfterFailed.length, 0, 'Permanent Failed record must never be retried on subsequent flush');

      mockMode = 'transient_503';
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        serverUrl: mockServer.baseUrl,
        domain: 'outbox',
        action: 'enqueueOffline',
        payload: { chatId: 77, text: 'Transient retry message', clientNonce: 960_002 },
        expectOk: true,
      });

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        serverUrl: mockServer.baseUrl,
        domain: 'outbox',
        action: 'flushOutbox',
        payload: {},
        expectOk: true,
      });

      const after503 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        serverUrl: mockServer.baseUrl,
        domain: 'outbox',
        action: 'listPending',
        payload: {},
        expectOk: true,
      });
      const pendingRec = (after503.data?.allRecords ?? []).find((r) => Number(r.client_nonce) === 960_002);
      assert.equal(pendingRec?.status, 'Pending', 'HTTP 503 transient failure must keep record Pending for backoff');
      assert.greaterThanOrEqual(Number(pendingRec?.retry_count), 1, 'Transient failure must increment retry_count');

      mockMode = 'healthy_200';
      const reconnectUi = await ctx.cli.uiSession({
        sandbox: alice.sandbox,
        serverUrl: mockServer.baseUrl,
        script: {
          steps: [
            { op: 'sleepMs', ms: 8 },
            { op: 'invoke', domain: 'outbox', action: 'simulateNetworkChange', payload: { online: false } },
            { op: 'invoke', domain: 'outbox', action: 'flushOutbox', payload: {} },
            { op: 'invoke', domain: 'outbox', action: 'listPending', payload: {} },
          ],
        },
        expectOk: true,
      });
      const recoveredFlush = reconnectUi.data?.stepResults?.[2]?.result;
      const finalPending = reconnectUi.data?.stepResults?.[3]?.result;
      assert.equal(recoveredFlush?.remainingPending, 0, 'Transient record must flush once server recovers');
      const deliveredRec = (finalPending?.allRecords ?? []).find((r) => Number(r.client_nonce) === 960_002);
      assert.equal(deliveredRec?.status, 'Delivered', 'Recovered transient record must reach Delivered');
    },
  }),
];

export default tests;
