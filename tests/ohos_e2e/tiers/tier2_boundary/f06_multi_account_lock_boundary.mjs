import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

const MAX_ACCOUNTS_DEFAULT = 8;

export const tests = [
  defineTest({
    id: 'T2-F06-01-revoked-session-token-immediately-rejected-401',
    name: 'F6 Boundary: Revoked session Bearer token is immediately rejected with 401 on GET /api/v1/auth/me and protected mutations',
    tier: 2,
    features: ['F6'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const adminSb = ctx.createClientSandbox('f06_b_revoke_http');

      const primary = await ctx.cli.invoke({
        sandbox: adminSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_b_revoked_tok',
          password: 'RevokedTokenPassword!1',
          firstName: 'Revoke Guard',
        },
        expectOk: true,
      });

      const secondary = await ctx.http.post(
        '/api/v1/auth/login',
        {
          username: 'f06_b_revoked_tok',
          password: 'RevokedTokenPassword!1',
          device_name: 'Compromised Tablet',
        },
        {},
      );
      assert.httpStatus(secondary, 200, 'Secondary device login');
      const secSid = secondary.json.session_id;
      const secToken = secondary.json.token;

      // Confirm secondary token works prior to revocation
      const preCheck = await ctx.http.get('/api/v1/auth/me', { token: secToken });
      assert.httpStatus(preCheck, 200, 'Secondary token must work prior to revocation');

      // Revoke secondary session from primary device via CLI
      const revRes = await ctx.cli.invoke({
        sandbox: adminSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'revokeDeviceSession',
        payload: { sessionId: secSid },
        expectOk: true,
      });
      assert.equal(revRes.data?.revoked, true, 'revokeDeviceSession must succeed');

      // Immediate 401 cut-off on /auth/me, /chats, and /chats/create
      const postMe = await ctx.http.get('/api/v1/auth/me', { token: secToken });
      assert.httpStatus(postMe, 401, 'Revoked session token on GET /api/v1/auth/me must return 401');

      const postChats = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Should Be Rejected', chat_type: 'group' },
        { token: secToken },
      );
      assert.httpStatus(postChats, 401, 'Revoked session token on POST /api/v1/chats/create must return 401');

      // Primary session remains completely healthy
      const primaryMe = await ctx.http.get('/api/v1/auth/me', { token: primary.data.session.token });
      assert.httpStatus(primaryMe, 200, 'Primary session token must remain valid');
    },
  }),

  defineTest({
    id: 'T2-F06-02-active-websocket-forcibly-disconnected-on-session-revocation',
    name: 'F6 Boundary: Active WebSocket connection receives 401 Error frame and is forcibly closed by server upon session revocation',
    tier: 2,
    features: ['F6'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const primary = await ctx.http.post(
        '/api/v1/auth/register',
        {
          username: 'f06_b_ws_cutoff',
          password: 'WsCutoffPassword!2',
          first_name: 'WS Cutoff',
          device_name: 'Primary Device',
        },
        {},
      );
      assert.httpStatus(primary, 201, 'Primary registration');
      const primaryToken = primary.json.token;

      const secondary = await ctx.http.post(
        '/api/v1/auth/login',
        {
          username: 'f06_b_ws_cutoff',
          password: 'WsCutoffPassword!2',
          device_name: 'Secondary WS Device',
        },
        {},
      );
      assert.httpStatus(secondary, 200, 'Secondary login');
      const secSid = secondary.json.session_id;
      const secToken = secondary.json.token;

      const wsPrimary = await ctx.connectWs(primaryToken);
      const wsSecondary = await ctx.connectWs(secToken);
      await wsPrimary.ping(60201);
      await wsSecondary.ping(60202);
      wsSecondary.clearBuffer();

      // Revoke secondary session -> wsSecondary must receive Error(401) + close, while wsPrimary stays open
      const delRes = await ctx.http.del(`/api/v1/auth/sessions/${secSid}`, undefined, { token: primaryToken });
      assert.httpStatus(delRes, 200, 'DELETE /api/v1/auth/sessions/{secSid}');

      const errFrame = await wsSecondary.waitForFrame((f) => f.type === 'Error', 6_000);
      assert.equal(errFrame.payload?.code, 401, 'Revoked WebSocket must receive Error frame with code=401');

      await wsSecondary.waitForClose(6_000);
      assert.equal(wsSecondary.isClosed, true, 'Revoked WebSocket must transition to isClosed=true');

      // Reconnecting with revoked token must be rejected at HTTP upgrade with 401
      const reconnectRej = await ctx.connectWs(secToken, { expectRejectStatus: 401 });
      assert.equal(reconnectRej.rejected, true, 'Reconnect with revoked token must be rejected');
      assert.equal(reconnectRej.status, 401, 'Reconnect rejection status must be 401');

      // Primary WS remains alive
      const pongPrimary = await wsPrimary.ping(60203);
      assert.equal(pongPrimary.type, 'Pong', 'Primary WebSocket must remain connected and answer Ping');
    },
  }),

  defineTest({
    id: 'T2-F06-03-unauthenticated-and-invalid-token-ws-upgrade-rejected-401',
    name: 'F6 Boundary: Unauthenticated, malformed, and forged Bearer/query token WebSocket upgrades rejected with HTTP 401',
    tier: 2,
    features: ['F6'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();

      const missingTok = await ctx.connectWs(null, { expectRejectStatus: 401 });
      assert.equal(missingTok.rejected, true, 'Missing token WS upgrade must be rejected');
      assert.equal(missingTok.status, 401, 'Missing token WS upgrade must return 401');

      const queryForged = await ctx.connectWs('sess_fake_id.deadbeef00000000', {
        useBearerHeader: false,
        expectRejectStatus: 401,
      });
      assert.equal(queryForged.rejected, true, 'Forged query token WS upgrade must be rejected');
      assert.equal(queryForged.status, 401, 'Forged query token WS upgrade must return 401');

      const bearerForged = await ctx.connectWs('sess_fake_id.deadbeef00000000', {
        useBearerHeader: true,
        expectRejectStatus: 401,
      });
      assert.equal(bearerForged.rejected, true, 'Forged Authorization Bearer WS upgrade must be rejected');
      assert.equal(bearerForged.status, 401, 'Forged Authorization Bearer WS upgrade must return 401');
    },
  }),

  defineTest({
    id: 'T2-F06-04-cross-user-session-deletion-rejected-404-preserving-victim',
    name: 'F6 Boundary: Cross-user DELETE /api/v1/auth/sessions/{victim_session_id} returns 404 and leaves victim HTTP + WS intact',
    tier: 2,
    features: ['F6'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const attackerSb = ctx.createClientSandbox('f06_b_attacker');

      const attacker = await ctx.cli.invoke({
        sandbox: attackerSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_b_attacker',
          password: 'AttackerPassword!4',
          firstName: 'Attacker',
        },
        expectOk: true,
      });
      const attackerToken = attacker.data.session.token;

      const victim = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f06_b_victim', password: 'VictimPassword!4', first_name: 'Victim' },
        {},
      );
      assert.httpStatus(victim, 201, 'Register victim');
      const victimSid = victim.json.session_id;
      const victimToken = victim.json.token;

      const wsVictim = await ctx.connectWs(victimToken);
      await wsVictim.ping(60401);

      // 1. Attacker attempts to delete victim's session over HTTP -> 404 session_not_found
      const crossDelHttp = await ctx.http.del(`/api/v1/auth/sessions/${victimSid}`, undefined, {
        token: attackerToken,
      });
      assert.httpStatus(crossDelHttp, 404, 'Cross-user session deletion must return 404');
      assert.equal(crossDelHttp.json?.error, 'session_not_found', 'Error must equal session_not_found');

      // 2. Attacker attempts via CLI revokeDeviceSession -> expectOk: false
      const crossDelCli = await ctx.cli.invoke({
        sandbox: attackerSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'revokeDeviceSession',
        payload: { sessionId: victimSid },
        expectOk: false,
      });
      assert.equal(crossDelCli.ok, false, 'Cross-user CLI revokeDeviceSession must fail');

      // 3. Victim HTTP & WebSocket remain 100% operational
      const victimMe = await ctx.http.get('/api/v1/auth/me', { token: victimToken });
      assert.httpStatus(victimMe, 200, 'Victim /auth/me must remain valid');
      const victimPong = await wsVictim.ping(60402);
      assert.equal(victimPong.type, 'Pong', 'Victim WebSocket must remain alive');
      assert.equal(wsVictim.isClosed, false, 'Victim WebSocket must not be closed');
    },
  }),

  defineTest({
    id: 'T2-F06-05-stale-generation-fence-and-nonexistent-account-rejection',
    name: 'F6 Boundary: Stale GenerationFence epoch rejected (STALE_GENERATION) and switchAccount/removeAccount on missing slot rejected (NOT_FOUND)',
    tier: 2,
    features: ['F6'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const sb = ctx.createClientSandbox('f06_b_stale_fence');

      const reg1 = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_b_fence_u1',
          password: 'StaleFencePassword!5',
          firstName: 'Fence 1',
        },
        expectOk: true,
      });
      const staleEpoch = reg1.generation;

      // Advance generation via addAccount
      const add2 = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'addAccount',
        payload: {
          username: 'f06_b_fence_u2',
          password: 'StaleFencePassword!6',
          register: true,
          firstName: 'Fence 2',
        },
        expectOk: true,
      });
      assert.greaterThan(add2.generation, staleEpoch, 'Generation must advance after addAccount');

      // 1. Strict checkGenerationFence with outdated epoch -> STALE_GENERATION
      const staleStrict = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'checkGenerationFence',
        payload: { expectedGeneration: staleEpoch, strict: true },
        expectOk: false,
      });
      assert.equal(staleStrict.errorCode, 'STALE_GENERATION', 'Outdated epoch with strict=true must return STALE_GENERATION');

      // 2. Non-strict checkGenerationFence reports matches=false, stale=true
      const staleSoft = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'checkGenerationFence',
        payload: { expectedGeneration: staleEpoch, strict: false },
        expectOk: true,
      });
      assert.equal(staleSoft.data?.matches, false, 'Stale epoch must report matches=false');
      assert.equal(staleSoft.data?.stale, true, 'Stale epoch must report stale=true');

      // 3. Switching or removing nonexistent account -> NOT_FOUND
      const swMissing = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'switchAccount',
        payload: { accountId: '999999999' },
        expectOk: false,
      });
      assert.equal(swMissing.errorCode, 'NOT_FOUND', 'switchAccount to unknown accountId must return NOT_FOUND');

      const rmMissing = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'removeAccount',
        payload: { accountId: '999999999' },
        expectOk: false,
      });
      assert.equal(rmMissing.errorCode, 'NOT_FOUND', 'removeAccount on unknown accountId must return NOT_FOUND');
    },
  }),

  defineTest({
    id: 'T2-F06-06-wrong-passcode-unlock-rejected-and-locked-guard-enforced',
    name: 'F6 Boundary: Invalid passcode bounds, lockApp without passcode, wrong PIN unlockApp (AUTH_INVALID_PASSCODE), and PASSCODE_LOCKED guard',
    tier: 2,
    features: ['F6'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const sb = ctx.createClientSandbox('f06_b_lock_guard');

      await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_b_guard_user',
          password: 'GuardUserPassword!6',
          firstName: 'Guard User',
        },
        expectOk: true,
      });

      // 1. lockApp before passcode is configured -> VALIDATION_ERROR
      const prematureLock = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'lockApp',
        payload: {},
        expectOk: false,
      });
      assert.equal(prematureLock.errorCode, 'VALIDATION_ERROR', 'lockApp without configured PIN must fail');

      // 2. Short <4-char PIN and >64-char PIN rejected
      const shortPin = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'setPasscodeLock',
        payload: { passcode: '123' },
        expectOk: false,
      });
      assert.equal(shortPin.errorCode, 'VALIDATION_ERROR', '<4-char passcode must fail validation');

      const longPin = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'setPasscodeLock',
        payload: { passcode: '9'.repeat(65) },
        expectOk: false,
      });
      assert.equal(longPin.errorCode, 'VALIDATION_ERROR', '>64-char passcode must fail validation');

      // 3. Set valid passcode and lock app
      await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'setPasscodeLock',
        payload: { passcode: '739182' },
        expectOk: true,
      });
      await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'lockApp',
        payload: {},
        expectOk: true,
      });

      // 4. Wrong PIN on unlockApp -> AUTH_INVALID_PASSCODE and state remains locked
      const wrongUnlock = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'unlockApp',
        payload: { passcode: '000000' },
        expectOk: false,
      });
      assert.equal(wrongUnlock.errorCode, 'AUTH_INVALID_PASSCODE', 'Wrong PIN must return AUTH_INVALID_PASSCODE');

      const uiStillLocked = await ctx.cli.uiSession({
        sandbox: sb,
        serverUrl: server.baseUrl,
        script: {
          initialWindowWidthVp: 360,
          steps: [{ op: 'resizeWindow', widthVp: 360 }],
        },
        expectOk: true,
      });
      assert.equal(uiStillLocked.data?.finalState?.authState, 'locked', 'Failed unlock must keep authState=locked');

      // 5. Protected domains/actions blocked with PASSCODE_LOCKED while locked
      for (const [domain, action] of [
        ['auth', 'getMe'],
        ['dialogs', 'listChats'],
        ['sessions', 'revokeOtherSessions'],
      ]) {
        const blocked = await ctx.cli.invoke({
          sandbox: sb,
          serverUrl: server.baseUrl,
          domain,
          action,
          payload: {},
          expectOk: false,
        });
        assert.equal(blocked.errorCode, 'PASSCODE_LOCKED', `${domain}.${action} must be blocked with PASSCODE_LOCKED`);
      }
    },
  }),

  defineTest({
    id: 'T2-F06-07-max-multi-account-cap-and-forged-asset-token-rejection',
    name: 'F6 Boundary: Exceeding MAX_MULTI_ACCOUNTS cap on addAccount and strict forged @kit.AssetStoreKit token rejected',
    tier: 2,
    features: ['F6'],
    timeoutMs: 50_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const capSb = ctx.createClientSandbox('f06_b_max_cap');

      const first = await ctx.cli.invoke({
        sandbox: capSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_b_cap_1',
          password: 'CapUserPassword!1',
          firstName: 'Cap 1',
        },
        expectOk: true,
      });
      const firstAccountId = first.data.account.accountId;

      // Forged hardware ASSET token with strict=true -> UNAUTHORIZED
      const forgedAsset = await ctx.cli.invoke({
        sandbox: capSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'verifyAssetToken',
        payload: {
          accountId: firstAccountId,
          assetToken: 'ohos_asset_forged_hmac_signature',
          strict: true,
        },
        expectOk: false,
      });
      assert.equal(forgedAsset.errorCode, 'UNAUTHORIZED', 'Forged assetToken with strict=true must return UNAUTHORIZED');

      // Inspect maxAccounts reported by engine and fill up to maxAccounts
      const listInit = await ctx.cli.invoke({
        sandbox: capSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'listAccounts',
        payload: {},
        expectOk: true,
      });
      const maxAccounts = listInit.data?.maxAccounts ?? MAX_ACCOUNTS_DEFAULT;
      assert.greaterThanOrEqual(maxAccounts, 3, 'Engine maxAccounts must be >= 3');

      for (let slotIdx = 2; slotIdx <= maxAccounts; slotIdx++) {
        await ctx.cli.invoke({
          sandbox: capSb,
          serverUrl: server.baseUrl,
          domain: 'sessions',
          action: 'addAccount',
          payload: {
            username: `f06_b_cap_${slotIdx}`,
            password: `CapUserPassword!${slotIdx}`,
            register: true,
            firstName: `Cap ${slotIdx}`,
          },
          expectOk: true,
        });
      }

      // Adding one account beyond maxAccounts must be rejected with expectOk: false
      const overflowAdd = await ctx.cli.invoke({
        sandbox: capSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'addAccount',
        payload: {
          username: 'f06_b_cap_overflow',
          password: 'CapOverflowPassword!9',
          register: true,
          firstName: 'Overflow',
        },
        expectOk: false,
      });
      assert.equal(overflowAdd.ok, false, 'Exceeding maxAccounts must be rejected');
    },
  }),
];

export default tests;
