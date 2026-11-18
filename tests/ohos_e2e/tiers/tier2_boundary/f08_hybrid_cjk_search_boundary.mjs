import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function waitForTantivyIndex(ctx, token, queryObj, minHits = 1, timeoutMs = 2_500) {
  const deadline = Date.now() + timeoutMs;
  let lastRes = null;
  while (Date.now() <= deadline) {
    lastRes = await ctx.http.get('/api/v1/search', { token, query: queryObj });
    if (lastRes.status === 200 && Array.isArray(lastRes.json?.hits) && lastRes.json.hits.length >= minHits) {
      return lastRes;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return lastRes;
}

export const tests = [
  defineTest({
    id: 'T2-F08-01-acl-cross-user-search-isolation-zero-hits',
    name: 'F8 Boundary: Strict ACL cross-user search isolation ensures User B never sees User A private chat messages across lexical or hybrid search',
    tier: 2,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const outsiderSb = ctx.createClientSandbox('f08_b_acl_outsider');

      const alice = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_b_acl_alice', password: 'AclAlicePassword!1', first_name: 'Alice Secret' },
        {},
      );
      const bob = await ctx.cli.invoke({
        sandbox: outsiderSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f08_b_acl_bob',
          password: 'AclBobPassword!2',
          firstName: 'Bob Outsider',
        },
        expectOk: true,
      });

      const aliceToken = alice.json.token;
      const bobToken = bob.data.session.token;

      const secretVault = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Alice Eyes Only Vault', chat_type: 'group' },
        { token: aliceToken },
      );
      const vaultChatId = secretVault.json.chat_id;

      const secretKeyword = 'classified_obsidian_cipher_909';
      const secretCjk = '绝密量子密钥分发协议严禁外泄';
      await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: vaultChatId, text: `Top secret ${secretKeyword} ${secretCjk}` },
        { token: aliceToken },
      );

      // Confirm Alice sees the indexed message in both Tantivy and Hybrid search
      const aliceLex = await waitForTantivyIndex(
        ctx,
        aliceToken,
        { q: secretKeyword, category: 'messages' },
        1,
        2_500,
      );
      assert.equal(aliceLex.json?.hits?.length, 1, 'Owner Alice must find her own private message');

      // Outsider Bob queries messages, chats, all, mode=hybrid, and CLI searchAll/searchHybrid -> strictly 0 hits
      for (const queryParams of [
        { q: secretKeyword, category: 'messages' },
        { q: secretKeyword, category: 'all' },
        { q: secretKeyword, mode: 'hybrid' },
        { q: '量子密钥分发协议', mode: 'hybrid' },
        { q: 'Alice Eyes Only Vault', category: 'chats' },
      ]) {
        const bobRes = await ctx.http.get('/api/v1/search', { token: bobToken, query: queryParams });
        assert.httpStatus(bobRes, 200, `Outsider search ${JSON.stringify(queryParams)}`);
        assert.equal(bobRes.json?.hits?.length ?? 0, 0, 'Outsider Bob must receive 0 message hits');
        assert.equal(bobRes.json?.results?.length ?? 0, 0, 'Outsider Bob must receive 0 dialog results');
      }

      const bobCliAll = await ctx.cli.invoke({
        sandbox: outsiderSb,
        serverUrl: server.baseUrl,
        domain: 'search',
        action: 'searchAll',
        payload: { query: secretKeyword },
        expectOk: true,
      });
      assert.equal(bobCliAll.data?.chats?.length ?? 0, 0, 'CLI searchAll must not leak Alice chat');
      assert.equal(bobCliAll.data?.messages?.hits?.length ?? 0, 0, 'CLI searchAll must not leak Alice message');
    },
  }),

  defineTest({
    id: 'T2-F08-02-soft-deleted-message-purged-from-lexical-and-hybrid-search',
    name: 'F8 Boundary: Soft-deleted/revoked message is purged from search results across both category=messages and mode=hybrid (0 hits)',
    tier: 2,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const reg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_b_del_purge', password: 'DelPurgePassword!2', first_name: 'Purge User' },
        {},
      );
      const token = reg.json.token;

      const chat = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Delete Purge Room', chat_type: 'group' },
        { token },
      );
      const chatId = chat.json.chat_id;

      const ephemeralToken = 'ephemeral_vanish_token_515';
      const ephemeralCjk = '阅后即焚敏感指令片段';
      const sent = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: chatId, text: `Temporary ${ephemeralToken} ${ephemeralCjk}` },
        { token },
      );
      const msgId = sent.json?.message_id ?? sent.json?.id;

      const preLex = await waitForTantivyIndex(
        ctx,
        token,
        { q: ephemeralToken, category: 'messages' },
        1,
        2_500,
      );
      assert.equal(preLex.json?.hits?.length, 1, 'Message must be indexed before deletion');

      const preHyb = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: '敏感指令片段', mode: 'hybrid' },
      });
      assert.greaterThanOrEqual(preHyb.json?.hits?.length, 1, 'Message must be in hybrid memory before deletion');

      // Soft-delete / revoke message via DELETE /api/v1/chats/{id}/messages/{msg_id}
      const delRes = await ctx.http.del(`/api/v1/chats/${chatId}/messages/${msgId}`, undefined, { token });
      assert.httpStatus(delRes, 200, 'DELETE /api/v1/chats/{id}/messages/{mid}');

      // Both category=messages AND mode=hybrid must return 0 hits for the deleted message
      const postLex = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: ephemeralToken, category: 'messages' },
      });
      assert.httpStatus(postLex, 200, 'Post-delete lexical search');
      assert.equal(postLex.json?.hits?.length, 0, 'Soft-deleted message must return 0 hits in category=messages');

      const postHyb = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: '敏感指令片段', mode: 'hybrid' },
      });
      assert.httpStatus(postHyb, 200, 'Post-delete hybrid search');
      assert.equal(postHyb.json?.hits?.length, 0, 'Soft-deleted message must return 0 hits in mode=hybrid');
    },
  }),

  defineTest({
    id: 'T2-F08-03-scoped-search-on-non-member-chat-rejected-403',
    name: 'F8 Boundary: Scoped search (chat_id=<id>) on non-member chat returns 403 Forbidden and nonexistent chat returns 404',
    tier: 2,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const intruderSb = ctx.createClientSandbox('f08_b_scoped_403');

      const owner = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_b_scope_owner', password: 'ScopeOwnerPassword!3', first_name: 'Owner' },
        {},
      );
      const intruder = await ctx.cli.invoke({
        sandbox: intruderSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f08_b_scope_intruder',
          password: 'ScopeIntruderPassword!3',
          firstName: 'Intruder',
        },
        expectOk: true,
      });

      const ownerChat = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Restricted Audit Room', chat_type: 'group' },
        { token: owner.json.token },
      );
      const restrictedChatId = ownerChat.json.chat_id;
      const intruderToken = intruder.data.session.token;

      // 1. Non-member scoped search on /api/v1/search and /api/v1/search/messages -> 403
      const scopedUnified = await ctx.http.get('/api/v1/search', {
        token: intruderToken,
        query: { q: 'audit', category: 'messages', chat_id: restrictedChatId },
      });
      assert.httpStatus(scopedUnified, 403, 'Non-member GET /api/v1/search?chat_id=<restricted> must return 403');

      const scopedHybrid = await ctx.http.get('/api/v1/search', {
        token: intruderToken,
        query: { q: 'audit', mode: 'hybrid', chat_id: restrictedChatId },
      });
      assert.httpStatus(scopedHybrid, 403, 'Non-member hybrid search with chat_id=<restricted> must return 403');

      const scopedMessagesRoute = await ctx.http.get('/api/v1/search/messages', {
        token: intruderToken,
        query: { q: 'audit', chat_id: restrictedChatId },
      });
      assert.httpStatus(scopedMessagesRoute, 403, 'Non-member GET /api/v1/search/messages?chat_id=<restricted> must return 403');

      // 2. CLI searchMessages & searchHybrid with restricted chatId -> expectOk: false
      const cliScopedRej = await ctx.cli.invoke({
        sandbox: intruderSb,
        serverUrl: server.baseUrl,
        domain: 'search',
        action: 'searchHybrid',
        payload: { query: 'audit', chatId: restrictedChatId },
        expectOk: false,
      });
      assert.equal(cliScopedRej.ok, false, 'CLI searchHybrid on unauthorized chatId must fail');

      // 3. Nonexistent chat_id -> 404
      const ghostChatSearch = await ctx.http.get('/api/v1/search', {
        token: intruderToken,
        query: { q: 'audit', category: 'messages', chat_id: 987654321 },
      });
      assert.httpStatus(ghostChatSearch, 404, 'Scoped search on nonexistent chat_id must return 404');
    },
  }),

  defineTest({
    id: 'T2-F08-04-empty-query-limit-clamping-and-special-operator-resilience',
    name: 'F8 Boundary: Empty/whitespace q, extreme limit=0/-5/999999 clamping, and malformed Tantivy/SQL/XSS query syntax return 200 without 500 crash',
    tier: 2,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const reg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_b_fuzz_user', password: 'FuzzSearchPassword!4', first_name: 'Fuzz User' },
        {},
      );
      const token = reg.json.token;

      const chat = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Fuzz Resilience Group', chat_type: 'group' },
        { token },
      );
      const chatId = chat.json.chat_id;

      for (let i = 1; i <= 4; i++) {
        await ctx.http.post(
          '/api/v1/messages/send',
          { chat_id: chatId, text: `Resilience sample_${i} baseline_token_fuzz` },
          { token },
        );
      }
      await waitForTantivyIndex(ctx, token, { q: 'baseline_token_fuzz', category: 'messages' }, 4, 2_500);

      // 1. Empty & whitespace query on category=messages and mode=hybrid -> 200 with 0 message hits (no full-DB dump)
      for (const emptyQ of ['', '    ']) {
        const emptyLex = await ctx.http.get('/api/v1/search', {
          token,
          query: { q: emptyQ, category: 'messages' },
        });
        assert.httpStatus(emptyLex, 200, 'Empty q on category=messages must return 200');
        assert.equal(emptyLex.json?.hits?.length, 0, 'Empty q must return 0 message hits');

        const emptyHyb = await ctx.http.get('/api/v1/search', {
          token,
          query: { q: emptyQ, mode: 'hybrid' },
        });
        assert.httpStatus(emptyHyb, 200, 'Empty q on mode=hybrid must return 200');
        assert.equal(emptyHyb.json?.hits?.length, 0, 'Empty q on mode=hybrid must return 0 message hits');
      }

      // 2. Extreme limit values: limit=0 clamps to 1; limit=-10 defaults/clamps safely; limit=999999 clamps <=100
      const limitZero = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'baseline_token_fuzz', category: 'messages', limit: 0 },
      });
      assert.httpStatus(limitZero, 200, 'limit=0 must clamp safely and return 200');
      assert.equal(limitZero.json?.hits?.length, 1, 'limit=0 clamped to 1..=100 must return 1 hit');

      const limitHuge = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'baseline_token_fuzz', category: 'messages', limit: 999999 },
      });
      assert.httpStatus(limitHuge, 200, 'limit=999999 must clamp <=100 and return 200');
      assert.lessThanOrEqual(limitHuge.json?.hits?.length, 100, 'Clamped limit must never exceed 100');

      const limitNeg = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'baseline_token_fuzz', category: 'messages', limit: -25 },
      });
      assert.httpStatus(limitNeg, 200, 'Negative limit must not panic');

      // 3. Malformed Tantivy syntax, SQL injection, XSS payloads, emoji, and 512-char query -> 200 OK
      const adversarialQueries = [
        '((([[[{{{:::AND OR NOT~~~^^^***???',
        "'; DROP TABLE messages; --",
        '<script>alert("xss")</script>',
        '🔥🚀🧘‍♂️ 法布施 ((unclosed "quote',
        '鸿蒙'.repeat(256),
      ];
      for (const adv of adversarialQueries) {
        const lexAdv = await ctx.http.get('/api/v1/search', {
          token,
          query: { q: adv, category: 'messages' },
        });
        assert.httpStatus(lexAdv, 200, `Adversarial Tantivy query must not 500: ${adv.slice(0, 32)}`);
        assert.isArray(lexAdv.json?.hits, 'Adversarial query response must contain valid hits array');

        const hybAdv = await ctx.http.get('/api/v1/search', {
          token,
          query: { q: adv, mode: 'hybrid' },
        });
        assert.httpStatus(hybAdv, 200, `Adversarial hybrid query must not 500: ${adv.slice(0, 32)}`);
      }
    },
  }),

  defineTest({
    id: 'T2-F08-05-cleared-chat-history-purges-indexed-messages-from-search',
    name: 'F8 Boundary: Clearing chat history (POST /api/v1/chats/{id}/clear) purges indexed messages from lexical and hybrid search',
    tier: 2,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const reg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_b_clear_user', password: 'ClearPurgePassword!5', first_name: 'Clear User' },
        {},
      );
      const token = reg.json.token;

      const chat = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Clear History Search Purge', chat_type: 'group' },
        { token },
      );
      const chatId = chat.json.chat_id;

      const clearToken = 'titanium_wipe_marker_737';
      const clearCjk = '清空历史记录彻底抹除检索索引';
      await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: chatId, text: `Confidential ${clearToken} ${clearCjk}` },
        { token },
      );

      const beforeClear = await waitForTantivyIndex(
        ctx,
        token,
        { q: clearToken, category: 'messages' },
        1,
        2_500,
      );
      assert.equal(beforeClear.json?.hits?.length, 1, 'Message must be searchable prior to clear');

      const clearRes = await ctx.http.post(`/api/v1/chats/${chatId}/clear`, {}, { token });
      assert.httpStatus(clearRes, 200, 'POST /api/v1/chats/{id}/clear');
      assert.equal(clearRes.json?.cleared, true, 'clear endpoint must report cleared=true');

      const afterLex = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: clearToken, category: 'messages' },
      });
      assert.httpStatus(afterLex, 200, 'Post-clear lexical search');
      assert.equal(afterLex.json?.hits?.length, 0, 'Cleared chat messages must return 0 hits in category=messages');

      const afterHyb = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: '彻底抹除检索索引', mode: 'hybrid' },
      });
      assert.httpStatus(afterHyb, 200, 'Post-clear hybrid search');
      assert.equal(afterHyb.json?.hits?.length, 0, 'Cleared chat messages must return 0 hits in mode=hybrid');
    },
  }),

  defineTest({
    id: 'T2-F08-06-e2ee-encrypted-envelope-never-indexed-in-plaintext-search',
    name: 'F8 Boundary: E2EE Encrypted message payloads are skipped by server-side Tantivy and HybridMemoryEngine indexers',
    tier: 2,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const reg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_b_e2ee_guard', password: 'E2eeSearchPassword!6', first_name: 'E2EE Guard' },
        {},
      );
      const token = reg.json.token;

      const chat = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'E2EE Unindexed Vault', chat_type: 'group' },
        { token },
      );
      const chatId = chat.json.chat_id;

      const unindexedMarker = 'unindexedratchetmarker31415';
      const encSend = await ctx.http.post(
        '/api/v1/messages/send',
        {
          chat_id: chatId,
          content: {
            type: 'Encrypted',
            data: {
              version: 1,
              sender_user_id: reg.json.user_id,
              sender_device_id: 'ohos_dev_1',
              sender_identity_key: Buffer.alloc(32, 7).toString('base64'),
              sender_signing_key: Buffer.alloc(32, 9).toString('base64'),
              kind: {
                kind: 'GroupSenderKey',
                payload: {
                  chat_id: chatId,
                  chain_id: 1,
                  iteration: 1,
                  ciphertext: unindexedMarker,
                  signature: Buffer.alloc(64, 5).toString('base64'),
                },
              },
            },
          },
        },
        { token },
      );
      assert.httpStatus(encSend, [200, 201], 'Send Encrypted E2EE envelope');

      // Also send a normal plaintext message and wait for Tantivy commit so writer queue is flushed
      await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: chatId, text: 'flush_barrier_plaintext_888' },
        { token },
      );
      await waitForTantivyIndex(ctx, token, { q: 'flush_barrier_plaintext_888', category: 'messages' }, 1, 2_500);

      const lexProbe = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: unindexedMarker, category: 'messages' },
      });
      assert.httpStatus(lexProbe, 200, 'Search encrypted marker in Tantivy');
      assert.equal(lexProbe.json?.hits?.length, 0, 'Encrypted envelope must never be indexed in Tantivy');

      const hybProbe = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: unindexedMarker, mode: 'hybrid' },
      });
      assert.httpStatus(hybProbe, 200, 'Search encrypted marker in HybridMemoryEngine');
      assert.equal(hybProbe.json?.hits?.length, 0, 'Encrypted envelope must never be indexed in HybridMemoryEngine');
    },
  }),

  defineTest({
    id: 'T2-F08-07-post-leave-chat-revokes-search-visibility-and-unauth-401',
    name: 'F8 Boundary: Leaving a group immediately revokes search visibility (0 hits + 403 scoped) and unauthenticated search returns 401',
    tier: 2,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const unauthSb = ctx.createClientSandbox('f08_b_unauth');

      // 1. Unauthenticated HTTP & CLI search -> 401 / expectOk: false
      const unauthHttp = await ctx.http.get('/api/v1/search', { query: { q: 'test', category: 'messages' } });
      assert.httpStatus(unauthHttp, 401, 'Unauthenticated GET /api/v1/search must return 401');

      const unauthCli = await ctx.cli.invoke({
        sandbox: unauthSb,
        serverUrl: server.baseUrl,
        domain: 'search',
        action: 'searchHybrid',
        payload: { query: 'test' },
        expectOk: false,
      });
      assert.equal(unauthCli.errorCode, 'UNAUTHORIZED', 'Unauthenticated CLI searchHybrid must return UNAUTHORIZED');

      // 2. Member joins group, sees search hit, leaves group -> immediately loses global & scoped search access
      const owner = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_b_leave_owner', password: 'LeaveOwnerPassword!7', first_name: 'Owner' },
        {},
      );
      const exMember = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_b_leave_member', password: 'LeaveMemberPassword!7', first_name: 'ExMember' },
        {},
      );
      const ownerToken = owner.json.token;
      const exToken = exMember.json.token;

      const grp = await ctx.http.post(
        '/api/v1/chats/create',
        {
          title: 'Membership Revocation Search Group',
          chat_type: 'group',
          member_ids: [exMember.json.user_id],
        },
        { token: ownerToken },
      );
      const chatId = grp.json.chat_id;

      const groupSecret = 'departed_member_secret_606';
      await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: chatId, text: `Internal memo ${groupSecret} 离群后不可检索` },
        { token: ownerToken },
      );

      const whileMember = await waitForTantivyIndex(
        ctx,
        exToken,
        { q: groupSecret, category: 'messages' },
        1,
        2_500,
      );
      assert.equal(whileMember.json?.hits?.length, 1, 'Active member must see group message in search');

      // Member leaves group
      const leaveRes = await ctx.http.post(`/api/v1/chats/${chatId}/leave`, {}, { token: exToken });
      assert.httpStatus(leaveRes, 200, 'POST /api/v1/chats/{id}/leave');

      const afterLeaveLex = await ctx.http.get('/api/v1/search', {
        token: exToken,
        query: { q: groupSecret, category: 'messages' },
      });
      assert.equal(afterLeaveLex.json?.hits?.length, 0, 'Departed member must get 0 hits in lexical search');

      const afterLeaveHyb = await ctx.http.get('/api/v1/search', {
        token: exToken,
        query: { q: '离群后不可检索', mode: 'hybrid' },
      });
      assert.equal(afterLeaveHyb.json?.hits?.length, 0, 'Departed member must get 0 hits in hybrid search');

      const afterLeaveScoped = await ctx.http.get('/api/v1/search', {
        token: exToken,
        query: { q: groupSecret, category: 'messages', chat_id: chatId },
      });
      assert.httpStatus(afterLeaveScoped, 403, 'Departed member scoped search on left group must return 403');
    },
  }),
];

export default tests;
