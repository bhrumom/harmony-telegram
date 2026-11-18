import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerBotOwner(ctx, label, prefix) {
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
      deviceName: `OHOS_F15_${label}`,
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
    id: 'T1-F15-01-botfather-create-nl-builder-and-token-regeneration',
    name: 'F15: BotFather bot creation (_bot normalization, 600000+ ID), NL prompt bot+miniapp builder, commands, inlineQuery, and token rotation',
    tier: 1,
    features: ['F15'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBotOwner(ctx, 'alice_bf', 'f15_bf');

      const createdBot = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'createBot',
        payload: {
          username: `harmony_helper_${alice.suffix}`,
          displayName: 'Harmony Helper Bot',
          about: 'Automated release & build helper',
        },
      });
      const botDto = createdBot.data?.bot ?? createdBot.data;
      const botUserId = Number(botDto?.bot_user_id ?? botDto?.bot_id);
      const botUsername = String(botDto?.username ?? '');
      const initialToken = String(createdBot.data?.botToken ?? createdBot.data?.bot_token ?? '');

      assert.greaterThanOrEqual(botUserId, 600_000, 'BotFather bot_user_id must allocate in 600_000+ range');
      assert.match(botUsername, /_bot$/i, 'BotFather must normalize bot username with _bot suffix');
      assert.includes(initialToken, ':', 'Bot token must follow <bot_id>:<secret> format');

      const nlCreated = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'createBotFromPrompt',
        payload: {
          prompt: 'Create a daily standup & sprint tracker bot with a kanban miniapp',
          avatarShape: 'hexagon',
          avatarColor: '#2563EB',
        },
      });
      assert.isNonEmptyString(nlCreated.data?.botToken, 'NL bot builder must return live botToken');
      assert.isNonEmptyString(nlCreated.data?.summary_markdown, 'NL bot builder must return summary_markdown');

      const setCmds = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'setBotCommands',
        payload: {
          botToken: initialToken,
          commands: [
            { command: 'status', description: 'Check cluster build health' },
            { command: 'deploy', description: 'Trigger canary rollout' },
          ],
        },
      });
      assert.equal(setCmds.data?.ok, true, 'setBotCommands via /bot/{token}/setMyCommands must return ok: true');

      const listRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'listBots',
        payload: {},
      });
      assert.greaterThanOrEqual((listRes.data?.bots || []).length, 2, 'listBots must list both created bots');

      const profRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'getBotProfile',
        payload: { target: botUsername },
      });
      assert.equal(profRes.data?.username, botUsername, 'getBotProfile must resolve bot by username');

      const inlineRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'inlineQuery',
        payload: { botUsername, query: 'status' },
      });
      assert.greaterThanOrEqual((inlineRes.data?.results || []).length, 1, 'inlineQuery must match /status command');

      const rotated = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'regenerateToken',
        payload: { botId: botUserId },
      });
      const newToken = String(rotated.data?.bot_token ?? rotated.data?.token ?? '');
      assert.isNonEmptyString(newToken, 'regenerateToken must issue replacement token');
      assert.notEqual(newToken, initialToken, 'regenerated token must differ from revoked token');

      const oldMe = await ctx.http.get(`/bot${initialToken}/getMe`);
      assert.httpStatus(oldMe, 401, 'Old bot token must return 401 Unauthorized after rotation');

      const newMe = await ctx.http.get(`/bot${newToken}/getMe`);
      assert.httpStatus(newMe, 200, 'New bot token must succeed on /bot{token}/getMe');
      assert.equal(newMe.json?.ok, true, 'getMe ok flag must be true');
    },
  }),

  defineTest({
    id: 'T1-F15-02-telegram-bot-api-inline-keyboard-callback-and-companion-bot',
    name: 'F15: Telegram Bot API getMe, sendMessage with InlineKeyboardMarkup, callback_query -> getUpdates -> answerCallbackQuery, and Grok persona bot',
    tier: 1,
    features: ['F15'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBotOwner(ctx, 'alice_botapi', 'f15_bapi');

      const botHttp = await ctx.http.post(
        '/api/v1/bots',
        {
          username: `deploy_gate_${alice.suffix}_bot`,
          display_name: 'Deploy Gate Bot',
          description: 'Interactive release approval bot',
        },
        { token: alice.token },
      );
      assert.httpStatus(botHttp, 201, 'POST /api/v1/bots');
      const botToken = String(botHttp.json?.bot_token ?? '');
      const botUserId = Number(botHttp.json?.bot?.bot_user_id);
      assert.isNonEmptyString(botToken, 'bot_token must be returned');

      const group = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Release Ops Group', chatType: 'group' },
      });
      const chatId = Number(group.data?.chat_id ?? group.data?.chatId);

      const added = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'addBotToChat',
        payload: { chatId, botUserId },
      });
      assert.equal(added.data?.added, true, 'addBotToChat must add bot to group');

      const sentMarkup = await ctx.http.post(`/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: 'Approve HarmonyOS v1.2.0 production rollout?',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve Rollout', callback_data: 'rollout:approve:v1.2.0' },
              { text: 'Abort', callback_data: 'rollout:abort' },
            ],
          ],
        },
      });
      assert.httpStatus(sentMarkup, 200, 'POST /bot{token}/sendMessage with inline_keyboard');
      assert.equal(sentMarkup.json?.ok, true, 'Bot API sendMessage must return ok: true');
      const messageId = Number(sentMarkup.json?.result?.message_id);
      assert.greaterThan(messageId, 0, 'Bot API sendMessage must return positive message_id');

      const cbClicked = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'sendCallbackQuery',
        payload: {
          chatId,
          messageId,
          callbackData: 'rollout:approve:v1.2.0',
        },
      });
      assert.isObject(cbClicked.data, 'sendCallbackQuery must return callback acknowledgement');

      const updates = await ctx.http.get(`/bot${botToken}/getUpdates`);
      assert.httpStatus(updates, 200, 'GET /bot{token}/getUpdates');
      assert.equal(updates.json?.ok, true, 'getUpdates must return ok: true');
      const cbUpdate = (updates.json?.result || []).find(
        (u) => u?.callback_query?.data === 'rollout:approve:v1.2.0',
      );
      assert.isObject(cbUpdate, 'getUpdates must deliver enqueued callback_query update');

      const answerCb = await ctx.http.post(`/bot${botToken}/answerCallbackQuery`, {
        callback_query_id: String(cbUpdate.callback_query.id),
        text: 'Rollout v1.2.0 approved!',
        show_alert: false,
      });
      assert.httpStatus(answerCb, 200, 'POST /bot{token}/answerCallbackQuery');
      assert.equal(answerCb.json?.ok, true, 'answerCallbackQuery must return ok: true');

      const grokBot = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'createBot',
        payload: {
          isAiCompanion: true,
          displayName: 'Grok Aurora Persona',
          systemPrompt: 'You are Grok Aurora, an energetic HarmonyOS companion.',
        },
      });
      const grokBotId = Number(grokBot.data?.bot_user_id ?? grokBot.data?.bot_id ?? grokBot.data?.bot?.bot_user_id);
      assert.greaterThanOrEqual(grokBotId, 600_000, 'Grok companion bot ID must be >= 600_000');

      const updatedGrok = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'updateBotProfile',
        payload: {
          botId: grokBotId,
          display_name: 'Grok Aurora Prime',
        },
      });
      assert.isObject(updatedGrok.data, 'updateBotProfile on companion bot must succeed');
    },
  }),

  defineTest({
    id: 'T1-F15-03-miniapp-catalog-wasm-upload-and-hmac-initdata',
    name: 'F15: MiniApp registration, valid 33-byte \\0asm WASM upload & app.wasm fetch, launch initData, and HMAC-SHA256 verification',
    tier: 1,
    features: ['F15'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBotOwner(ctx, 'alice_tma', 'f15_tma');

      const botRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'createBot',
        payload: {
          username: `miniapp_host_${alice.suffix}`,
          displayName: 'MiniApp Host Bot',
        },
      });
      const botUsername = String(botRes.data?.bot?.username ?? botRes.data?.username);
      const botToken = String(botRes.data?.botToken ?? botRes.data?.bot_token);

      const registeredApp = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'registerMiniApp',
        payload: {
          botUsername,
          shortName: 'zen_clock',
          title: 'Zen Clock MiniApp',
          description: 'Minimal WASM mindfulness timer',
          category: 'utilities',
          iconEmoji: '⏳',
        },
      });
      assert.equal(registeredApp.data?.short_name ?? registeredApp.data?.shortName, 'zen_clock', 'short_name must match');

      const catalog = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'listCatalog',
        payload: { query: 'Zen Clock' },
      });
      assert.greaterThanOrEqual(Number(catalog.data?.count), 1, 'listCatalog must find registered MiniApp');

      const wasmBytes = ctx.crypto.buildMinimalWasmModuleBytes();
      const expectedWasmSha = ctx.crypto.sha256Hex(wasmBytes);
      const uploadedWasm = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'uploadWasm',
        payload: {
          wasmBase64: wasmBytes.toString('base64'),
          filename: 'zen_clock.wasm',
        },
      });
      assert.equal(uploadedWasm.data?.validWasm, true, 'uploadWasm must validate \\0asm v1 binary header');
      assert.equal(Number(uploadedWasm.data?.sizeBytes), 33, 'minimal WASM module must be 33 bytes');
      assert.equal(uploadedWasm.data?.sha256, expectedWasmSha, 'uploaded WASM SHA-256 must match local digest');

      const fabushiWasm = await ctx.http.get('/api/v1/miniapps/fabushi/app.wasm', {
        token: alice.token,
      });
      assert.httpStatus(fabushiWasm, 200, 'GET /api/v1/miniapps/fabushi/app.wasm');
      assert.includes(
        String(fabushiWasm.headers['content-type'] || ''),
        'application/wasm',
        'app.wasm endpoint must serve Content-Type: application/wasm',
      );
      assert.equal(
        fabushiWasm.buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])),
        true,
        'served app.wasm payload must start with \\0asm magic bytes',
      );

      const launched = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'launchMiniApp',
        payload: {
          uri: `gpui-miniapp://${botUsername}/zen_clock`,
          startParam: 'ref_ohos_e2e',
        },
      });
      const initDataObj = launched.data?.init_data ?? launched.data?.initData;
      assert.equal(initDataObj?.hmac_verified, true, 'launched MiniApp context must mark hmac_verified: true');
      const rawInitData = String(initDataObj?.raw_query_string ?? '');
      assert.includes(rawInitData, 'hash=', 'launched raw_query_string must contain HMAC hash');

      const nodeVerified = ctx.crypto.verifyTelegramWebAppInitData(botToken, rawInitData);
      assert.equal(nodeVerified, true, 'WebAppData HMAC-SHA256 must verify independently in Node crypto');

      const cliLocalVerify = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'verifyInitDataHmac',
        payload: { initData: rawInitData, botToken },
      });
      assert.equal(cliLocalVerify.data?.valid, true, 'CLI local verifyInitDataHmac must pass');

      const cliServerVerify = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'verifyInitDataHmac',
        payload: { botUsername, shortName: 'zen_clock', initData: rawInitData },
      });
      assert.equal(cliServerVerify.data?.valid, true, 'Server validate-init-data via CLI must pass');
    },
  }),

  defineTest({
    id: 'T1-F15-04-miniapp-cloud-storage-crud-and-a2ui-schema-renderer',
    name: 'F15: Per-user MiniApp CloudStorage CRUD and safe declarative A2UI widget schema validation/rendering',
    tier: 1,
    features: ['F15'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBotOwner(ctx, 'alice_storage', 'f15_store');

      const botRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'createBot',
        payload: { username: `storage_bot_${alice.suffix}`, displayName: 'Cloud Storage Bot' },
      });
      const botUsername = String(botRes.data?.bot?.username ?? botRes.data?.username);

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'registerMiniApp',
        payload: {
          botUsername,
          shortName: 'notes_pad',
          title: 'Cloud Notes Pad',
        },
      });

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'cloudStorageSet',
        payload: {
          botUsername,
          shortName: 'notes_pad',
          key: 'draft_note_1',
          value: JSON.stringify({ title: 'Stage V2 Checklist', done: true }),
        },
      });

      const fetched = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'cloudStorageGet',
        payload: {
          botUsername,
          shortName: 'notes_pad',
          key: 'draft_note_1',
        },
      });
      assert.includes(String(fetched.data?.item?.value ?? ''), 'Stage V2 Checklist', 'cloudStorageGet must return saved value');

      const storageHttp = await ctx.http.get(`/api/v1/miniapps/${botUsername}/notes_pad/storage`, {
        token: alice.token,
      });
      assert.httpStatus(storageHttp, 200, 'GET /api/v1/miniapps/{bot}/{short}/storage');
      assert.equal(Number(storageHttp.json?.total), 1, 'CloudStorage total must be 1');

      const deleted = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'cloudStorageDelete',
        payload: {
          botUsername,
          shortName: 'notes_pad',
          key: 'draft_note_1',
        },
      });
      assert.equal(deleted.data?.deleted, true, 'cloudStorageDelete must delete key cleanly');

      const a2uiRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'renderUiSchema',
        payload: {
          schema: {
            type: 'Card',
            title: 'Fabushi Daily Merit Summary',
            children: [
              {
                type: 'Row',
                children: [
                  { type: 'Badge', text: 'VIP 2x' },
                  { type: 'Stat', label: 'Merit', value: '1,280' },
                ],
              },
              { type: 'Progress', value: 0.75 },
              { type: 'Button', label: 'Open Dharma Globe', url: 'https://openharmony.cn/fabushi' },
            ],
          },
        },
      });
      assert.equal(a2uiRes.data?.valid, true, 'renderUiSchema must accept valid A2UI tree');
      assert.equal(Number(a2uiRes.data?.renderedNodeCount), 6, 'renderedNodeCount must count all 6 A2UI widget nodes');
    },
  }),

  defineTest({
    id: 'T1-F15-05-fabushi-bootstrap-3d-globe-projection-and-offerings-vip',
    name: 'F15: Fabushi Global Dharma Offering bootstrap, 3D spherical globe beam projection, merit offering transfer, and VIP subscription',
    tier: 1,
    features: ['F15'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBotOwner(ctx, 'alice_fabushi', 'f15_fab');

      const boot = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'bootstrap',
        payload: {},
      });
      assert.greaterThanOrEqual(Number(boot.data?.countryCount), 8, 'Fabushi must seed >= 8 global country nodes');
      assert.greaterThanOrEqual(Number(boot.data?.sutraCount), 8, 'Fabushi must include >= 8 canonical sutras');
      assert.isObject(boot.data?.bootstrap?.profile, 'Fabushi bootstrap must return user Dharma profile');

      const globe = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'getGlobe',
        payload: {
          fromCountry: 'CN',
          toCountry: 'JP',
        },
      });
      assert.equal(Number(globe.data?.beamCount), 1, 'getGlobe must add active light beam arc');
      assert.equal(globe.data?.from?.code, 'CN', 'origin country must be CN');
      assert.equal(globe.data?.to?.code, 'JP', 'destination country must be JP');
      assert.isObject(globe.data?.from?.projected, '3D globe projection must compute x/y/z coordinates');

      const vipSub = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'subscribeVip',
        payload: { plan: 'monthly' },
      });
      assert.isObject(vipSub.data, 'subscribeVip(monthly) must return membership activation');

      const offering = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'createOffering',
        payload: {
          toCountry: 'US',
          contentTitle: '金刚经',
          beamCount: 3,
        },
      });
      assert.greaterThanOrEqual(Number(offering.data?.meritGained), 30, 'createOffering(beamCount=3) must award >= 30 merit');
      assert.greaterThan(Number(offering.data?.bytesOffered), 0, 'bytesOffered must be > 0');
      assert.equal(offering.data?.targetCountry, 'US', 'targetCountry must be US');

      const updatedProf = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'updateProfile',
        payload: {
          dharma_name: '慧明居士',
          country_code: 'CN',
          dedication_text: '愿以此功德，普及于一切',
        },
      });
      assert.isObject(updatedProf.data, 'fabushi.updateProfile must update Dharma profile');

      const profHttp = await ctx.http.get('/api/v1/miniapps/fabushi/profile', {
        token: alice.token,
      });
      assert.httpStatus(profHttp, 200, 'GET /api/v1/miniapps/fabushi/profile');
    },
  }),

  defineTest({
    id: 'T1-F15-06-fabushi-zen-meditation-sutras-leaderboard-and-ai-guide',
    name: 'F15: Fabushi Zen Room meditation sessions, canonical sutra completion, global merit leaderboard, and Dharma AI Guide chat',
    tier: 1,
    features: ['F15'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBotOwner(ctx, 'alice_zen', 'f15_zen');

      const sutrasRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'listSutras',
        payload: {},
      });
      const sutras = sutrasRes.data?.sutras || [];
      assert.greaterThanOrEqual(sutras.length, 8, 'listSutras must return >= 8 canonical sutras');
      const heartOrFirst = sutras.find((s) => String(s.title).includes('心经')) ?? sutras[0];
      assert.isNonEmptyString(heartOrFirst?.title, 'canonical sutra must have non-empty title');

      const completed = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'completeSutra',
        payload: { sutraTitle: heartOrFirst.title },
      });
      assert.equal(completed.data?.completed, true, 'completeSutra must mark canonical sutra completed');
      assert.greaterThan(Number(completed.data?.byteCount), 0, 'completed sutra byteCount must be > 0');

      const meditated = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'recordMeditation',
        payload: {
          durationSeconds: 1200,
          sutraName: '木鱼静心禅修',
          chantCount: 108,
          notes: 'Evening breath & wooden fish session',
        },
      });
      assert.isObject(meditated.data, 'recordMeditation must persist Zen Room session');

      const practiceList = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'listPracticeRecords',
        payload: {},
      });
      assert.isObject(practiceList.data, 'listPracticeRecords must return practice log payload');

      const leaderboard = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'getLeaderboard',
        payload: { kind: 'global', limit: 20 },
      });
      assert.isObject(leaderboard.data, 'getLeaderboard must return global Dharma ranking');

      const aiChat = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'aiGuideChat',
        payload: {
          message: '请简述每日禅修静坐的呼吸要点',
          history: [],
        },
      });
      assert.isObject(aiChat.data, 'aiGuideChat must return Dharma AI guide response');
      const replyStr = String(aiChat.data?.reply ?? aiChat.data?.message ?? aiChat.data?.content ?? JSON.stringify(aiChat.data));
      assert.greaterThan(replyStr.length, 2, 'Dharma AI guide reply must be non-empty');
    },
  }),
];

export default tests;
