import fs from 'node:fs';
import path from 'node:path';
import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

export const tests = [
  defineTest({
    id: 'T1-F06-01-multi-account-add-list-switch-and-isolated-sandbox-sqlite',
    name: 'F6: Multi-account addition, listing, switching, and isolated per-account sandbox SQLite state (addAccount, listAccounts, switchAccount)',
    tier: 1,
    features: ['F6'],
    timeoutMs: 45_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const multiSb = ctx.createClientSandbox('f06_multi_acct');

      // 1. Register primary account (Alice) in default slot_1
      const aliceReg = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_alice_acct',
          password: 'MultiPassAlice!1',
          firstName: 'Alice Slot1',
        },
        expectOk: true,
      });
      const aliceUid = aliceReg.data.session.user_id;
      const aliceSlot = aliceReg.data.account.slotName;

      // Create an Alice-only group chat so dialog state is distinct from Bob/Carol
      const aliceChat = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Alice Private Workspace', chatType: 'group' },
        expectOk: true,
      });
      assert.greaterThan(aliceChat.data?.chat_id, 0, 'Alice must create isolated group chat');

      // 2. Add second account (Bob) via sessions.addAccount
      const bobAdd = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'addAccount',
        payload: {
          username: 'f06_bob_acct',
          password: 'MultiPassBob!2',
          register: true,
          firstName: 'Bob Slot2',
        },
        expectOk: true,
      });
      const bobUid = bobAdd.data?.account?.userId;
      const bobSlot = bobAdd.data?.slot;
      assert.greaterThan(bobUid, 0, 'addAccount (Bob) must register and bind userId');
      assert.notEqual(bobUid, aliceUid, 'Bob userId must differ from Alice userId');
      assert.notEqual(bobSlot, aliceSlot, 'Bob must receive an isolated database slot directory');

      const bobChat = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Bob Isolated Ledger', chatType: 'group' },
        expectOk: true,
      });
      assert.greaterThan(bobChat.data?.chat_id, 0, 'Bob must create isolated group chat');

      // 3. Add third account (Carol) via sessions.addAccount
      const carolAdd = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'addAccount',
        payload: {
          username: 'f06_carol_acct',
          password: 'MultiPassCarol!3',
          register: true,
          firstName: 'Carol Slot3',
        },
        expectOk: true,
      });
      const carolUid = carolAdd.data?.account?.userId;
      assert.greaterThan(carolUid, 0, 'addAccount (Carol) must register and bind userId');

      // 4. List accounts -> verify all 3 accounts & isolated per-slot SQLite directories on disk
      const listRes = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'listAccounts',
        payload: {},
        expectOk: true,
      });
      assert.equal(listRes.data?.accounts?.length, 3, 'listAccounts must report 3 bound accounts');
      assert.equal(listRes.data?.activeAccountId, String(carolUid), 'Carol must be current activeAccountId');
      assert.equal(
        fs.existsSync(path.join(multiSb.databaseDir, aliceSlot)),
        true,
        'Alice isolated SQLite slot directory must exist under sandbox databaseDir',
      );
      assert.equal(
        fs.existsSync(path.join(multiSb.databaseDir, bobSlot)),
        true,
        'Bob isolated SQLite slot directory must exist under sandbox databaseDir',
      );

      // 5. Switch back to Alice -> verify active identity & Alice's private dialogs (zero Bob leakage)
      const swAlice = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'switchAccount',
        payload: { accountId: String(aliceUid) },
        expectOk: true,
      });
      assert.equal(swAlice.data?.switched, true, 'switchAccount to Alice must succeed');
      assert.equal(swAlice.data?.activeAccount?.userId, aliceUid, 'activeAccount must be Alice');

      const aliceMe = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'getMe',
        payload: {},
        expectOk: true,
      });
      assert.equal(aliceMe.data?.user_id, aliceUid, 'getMe after switchAccount must return Alice');

      const aliceDialogs = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'listChats',
        payload: {},
        expectOk: true,
      });
      const aliceTitles = (aliceDialogs.data?.chats ?? []).map((c) => c.title);
      assert.includes(aliceTitles, 'Alice Private Workspace', 'Alice dialog list must contain Alice chat');
      assert.notIncludes(aliceTitles, 'Bob Isolated Ledger', 'Alice dialog list must NOT leak Bob chat');

      // 6. Switch to Bob -> verify Bob's identity & Bob's private dialogs
      await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'switchAccount',
        payload: { accountId: String(bobUid) },
        expectOk: true,
      });
      const bobDialogs = await ctx.cli.invoke({
        sandbox: multiSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'listChats',
        payload: {},
        expectOk: true,
      });
      const bobTitles = (bobDialogs.data?.chats ?? []).map((c) => c.title);
      assert.includes(bobTitles, 'Bob Isolated Ledger', 'Bob dialog list must contain Bob chat');
      assert.notIncludes(bobTitles, 'Alice Private Workspace', 'Bob dialog list must NOT leak Alice chat');
    },
  }),

  defineTest({
    id: 'T1-F06-02-active-device-sessions-listing-and-is-current-marker',
    name: 'F6: Active Device Sessions listing via GET /api/v1/auth/sessions and listDeviceSessions accurately marks current session',
    tier: 1,
    features: ['F6'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const phoneSb = ctx.createClientSandbox('f06_sess_phone');

      const phoneReg = await ctx.cli.invoke({
        sandbox: phoneSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_multidev_user',
          password: 'DeviceSessionsPass!4',
          firstName: 'MultiDevice',
          deviceName: 'Mate 70 RS',
        },
        expectOk: true,
      });
      const phoneSessionId = phoneReg.data.session.session_id;
      const phoneToken = phoneReg.data.session.token;

      const tabletLogin = await ctx.http.post(
        '/api/v1/auth/login',
        {
          username: 'f06_multidev_user',
          password: 'DeviceSessionsPass!4',
          device_name: 'MatePad Pro 13.2',
        },
        {},
      );
      assert.httpStatus(tabletLogin, 200, 'Second device login');
      const tabletSessionId = tabletLogin.json.session_id;
      const tabletToken = tabletLogin.json.token;

      const pcLogin = await ctx.http.post(
        '/api/v1/auth/login',
        {
          username: 'f06_multidev_user',
          password: 'DeviceSessionsPass!4',
          device_name: 'MateBook Pro HarmonyOS PC',
        },
        {},
      );
      assert.httpStatus(pcLogin, 200, 'Third device login');
      const pcSessionId = pcLogin.json.session_id;

      // 1. Inspect via HTTP from Tablet perspective -> tablet session has is_current=true
      const httpList = await ctx.http.get('/api/v1/auth/sessions', { token: tabletToken });
      assert.httpStatus(httpList, 200, 'GET /api/v1/auth/sessions');
      assert.equal(httpList.json?.user_id, phoneReg.data.session.user_id, 'sessions response user_id must match');
      assert.greaterThanOrEqual(httpList.json?.sessions?.length, 3, 'Must list all 3 active device sessions');

      const tabletCurrentList = httpList.json.sessions.filter((s) => s.is_current === true);
      assert.equal(tabletCurrentList.length, 1, 'Exactly one session must have is_current=true');
      assert.equal(tabletCurrentList[0].session_id, tabletSessionId, 'Tablet token must see tablet session as current');

      // 2. Inspect via CLI listDeviceSessions from Phone sandbox -> phone session has is_current=true
      const cliList = await ctx.cli.invoke({
        sandbox: phoneSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'listDeviceSessions',
        payload: {},
        expectOk: true,
      });
      assert.isArray(cliList.data, 'CLI listDeviceSessions must return array of SessionDto');
      const seenIds = cliList.data.map((s) => s.session_id);
      assert.includes(seenIds, phoneSessionId, 'listDeviceSessions must include phone session_id');
      assert.includes(seenIds, tabletSessionId, 'listDeviceSessions must include tablet session_id');
      assert.includes(seenIds, pcSessionId, 'listDeviceSessions must include PC session_id');

      const phoneCurrent = cliList.data.filter((s) => s.is_current === true);
      assert.equal(phoneCurrent.length, 1, 'CLI listDeviceSessions must mark exactly one current session');
      assert.equal(phoneCurrent[0].session_id, phoneSessionId, 'Phone sandbox must mark phoneSessionId as is_current');
      assert.equal(
        (await ctx.http.get('/api/v1/auth/me', { token: phoneToken })).json?.session_id,
        phoneSessionId,
        'GET /api/v1/auth/me must expose current session_id matching is_current session',
      );
    },
  }),

  defineTest({
    id: 'T1-F06-03-single-session-and-other-sessions-revocation',
    name: 'F6: Single session revocation (DELETE /api/v1/auth/sessions/{id} + revokeDeviceSession) and revokeOtherSessions',
    tier: 1,
    features: ['F6'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const primarySb = ctx.createClientSandbox('f06_revoke_primary');

      const primaryAuth = await ctx.cli.invoke({
        sandbox: primarySb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_revoke_owner',
          password: 'RevokeOwnerPassword!5',
          firstName: 'Revoke Owner',
          deviceName: 'Primary Phone',
        },
        expectOk: true,
      });
      const primarySid = primaryAuth.data.session.session_id;
      const primaryToken = primaryAuth.data.session.token;

      // Spawn 3 secondary sessions
      const sec1 = await ctx.http.post(
        '/api/v1/auth/login',
        { username: 'f06_revoke_owner', password: 'RevokeOwnerPassword!5', device_name: 'Sec 1' },
        {},
      );
      const sec2 = await ctx.http.post(
        '/api/v1/auth/login',
        { username: 'f06_revoke_owner', password: 'RevokeOwnerPassword!5', device_name: 'Sec 2' },
        {},
      );
      const sec3 = await ctx.http.post(
        '/api/v1/auth/login',
        { username: 'f06_revoke_owner', password: 'RevokeOwnerPassword!5', device_name: 'Sec 3' },
        {},
      );
      assert.httpStatus(sec1, 200, 'Sec 1 login');
      assert.httpStatus(sec2, 200, 'Sec 2 login');
      assert.httpStatus(sec3, 200, 'Sec 3 login');

      // 1. Revoke Sec 1 via HTTP DELETE /api/v1/auth/sessions/{id}
      const delSec1 = await ctx.http.del(
        `/api/v1/auth/sessions/${sec1.json.session_id}`,
        undefined,
        { token: primaryToken },
      );
      assert.httpStatus(delSec1, 200, 'DELETE /api/v1/auth/sessions/{sec1}');
      assert.equal(delSec1.json?.revoked, true, 'DELETE single session must return revoked=true');

      // 2. Revoke Sec 2 via CLI sessions.revokeDeviceSession
      const cliRevokeSec2 = await ctx.cli.invoke({
        sandbox: primarySb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'revokeDeviceSession',
        payload: { sessionId: sec2.json.session_id },
        expectOk: true,
      });
      assert.equal(cliRevokeSec2.data?.revoked, true, 'CLI revokeDeviceSession must return revoked=true');

      // 3. Add Sec 4, then revoke all other sessions via CLI revokeOtherSessions + HTTP /others check
      const sec4 = await ctx.http.post(
        '/api/v1/auth/login',
        { username: 'f06_revoke_owner', password: 'RevokeOwnerPassword!5', device_name: 'Sec 4' },
        {},
      );
      assert.httpStatus(sec4, 200, 'Sec 4 login');

      const cliRevokeOthers = await ctx.cli.invoke({
        sandbox: primarySb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'revokeOtherSessions',
        payload: {},
        expectOk: true,
      });
      assert.equal(cliRevokeOthers.data?.revokedOthers, true, 'CLI revokeOtherSessions must succeed');

      // Also verify direct HTTP DELETE /api/v1/auth/sessions/others returns 200 { revoked_count }
      const httpRevokeOthers = await ctx.http.del('/api/v1/auth/sessions/others', undefined, { token: primaryToken });
      assert.httpStatus(httpRevokeOthers, 200, 'DELETE /api/v1/auth/sessions/others');
      assert.greaterThanOrEqual(httpRevokeOthers.json?.revoked_count, 0, 'revoked_count must be numeric >= 0');

      const remainingRes = await ctx.http.get('/api/v1/auth/sessions', { token: primaryToken });
      assert.httpStatus(remainingRes, 200, 'GET /api/v1/auth/sessions after revoking others');
      assert.equal(remainingRes.json?.sessions?.length, 1, 'Only primary session must remain active');
      assert.equal(remainingRes.json.sessions[0].session_id, primarySid, 'Surviving session must be primarySid');
    },
  }),

  defineTest({
    id: 'T1-F06-04-generation-fence-monotonic-epoch-and-account-generation',
    name: 'F6: GenerationFence monotonic epoch increments across account transitions (checkGenerationFence) and account_generation in /auth/me',
    tier: 1,
    features: ['F6'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const fenceSb = ctx.createClientSandbox('f06_gen_fence');

      const initReg = await ctx.cli.invoke({
        sandbox: fenceSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_fence_u1',
          password: 'FencePassword!1',
          firstName: 'Fence One',
        },
        expectOk: true,
      });
      const u1Id = initReg.data.session.user_id;
      const u1Token = initReg.data.session.token;
      const gen1 = initReg.generation;
      assert.greaterThanOrEqual(gen1, 1, 'Initial CoreResponseEnvelope generation must be >= 1');

      // Verify server-side account_generation in /api/v1/auth/me and session delete response
      const meBefore = await ctx.http.get('/api/v1/auth/me', { token: u1Token });
      assert.httpStatus(meBefore, 200, 'GET /api/v1/auth/me');
      assert.greaterThanOrEqual(meBefore.json?.account_generation, 1, '/auth/me must include account_generation >= 1');

      const extraLogin = await ctx.http.post(
        '/api/v1/auth/login',
        { username: 'f06_fence_u1', password: 'FencePassword!1', device_name: 'Temp Device' },
        {},
      );
      const delExtra = await ctx.http.del(
        `/api/v1/auth/sessions/${extraLogin.json.session_id}`,
        undefined,
        { token: u1Token },
      );
      assert.httpStatus(delExtra, 200, 'DELETE /api/v1/auth/sessions/{extra}');
      assert.greaterThanOrEqual(delExtra.json?.account_generation, 1, 'Session revoke must report account_generation');

      // Verify client GenerationFence monotonic epoch increments: gen1 -> gen2 -> gen3 -> gen4
      const addU2 = await ctx.cli.invoke({
        sandbox: fenceSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'addAccount',
        payload: {
          username: 'f06_fence_u2',
          password: 'FencePassword!2',
          register: true,
          firstName: 'Fence Two',
        },
        expectOk: true,
      });
      const u2Id = addU2.data.account.userId;
      const gen2 = addU2.generation;
      assert.greaterThan(gen2, gen1, 'addAccount must monotonically increment GenerationFence epoch');

      const swU1 = await ctx.cli.invoke({
        sandbox: fenceSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'switchAccount',
        payload: { accountId: String(u1Id) },
        expectOk: true,
      });
      const gen3 = swU1.generation;
      assert.greaterThan(gen3, gen2, 'switchAccount must monotonically increment GenerationFence epoch');

      const rmU2 = await ctx.cli.invoke({
        sandbox: fenceSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'removeAccount',
        payload: { accountId: String(u2Id) },
        expectOk: true,
      });
      const gen4 = rmU2.generation;
      assert.greaterThan(gen4, gen3, 'removeAccount must monotonically increment GenerationFence epoch');

      const fenceCheck = await ctx.cli.invoke({
        sandbox: fenceSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'checkGenerationFence',
        payload: { expectedGeneration: gen4, strict: true },
        expectOk: true,
      });
      assert.equal(fenceCheck.data?.currentGeneration, gen4, 'checkGenerationFence must report latest epoch gen4');
      assert.equal(fenceCheck.data?.matches, true, 'Current epoch must match GenerationFence');
      assert.equal(fenceCheck.data?.stale, false, 'Current epoch must report stale=false');
      assert.isNonEmptyString(fenceCheck.data?.tokenFingerprint, 'checkGenerationFence must return tokenFingerprint');
    },
  }),

  defineTest({
    id: 'T1-F06-05-asset-store-kit-hardware-token-vault-verification',
    name: 'F6: @kit.AssetStoreKit hardware-backed HMAC token storage and verifyAssetToken validation across restarts',
    tier: 1,
    features: ['F6'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const assetSb = ctx.createClientSandbox('f06_asset_vault');

      const regRes = await ctx.cli.invoke({
        sandbox: assetSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_asset_user',
          password: 'AssetVaultPassword!7',
          firstName: 'Asset Vault',
        },
        expectOk: true,
      });
      const accountId = regRes.data.account.accountId;
      const assetToken = regRes.data.account.assetToken;
      assert.match(assetToken, /^ohos_asset_/, 'Issued assetToken must carry ohos_asset_ HMAC tag prefix');

      const vaultFilePath = path.join(assetSb.filesDir, 'ohos_asset_store.json');
      assert.equal(fs.existsSync(vaultFilePath), true, 'Sandbox must persist ohos_asset_store.json');
      const vaultJson = JSON.parse(fs.readFileSync(vaultFilePath, 'utf8'));
      assert.isNonEmptyString(vaultJson?.masterKeyB64, 'Asset vault must persist 256-bit masterKeyB64');
      assert.equal(
        vaultJson?.tokensByAccount?.[accountId],
        assetToken,
        'Asset vault tokensByAccount must store exact HMAC assetToken for accountId',
      );

      // Verify via CLI sessions.verifyAssetToken in a fresh process invocation
      const verifyOk = await ctx.cli.invoke({
        sandbox: assetSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'verifyAssetToken',
        payload: {
          accountId,
          assetToken,
          strict: true,
        },
        expectOk: true,
      });
      assert.equal(verifyOk.data?.valid, true, 'verifyAssetToken must confirm valid=true');
      assert.equal(verifyOk.data?.hardwareBacked, true, 'verifyAssetToken must report hardwareBacked=true');

      // Non-strict check with wrong candidate returns valid=false cleanly
      const verifyMismatchSoft = await ctx.cli.invoke({
        sandbox: assetSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'verifyAssetToken',
        payload: {
          accountId,
          assetToken: 'ohos_asset_tampered_invalid_tag',
          strict: false,
        },
        expectOk: true,
      });
      assert.equal(verifyMismatchSoft.data?.valid, false, 'Tampered assetToken with strict=false must report valid=false');
    },
  }),

  defineTest({
    id: 'T1-F06-06-local-passcode-app-lock-and-ui-session-auth-state',
    name: 'F6: Argon2id App Passcode Lock lifecycle (setPasscodeLock -> lockApp -> authState=locked -> unlockApp -> authState=authenticated)',
    tier: 1,
    features: ['F6'],
    timeoutMs: 45_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const lockSb = ctx.createClientSandbox('f06_passcode_lock');
      const secretPin = '864209';

      await ctx.cli.invoke({
        sandbox: lockSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_lock_user',
          password: 'PasscodeOwnerPassword!9',
          firstName: 'Lock User',
        },
        expectOk: true,
      });

      // 1. Before lock: uiSession reports authState === 'authenticated'
      const uiBefore = await ctx.cli.uiSession({
        sandbox: lockSb,
        serverUrl: server.baseUrl,
        script: {
          initialWindowWidthVp: 360,
          steps: [{ op: 'navigate', nav: 'chats' }],
        },
        expectOk: true,
      });
      assert.equal(uiBefore.data?.finalState?.authState, 'authenticated', 'Pre-lock authState must be authenticated');

      // 2. Configure Argon2id passcode -> verify zero plaintext PIN on disk
      const setPin = await ctx.cli.invoke({
        sandbox: lockSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'setPasscodeLock',
        payload: {
          passcode: secretPin,
          autoLockSeconds: 180,
        },
        expectOk: true,
      });
      assert.equal(setPin.data?.passcodeEnabled, true, 'setPasscodeLock must enable passcode');
      assert.equal(setPin.data?.autoLockSeconds, 180, 'setPasscodeLock must persist autoLockSeconds');

      const rawStateText = fs.readFileSync(path.join(lockSb.filesDir, 'ohos_core_state.json'), 'utf8');
      assert.notIncludes(rawStateText, secretPin, 'Persisted state must NEVER store plaintext PIN');
      const parsedState = JSON.parse(rawStateText);
      assert.match(parsedState?.passcodeHashHex, /^[0-9a-f]{64}$/, 'Persisted state must store 32-byte Argon2id hex hash');
      assert.match(parsedState?.passcodeSaltHex, /^[0-9a-f]{32}$/, 'Persisted state must store 16-byte CSPRNG salt');

      // 3. Lock app -> uiSession reports authState === 'locked'
      const lockRes = await ctx.cli.invoke({
        sandbox: lockSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'lockApp',
        payload: {},
        expectOk: true,
      });
      assert.equal(lockRes.data?.locked, true, 'lockApp must set locked=true');

      const uiLocked = await ctx.cli.uiSession({
        sandbox: lockSb,
        serverUrl: server.baseUrl,
        script: {
          initialWindowWidthVp: 360,
          steps: [{ op: 'resizeWindow', widthVp: 360 }],
        },
        expectOk: true,
      });
      assert.equal(uiLocked.data?.finalState?.authState, 'locked', 'Locked sandbox uiSession must report authState=locked');

      // 4. Unlock app with valid PIN -> uiSession returns to authState === 'authenticated'
      const unlockRes = await ctx.cli.invoke({
        sandbox: lockSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'unlockApp',
        payload: { passcode: secretPin },
        expectOk: true,
      });
      assert.equal(unlockRes.data?.locked, false, 'unlockApp must clear locked flag');
      assert.equal(unlockRes.data?.unlocked, true, 'unlockApp must report unlocked=true');

      const uiUnlocked = await ctx.cli.uiSession({
        sandbox: lockSb,
        serverUrl: server.baseUrl,
        script: {
          initialWindowWidthVp: 360,
          steps: [{ op: 'navigate', nav: 'settings' }],
        },
        expectOk: true,
      });
      assert.equal(
        uiUnlocked.data?.finalState?.authState,
        'authenticated',
        'Unlocked sandbox uiSession must restore authState=authenticated',
      );

      // 5. Disable passcode lock cleanly
      const disablePin = await ctx.cli.invoke({
        sandbox: lockSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'setPasscodeLock',
        payload: { enabled: false },
        expectOk: true,
      });
      assert.equal(disablePin.data?.passcodeEnabled, false, 'Disabling passcode must set passcodeEnabled=false');
    },
  }),

  defineTest({
    id: 'T1-F06-07-remove-active-account-automatic-fallback-and-persistence',
    name: 'F6: Removing active account via removeAccount automatically falls back to surviving account slot across CLI restarts',
    tier: 1,
    features: ['F6'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const fallbackSb = ctx.createClientSandbox('f06_fallback');

      const u1 = await ctx.cli.invoke({
        sandbox: fallbackSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f06_survive_u1',
          password: 'SurvivePassword!1',
          firstName: 'Survivor One',
        },
        expectOk: true,
      });
      const u1Id = u1.data.session.user_id;

      const u2 = await ctx.cli.invoke({
        sandbox: fallbackSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'addAccount',
        payload: {
          username: 'f06_transient_u2',
          password: 'TransientPassword!2',
          register: true,
          firstName: 'Transient Two',
        },
        expectOk: true,
      });
      const u2Id = u2.data.account.userId;

      // Remove currently active u2 -> engine must fall back automatically to u1
      const rmRes = await ctx.cli.invoke({
        sandbox: fallbackSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'removeAccount',
        payload: { accountId: String(u2Id) },
        expectOk: true,
      });
      assert.equal(rmRes.data?.removed, true, 'removeAccount must return removed=true');

      const listAfter = await ctx.cli.invoke({
        sandbox: fallbackSb,
        serverUrl: server.baseUrl,
        domain: 'sessions',
        action: 'listAccounts',
        payload: {},
        expectOk: true,
      });
      assert.equal(listAfter.data?.accounts?.length, 1, 'Exactly 1 account must remain after removal');
      assert.equal(listAfter.data?.activeAccountId, String(u1Id), 'Engine must fall back activeAccountId to u1');

      const meAfter = await ctx.cli.invoke({
        sandbox: fallbackSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'getMe',
        payload: {},
        expectOk: true,
      });
      assert.equal(meAfter.data?.user_id, u1Id, 'Subsequent CLI process must authenticate seamlessly as u1');
    },
  }),
];

export default tests;
