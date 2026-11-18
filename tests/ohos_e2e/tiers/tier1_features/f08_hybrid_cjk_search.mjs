import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function pollTantivyHits(ctx, token, queryObj, minHits = 1, timeoutMs = 2_500) {
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
    id: 'T1-F08-01-categorized-chats-and-channels-lexical-search',
    name: 'F8: Categorized chats and channels lexical search via GET /api/v1/search?category=chats|channels',
    tier: 1,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const aliceReg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_cat_alice', password: 'SearchPassword!1', first_name: 'Alice Search' },
        {},
      );
      const bobReg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_cat_bob', password: 'SearchPassword!2', first_name: 'Zephyr Contact' },
        {},
      );
      assert.httpStatus(aliceReg, 201, 'Register Alice');
      assert.httpStatus(bobReg, 201, 'Register Bob');
      const token = aliceReg.json.token;

      const grp = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Nebula Architecture Guild', chat_type: 'group' },
        { token },
      );
      const chan = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Nebula Kernel Releases', chat_type: 'channel', about: 'Official kernel changelog' },
        { token },
      );
      const dm = await ctx.http.post(
        '/api/v1/chats/create',
        { chat_type: 'direct', peer_user_id: bobReg.json.user_id },
        { token },
      );
      assert.httpStatus(grp, 201, 'Create group');
      assert.httpStatus(chan, 201, 'Create channel');
      assert.httpStatus(dm, 201, 'Create DM');

      // 1. category=chats matches both group and channel with 'Nebula'
      const chatsSearch = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'Nebula', category: 'chats' },
      });
      assert.httpStatus(chatsSearch, 200, 'GET /api/v1/search?category=chats');
      assert.isArray(chatsSearch.json?.results, 'search results must be an array');
      const resultChatIds = chatsSearch.json.results.map((r) => r.chat_id ?? r.id);
      assert.includes(resultChatIds, grp.json.chat_id, 'category=chats must match Nebula group');
      assert.includes(resultChatIds, chan.json.chat_id, 'category=chats must match Nebula channel');
      assert.notIncludes(resultChatIds, dm.json.chat_id, 'category=chats for Nebula must exclude unrelated DM');

      // 2. category=channels returns group/channel results and excludes private 1:1 DM
      const chanSearch = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'Releases', category: 'channels' },
      });
      assert.httpStatus(chanSearch, 200, 'GET /api/v1/search?category=channels');
      const chanIds = (chanSearch.json?.results ?? []).map((r) => r.chat_id ?? r.id);
      assert.includes(chanIds, chan.json.chat_id, 'category=channels must match Nebula Kernel Releases channel');
      assert.notIncludes(chanIds, dm.json.chat_id, 'category=channels must exclude private DM');
    },
  }),

  defineTest({
    id: 'T1-F08-02-tantivy-lexical-messages-search-and-mark-snippets',
    name: 'F8: Tantivy full-text message search (category=messages) after commit window with <mark>...</mark> snippet highlights',
    tier: 1,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const reg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_tantivy_user', password: 'TantivyPassword!2', first_name: 'Tantivy' },
        {},
      );
      assert.httpStatus(reg, 201, 'Register user');
      const token = reg.json.token;

      const chat = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Tantivy Lexical Lab', chat_type: 'group' },
        { token },
      );
      const chatId = chat.json.chat_id;

      const enMsg = await ctx.http.post(
        '/api/v1/messages/send',
        {
          chat_id: chatId,
          text: 'Deploying hyperionbeacon941 telemetry pipeline on OpenHarmony Stage Model',
        },
        { token },
      );
      const cjkMsg = await ctx.http.post(
        '/api/v1/messages/send',
        {
          chat_id: chatId,
          text: '法布施 鸿蒙原生 分布式软总线 检索引擎 验证通过',
        },
        { token },
      );
      assert.httpStatus(enMsg, [200, 201], 'Send English message');
      assert.httpStatus(cjkMsg, [200, 201], 'Send tokenized CJK message');
      const enMsgId = enMsg.json?.message_id ?? enMsg.json?.id;
      const cjkMsgId = cjkMsg.json?.message_id ?? cjkMsg.json?.id;

      // Wait for background tantivy-writer commit (>= 600ms window) via bounded poll
      const enSearch = await pollTantivyHits(
        ctx,
        token,
        { q: 'hyperionbeacon941', category: 'messages' },
        1,
        2_500,
      );
      assert.httpStatus(enSearch, 200, 'Tantivy English search');
      assert.greaterThanOrEqual(enSearch.json?.hits?.length, 1, 'Tantivy must return hit for hyperionbeacon941');
      const enHit = enSearch.json.hits.find((h) => h.message_id === enMsgId);
      assert.isObject(enHit, 'Tantivy hits must contain exact enMsgId');
      assert.equal(enHit.chat_id, chatId, 'Hit chat_id must match');
      assert.includes(
        enHit.snippet_html,
        '<mark>hyperionbeacon941</mark>',
        'Tantivy snippet_html must wrap matched token in <mark>...</mark>',
      );

      const cjkSearch = await pollTantivyHits(
        ctx,
        token,
        { q: '分布式软总线', category: 'messages' },
        1,
        2_500,
      );
      assert.httpStatus(cjkSearch, 200, 'Tantivy CJK search');
      const cjkHit = (cjkSearch.json?.hits ?? []).find((h) => h.message_id === cjkMsgId);
      assert.isObject(cjkHit, 'Tantivy hits must contain CJK message');
      assert.includes(
        cjkHit.snippet_html,
        '<mark>分布式软总线</mark>',
        'Tantivy CJK snippet_html must highlight matched CJK token with <mark>',
      );
    },
  }),

  defineTest({
    id: 'T1-F08-03-synchronous-hybrid-rrf-unspaced-cjk-trigram-search',
    name: 'F8: Synchronous mode=hybrid and category=hybrid RRF 3-byte CJK window search immediately matches unspaced Chinese phrases',
    tier: 1,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const reg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_hybrid_cjk', password: 'HybridCjkPassword!3', first_name: 'Hybrid CJK' },
        {},
      );
      assert.httpStatus(reg, 201, 'Register user');
      const token = reg.json.token;

      const chat = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Hybrid CJK Memory Channel', chat_type: 'supergroup' },
        { token },
      );
      const chatId = chat.json.chat_id;

      // Send contiguous unspaced Chinese sentence + entity hashtag and query IMMEDIATELY (0ms wait)
      const sent = await ctx.http.post(
        '/api/v1/messages/send',
        {
          chat_id: chatId,
          text: '鸿蒙原生全场景端云协同量子态加密通信底座正式上线 #HarmonyNext @CoreTeam',
        },
        { token },
      );
      assert.httpStatus(sent, [200, 201], 'Send contiguous unspaced CJK message');
      const sentMsgId = sent.json?.message_id ?? sent.json?.id;

      // 1. Immediate mode=hybrid query on interior unspaced CJK substring (no sleep for Tantivy 500ms commit)
      const hybridModeRes = await ctx.http.get('/api/v1/search', {
        token,
        query: {
          q: '端云协同量子态加密',
          mode: 'hybrid',
        },
      });
      assert.httpStatus(hybridModeRes, 200, 'Immediate GET /api/v1/search?mode=hybrid');
      assert.greaterThanOrEqual(
        hybridModeRes.json?.hits?.length,
        1,
        'Synchronous HybridMemoryEngine (mode=hybrid) must immediately match unspaced CJK substring',
      );
      const modeHit = hybridModeRes.json.hits.find((h) => h.message_id === sentMsgId);
      assert.isObject(modeHit, 'mode=hybrid hits must include sentMsgId immediately');
      assert.equal(modeHit.chat_id, chatId, 'mode=hybrid hit chat_id must match');

      // 2. Immediate category=hybrid query on another unspaced CJK substring + entity hint
      const hybridCatRes = await ctx.http.get('/api/v1/search', {
        token,
        query: {
          q: '全场景端云协同',
          category: 'hybrid',
          entity: 'HarmonyNext',
        },
      });
      assert.httpStatus(hybridCatRes, 200, 'Immediate GET /api/v1/search?category=hybrid');
      const catHit = (hybridCatRes.json?.hits ?? []).find((h) => h.message_id === sentMsgId);
      assert.isObject(catHit, 'category=hybrid RRF search must match unspaced CJK phrase immediately');
    },
  }),

  defineTest({
    id: 'T1-F08-04-scoped-single-chat-message-search-isolation',
    name: 'F8: Scoped single-chat message search (chat_id=<id>) strictly isolates hits to target conversation',
    tier: 1,
    features: ['F8'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const reg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_scoped_user', password: 'ScopedPassword!4', first_name: 'Scoped' },
        {},
      );
      const token = reg.json.token;

      const roomAlpha = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Alpha Scoped Room', chat_type: 'group' },
        { token },
      );
      const roomBeta = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Beta Scoped Room', chat_type: 'group' },
        { token },
      );
      const alphaId = roomAlpha.json.chat_id;
      const betaId = roomBeta.json.chat_id;

      const sharedToken = 'solstice_meridian_409';
      const msgAlpha = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: alphaId, text: `Alpha report containing ${sharedToken} payload` },
        { token },
      );
      const msgBeta = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: betaId, text: `Beta report containing ${sharedToken} payload` },
        { token },
      );
      assert.httpStatus(msgAlpha, [200, 201], 'Send to Alpha');
      assert.httpStatus(msgBeta, [200, 201], 'Send to Beta');

      // Wait until global search sees both chats indexed
      const globalHitsRes = await pollTantivyHits(
        ctx,
        token,
        { q: sharedToken, category: 'messages' },
        2,
        2_500,
      );
      assert.greaterThanOrEqual(globalHitsRes.json?.hits?.length, 2, 'Unscoped search must find hits in both rooms');

      // Scoped search on alphaId must return ONLY alphaId hits across both lexical and hybrid modes
      const scopedLex = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: sharedToken, category: 'messages', chat_id: alphaId },
      });
      assert.httpStatus(scopedLex, 200, 'Scoped lexical search on alphaId');
      assert.equal(scopedLex.json?.hits?.length, 1, 'Scoped lexical search must return exactly 1 hit');
      assert.equal(scopedLex.json.hits[0].chat_id, alphaId, 'Scoped lexical hit must belong strictly to alphaId');

      const scopedHyb = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: sharedToken, mode: 'hybrid', chat_id: betaId },
      });
      assert.httpStatus(scopedHyb, 200, 'Scoped hybrid search on betaId');
      assert.greaterThanOrEqual(scopedHyb.json?.hits?.length, 1, 'Scoped hybrid search must find betaId hit');
      for (const hit of scopedHyb.json.hits) {
        assert.equal(hit.chat_id, betaId, 'Every scoped hybrid hit must belong strictly to betaId');
      }
    },
  }),

  defineTest({
    id: 'T1-F08-05-global-bots-miniapps-and-all-catalog-search',
    name: 'F8: Global bots and apps/miniapps catalog search across category=bots, category=apps, category=miniapps, and category=all',
    tier: 1,
    features: ['F8'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();

      const reg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f08_catalog_owner', password: 'CatalogPassword!5', first_name: 'Catalog Owner' },
        {},
      );
      assert.httpStatus(reg, 201, 'Register catalog owner');
      const token = reg.json.token;

      // 1. Verify auto-seeded @BotFather (777001) in category=bots
      const bfSearch = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'BotFather', category: 'bots' },
      });
      assert.httpStatus(bfSearch, 200, 'Search @BotFather in category=bots');
      assert.isArray(bfSearch.json?.bots, 'category=bots must return bots array');
      const hasBotFather = bfSearch.json.bots.some(
        (b) => b.bot_user_id === 777001 || String(b.username).toLowerCase() === 'botfather',
      );
      assert.equal(hasBotFather, true, 'Auto-seeded @BotFather (777001) must match category=bots');

      // 2. Register a custom companion bot + published MiniApp and query category=bots, apps, miniapps, all
      const botRes = await ctx.http.post(
        '/api/v1/bots',
        {
          username: 'lotus_zen_compass_bot',
          display_name: 'Lotus Zen Compass Bot',
          description: 'Mindfulness timer and sutra companion',
          about: 'Official Lotus Zen bot',
        },
        { token },
      );
      assert.httpStatus(botRes, [200, 201], 'POST /api/v1/bots');

      const appRes = await ctx.http.post(
        '/api/v1/miniapps',
        {
          bot_username: 'lotus_zen_compass_bot',
          short_name: 'lotus_zen_compass',
          title: 'Lotus Zen Dharma Compass',
          description: 'Interactive 3D Dharma meditation MiniApp',
          category: 'productivity',
        },
        { token },
      );
      assert.httpStatus(appRes, [200, 201], 'POST /api/v1/miniapps');

      const appsSearch = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'Lotus Zen', category: 'apps' },
      });
      assert.httpStatus(appsSearch, 200, 'GET /api/v1/search?category=apps');
      assert.isArray(appsSearch.json?.apps, 'category=apps must return apps array');
      assert.equal(
        appsSearch.json.apps.some((a) => a.short_name === 'lotus_zen_compass' || a.title?.includes('Lotus Zen')),
        true,
        'category=apps must return published Lotus Zen MiniApp',
      );

      const miniappsSearch = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'Dharma Compass', category: 'miniapps' },
      });
      assert.httpStatus(miniappsSearch, 200, 'GET /api/v1/search?category=miniapps');
      assert.equal(
        (miniappsSearch.json?.apps ?? []).some((a) => a.short_name === 'lotus_zen_compass'),
        true,
        'category=miniapps alias must return published Lotus Zen MiniApp',
      );

      const allSearch = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'Lotus Zen', category: 'all' },
      });
      assert.httpStatus(allSearch, 200, 'GET /api/v1/search?category=all');
      assert.greaterThanOrEqual(allSearch.json?.bots?.length, 1, 'category=all must populate bots matches');
      assert.greaterThanOrEqual(allSearch.json?.apps?.length, 1, 'category=all must populate apps matches');
    },
  }),

  defineTest({
    id: 'T1-F08-06-ohos-cli-search-domain-all-five-actions',
    name: 'F8: HarmonyOS ohos-app-cli search domain exercises searchAll, searchChats, searchMessages, searchHybrid, and searchGlobalCatalog',
    tier: 1,
    features: ['F8'],
    timeoutMs: 45_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const searchSb = ctx.createClientSandbox('f08_cli_search');

      const reg = await ctx.cli.invoke({
        sandbox: searchSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f08_cli_researcher',
          password: 'CliSearchPassword!6',
          firstName: 'CLI Researcher',
        },
        expectOk: true,
      });
      const token = reg.data.session.token;

      const chat = await ctx.cli.invoke({
        sandbox: searchSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Celestial Observatory Room', chatType: 'group' },
        expectOk: true,
      });
      const chatId = chat.data.chat_id;

      await ctx.http.post(
        '/api/v1/messages/send',
        {
          chat_id: chatId,
          text: 'Celestial quasar_pulse_883 observation and 鸿蒙星闪超低时延协同链路 telemetry',
        },
        { token },
      );

      await ctx.http.post(
        '/api/v1/bots',
        {
          username: 'celestial_atlas_bot',
          display_name: 'Celestial Atlas Bot',
          description: 'Star chart catalog assistant',
          about: 'Celestial bot',
        },
        { token },
      );

      // Ensure Tantivy writer has committed lexical tokens before CLI lexical queries
      await pollTantivyHits(ctx, token, { q: 'quasar_pulse_883', category: 'messages' }, 1, 2_500);

      // 1. searchChats
      const chatsRes = await ctx.cli.invoke({
        sandbox: searchSb,
        serverUrl: server.baseUrl,
        domain: 'search',
        action: 'searchChats',
        payload: { query: 'Observatory', limit: 10 },
        expectOk: true,
      });
      assert.equal(chatsRes.data?.count, 1, 'CLI searchChats must match Celestial Observatory Room');
      assert.equal(chatsRes.data?.chats?.[0]?.chat_id, chatId, 'searchChats chat_id must match');

      // 2. searchMessages
      const msgsRes = await ctx.cli.invoke({
        sandbox: searchSb,
        serverUrl: server.baseUrl,
        domain: 'search',
        action: 'searchMessages',
        payload: { query: 'quasar_pulse_883', chatId, limit: 10 },
        expectOk: true,
      });
      const msgHits = msgsRes.data?.hits ?? msgsRes.data?.results ?? [];
      assert.greaterThanOrEqual(msgHits.length, 1, 'CLI searchMessages must return Tantivy lexical hit');

      // 3. searchHybrid (unspaced CJK phrase)
      const hybRes = await ctx.cli.invoke({
        sandbox: searchSb,
        serverUrl: server.baseUrl,
        domain: 'search',
        action: 'searchHybrid',
        payload: { query: '星闪超低时延协同', chatId, limit: 10 },
        expectOk: true,
      });
      assert.greaterThanOrEqual(
        hybRes.data?.hits?.length,
        1,
        'CLI searchHybrid must return RRF CJK trigram hit',
      );

      // 4. searchAll
      const allRes = await ctx.cli.invoke({
        sandbox: searchSb,
        serverUrl: server.baseUrl,
        domain: 'search',
        action: 'searchAll',
        payload: { query: 'Celestial', limit: 20 },
        expectOk: true,
      });
      assert.greaterThanOrEqual(allRes.data?.chats?.length, 1, 'CLI searchAll must include matching chats');
      assert.isObject(allRes.data?.messages, 'CLI searchAll must include messages search section');

      // 5. searchGlobalCatalog
      const catRes = await ctx.cli.invoke({
        sandbox: searchSb,
        serverUrl: server.baseUrl,
        domain: 'search',
        action: 'searchGlobalCatalog',
        payload: { query: 'Celestial Atlas', category: 'bots' },
        expectOk: true,
      });
      assert.isObject(catRes.data, 'CLI searchGlobalCatalog must return catalog response object');
      assert.includes(JSON.stringify(catRes.data), 'celestial_atlas_bot', 'searchGlobalCatalog must find registered bot');
    },
  }),

  defineTest({
    id: 'T1-F08-07-message-edit-reindexing-and-ui-session-quick-search-shortcuts',
    name: 'F8: Message edit updates Tantivy search index and 2-in-1 Ctrl+K / Ctrl+F / Escape shortcuts drive quick search in uiSession',
    tier: 1,
    features: ['F8'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const uiSb = ctx.createClientSandbox('f08_edit_and_shortcuts');

      const reg = await ctx.cli.invoke({
        sandbox: uiSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f08_reindex_user',
          password: 'ReindexPassword!7',
          firstName: 'Reindex User',
        },
        expectOk: true,
      });
      const token = reg.data.session.token;

      const chat = await ctx.cli.invoke({
        sandbox: uiSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Edit Reindex Verification', chatType: 'group' },
        expectOk: true,
      });
      const chatId = chat.data.chat_id;

      const sendRes = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: chatId, text: 'Initial draft token cobalt_legacy_111 before edit' },
        { token },
      );
      const msgId = sendRes.json?.message_id ?? sendRes.json?.id;
      await pollTantivyHits(ctx, token, { q: 'cobalt_legacy_111', category: 'messages' }, 1, 2_500);

      // Edit message via PUT /api/v1/chats/{id}/messages/{mid} -> new token indexed, old token replaced
      const editRes = await ctx.http.put(
        `/api/v1/chats/${chatId}/messages/${msgId}`,
        { text: 'Updated finalized token emerald_revised_222 after edit' },
        { token },
      );
      assert.httpStatus(editRes, 200, 'PUT /api/v1/chats/{id}/messages/{mid}');

      const updatedSearch = await pollTantivyHits(
        ctx,
        token,
        { q: 'emerald_revised_222', category: 'messages' },
        1,
        2_500,
      );
      assert.equal(updatedSearch.json?.hits?.[0]?.message_id, msgId, 'Edited message must be searchable by new token');

      const staleSearch = await ctx.http.get('/api/v1/search', {
        token,
        query: { q: 'cobalt_legacy_111', category: 'messages' },
      });
      assert.equal(staleSearch.json?.hits?.length, 0, 'Edited-out token must no longer return hits in Tantivy');

      // Exercise 2-in-1 quick-search keyboard shortcuts + live search invoke inside uiSession
      const uiRes = await ctx.cli.uiSession({
        sandbox: uiSb,
        serverUrl: server.baseUrl,
        script: {
          initialWindowWidthVp: 1440,
          steps: [
            { op: 'shortcut', key: 'k', ctrl: true },
            {
              op: 'invoke',
              domain: 'search',
              action: 'searchMessages',
              payload: { query: 'emerald_revised_222', chatId },
            },
            { op: 'shortcut', key: 'Escape', ctrl: false },
            { op: 'shortcut', key: 'f', ctrl: true },
          ],
        },
        expectOk: true,
      });
      assert.equal(uiRes.data?.stepResults?.[0]?.effect, 'openQuickSearch', 'Ctrl+K must trigger openQuickSearch');
      assert.equal(uiRes.data?.stepResults?.[0]?.commandPaletteOpen, true, 'Ctrl+K must open command palette');
      assert.equal(uiRes.data?.stepResults?.[2]?.effect, 'dismissOverlay', 'Escape must dismiss search overlay');
      assert.equal(uiRes.data?.stepResults?.[3]?.effect, 'focusInChatSearch', 'Ctrl+F must focus in-chat search');
      assert.equal(uiRes.data?.finalState?.searchFocused, true, 'Final state after Ctrl+F must have searchFocused=true');
    },
  }),
];

export default tests;
