import fs from 'node:fs';
import path from 'node:path';
import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

export const tests = [
  defineTest({
    id: 'T1-F05-01-argon2id-password-register-login-welcome-bot-and-me',
    name: 'F5: Argon2id username+password registration (201 + welcome bot chat), login (200), GET /api/v1/auth/me, and ohos-app-cli auth lifecycle',
    tier: 1,
    features: ['F5'],
    timeoutMs: 45_000,
    async run(ctx) {
      const server = await ctx.ensureServer();

      // 1. Direct HTTP registration with auto_welcome=true -> 201 Created + Welcome Bot dialog
      const regRes = await ctx.http.post(
        '/api/v1/auth/register',
        {
          username: 'f05_http_alice',
          password: 'Argon2StrongPassword!9',
          first_name: 'Alice HTTP',
          device_name: 'HarmonyOS Phone HTTP',
          auto_welcome: true,
        },
        {},
      );
      assert.httpStatus(regRes, 201, 'POST /api/v1/auth/register must return 201 Created');
      assert.greaterThan(regRes.json?.user_id, 0, 'register must return positive user_id');
      assert.equal(regRes.json?.username, 'f05_http_alice', 'register must echo username');
      assert.isNonEmptyString(regRes.json?.session_id, 'register must issue session_id');
      assert.isNonEmptyString(regRes.json?.token, 'register must issue bearer token');

      const regToken = regRes.json.token;
      const aliceUid = regRes.json.user_id;

      const chatsRes = await ctx.http.get('/api/v1/chats', { token: regToken });
      assert.httpStatus(chatsRes, 200, 'GET /api/v1/chats after auto_welcome registration');
      assert.isArray(chatsRes.json?.chats, 'GET /api/v1/chats must return chats array');
      const welcomeChat = chatsRes.json.chats.find(
        (c) => c.creator_id === 777000 || c.chat_id === 700_000_000 + aliceUid || c.is_bot === true,
      );
      assert.isObject(welcomeChat, 'Registration with auto_welcome=true must auto-provision official welcome bot chat');

      // 2. Login over HTTP -> 200 OK with distinct session_id & bearer token
      const loginRes = await ctx.http.post(
        '/api/v1/auth/login',
        {
          username: 'f05_http_alice',
          password: 'Argon2StrongPassword!9',
          device_name: 'HarmonyOS Tablet HTTP',
        },
        {},
      );
      assert.httpStatus(loginRes, 200, 'POST /api/v1/auth/login must return 200 OK');
      assert.equal(loginRes.json?.user_id, aliceUid, 'login must authenticate same user_id');
      assert.isNonEmptyString(loginRes.json?.token, 'login must issue new token');
      assert.notEqual(loginRes.json.session_id, regRes.json.session_id, 'new device login must mint distinct session_id');

      const meRes = await ctx.http.get('/api/v1/auth/me', { token: loginRes.json.token });
      assert.httpStatus(meRes, 200, 'GET /api/v1/auth/me must return 200 OK');
      assert.equal(meRes.json?.user_id, aliceUid, '/auth/me user_id must match');
      assert.equal(meRes.json?.username, 'f05_http_alice', '/auth/me username must match');
      assert.equal(meRes.json?.session_id, loginRes.json.session_id, '/auth/me session_id must match active token');
      assert.greaterThanOrEqual(meRes.json?.account_generation, 1, '/auth/me must report account_generation >= 1');

      // 3. HarmonyOS Client CLI invoke: registerPassword -> getMe -> logout -> loginPassword -> getMe + persisted state
      const cliSandbox = ctx.createClientSandbox('f05_cli_pw');
      const cliReg = await ctx.cli.invoke({
        sandbox: cliSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f05_cli_bob',
          password: 'HarmonyCliPassword!8',
          firstName: 'Bob Harmony',
          deviceName: 'Mate 70 Pro',
        },
        expectOk: true,
      });
      assert.greaterThan(cliReg.data?.session?.user_id, 0, 'CLI registerPassword must return session.user_id');
      assert.equal(cliReg.data?.account?.username, 'f05_cli_bob', 'CLI registerPassword must bind account slot');

      const cliMe1 = await ctx.cli.invoke({
        sandbox: cliSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'getMe',
        payload: {},
        expectOk: true,
      });
      assert.equal(cliMe1.data?.user_id, cliReg.data.session.user_id, 'CLI getMe must return registered user_id');

      const cliLogout = await ctx.cli.invoke({
        sandbox: cliSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'logout',
        payload: {},
        expectOk: true,
      });
      assert.equal(cliLogout.data?.loggedOut, true, 'CLI logout must succeed');

      const cliLogin = await ctx.cli.invoke({
        sandbox: cliSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'loginPassword',
        payload: {
          username: 'f05_cli_bob',
          password: 'HarmonyCliPassword!8',
          deviceName: 'MatePad Pro',
        },
        expectOk: true,
      });
      assert.equal(cliLogin.data?.session?.user_id, cliReg.data.session.user_id, 'CLI loginPassword must restore user_id');
      assert.equal(
        fs.existsSync(path.join(cliSandbox.filesDir, 'ohos_core_state.json')),
        true,
        'HarmonyOS sandbox filesDir must persist ohos_core_state.json',
      );

      const cliMe2 = await ctx.cli.invoke({
        sandbox: cliSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'getMe',
        payload: {},
        expectOk: true,
      });
      assert.equal(cliMe2.data?.username, 'f05_cli_bob', 'Persisted CLI session must authenticate subsequent getMe');
    },
  }),

  defineTest({
    id: 'T1-F05-02-phone-otp-send-code-and-verify-session',
    name: 'F5: Phone + OTP send-code (debug_code + phone_code_hash) and verify across REST /api/v1/auth/phone/* and ohos-app-cli',
    tier: 1,
    features: ['F5'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();

      // 1. Direct REST phone OTP flow
      const phoneHttp = '+8613800138101';
      const sendRes = await ctx.http.post('/api/v1/auth/phone/send-code', { phone: phoneHttp }, {});
      assert.httpStatus(sendRes, 200, 'POST /api/v1/auth/phone/send-code must return 200');
      assert.equal(sendRes.json?.sent, true, 'send-code must set sent=true');
      assert.isNonEmptyString(sendRes.json?.phone_code_hash, 'send-code must return phone_code_hash');
      assert.match(sendRes.json?.debug_code, /^\d{6}$/, 'send-code in test env must return 6-digit debug_code');

      const verifyRes = await ctx.http.post(
        '/api/v1/auth/phone/verify',
        {
          phone: phoneHttp,
          phone_code_hash: sendRes.json.phone_code_hash,
          code: sendRes.json.debug_code,
          username: 'f05_phone_http',
          first_name: 'Phone HTTP User',
          device_name: 'HarmonyOS Fold',
        },
        {},
      );
      assert.httpStatus(verifyRes, 200, 'POST /api/v1/auth/phone/verify must return 200');
      assert.greaterThan(verifyRes.json?.user_id, 0, 'phone/verify must return positive user_id');
      assert.isNonEmptyString(verifyRes.json?.token, 'phone/verify must issue bearer token');

      const meHttp = await ctx.http.get('/api/v1/auth/me', { token: verifyRes.json.token });
      assert.httpStatus(meHttp, 200, 'GET /api/v1/auth/me for phone-authenticated user');
      assert.equal(meHttp.json?.phone, phoneHttp, '/auth/me must expose verified phone number');

      // 2. HarmonyOS CLI sendPhoneCode + verifyPhoneCode flow
      const phoneSandbox = ctx.createClientSandbox('f05_phone_cli');
      const phoneCli = '+8613800138102';
      const cliSend = await ctx.cli.invoke({
        sandbox: phoneSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'sendPhoneCode',
        payload: { phone: phoneCli },
        expectOk: true,
      });
      assert.equal(cliSend.data?.sent, true, 'CLI sendPhoneCode must report sent=true');
      assert.match(cliSend.data?.debug_code, /^\d{6}$/, 'CLI sendPhoneCode must return 6-digit debug_code');

      const cliVerify = await ctx.cli.invoke({
        sandbox: phoneSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'verifyPhoneCode',
        payload: {
          phone: phoneCli,
          phoneCodeHash: cliSend.data.phone_code_hash,
          code: cliSend.data.debug_code,
          firstName: 'Phone CLI User',
        },
        expectOk: true,
      });
      assert.greaterThan(cliVerify.data?.session?.user_id, 0, 'CLI verifyPhoneCode must create authenticated session');
      assert.isNonEmptyString(cliVerify.data?.account?.assetToken, 'CLI verifyPhoneCode must bind hardware asset token');

      const cliMe = await ctx.cli.invoke({
        sandbox: phoneSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'getMe',
        payload: {},
        expectOk: true,
      });
      assert.equal(cliMe.data?.user_id, cliVerify.data.session.user_id, 'CLI getMe must reflect phone-verified user');
    },
  }),

  defineTest({
    id: 'T1-F05-03-two-factor-cloud-password-full-lifecycle',
    name: 'F5: 2FA Cloud Password status -> setup -> phone login challenge -> verify -> DELETE /api/v1/auth/2fa disable + CLI parity',
    tier: 1,
    features: ['F5'],
    timeoutMs: 45_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const tfaSandbox = ctx.createClientSandbox('f05_2fa_owner');
      const phone = '+8613900139201';
      const cloudPw = 'CloudVault#2026!';

      // 1. Create phone+password account via CLI
      const send1 = await ctx.cli.invoke({
        sandbox: tfaSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'sendPhoneCode',
        payload: { phone },
        expectOk: true,
      });
      const ver1 = await ctx.cli.invoke({
        sandbox: tfaSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'verifyPhoneCode',
        payload: {
          phone,
          phoneCodeHash: send1.data.phone_code_hash,
          code: send1.data.debug_code,
          password: 'PrimaryLoginPass!1',
          firstName: 'Cloud 2FA User',
        },
        expectOk: true,
      });
      const ownerToken = ver1.data.session.token;
      const ownerUid = ver1.data.session.user_id;

      // 2. Check initial 2FA status (false) -> setup2fa via CLI -> status (true)
      const statusBefore = await ctx.cli.invoke({
        sandbox: tfaSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'get2faStatus',
        payload: {},
        expectOk: true,
      });
      assert.equal(statusBefore.data?.has_password, false, 'Initial 2FA has_password must be false');

      const setupRes = await ctx.cli.invoke({
        sandbox: tfaSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setup2fa',
        payload: {
          newPassword: cloudPw,
          hint: 'snow lotus',
          recoveryEmail: 'tfa_recovery@example.com',
        },
        expectOk: true,
      });
      assert.equal(setupRes.data?.has_password, true, 'setup2fa must enable 2FA password');
      assert.equal(setupRes.data?.hint, 'snow lotus', 'setup2fa must persist hint');

      const httpStatusRes = await ctx.http.get('/api/v1/auth/2fa/status', { token: ownerToken });
      assert.httpStatus(httpStatusRes, 200, 'GET /api/v1/auth/2fa/status');
      assert.equal(httpStatusRes.json?.has_password, true, 'HTTP 2fa/status must confirm has_password=true');

      // 3. Subsequent phone OTP login triggers 2FA challenge -> complete via /api/v1/auth/2fa/verify
      const send2 = await ctx.http.post('/api/v1/auth/phone/send-code', { phone }, {});
      assert.httpStatus(send2, 200, 'Second phone/send-code after consumed challenge');
      const phoneGateRes = await ctx.http.post(
        '/api/v1/auth/phone/verify',
        {
          phone,
          phone_code_hash: send2.json.phone_code_hash,
          code: send2.json.debug_code,
          device_name: 'HarmonyOS 2in1',
        },
        {},
      );
      assert.httpStatus(phoneGateRes, 200, 'phone/verify on 2FA-protected user');
      assert.equal(phoneGateRes.json?.requires_2fa, true, 'phone/verify must require second factor');
      assert.isNonEmptyString(phoneGateRes.json?.challenge_token, 'phone/verify must issue challenge_token');
      assert.equal(phoneGateRes.json?.token ?? null, null, 'phone/verify must NOT issue bearer token before 2FA verify');

      const verify2faHttp = await ctx.http.post(
        '/api/v1/auth/2fa/verify',
        {
          challenge_token: phoneGateRes.json.challenge_token,
          cloud_password: cloudPw,
          device_name: 'HarmonyOS 2in1',
        },
        {},
      );
      assert.httpStatus(verify2faHttp, 200, 'POST /api/v1/auth/2fa/verify must succeed with valid cloud_password');
      assert.equal(verify2faHttp.json?.user_id, ownerUid, '2fa/verify must issue session for owner user_id');
      assert.isNonEmptyString(verify2faHttp.json?.token, '2fa/verify must issue valid bearer token');

      // 4. Disable 2FA via DELETE /api/v1/auth/2fa, re-enable via HTTP, and disable via CLI disable2fa
      const del2faHttp = await ctx.http.del(
        '/api/v1/auth/2fa',
        { current_password: cloudPw },
        { token: ownerToken },
      );
      assert.httpStatus(del2faHttp, 200, 'DELETE /api/v1/auth/2fa must return 200 OK');
      assert.equal(del2faHttp.json?.has_password, false, 'DELETE /api/v1/auth/2fa must clear has_password');

      const reSetHttp = await ctx.http.post(
        '/api/v1/auth/2fa/set',
        { new_password: cloudPw, hint: 're-enabled' },
        { token: ownerToken },
      );
      assert.httpStatus(reSetHttp, 200, 'POST /api/v1/auth/2fa/set re-enable');
      assert.equal(reSetHttp.json?.has_password, true, 'Re-enabled 2FA must report has_password=true');

      const cliDisable = await ctx.cli.invoke({
        sandbox: tfaSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'disable2fa',
        payload: { currentPassword: cloudPw },
        expectOk: true,
      });
      assert.equal(cliDisable.data?.disabled, true, 'CLI disable2fa must return disabled=true');

      const statusAfter = await ctx.cli.invoke({
        sandbox: tfaSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'get2faStatus',
        payload: {},
        expectOk: true,
      });
      assert.equal(statusAfter.data?.has_password, false, 'Final 2FA status must be false after disable');
    },
  }),

  defineTest({
    id: 'T1-F05-04-alipay-qr-sandbox-start-scan-poll-and-me',
    name: 'F5: Alipay QR OAuth sandbox start -> pending poll -> simulate-scan -> completed poll -> authenticated /me + CLI parity',
    tier: 1,
    features: ['F5'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const alipaySandbox = ctx.createClientSandbox('f05_alipay');

      const startRes = await ctx.cli.invoke({
        sandbox: alipaySandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'startAlipayQr',
        payload: {},
        expectOk: true,
      });
      const attemptId = startRes.data?.attempt_id;
      assert.isNonEmptyString(attemptId, 'startAlipayQr must return attempt_id');

      const pendingPoll = await ctx.cli.invoke({
        sandbox: alipaySandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'pollAlipayQr',
        payload: { attemptId },
        expectOk: true,
      });
      assert.equal(pendingPoll.data?.poll?.status, 'pending', 'Poll prior to scan must report status=pending');
      assert.equal(pendingPoll.data?.account, null, 'Pending poll must not bind an account slot');

      const scanRes = await ctx.cli.invoke({
        sandbox: alipaySandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'simulateAlipayScan',
        payload: { attemptId },
        expectOk: true,
      });
      assert.equal(scanRes.data?.simulated, true, 'simulateAlipayScan must succeed');

      const completedPoll = await ctx.cli.invoke({
        sandbox: alipaySandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'pollAlipayQr',
        payload: { attemptId },
        expectOk: true,
      });
      assert.equal(completedPoll.data?.poll?.status, 'completed', 'Post-scan poll must report status=completed');
      assert.isObject(completedPoll.data?.account, 'Completed Alipay poll must bind HarmonyOS account slot');
      const issuedToken = completedPoll.data.account.token;
      assert.isNonEmptyString(issuedToken, 'Bound account slot must contain issued bearer token');

      const meHttp = await ctx.http.get('/api/v1/auth/me', { token: issuedToken });
      assert.httpStatus(meHttp, 200, 'GET /api/v1/auth/me with Alipay OAuth token');
      assert.equal(meHttp.json?.user_id, completedPoll.data.account.userId, '/auth/me user_id must match bound slot');

      const cliMe = await ctx.cli.invoke({
        sandbox: alipaySandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'getMe',
        payload: {},
        expectOk: true,
      });
      assert.equal(cliMe.data?.user_id, completedPoll.data.account.userId, 'CLI getMe must succeed for Alipay session');
    },
  }),

  defineTest({
    id: 'T1-F05-05-email-otp-send-code-and-register-201',
    name: 'F5: Email OTP send-code (@example.com debug_code) and 201 registration across REST /api/v1/auth/email/* and ohos-app-cli',
    tier: 1,
    features: ['F5'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();

      // 1. Direct REST email OTP registration -> 201 Created
      const emailHttp = 'f05_email_http@example.com';
      const sendHttp = await ctx.http.post('/api/v1/auth/email/send-code', { email: emailHttp }, {});
      assert.httpStatus(sendHttp, 200, 'POST /api/v1/auth/email/send-code must return 200');
      assert.equal(sendHttp.json?.ok, true, 'email/send-code must return ok=true');
      assert.match(sendHttp.json?.debug_code, /^\d{6}$/, 'email/send-code must return 6-digit debug_code');

      const regHttp = await ctx.http.post(
        '/api/v1/auth/email/register',
        {
          email: emailHttp,
          code: sendHttp.json.debug_code,
          username: 'f05_email_http_u',
          password: 'EmailStrongPassword!1',
          first_name: 'Email HTTP',
          device_name: 'HarmonyOS Email Client',
        },
        {},
      );
      assert.httpStatus(regHttp, 201, 'POST /api/v1/auth/email/register must return 201 Created');
      assert.greaterThan(regHttp.json?.user_id, 0, 'email/register must allocate user_id');
      assert.isNonEmptyString(regHttp.json?.token, 'email/register must return bearer token');

      const meHttp = await ctx.http.get('/api/v1/auth/me', { token: regHttp.json.token });
      assert.httpStatus(meHttp, 200, 'GET /api/v1/auth/me for email-registered account');
      assert.equal(meHttp.json?.username, 'f05_email_http_u', '/auth/me username must match');

      // 2. HarmonyOS CLI sendEmailCode + registerEmail
      const emailSandbox = ctx.createClientSandbox('f05_email_cli');
      const emailCli = 'f05_email_cli@example.com';
      const sendCli = await ctx.cli.invoke({
        sandbox: emailSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'sendEmailCode',
        payload: { email: emailCli },
        expectOk: true,
      });
      assert.match(sendCli.data?.debug_code, /^\d{6}$/, 'CLI sendEmailCode must return 6-digit debug_code');

      const regCli = await ctx.cli.invoke({
        sandbox: emailSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerEmail',
        payload: {
          email: emailCli,
          code: sendCli.data.debug_code,
          username: 'f05_email_cli_u',
          password: 'EmailStrongPassword!2',
          firstName: 'Email CLI',
        },
        expectOk: true,
      });
      assert.greaterThan(regCli.data?.session?.user_id, 0, 'CLI registerEmail must issue authenticated session');
      assert.equal(regCli.data?.account?.username, 'f05_email_cli_u', 'CLI registerEmail must bind account slot');

      const cliMe = await ctx.cli.invoke({
        sandbox: emailSandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'getMe',
        payload: {},
        expectOk: true,
      });
      assert.equal(cliMe.data?.user_id, regCli.data.session.user_id, 'CLI getMe must confirm email-registered user');
    },
  }),

  defineTest({
    id: 'T1-F05-06-qr-device-pairing-init-approve-poll-and-token',
    name: 'F5: Companion QR Device Pairing start -> pending poll -> authenticated approve -> confirmed poll & token verification',
    tier: 1,
    features: ['F5'],
    timeoutMs: 45_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const primaryPhoneSb = ctx.createClientSandbox('f05_qr_primary');
      const companionTabletSb = ctx.createClientSandbox('f05_qr_companion');

      // 1. Primary phone authenticates
      const primaryAuth = await ctx.cli.invoke({
        sandbox: primaryPhoneSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f05_qr_owner',
          password: 'QrOwnerPassword!9',
          firstName: 'QR Owner',
        },
        expectOk: true,
      });
      const ownerUid = primaryAuth.data.session.user_id;

      // 2. Unauthenticated companion tablet initiates QR pairing
      const initQr = await ctx.cli.invoke({
        sandbox: companionTabletSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'startQrPairing',
        payload: {},
        expectOk: true,
      });
      const pairToken = initQr.data?.pair_token;
      assert.isNonEmptyString(pairToken, 'startQrPairing must return pair_token');
      assert.includes(initQr.data?.qr_url ?? '', pairToken, 'qr_url must embed pair_token');

      const pendingPoll = await ctx.cli.invoke({
        sandbox: companionTabletSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'pollQrPairing',
        payload: { pairToken },
        expectOk: true,
      });
      assert.equal(pendingPoll.data?.poll?.status, 'pending', 'QR session before scan must report status=pending');

      // 3. Authenticated primary phone approves the QR pairing token
      const approveRes = await ctx.cli.invoke({
        sandbox: primaryPhoneSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'approveQrPairing',
        payload: { pairToken },
        expectOk: true,
      });
      assert.equal(approveRes.data?.approved, true, 'approveQrPairing must return approved=true');

      // 4. Companion tablet polls -> confirmed + auto-bound session token
      const confirmedPoll = await ctx.cli.invoke({
        sandbox: companionTabletSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'pollQrPairing',
        payload: { pairToken },
        expectOk: true,
      });
      assert.equal(confirmedPoll.data?.poll?.status, 'confirmed', 'Approved QR poll must report status=confirmed');
      assert.equal(confirmedPoll.data?.account?.userId, ownerUid, 'Companion sandbox must bind to primary user_id');
      const companionToken = confirmedPoll.data.account.token;
      assert.isNonEmptyString(companionToken, 'Companion sandbox must receive distinct live bearer token');
      assert.notEqual(companionToken, primaryAuth.data.session.token, 'Companion device must get its own session token');

      const companionHttpMe = await ctx.http.get('/api/v1/auth/me', { token: companionToken });
      assert.httpStatus(companionHttpMe, 200, 'GET /api/v1/auth/me with QR-paired companion token');
      assert.equal(companionHttpMe.json?.user_id, ownerUid, 'Companion token /auth/me user_id must match owner');

      const companionCliMe = await ctx.cli.invoke({
        sandbox: companionTabletSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'getMe',
        payload: {},
        expectOk: true,
      });
      assert.equal(companionCliMe.data?.user_id, ownerUid, 'Companion CLI getMe must succeed without re-login');
    },
  }),

  defineTest({
    id: 'T1-F05-07-passkey-ed25519-challenge-register-list-and-verify',
    name: 'F5: Passkey Ed25519 WebAuthn challenge -> register (201) -> list -> challenge -> signed verify via ohos-app-cli verifyPasskey',
    tier: 1,
    features: ['F5'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();

      // 1. Register account to own the Passkey credential
      const ownerReg = await ctx.http.post(
        '/api/v1/auth/register',
        {
          username: 'f05_passkey_user',
          password: 'PasskeyOwnerPassword!7',
          first_name: 'Passkey User',
        },
        {},
      );
      assert.httpStatus(ownerReg, 201, 'Owner registration for passkey enrollment');
      const ownerToken = ownerReg.json.token;
      const ownerUid = ownerReg.json.user_id;

      // 2. Request enrollment challenge -> generate Ed25519 keypair -> register passkey (201) -> list
      const enrollChall = await ctx.http.post(
        '/api/v1/auth/passkey/challenge',
        { username: 'f05_passkey_user' },
        {},
      );
      assert.httpStatus(enrollChall, 200, 'POST /api/v1/auth/passkey/challenge (enrollment)');
      assert.isNonEmptyString(enrollChall.json?.challenge, 'passkey/challenge must return challenge string');
      assert.isNonEmptyString(enrollChall.json?.rp_id, 'passkey/challenge must return rp_id');

      const kp = ctx.crypto.generateEd25519KeyPairHex();
      const credentialId = `cred_ohos_${kp.publicKeyHex.slice(0, 20)}`;

      const regPkRes = await ctx.http.post(
        '/api/v1/auth/passkey/register',
        {
          credential_id: credentialId,
          public_key: kp.publicKeyBase64,
          device_name: 'HarmonyOS 3D Face / Fingerprint Authenticator',
        },
        { token: ownerToken },
      );
      assert.httpStatus(regPkRes, 201, 'POST /api/v1/auth/passkey/register must return 201 Created');
      assert.equal(regPkRes.json?.credential_id, credentialId, 'passkey/register must echo credential_id');
      assert.equal(regPkRes.json?.user_id, ownerUid, 'passkey/register must associate owner user_id');
      assert.greaterThanOrEqual(regPkRes.json?.sign_count, 0, 'passkey/register must initialize sign_count');

      const listPkRes = await ctx.http.get('/api/v1/auth/passkey/list', { token: ownerToken });
      assert.httpStatus(listPkRes, 200, 'GET /api/v1/auth/passkey/list');
      assert.equal(listPkRes.json?.total, 1, 'passkey/list must report 1 registered credential');
      assert.equal(listPkRes.json?.passkeys?.[0]?.credential_id, credentialId, 'passkey/list must return credential_id');

      // 3. Request assertion challenge -> sign UTF-8 challenge bytes with Ed25519 -> verify via CLI verifyPasskey
      const assertChall = await ctx.http.post(
        '/api/v1/auth/passkey/challenge',
        { username: 'f05_passkey_user' },
        {},
      );
      assert.httpStatus(assertChall, 200, 'POST /api/v1/auth/passkey/challenge (assertion)');
      const challengeStr = assertChall.json.challenge;
      assert.notEqual(challengeStr, enrollChall.json.challenge, 'Each passkey challenge must be unique');

      const signatureB64 = ctx.crypto.signEd25519Base64(challengeStr, kp.privateKeyHex);
      assert.equal(
        ctx.crypto.verifyEd25519(challengeStr, signatureB64, kp.publicKeyBase64),
        true,
        'Generated Ed25519 WebAuthn assertion signature must self-verify',
      );

      const clientDataJson = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: challengeStr,
          origin: `https://${assertChall.json.rp_id}`,
        }),
      ).toString('base64');
      const authenticatorData = Buffer.alloc(37, 1).toString('base64');

      const passkeyLoginSb = ctx.createClientSandbox('f05_passkey_login');
      const verifyCli = await ctx.cli.invoke({
        sandbox: passkeyLoginSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'verifyPasskey',
        payload: {
          challenge: challengeStr,
          credential_id: credentialId,
          signature: signatureB64,
          client_data_json: clientDataJson,
          authenticator_data: authenticatorData,
        },
        expectOk: true,
      });
      assert.equal(verifyCli.data?.session?.user_id, ownerUid, 'verifyPasskey must authenticate owner user_id');
      assert.isNonEmptyString(verifyCli.data?.session?.token, 'verifyPasskey must issue live session token');

      const verifyMe = await ctx.http.get('/api/v1/auth/me', { token: verifyCli.data.session.token });
      assert.httpStatus(verifyMe, 200, 'GET /api/v1/auth/me using passkey-issued bearer token');
      assert.equal(verifyMe.json?.user_id, ownerUid, 'Passkey token /auth/me user_id must match owner');
    },
  }),

  defineTest({
    id: 'T1-F05-08-pre-auth-server-url-and-proxy-config-cli',
    name: 'F5: Pre-auth server_url health probe and SOCKS5/HTTP/Direct proxy configuration via ohos-app-cli auth domain',
    tier: 1,
    features: ['F5'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const preAuthSb = ctx.createClientSandbox('f05_preauth_cfg');

      // 1. Pre-auth setServerConfig with live health probe
      const srvCfg = await ctx.cli.invoke({
        sandbox: preAuthSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setServerConfig',
        payload: {
          serverUrl: `${server.baseUrl}/`,
          probe: true,
        },
        expectOk: true,
      });
      assert.equal(srvCfg.data?.serverUrl, server.baseUrl, 'setServerConfig must normalize trailing slash');
      assert.equal(srvCfg.data?.reachable, true, 'setServerConfig with probe=true must confirm server reachability');

      // 2. Pre-auth SOCKS5 proxy configuration (disabled for traffic, persisted with tg://socks deep link)
      const socksCfg = await ctx.cli.invoke({
        sandbox: preAuthSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setProxyConfig',
        payload: {
          kind: 'SOCKS5',
          host: '127.0.0.1',
          port: 10808,
          username: 'ohos_proxy_user',
          password: 'ohos_proxy_pass',
          enabled: false,
        },
        expectOk: true,
      });
      assert.equal(socksCfg.data?.proxy?.kind, 'SOCKS5', 'setProxyConfig must persist SOCKS5 kind');
      assert.equal(socksCfg.data?.proxy?.port, 10808, 'setProxyConfig must persist port 10808');
      assert.isNonEmptyString(socksCfg.data?.deepLink, 'setProxyConfig must emit tg:// proxy deepLink');

      // 3. Pre-auth HTTP proxy configuration
      const httpProxyCfg = await ctx.cli.invoke({
        sandbox: preAuthSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setProxyConfig',
        payload: {
          kind: 'HTTP',
          host: '127.0.0.1',
          port: 8889,
          enabled: false,
        },
        expectOk: true,
      });
      assert.equal(httpProxyCfg.data?.proxy?.kind, 'HTTP', 'setProxyConfig must support HTTP proxy kind');
      assert.equal(httpProxyCfg.data?.proxy?.port, 8889, 'setProxyConfig must persist HTTP proxy port');

      // 4. Reset to Direct and verify pre-auth checkHealth + registration succeed end-to-end
      const directCfg = await ctx.cli.invoke({
        sandbox: preAuthSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setProxyConfig',
        payload: { kind: 'Direct', enabled: false },
        expectOk: true,
      });
      assert.equal(directCfg.data?.proxy?.kind, 'Direct', 'Resetting proxy to Direct must set kind=Direct');
      assert.equal(directCfg.data?.proxy?.enabled, false, 'Direct proxy mode must have enabled=false');

      const healthRes = await ctx.cli.invoke({
        sandbox: preAuthSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'checkHealth',
        payload: {},
        expectOk: true,
      });
      assert.equal(healthRes.data?.healthy, true, 'Pre-auth checkHealth must succeed after Direct reset');
    },
  }),
];

export default tests;
