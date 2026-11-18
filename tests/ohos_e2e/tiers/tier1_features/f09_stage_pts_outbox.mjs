import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerSandboxUser(ctx, label, usernamePrefix) {
  const sandbox = ctx.createClientSandbox(label);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const username = `${usernamePrefix}_${suffix}`;
  const password = 'StagePtsPass#2026!';
  const reg = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: 'registerPassword',
    payload: {
      username,
      password,
      displayName: usernamePrefix.toUpperCase(),
    },
    expectOk: true,
  });
  const userId = reg.data?.account?.userId ?? reg.data?.session?.user_id;
  const token = reg.data?.account?.token ?? reg.data?.session?.token;
  assert.greaterThan(Number(userId), 0, `${label} userId must be positive`);
  assert.isNonEmptyString(token, `${label} bearer token must be non-empty`);
  return { sandbox, username, password, userId: Number(userId), token };
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

async function createSharedGroup(ctx, owner, title, memberIds) {
  const res = await ctx.cli.invoke({
    sandbox: owner.sandbox,
    domain: 'dialogs',
    action: 'createChat',
    payload: {
      title,
      chatType: 'group',
      memberIds,
    },
    expectOk: true,
  });
  const chatId = Number(res.data?.chat_id ?? res.data?.id ?? 0);
  assert.greaterThan(chatId, 0, 'Created group chatId must be positive');
  return chatId;
}

export const tests = [
  defineTest({
    id: 'T1-F09-01-message-send-dual-routes-and-cursor-pagination',
    name: 'F9: Message send across flat and chat-scoped routes with monotonic IDs and cursor pagination (before_id, after_id, limit)',
    tier: 1,
    features: ['F9'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'f09_t1_01_alice', 'alice_f09_01');
      const bob = await registerSandboxUser(ctx, 'f09_t1_01_bob', 'bob_f09_01');
      const chatId = await createSharedGroup(ctx, alice, 'F9 Pagination Stage', [bob.userId]);

      const sentIds = [];
      const sentPts = [];
      for (let i = 1; i <= 6; i++) {
        const text = `Stage item #${i}`;
        const res =
          i % 2 === 1
            ? await ctx.http.post(
                '/api/v1/messages/send',
                { chat_id: chatId, text, client_nonce: 1000 + i },
                { token: alice.token },
              )
            : await ctx.http.post(
                `/api/v1/chats/${chatId}/messages`,
                { text, client_nonce: 1000 + i },
                { token: bob.token },
              );
        assert.httpStatus(res, i % 2 === 1 ? 200 : 201, `send message #${i}`);
        assert.equal(res.json?.duplicate, false, `message #${i} must not be marked duplicate`);
        assert.equal(res.json?.pts_count, 1, `message #${i} must advance PTS by 1`);
        const msgId = Number(res.json?.message_id);
        const pts = Number(res.json?.pts);
        assert.greaterThan(msgId, 0, 'message_id must be positive');
        if (sentIds.length > 0) {
          assert.greaterThan(msgId, sentIds[sentIds.length - 1], 'message_id must strictly increase');
          assert.equal(pts, sentPts[sentPts.length - 1] + 1, 'per-chat PTS must increment contiguously');
        }
        sentIds.push(msgId);
        sentPts.push(pts);
      }

      const latestPage = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, {
        token: alice.token,
        query: { limit: 3 },
      });
      assert.httpStatus(latestPage, 200, 'latest page');
      assert.equal(latestPage.json?.has_more, true, 'latest 3 of 6 messages must report has_more=true');
      const latestIds = latestPage.json.messages.map((m) => Number(m.message_id));
      assert.deepEqual(latestIds, sentIds.slice(3, 6), 'latest page must return messages 4..6 ascending');

      const olderPage = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, {
        token: alice.token,
        query: { limit: 3, before_id: sentIds[3] },
      });
      assert.httpStatus(olderPage, 200, 'before_id page');
      assert.equal(olderPage.json?.has_more, false, 'oldest 3 messages must report has_more=false');
      const olderIds = olderPage.json.messages.map((m) => Number(m.message_id));
      assert.deepEqual(olderIds, sentIds.slice(0, 3), 'before_id=msg4 must return messages 1..3 ascending');

      const forwardPage = await ctx.http.get('/api/v1/messages/history', {
        token: bob.token,
        query: { chat_id: chatId, after_id: sentIds[1], limit: 2 },
      });
      assert.httpStatus(forwardPage, 200, 'after_id page');
      assert.equal(forwardPage.json?.has_more, true, 'after_id=msg2 limit=2 must report has_more=true');
      const forwardIds = forwardPage.json.messages.map((m) => Number(m.message_id));
      assert.deepEqual(forwardIds, sentIds.slice(2, 4), 'after_id=msg2 limit=2 must return messages 3..4');

      const cliHist = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'listHistory',
        payload: { chatId, limit: 10 },
        expectOk: true,
      });
      assert.equal(cliHist.data?.count, 6, 'CLI messages.listHistory must return all 6 messages');
    },
  }),

  defineTest({
    id: 'T1-F09-02-ws-pts-push-delivery-and-read-history-receipts',
    name: 'F9: Monotonic per-chat PTS with live WebSocket PtsPush(NewMessage) delivery and ReadHistory inbox/outbox receipts',
    tier: 1,
    features: ['F9'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'f09_t1_02_alice', 'alice_f09_02');
      const bob = await registerSandboxUser(ctx, 'f09_t1_02_bob', 'bob_f09_02');
      const chatId = await createSharedGroup(ctx, alice, 'F9 Realtime WS PTS', [bob.userId]);

      const aliceWs = await ctx.connectWs(alice.token);
      const bobWs = await ctx.connectWs(bob.token);
      await aliceWs.subscribeChat(chatId);
      await bobWs.subscribeChat(chatId);
      const pong = await bobWs.ping(4201);
      assert.equal(pong.payload?.nonce, 4201, 'WebSocket Ping/Pong must echo exact nonce');

      aliceWs.clearBuffer();
      bobWs.clearBuffer();

      const msgIds = [];
      for (let i = 1; i <= 3; i++) {
        const sendRes = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'messages',
          action: 'sendMessage',
          payload: { chatId, text: `WS live msg ${i}`, clientNonce: 2000 + i },
          expectOk: true,
        });
        const mid = Number(sendRes.data?.message_id);
        msgIds.push(mid);

        const pushFrame = await bobWs.waitForFrame(
          (f) =>
            f.type === 'PtsPush' &&
            Number(f.payload?.chat_id) === chatId &&
            f.payload?.event?.type === 'NewMessage' &&
            Number(f.payload?.event?.data?.id) === mid,
          8_000,
        );
        assert.equal(pushFrame.payload.pts_count, 1, 'NewMessage PtsPush must carry pts_count=1');
      }

      const readRes = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'markRead',
        payload: { chatId, maxId: msgIds[1] },
        expectOk: true,
      });
      assert.equal(readRes.data?.success, true, 'markRead must succeed');
      assert.equal(Number(readRes.data?.read_inbox_max_id), msgIds[1], 'read_inbox_max_id must equal msg #2');
      assert.equal(Number(readRes.data?.unread_count), 1, 'unread_count must drop from 3 to 1');

      const bobReadPush = await bobWs.waitForFrame(
        (f) =>
          f.type === 'Update' &&
          f.payload?.type === 'ReadHistory' &&
          Number(f.payload?.data?.chat_id) === chatId &&
          f.payload?.data?.is_outbox === false,
        8_000,
      );
      assert.equal(Number(bobReadPush.payload?.data?.max_id), msgIds[1], 'Bob ReadHistory Update max_id must match');
      assert.equal(Number(bobReadPush.payload?.data?.unread_count), 1, 'Bob ReadHistory Update unread_count must be 1');

      const aliceOutRead = await aliceWs.waitForFrame(
        (f) =>
          f.type === 'Update' &&
          f.payload?.type === 'ReadHistory' &&
          Number(f.payload?.data?.chat_id) === chatId &&
          f.payload?.data?.is_outbox === true,
        8_000,
      );
      assert.equal(
        Number(aliceOutRead.payload?.data?.max_id),
        msgIds[1],
        'Alice outbox ReadHistory Update max_id must match',
      );

      const readAllRes = await ctx.http.post(
        `/api/v1/chats/${chatId}/read`,
        { max_id: msgIds[2] },
        { token: bob.token },
      );
      assert.httpStatus(readAllRes, 200, 'read final message');
      assert.equal(Number(readAllRes.json?.unread_count), 0, 'unread_count must reach 0 after reading msg #3');
      assert.greaterThanOrEqual(
        Number(readAllRes.json?.read_inbox_max_id),
        msgIds[2],
        'read_inbox_max_id must advance monotonically to msg #3',
      );
    },
  }),

  defineTest({
    id: 'T1-F09-03-sync-get-difference-gap-catchup',
    name: 'F9: Sync get_difference gap catch-up recovers missed messages, edits, and reactions up to current_pts',
    tier: 1,
    features: ['F9'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'f09_t1_03_alice', 'alice_f09_03');
      const bob = await registerSandboxUser(ctx, 'f09_t1_03_bob', 'bob_f09_03');
      const chatId = await createSharedGroup(ctx, alice, 'F9 Sync Difference', [bob.userId]);

      const m1 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Anchor baseline message' },
        expectOk: true,
      });
      const anchorPts = Number(m1.data?.pts);
      assert.greaterThanOrEqual(anchorPts, 1, 'Anchor PTS must be >= 1');

      const m2 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Missed message alpha' },
        expectOk: true,
      });
      const m3 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Missed message beta' },
        expectOk: true,
      });
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'editMessage',
        payload: { chatId, messageId: m2.data.message_id, text: 'Missed message alpha (edited)' },
        expectOk: true,
      });
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'toggleReaction',
        payload: { chatId, messageId: m3.data.message_id, emoji: '🔥', reactionAction: 'add' },
        expectOk: true,
      });

      const page1 = await ctx.http.post(
        '/api/v1/sync/get_difference',
        { chat_id: chatId, pts: anchorPts, limit: 2 },
        { token: bob.token },
      );
      assert.httpStatus(page1, 200, 'get_difference page 1');
      assert.equal(page1.json?.has_more, true, 'Bounded limit=2 on 4 missed updates must set has_more=true');
      assert.equal(page1.json?.snapshot_required, false, 'Active journal catch-up must not require snapshot');
      assert.equal(page1.json?.updates?.length, 2, 'Page 1 must return exactly 2 updates');
      assert.greaterThan(Number(page1.json?.current_pts), Number(page1.json?.pts), 'current_pts must exceed page 1 pts');

      const fullDiff = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'sync',
        action: 'getDifference',
        payload: { chatId, pts: anchorPts, limit: 50 },
        expectOk: true,
      });
      assert.equal(fullDiff.data?.has_more, false, 'Full catch-up must reach current_pts with has_more=false');
      assert.equal(fullDiff.data?.pts, fullDiff.data?.current_pts, 'Returned pts cursor must equal current_pts');
      const newMsgUpdates = (fullDiff.data?.updates ?? []).filter((u) => u.event?.type === 'NewMessage');
      assert.equal(newMsgUpdates.length, 2, 'updates must include both missed NewMessage events');
      assert.greaterThanOrEqual(fullDiff.data?.other_updates?.length, 2, 'other_updates must include edit + reaction');

      const caughtUp = await ctx.http.post(
        '/api/v1/sync/get_difference',
        { chat_id: chatId, pts: fullDiff.data.current_pts, limit: 50 },
        { token: bob.token },
      );
      assert.httpStatus(caughtUp, 200, 'caught up get_difference');
      assert.equal(caughtUp.json?.updates?.length, 0, 'Caught-up cursor must return 0 updates');
      assert.equal(caughtUp.json?.has_more, false, 'Caught-up cursor must report has_more=false');
    },
  }),

  defineTest({
    id: 'T1-F09-04-client-nonce-optimistic-deduplication',
    name: 'F9: Optimistic client_nonce (1..=i64::MAX) deduplicates live send and network retries without advancing PTS',
    tier: 1,
    features: ['F9'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'f09_t1_04_alice', 'alice_f09_04');
      const bob = await registerSandboxUser(ctx, 'f09_t1_04_bob', 'bob_f09_04');
      const chatId = await createSharedGroup(ctx, alice, 'F9 Nonce Dedup', [bob.userId]);

      const nonce = 880_441_992;
      const firstSend = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'Exactly-once optimistic message', client_nonce: nonce },
        { token: alice.token },
      );
      assert.httpStatus(firstSend, 201, 'initial send with client_nonce');
      assert.equal(firstSend.json?.duplicate, false, 'Initial send must have duplicate=false');
      assert.equal(firstSend.json?.pts_count, 1, 'Initial send must have pts_count=1');
      const origMsgId = Number(firstSend.json?.message_id);
      const origPts = Number(firstSend.json?.pts);

      const retryHttp = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: chatId, text: 'Exactly-once optimistic message', client_nonce: nonce },
        { token: alice.token },
      );
      assert.oneOf(retryHttp.status, [200, 201], 'Idempotent retry HTTP status');
      assert.equal(retryHttp.json?.duplicate, true, 'Retry with identical nonce+payload must report duplicate=true');
      assert.equal(retryHttp.json?.pts_count, 0, 'Duplicate retry must report pts_count=0');
      assert.equal(Number(retryHttp.json?.message_id), origMsgId, 'Duplicate retry must return original message_id');
      assert.equal(Number(retryHttp.json?.pts), origPts, 'Duplicate retry must preserve original PTS');

      const retryCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Exactly-once optimistic message', clientNonce: nonce },
        expectOk: true,
      });
      assert.equal(retryCli.data?.duplicate, true, 'CLI retry with same clientNonce must deduplicate');
      assert.equal(Number(retryCli.data?.message_id), origMsgId, 'CLI retry must return original message_id');

      const hist = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, { token: bob.token });
      assert.httpStatus(hist, 200, 'history after retries');
      assert.equal(hist.json?.messages?.length, 1, 'Deduplicated retries must persist only 1 message in chat');
    },
  }),

  defineTest({
    id: 'T1-F09-05-durable-sqlite-outbox-offline-queue-and-server-restart-flush',
    name: 'F9: Durable SQLite OutboxStore queues messages while server is stopped/offline and flushes cleanly after server restart',
    tier: 1,
    features: ['F9'],
    timeoutMs: 45_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'f09_t1_05_alice', 'alice_f09_05');
      const bob = await registerSandboxUser(ctx, 'f09_t1_05_bob', 'bob_f09_05');
      const chatId = await createSharedGroup(ctx, alice, 'F9 Durable Outbox', [bob.userId]);

      await server.stop();
      assert.equal(server.isRunning, false, 'Server must be stopped during offline enqueue window');

      const q1 = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'outbox',
        action: 'enqueueOffline',
        payload: { chatId, text: 'Offline durable item 1', clientNonce: 510_001 },
        expectOk: true,
      });
      assert.equal(q1.data?.queued, true, 'First offline message must queue cleanly');
      assert.equal(q1.data?.online, false, 'Outbox must transition sandbox to offline mode');

      const q2 = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'outbox',
        action: 'enqueueOffline',
        payload: { chatId, text: 'Offline durable item 2', clientNonce: 510_002 },
        expectOk: true,
      });
      assert.equal(q2.data?.pendingCount, 2, 'pendingCount must equal 2 after second offline enqueue');

      const pendingSnap = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'outbox',
        action: 'listPending',
        payload: {},
        expectOk: true,
      });
      assert.equal(pendingSnap.data?.online, false, 'Sandbox must remain offline across CLI restarts');
      assert.equal(pendingSnap.data?.pendingCount, 2, 'SQLite outbox must persist 2 Pending records');
      assert.equal(pendingSnap.data?.pending?.length, 2, 'pending array must contain 2 queued records');

      await server.restart();
      assert.equal(server.isRunning, true, 'Server must restart on same port and SQLite DB');

      const flushRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'outbox',
        action: 'flushOutbox',
        payload: {},
        expectOk: true,
      });
      assert.equal(flushRes.data?.online, true, 'flushOutbox must restore online=true');
      assert.equal(flushRes.data?.flushedCount, 2, 'flushOutbox must deliver both queued messages');
      assert.equal(flushRes.data?.remainingPending, 0, 'remainingPending must drop to 0');
      for (const rec of flushRes.data?.flushed ?? []) {
        assert.equal(rec.status, 'Delivered', 'Flushed outbox record must reach Delivered status');
        assert.greaterThan(Number(rec.server_message_id), 0, 'Delivered record must capture server_message_id');
      }

      const historyRes = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'listHistory',
        payload: { chatId, limit: 10 },
        expectOk: true,
      });
      const texts = (historyRes.data?.messages ?? []).map((m) => m.text);
      assert.includes(texts, 'Offline durable item 1', 'Server history must contain flushed message 1');
      assert.includes(texts, 'Offline durable item 2', 'Server history must contain flushed message 2');
    },
  }),

  defineTest({
    id: 'T1-F09-06-conversation-stage-ui-session-and-sync-reconciliation',
    name: 'F9: Virtualized ConversationStage ui-session opens chat, drafts/sends messages, and reconciles PTS sync state across breakpoints',
    tier: 1,
    features: ['F9'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'f09_t1_06_alice', 'alice_f09_06');
      const bob = await registerSandboxUser(ctx, 'f09_t1_06_bob', 'bob_f09_06');
      const chatId = await createSharedGroup(ctx, alice, 'F9 Stage Controller', [bob.userId]);

      await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { text: 'Remote peer message before stage open' },
        { token: bob.token },
      );

      const uiRes = await ctx.cli.uiSession({
        sandbox: alice.sandbox,
        serverUrl: server.baseUrl,
        script: {
          initialWindowWidthVp: 360,
          steps: [
            { op: 'sleepMs', ms: 8 },
            { op: 'navigate', nav: 'chats', chatId },
            { op: 'shortcut', ctrl: true, key: 'f' },
            {
              op: 'invoke',
              domain: 'messages',
              action: 'sendMessage',
              payload: { chatId, text: 'Sent from ConversationStage UI session', clientNonce: 610_001 },
            },
            { op: 'resizeWindow', widthVp: 1360 },
            { op: 'contextMenu', target: 'message_bubble_1' },
            {
              op: 'invoke',
              domain: 'sync',
              action: 'getDifference',
              payload: { chatId, pts: 0, limit: 20 },
            },
            {
              op: 'invoke',
              domain: 'messages',
              action: 'listHistory',
              payload: { chatId, limit: 20 },
            },
          ],
        },
        expectOk: true,
      });

      const finalState = uiRes.data?.finalState;
      assert.equal(finalState?.authState, 'authenticated', 'UI session must remain authenticated');
      assert.equal(finalState?.breakpoint, 'xl', '1360vp resize must transition stage to xl 4-pane');
      assert.equal(finalState?.activeNav, 'chats', 'navigate must activate chats nav');
      assert.equal(finalState?.activeChatId, chatId, 'activeChatId must match opened stage chat');
      assert.equal(finalState?.inspectorOpen, true, 'xl breakpoint must auto-dock right inspector');

      const steps = uiRes.data?.stepResults ?? [];
      assert.equal(steps.length, 8, 'All 8 UI session steps must execute');
      assert.includes(steps[5]?.actions ?? [], 'reply', 'Message context menu must expose reply action');
      assert.equal(steps[6]?.result?.current_pts, 2, 'Sync getDifference step must reconcile current_pts=2');
      assert.equal(steps[7]?.result?.count, 2, 'Stage listHistory step must return both peer and local messages');
    },
  }),
];

export default tests;
