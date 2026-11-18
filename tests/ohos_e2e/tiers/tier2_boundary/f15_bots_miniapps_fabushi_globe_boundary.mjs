import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerF15BoundaryUser(ctx, label, prefix) {
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
      deviceName: `OHOS_B15_${label}`,
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
    id: 'T2-F15-01-corrupted-wasm-magic-and-truncated-binary-rejection',
    name: 'F15 Boundary: Reject corrupted \\0asm magic headers, truncated <8-byte binaries, wrong WASM version, and malformed gpui-miniapp:// URIs',
    tier: 2,
    features: ['F15'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF15BoundaryUser(ctx, 'alice_wasm_b', 'f15b_wasm');

      const badMagic = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x00, 0x00, 0x00, 0x00]);
      const resBadMagic = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'uploadWasm',
        payload: { wasmBase64: badMagic.toString('base64'), filename: 'corrupt.wasm' },
        expectOk: false,
      });
      assert.equal(resBadMagic.errorCode, 'VALIDATION_ERROR', 'Corrupted WASM magic bytes must return VALIDATION_ERROR');
      assert.includes(resBadMagic.error, 'missing \\0asm', 'error message must cite missing \\0asm header');

      const truncatedWasm = Buffer.from([0x00, 0x61, 0x73]);
      const resTrunc = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'uploadWasm',
        payload: { wasmBase64: truncatedWasm.toString('base64') },
        expectOk: false,
      });
      assert.equal(resTrunc.errorCode, 'VALIDATION_ERROR', 'Truncated <8-byte WASM binary must return VALIDATION_ERROR');

      const wrongVersionWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
      const resWrongVer = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'uploadWasm',
        payload: { wasmBase64: wrongVersionWasm.toString('base64') },
        expectOk: false,
      });
      assert.equal(resWrongVer.errorCode, 'VALIDATION_ERROR', 'WASM version != 1 must return VALIDATION_ERROR');

      for (const badUri of ['https://evil.example/app', 'gpui-miniapp://bot_without_short_name']) {
        const badLaunch = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'miniapps',
          action: 'launchMiniApp',
          payload: { uri: badUri },
          expectOk: false,
        });
        assert.equal(badLaunch.errorCode, 'VALIDATION_ERROR', `Malformed MiniApp URI '${badUri}' must fail validation`);
      }
    },
  }),

  defineTest({
    id: 'T2-F15-02-tampered-and-forged-miniapp-initdata-hmac-rejection',
    name: 'F15 Boundary: Tampered WebApp initData parameters, wrong botToken secret, and missing hash fail HMAC-SHA256 verification',
    tier: 2,
    features: ['F15'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF15BoundaryUser(ctx, 'alice_hmac_b', 'f15b_hmac');

      const botRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'createBot',
        payload: { username: `hmac_guard_${alice.suffix}`, displayName: 'HMAC Guard Bot' },
      });
      const botUsername = String(botRes.data?.bot?.username ?? botRes.data?.username);
      const botToken = String(botRes.data?.botToken ?? botRes.data?.bot_token);

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'registerMiniApp',
        payload: { botUsername, shortName: 'pay_vault', title: 'Pay Vault' },
      });

      const launched = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'launchMiniApp',
        payload: { botUsername, shortName: 'pay_vault' },
      });
      const validInitData = String(launched.data?.init_data?.raw_query_string ?? '');
      assert.includes(validInitData, 'hash=', 'valid launch initData must include hash');

      // Tamper with auth_date while keeping original hash
      const tamperedInitData = validInitData.replace(/auth_date=\d+/, 'auth_date=1999999999');
      assert.notEqual(tamperedInitData, validInitData, 'tampered query string must differ from original');

      assert.equal(
        ctx.crypto.verifyTelegramWebAppInitData(botToken, tamperedInitData),
        false,
        'Node WebAppData HMAC verifier must reject tampered auth_date',
      );

      const cliLocalTamper = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'verifyInitDataHmac',
        payload: { initData: tamperedInitData, botToken },
        expectOk: false,
      });
      assert.equal(cliLocalTamper.errorCode, 'UNAUTHORIZED', 'CLI local HMAC check must return UNAUTHORIZED on tamper');

      const cliServerTamper = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'verifyInitDataHmac',
        payload: { botUsername, shortName: 'pay_vault', initData: tamperedInitData },
        expectOk: false,
      });
      assert.equal(cliServerTamper.errorCode, 'UNAUTHORIZED', 'Server initData check via CLI must return UNAUTHORIZED');

      const httpValidate = await ctx.http.post(
        `/api/v1/miniapps/${botUsername}/pay_vault/validate-init-data`,
        { init_data: tamperedInitData },
        { token: alice.token },
      );
      assert.httpStatus(httpValidate, 200, 'POST validate-init-data returns structured validation result');
      assert.equal(httpValidate.json?.valid, false, 'Server validate-init-data must set valid: false for tampered signature');

      const wrongBotSecret = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'verifyInitDataHmac',
        payload: { initData: validInitData, botToken: '600999:forged_wrong_bot_secret' },
        expectOk: false,
      });
      assert.equal(wrongBotSecret.errorCode, 'UNAUTHORIZED', 'Wrong botToken secret must fail HMAC verification');

      const missingHash = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'verifyInitDataHmac',
        payload: { initData: 'auth_date=1700000000&query_id=q_no_hash', botToken },
        expectOk: false,
      });
      assert.equal(missingHash.errorCode, 'VALIDATION_ERROR', 'initData missing hash parameter must return VALIDATION_ERROR');
    },
  }),

  defineTest({
    id: 'T2-F15-03-miniapp-cloud-storage-isolation-and-size-quotas',
    name: 'F15 Boundary: Per-user MiniApp CloudStorage strict tenant isolation and >128B key / >4096B value size quota rejection',
    tier: 2,
    features: ['F15'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF15BoundaryUser(ctx, 'alice_cs_b', 'f15b_cs_a');
      const bob = await registerF15BoundaryUser(ctx, 'bob_cs_b', 'f15b_cs_b');

      const botRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'createBot',
        payload: { username: `tenant_vault_${alice.suffix}`, displayName: 'Tenant Vault Bot' },
      });
      const botUsername = String(botRes.data?.bot?.username ?? botRes.data?.username);

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'registerMiniApp',
        payload: { botUsername, shortName: 'iso_vault', title: 'Isolated Vault' },
      });

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'cloudStorageSet',
        payload: {
          botUsername,
          shortName: 'iso_vault',
          key: 'private_seed_note',
          value: 'ALICE_CONFIDENTIAL_DATA_9911',
        },
      });

      // Bob reads same MiniApp CloudStorage and must NOT see Alice's data
      const bobReadCli = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'miniapps',
        action: 'cloudStorageGet',
        payload: { botUsername, shortName: 'iso_vault', key: 'private_seed_note' },
      });
      assert.equal(bobReadCli.data?.item, null, 'Bob must NOT read Alice CloudStorage key');

      const bobStorageHttp = await ctx.http.get(`/api/v1/miniapps/${botUsername}/iso_vault/storage`, {
        token: bob.token,
      });
      assert.httpStatus(bobStorageHttp, 200, 'Bob GET storage');
      assert.equal(Number(bobStorageHttp.json?.total), 0, 'Bob CloudStorage namespace must be empty');

      // Bob deleting key must not delete Alice's key
      await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'miniapps',
        action: 'cloudStorageDelete',
        payload: { botUsername, shortName: 'iso_vault', key: 'private_seed_note' },
      });
      const aliceStillIntact = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'cloudStorageGet',
        payload: { botUsername, shortName: 'iso_vault', key: 'private_seed_note' },
      });
      assert.equal(aliceStillIntact.data?.item?.value, 'ALICE_CONFIDENTIAL_DATA_9911', 'Alice key must survive Bob delete');

      // Oversized key (>128 bytes) & oversized value (>4096 bytes)
      const overKey = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'cloudStorageSet',
        payload: {
          botUsername,
          shortName: 'iso_vault',
          key: 'k'.repeat(129),
          value: 'ok',
        },
        expectOk: false,
      });
      assert.equal(overKey.errorCode, 'VALIDATION_ERROR', 'CloudStorage key > 128 bytes must return VALIDATION_ERROR');

      const overValue = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'cloudStorageSet',
        payload: {
          botUsername,
          shortName: 'iso_vault',
          key: 'oversized_val',
          value: 'v'.repeat(4097),
        },
        expectOk: false,
      });
      assert.equal(overValue.errorCode, 'VALIDATION_ERROR', 'CloudStorage value > 4096 bytes must return VALIDATION_ERROR');
    },
  }),

  defineTest({
    id: 'T2-F15-04-bot-token-forgery-uninvited-dm-403-and-cross-owner-protection',
    name: 'F15 Boundary: Forged bot tokens (401), duplicate bot username (409), cross-owner rotation/deletion (403), and unsolicited bot DM anti-spam (403)',
    tier: 2,
    features: ['F15'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF15BoundaryUser(ctx, 'alice_sec_b', 'f15b_sec_a');
      const bob = await registerF15BoundaryUser(ctx, 'bob_sec_b', 'f15b_sec_b');

      const botRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'createBot',
        payload: { username: `guarded_bot_${alice.suffix}`, displayName: 'Guarded Bot' },
      });
      const botDto = botRes.data?.bot ?? botRes.data;
      const botUserId = Number(botDto?.bot_user_id ?? botDto?.bot_id);
      const botUsername = String(botDto?.username);
      const botToken = String(botRes.data?.botToken ?? botRes.data?.bot_token);

      // 1. Forged Bot API tokens -> 401
      const forgedGetMe = await ctx.http.get(`/bot${botUserId}:forged_invalid_secret_token/getMe`);
      assert.httpStatus(forgedGetMe, 401, 'Forged bot secret on /getMe must return 401');

      const malformedTokenSend = await ctx.http.post('/botmalformed_no_colon/sendMessage', {
        chat_id: bob.userId,
        text: 'Forged message',
      });
      assert.httpStatus(malformedTokenSend, 401, 'Malformed bot token without colon must return 401');

      // 2. Duplicate bot username -> 409 Conflict
      const dupCreate = await ctx.http.post(
        '/api/v1/bots',
        { username: botUsername, display_name: 'Duplicate Clone' },
        { token: bob.token },
      );
      assert.httpStatus(dupCreate, 409, 'Creating bot with already-registered username must return 409 Conflict');

      // 3. Cross-owner token rotation & deletion -> 403 Forbidden
      const bobRotate = await ctx.http.post(
        `/api/v1/bots/${botUserId}/regenerate-token`,
        {},
        { token: bob.token },
      );
      assert.httpStatus(bobRotate, 403, 'Non-owner regenerating another user bot token must return 403');

      const bobDelete = await ctx.http.delete(`/api/v1/bots/${botUserId}`, {
        token: bob.token,
      });
      assert.httpStatus(bobDelete, 403, 'Non-owner deleting another user bot must return 403');

      // 4. Bot DM anti-spam gate: unsolicited DM to Bob fails with 403 until Bob grants permission
      const unsolicitedDm = await ctx.http.post(`/bot${botToken}/sendMessage`, {
        chat_id: bob.userId,
        text: 'Unsolicited cold DM from bot',
      });
      assert.httpStatus(unsolicitedDm, 403, 'Bot DM before user opt-in must return 403 Forbidden');

      const allowDm = await ctx.http.post(
        `/api/v1/bots/${botUserId}/allow-send-message`,
        {},
        { token: bob.token },
      );
      assert.httpStatus(allowDm, 200, 'Bob granting allow-send-message to bot');

      const permittedDm = await ctx.http.post(`/bot${botToken}/sendMessage`, {
        chat_id: bob.userId,
        text: 'Opted-in welcome message from bot',
      });
      assert.httpStatus(permittedDm, 200, 'Bot DM after allow-send-message must succeed with 200');
    },
  }),

  defineTest({
    id: 'T2-F15-05-a2ui-javascript-uri-disallowed-widget-and-deep-nesting-rejection',
    name: 'F15 Boundary: Declarative A2UI renderer blocks javascript: XSS URIs, disallowed HTML/Iframe widgets, and >16 nesting depth',
    tier: 2,
    features: ['F15'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF15BoundaryUser(ctx, 'alice_a2ui_b', 'f15b_a2ui');

      const xssButton = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'renderUiSchema',
        payload: {
          schema: {
            type: 'Card',
            children: [
              {
                type: 'Button',
                label: 'Claim Reward',
                url: 'javascript:window.stealSessionToken()',
              },
            ],
          },
        },
        expectOk: false,
      });
      assert.equal(xssButton.errorCode, 'VALIDATION_ERROR', 'javascript: URI in A2UI Button must return VALIDATION_ERROR');
      assert.includes(xssButton.error, 'javascript:', 'error message must cite blocked javascript: URI');

      const disallowedWidget = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'renderUiSchema',
        payload: {
          schema: {
            type: 'ScriptTag',
            src: 'https://attacker.example/payload.js',
          },
        },
        expectOk: false,
      });
      assert.equal(disallowedWidget.errorCode, 'VALIDATION_ERROR', 'Disallowed A2UI component type must fail validation');

      let deepTree = { type: 'Text', content: 'leaf' };
      for (let i = 0; i < 18; i += 1) {
        deepTree = { type: 'Column', children: [deepTree] };
      }
      const deepNesting = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'miniapps',
        action: 'renderUiSchema',
        payload: { schema: deepTree },
        expectOk: false,
      });
      assert.equal(deepNesting.errorCode, 'VALIDATION_ERROR', 'A2UI tree exceeding depth 16 must return VALIDATION_ERROR');
      assert.includes(deepNesting.error, 'depth', 'error must mention nesting depth limit');
    },
  }),

  defineTest({
    id: 'T2-F15-06-fabushi-invalid-iso-country-zero-meditation-and-unknown-sutra',
    name: 'F15 Boundary: Fabushi rejects unknown ISO country codes, 0-second meditation, unknown sutras, and unauthenticated API calls',
    tier: 2,
    features: ['F15'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerF15BoundaryUser(ctx, 'alice_fab_b', 'f15b_fab');

      const badGlobe = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'getGlobe',
        payload: { fromCountry: 'CN', toCountry: 'ZZ_INVALID' },
        expectOk: false,
      });
      assert.equal(badGlobe.errorCode, 'VALIDATION_ERROR', 'Unknown ISO country in getGlobe must return VALIDATION_ERROR');

      const badOffering = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'createOffering',
        payload: { toCountry: 'XX_UNKNOWN', beamCount: 1 },
        expectOk: false,
      });
      assert.equal(badOffering.errorCode, 'VALIDATION_ERROR', 'Unknown target country in createOffering must return VALIDATION_ERROR');

      const zeroMeditation = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'recordMeditation',
        payload: { durationSeconds: 0 },
        expectOk: false,
      });
      assert.equal(zeroMeditation.errorCode, 'VALIDATION_ERROR', 'durationSeconds=0 in recordMeditation must fail');

      const unknownSutra = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'fabushi',
        action: 'completeSutra',
        payload: { sutraTitle: 'Nonexistent Sutra Title XYZ-999' },
        expectOk: false,
      });
      assert.equal(unknownSutra.errorCode, 'NOT_FOUND', 'Unknown sutra in completeSutra must return NOT_FOUND');

      const unauthBootstrap = await ctx.http.get('/api/v1/miniapps/fabushi/bootstrap');
      assert.httpStatus(unauthBootstrap, 401, 'Unauthenticated Fabushi bootstrap must return 401');

      const unauthTransfer = await ctx.http.post('/api/v1/miniapps/fabushi/transfer', {
        content_title: '金刚经',
        content_kind: 'sutra',
        target_countries: ['JP'],
        bytes_sent: 1024,
        beam_count: 1,
      });
      assert.httpStatus(unauthTransfer, 401, 'Unauthenticated Fabushi transfer must return 401');
    },
  }),
];

export default tests;
