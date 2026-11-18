import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

export const tests = [
  defineTest({
    id: 'T2-F05-01-duplicate-case-insensitive-username-and-credential-length-bounds',
    name: 'F5 Boundary: Case-insensitive duplicate username (409 user_already_exists) and empty/oversized username (>128) or password (>1024) rejected (400)',
    tier: 2,
    features: ['F5'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const sb = ctx.createClientSandbox('f05_b_dup_reg');

      const firstReg = await ctx.http.post(
        '/api/v1/auth/register',
        {
          username: 'CaseSensitiveHero',
          password: 'ValidPassword!123',
          first_name: 'Hero',
        },
        {},
      );
      assert.httpStatus(firstReg, 201, 'Initial registration must succeed with 201');

      // 1. Case-insensitive duplicate username via HTTP -> 409 user_already_exists
      const dupHttp = await ctx.http.post(
        '/api/v1/auth/register',
        {
          username: 'casesensitivehero',
          password: 'AnotherValidPassword!4',
          first_name: 'Duplicate',
        },
        {},
      );
      assert.httpStatus(dupHttp, 409, 'Case-insensitive duplicate username must return 409 Conflict');
      assert.equal(dupHttp.json?.error, 'user_already_exists', 'Duplicate username error code must equal user_already_exists');

      // 2. Duplicate username via CLI registerPassword -> expectOk: false
      const dupCli = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'CASESENSITIVEHERO',
          password: 'AnotherValidPassword!4',
          firstName: 'Duplicate CLI',
        },
        expectOk: false,
      });
      assert.equal(dupCli.ok, false, 'CLI duplicate registration must fail');
      assert.isNonEmptyString(dupCli.errorCode, 'CLI duplicate registration must emit errorCode');

      // 3. Empty username & >128-char username -> 400
      const emptyUser = await ctx.http.post(
        '/api/v1/auth/register',
        { username: '   ', password: 'ValidPassword!123', first_name: 'Empty' },
        {},
      );
      assert.httpStatus(emptyUser, 400, 'Empty/whitespace username must return 400');

      const oversizedUser = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'u'.repeat(129), password: 'ValidPassword!123', first_name: 'Oversized' },
        {},
      );
      assert.httpStatus(oversizedUser, 400, '>128-character username must return 400');

      // 4. Empty password & >1024-byte password -> 400; <6-char CLI password -> expectOk: false
      const emptyPass = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f05_b_empty_pw', password: '', first_name: 'EmptyPw' },
        {},
      );
      assert.httpStatus(emptyPass, 400, 'Empty password must return 400');

      const oversizedPass = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f05_b_huge_pw', password: 'P'.repeat(1025), first_name: 'HugePw' },
        {},
      );
      assert.httpStatus(oversizedPass, 400, '>1024-byte password must return 400');

      const shortCliPass = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: { username: 'f05_b_short_cli', password: '123', firstName: 'Short' },
        expectOk: false,
      });
      assert.equal(shortCliPass.errorCode, 'VALIDATION_ERROR', 'CLI <6-char password must return VALIDATION_ERROR');
    },
  }),

  defineTest({
    id: 'T2-F05-02-wrong-password-login-and-malformed-bearer-token-rejection',
    name: 'F5 Boundary: Wrong password login (401 invalid_credentials) and missing/malformed/forged Bearer tokens on /api/v1/auth/me (401)',
    tier: 2,
    features: ['F5'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const sb = ctx.createClientSandbox('f05_b_bad_login');

      const regRes = await ctx.http.post(
        '/api/v1/auth/register',
        {
          username: 'f05_b_auth_target',
          password: 'CorrectHorseBatteryStaple!9',
          first_name: 'Target',
        },
        {},
      );
      assert.httpStatus(regRes, 201, 'Register target user');

      // 1. Wrong password on /api/v1/auth/login -> 401 invalid_credentials
      const wrongPwHttp = await ctx.http.post(
        '/api/v1/auth/login',
        { username: 'f05_b_auth_target', password: 'WrongPasswordAttempt!0' },
        {},
      );
      assert.httpStatus(wrongPwHttp, 401, 'Wrong password login must return 401 Unauthorized');
      assert.equal(wrongPwHttp.json?.error, 'invalid_credentials', 'Wrong password error must equal invalid_credentials');

      // 2. Nonexistent user login -> 401 invalid_credentials (no user enumeration)
      const ghostLogin = await ctx.http.post(
        '/api/v1/auth/login',
        { username: 'f05_b_nonexistent_ghost', password: 'AnyPassword!123' },
        {},
      );
      assert.httpStatus(ghostLogin, 401, 'Unknown username login must return 401 Unauthorized');
      assert.equal(ghostLogin.json?.error, 'invalid_credentials', 'Unknown user error must equal invalid_credentials');

      // 3. CLI loginPassword with wrong password -> expectOk: false
      const wrongPwCli = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'loginPassword',
        payload: { username: 'f05_b_auth_target', password: 'WrongCliPassword!0' },
        expectOk: false,
      });
      assert.equal(wrongPwCli.ok, false, 'CLI loginPassword with wrong password must fail');

      // 4. Missing, malformed, and tampered Bearer tokens on GET /api/v1/auth/me -> 401
      const noTokenRes = await ctx.http.get('/api/v1/auth/me');
      assert.httpStatus(noTokenRes, 401, 'Unauthenticated GET /api/v1/auth/me must return 401');

      const malformedTokenRes = await ctx.http.get('/api/v1/auth/me', { token: 'not_a_valid_token_format' });
      assert.httpStatus(malformedTokenRes, 401, 'Malformed Bearer token without secret separator must return 401');

      const validToken = regRes.json.token;
      const tamperedToken = `${validToken.slice(0, -4)}ffff`;
      const tamperedRes = await ctx.http.get('/api/v1/auth/me', { token: tamperedToken });
      assert.httpStatus(tamperedRes, 401, 'Tampered Bearer token secret must return 401');
    },
  }),

  defineTest({
    id: 'T2-F05-03-phone-otp-rate-limit-wrong-hash-and-brute-force-lockout',
    name: 'F5 Boundary: Phone OTP invalid phone (400), 60s resend cooldown (429), wrong phone_code_hash (400), and 5-attempt lockout (429)',
    tier: 2,
    features: ['F5'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      // 1. Invalid short/empty phone -> 400 invalid_phone
      const badPhone = await ctx.http.post('/api/v1/auth/phone/send-code', { phone: '123' }, {});
      assert.httpStatus(badPhone, 400, 'Short invalid phone number must return 400');
      assert.equal(badPhone.json?.error, 'invalid_phone', 'Invalid phone error must equal invalid_phone');

      // 2. Valid send-code followed immediately by resend within 60s -> 429 rate_limited
      const phone = '+8613700137901';
      const send1 = await ctx.http.post('/api/v1/auth/phone/send-code', { phone }, {});
      assert.httpStatus(send1, 200, 'Initial phone/send-code must return 200');
      const realCode = send1.json.debug_code;
      const realHash = send1.json.phone_code_hash;

      const sendCooldown = await ctx.http.post('/api/v1/auth/phone/send-code', { phone }, {});
      assert.httpStatus(sendCooldown, 429, 'Resending phone OTP within 60s cooldown must return 429');
      assert.equal(sendCooldown.json?.error, 'rate_limited', 'Cooldown error must equal rate_limited');

      // 3. Mismatched phone_code_hash -> 400 invalid_phone_code_hash
      const wrongHashRes = await ctx.http.post(
        '/api/v1/auth/phone/verify',
        { phone, phone_code_hash: '00000000000000000000000000000000', code: realCode },
        {},
      );
      assert.httpStatus(wrongHashRes, 400, 'Wrong phone_code_hash must return 400');
      assert.equal(wrongHashRes.json?.error, 'invalid_phone_code_hash', 'Error must equal invalid_phone_code_hash');

      // 4. Brute-force 5 wrong OTP attempts -> 401 invalid_code, then 6th attempt (even with real code!) -> 429 too_many_attempts
      const wrongCode = realCode === '000000' ? '999999' : '000000';
      for (let i = 1; i <= 5; i++) {
        const badVerify = await ctx.http.post(
          '/api/v1/auth/phone/verify',
          { phone, phone_code_hash: realHash, code: wrongCode },
          {},
        );
        assert.httpStatus(badVerify, 401, `Wrong phone OTP attempt #${i} must return 401`);
        assert.equal(badVerify.json?.error, 'invalid_code', 'Wrong phone OTP error must equal invalid_code');
        assert.equal(badVerify.json?.attempts_left, 5 - i, `attempts_left after attempt #${i} must equal ${5 - i}`);
      }

      const sixthAttempt = await ctx.http.post(
        '/api/v1/auth/phone/verify',
        { phone, phone_code_hash: realHash, code: realCode },
        {},
      );
      assert.httpStatus(sixthAttempt, 429, '6th attempt after exhausting 5 attempts must return 429');
      assert.equal(sixthAttempt.json?.error, 'too_many_attempts', 'Exhausted phone OTP must return too_many_attempts');
    },
  }),

  defineTest({
    id: 'T2-F05-04-email-otp-duplicate-email-rate-limit-and-brute-force-expiry',
    name: 'F5 Boundary: Email OTP invalid email (400), duplicate email (409), 60s cooldown (429), and >5 wrong attempts code_expired (400)',
    tier: 2,
    features: ['F5'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      // 1. Malformed email -> 400 invalid_email
      const invalidEmail = await ctx.http.post('/api/v1/auth/email/send-code', { email: 'not-an-email' }, {});
      assert.httpStatus(invalidEmail, 400, 'Malformed email must return 400');
      assert.equal(invalidEmail.json?.error, 'invalid_email', 'Malformed email error must equal invalid_email');

      // 2. Register an email account, then attempt send-code on already-registered email -> 409 email_already_registered
      const registeredEmail = 'f05_b_taken@example.com';
      const sendTaken = await ctx.http.post('/api/v1/auth/email/send-code', { email: registeredEmail }, {});
      assert.httpStatus(sendTaken, 200, 'Initial email/send-code');

      // Resend immediately before registering -> 429 rate_limited
      const resendCooldown = await ctx.http.post('/api/v1/auth/email/send-code', { email: registeredEmail }, {});
      assert.httpStatus(resendCooldown, 429, 'Email OTP resend within 60s must return 429');
      assert.equal(resendCooldown.json?.error, 'rate_limited', 'Email cooldown error must equal rate_limited');

      // Weak <8-char password on email/register -> 400 invalid_password
      const weakPassReg = await ctx.http.post(
        '/api/v1/auth/email/register',
        {
          email: registeredEmail,
          code: sendTaken.json.debug_code,
          username: 'f05_b_taken_user',
          password: 'short',
          first_name: 'Short',
        },
        {},
      );
      assert.httpStatus(weakPassReg, 400, '<8-char password on email/register must return 400');
      assert.equal(weakPassReg.json?.error, 'invalid_password', 'Error must equal invalid_password');

      // Complete registration -> 201, then verify duplicate email send-code -> 409
      const okReg = await ctx.http.post(
        '/api/v1/auth/email/register',
        {
          email: registeredEmail,
          code: sendTaken.json.debug_code,
          username: 'f05_b_taken_user',
          password: 'StrongEmailPassword!8',
          first_name: 'Taken',
          device_name: 'HarmonyOS Test',
        },
        {},
      );
      assert.httpStatus(okReg, 201, 'Valid email registration');

      const dupSend = await ctx.http.post('/api/v1/auth/email/send-code', { email: registeredEmail }, {});
      assert.httpStatus(dupSend, 409, 'send-code on already-registered email must return 409');
      assert.equal(dupSend.json?.error, 'email_already_registered', 'Duplicate email error must equal email_already_registered');

      // 3. Brute-force 5 wrong codes on a fresh email -> 400 invalid_code, then 6th attempt -> 400 code_expired
      const bruteEmail = 'f05_b_brute@example.com';
      const sendBrute = await ctx.http.post('/api/v1/auth/email/send-code', { email: bruteEmail }, {});
      assert.httpStatus(sendBrute, 200, 'Send OTP to bruteEmail');
      const wrongCode = sendBrute.json.debug_code === '111111' ? '222222' : '111111';

      for (let i = 1; i <= 5; i++) {
        const badAttempt = await ctx.http.post(
          '/api/v1/auth/email/register',
          {
            email: bruteEmail,
            code: wrongCode,
            username: `f05_brute_${i}`,
            password: 'StrongEmailPassword!8',
            first_name: 'Brute',
            device_name: 'Test',
          },
          {},
        );
        assert.httpStatus(badAttempt, 400, `Wrong email OTP attempt #${i} must return 400`);
        assert.equal(badAttempt.json?.error, 'invalid_code', 'Wrong email OTP error must equal invalid_code');
      }

      const exhaustedAttempt = await ctx.http.post(
        '/api/v1/auth/email/register',
        {
          email: bruteEmail,
          code: sendBrute.json.debug_code,
          username: 'f05_brute_final',
          password: 'StrongEmailPassword!8',
          first_name: 'Brute',
          device_name: 'Test',
        },
        {},
      );
      assert.httpStatus(exhaustedAttempt, 400, '6th email OTP attempt must fail with 400');
      assert.equal(exhaustedAttempt.json?.error, 'code_expired', 'Exhausted email OTP must return code_expired');
    },
  }),

  defineTest({
    id: 'T2-F05-05-two-factor-weak-password-wrong-current-and-challenge-exhaustion',
    name: 'F5 Boundary: 2FA empty/<6-char password (400), wrong current_password on update/disable (401/403), and wrong cloud_password exhaustion (401)',
    tier: 2,
    features: ['F5'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();

      const reg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f05_b_2fa_user', password: 'LoginPassword!9', first_name: 'TwoFA Boundary' },
        {},
      );
      assert.httpStatus(reg, 201, 'Register 2FA boundary user');
      const token = reg.json.token;

      // 1. Empty 2FA password -> 400
      const emptyPw = await ctx.http.post('/api/v1/auth/2fa/set', { new_password: '   ' }, { token });
      assert.httpStatus(emptyPw, 400, 'Empty 2FA cloud password must return 400');

      // 2. Enable valid 2FA password -> test wrong current_password on update and disable
      const real2fa = 'RealCloudSecret!9';
      const setOk = await ctx.http.post(
        '/api/v1/auth/2fa/set',
        { new_password: real2fa, hint: 'strict hint' },
        { token },
      );
      assert.httpStatus(setOk, 200, 'Enable 2FA cloud password');

      const badUpdate = await ctx.http.post(
        '/api/v1/auth/2fa/set',
        { current_password: 'WrongCurrentPassword!', new_password: 'NewCloudPassword!8' },
        { token },
      );
      assert.httpStatus(badUpdate, [401, 403], 'Updating 2FA with wrong current_password must be rejected (401/403)');
      assert.isNonEmptyString(badUpdate.json?.error, 'Rejected 2FA update must return structured error code');

      const badDisable = await ctx.http.del(
        '/api/v1/auth/2fa',
        { current_password: 'WrongCurrentPassword!' },
        { token },
      );
      assert.httpStatus(badDisable, [401, 403], 'Disabling 2FA with wrong current_password must be rejected (401/403)');

      // 3. Login gates session issuance behind challenge_token; wrong cloud_password -> 401 until challenge_expired
      const loginGate = await ctx.http.post(
        '/api/v1/auth/login',
        { username: 'f05_b_2fa_user', password: 'LoginPassword!9' },
        {},
      );
      assert.httpStatus(loginGate, 200, 'Login step 1 on 2FA account');
      assert.equal(loginGate.json?.requires_2fa, true, 'Login must demand 2FA completion');
      const challengeToken = loginGate.json.challenge_token;

      for (let i = 1; i <= 5; i++) {
        const wrongVerify = await ctx.http.post(
          '/api/v1/auth/2fa/verify',
          { challenge_token: challengeToken, cloud_password: `WrongAttempt_${i}!` },
          {},
        );
        assert.httpStatus(wrongVerify, 401, `Wrong 2FA password attempt #${i} must return 401`);
        assert.equal(wrongVerify.json?.error, 'invalid_cloud_password', 'Error must equal invalid_cloud_password');
      }

      const exhaustedVerify = await ctx.http.post(
        '/api/v1/auth/2fa/verify',
        { challenge_token: challengeToken, cloud_password: real2fa },
        {},
      );
      assert.httpStatus(exhaustedVerify, 401, 'Exhausted 2FA challenge must reject even real password with 401');
      assert.equal(exhaustedVerify.json?.error, 'challenge_expired', 'Exhausted 2FA challenge must report challenge_expired');

      // 4. Sub-6-character weak 2FA password rejection (400) per SCOPE.md § 3.1 F5 Boundary
      const freshUser = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f05_b_2fa_weak', password: 'LoginPassword!9', first_name: 'Weak2FA' },
        {},
      );
      const short2fa = await ctx.http.post(
        '/api/v1/auth/2fa/set',
        { new_password: '12345' },
        { token: freshUser.json.token },
      );
      assert.httpStatus(short2fa, 400, '2FA Cloud Password <6 characters must be rejected with 400');
    },
  }),

  defineTest({
    id: 'T2-F05-06-passkey-one-shot-challenge-replay-and-forged-signature-rejection',
    name: 'F5 Boundary: Passkey unauthenticated/empty register, one-shot challenge replay (400 invalid_challenge), unknown credential, and forged Ed25519 signature (401)',
    tier: 2,
    features: ['F5'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const owner = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f05_b_pk_victim', password: 'VictimPassword!9', first_name: 'PK Victim' },
        {},
      );
      assert.httpStatus(owner, 201, 'Register passkey owner');
      const ownerToken = owner.json.token;

      // 1. Unauthenticated passkey/register -> 401; empty credential_id/public_key -> 400 invalid_passkey
      const unauthReg = await ctx.http.post(
        '/api/v1/auth/passkey/register',
        { credential_id: 'cred_unauth', public_key: 'AAAA' },
        {},
      );
      assert.httpStatus(unauthReg, 401, 'Unauthenticated passkey/register must return 401');

      const emptyReg = await ctx.http.post(
        '/api/v1/auth/passkey/register',
        { credential_id: '', public_key: '' },
        { token: ownerToken },
      );
      assert.httpStatus(emptyReg, 400, 'Empty passkey credential_id/public_key must return 400');
      assert.equal(emptyReg.json?.error, 'invalid_passkey', 'Error must equal invalid_passkey');

      // 2. Register real Ed25519 credential
      const legitKeys = ctx.crypto.generateEd25519KeyPairHex();
      const attackerKeys = ctx.crypto.generateEd25519KeyPairHex();
      const credentialId = `cred_victim_${legitKeys.publicKeyHex.slice(0, 16)}`;

      const regPk = await ctx.http.post(
        '/api/v1/auth/passkey/register',
        { credential_id: credentialId, public_key: legitKeys.publicKeyBase64, device_name: 'Legit Key' },
        { token: ownerToken },
      );
      assert.httpStatus(regPk, 201, 'Register legitimate passkey');

      // 3. Valid assertion consumes challenge -> replaying same challenge returns 400 invalid_challenge
      const chall1 = await ctx.http.post('/api/v1/auth/passkey/challenge', { username: 'f05_b_pk_victim' }, {});
      const c1 = chall1.json.challenge;
      const validSig1 = ctx.crypto.signEd25519Base64(c1, legitKeys.privateKeyHex);

      const firstVerify = await ctx.http.post(
        '/api/v1/auth/passkey/verify',
        { challenge: c1, credential_id: credentialId, signature: validSig1 },
        {},
      );
      assert.httpStatus(firstVerify, 200, 'First passkey verification with valid challenge & signature');

      const replayVerify = await ctx.http.post(
        '/api/v1/auth/passkey/verify',
        { challenge: c1, credential_id: credentialId, signature: validSig1 },
        {},
      );
      assert.httpStatus(replayVerify, 400, 'Replaying consumed passkey challenge must return 400');
      assert.equal(replayVerify.json?.error, 'invalid_challenge', 'Replay error must equal invalid_challenge');

      // 4. Unknown credential_id with fresh challenge -> 401 unknown_credential
      const chall2 = await ctx.http.post('/api/v1/auth/passkey/challenge', { username: 'f05_b_pk_victim' }, {});
      const unknownCredRes = await ctx.http.post(
        '/api/v1/auth/passkey/verify',
        {
          challenge: chall2.json.challenge,
          credential_id: 'cred_nonexistent_attacker',
          signature: validSig1,
        },
        {},
      );
      assert.httpStatus(unknownCredRes, 401, 'Unknown credential_id must return 401');

      // 5. Forged/tampered Ed25519 signature on registered credential_id with fresh challenge -> 401
      const chall3 = await ctx.http.post('/api/v1/auth/passkey/challenge', { username: 'f05_b_pk_victim' }, {});
      const c3 = chall3.json.challenge;
      const forgedSig = ctx.crypto.signEd25519Base64(c3, attackerKeys.privateKeyHex);

      const forgedRes = await ctx.http.post(
        '/api/v1/auth/passkey/verify',
        {
          challenge: c3,
          credential_id: credentialId,
          signature: forgedSig,
        },
        {},
      );
      assert.httpStatus(forgedRes, 401, 'Forged Ed25519 passkey signature must be rejected with 401');
    },
  }),

  defineTest({
    id: 'T2-F05-07-invalid-pre-auth-proxy-port-scheme-and-orphan-password-rejection',
    name: 'F5 Boundary: Invalid pre-auth proxy port (0 / 70000), unsupported scheme, invalid serverUrl, and password-without-username rejected via ohos-app-cli',
    tier: 2,
    features: ['F5'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const sb = ctx.createClientSandbox('f05_b_bad_proxy');

      // 1. Invalid serverUrl scheme on setServerConfig
      const badSrv = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setServerConfig',
        payload: { serverUrl: 'ftp://127.0.0.1:8080' },
        expectOk: false,
      });
      assert.equal(badSrv.errorCode, 'VALIDATION_ERROR', 'ftp:// serverUrl must return VALIDATION_ERROR');

      // 2. Proxy port 0 -> expectOk: false
      const portZero = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setProxyConfig',
        payload: { kind: 'SOCKS5', host: '127.0.0.1', port: 0 },
        expectOk: false,
      });
      assert.equal(portZero.errorCode, 'VALIDATION_ERROR', 'Proxy port 0 must fail validation');

      // 3. Proxy port 70000 (>65535) -> expectOk: false
      const portHuge = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setProxyConfig',
        payload: { kind: 'HTTP', host: '127.0.0.1', port: 70000 },
        expectOk: false,
      });
      assert.equal(portHuge.errorCode, 'VALIDATION_ERROR', 'Proxy port 70000 must fail validation');

      // 4. Unsupported proxy scheme -> expectOk: false
      const badScheme = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setProxyConfig',
        payload: { kind: 'GOPHER', host: '127.0.0.1', port: 1080 },
        expectOk: false,
      });
      assert.equal(badScheme.errorCode, 'VALIDATION_ERROR', 'Unsupported proxy kind GOPHER must fail validation');

      // 5. Password-without-username rejected in settings.probeProxy AND auth.setProxyConfig
      const probeOrphanPw = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'settings',
        action: 'probeProxy',
        payload: {
          kind: 'SOCKS5',
          host: '127.0.0.1',
          port: 1080,
          password: 'orphan_password_no_user',
        },
        expectOk: false,
      });
      assert.equal(probeOrphanPw.ok, false, 'probeProxy with password-without-username must fail');

      const setOrphanPw = await ctx.cli.invoke({
        sandbox: sb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setProxyConfig',
        payload: {
          kind: 'SOCKS5',
          host: '127.0.0.1',
          port: 1080,
          password: 'orphan_password_no_user',
          enabled: true,
        },
        expectOk: false,
      });
      assert.equal(setOrphanPw.ok, false, 'setProxyConfig with password-without-username must be rejected');
    },
  }),

  defineTest({
    id: 'T2-F05-08-qr-pairing-and-alipay-one-shot-replay-boundaries',
    name: 'F5 Boundary: Unknown/unconfirmed/re-accepted QR pair_token (404/401/400) and Alipay one-shot session re-poll (410 Gone)',
    tier: 2,
    features: ['F5'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const owner = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f05_b_qr_owner', password: 'QrBoundaryPassword!8', first_name: 'QR Owner' },
        {},
      );
      const token = owner.json.token;

      // 1. Unknown pair_token poll -> 404 pair_token_not_found
      const unknownPoll = await ctx.http.get('/api/v1/auth/pair/poll/pair_does_not_exist');
      assert.httpStatus(unknownPoll, 404, 'Polling unknown pair_token must return 404');
      assert.equal(unknownPoll.json?.error, 'pair_token_not_found', 'Error must equal pair_token_not_found');

      // 2. pair/verify before confirmation -> 401 pair_not_confirmed; re-accepting confirmed pair_token -> 400
      const pairInit = await ctx.http.post('/api/v1/auth/pair/init', { device_name: 'Companion' }, {});
      assert.httpStatus(pairInit, 200, 'POST /api/v1/auth/pair/init');
      const pairToken = pairInit.json.pair_token;

      const verifyTooEarly = await ctx.http.post('/api/v1/auth/pair/verify', { pair_token: pairToken }, {});
      assert.httpStatus(verifyTooEarly, 401, 'pair/verify before accept must return 401');
      assert.equal(verifyTooEarly.json?.error, 'pair_not_confirmed', 'Error must equal pair_not_confirmed');

      const accept1 = await ctx.http.post('/api/v1/auth/pair/accept', { pair_token: pairToken }, { token });
      assert.httpStatus(accept1, 200, 'First pair/accept must succeed');

      const acceptReplay = await ctx.http.post('/api/v1/auth/pair/accept', { pair_token: pairToken }, { token });
      assert.httpStatus(acceptReplay, 400, 'Re-accepting already-confirmed pair_token must return 400');
      assert.equal(
        acceptReplay.json?.error,
        'invalid_or_expired_pair_token',
        'Replayed pair/accept must return invalid_or_expired_pair_token',
      );

      // 3. Alipay OAuth one-shot delivery: first post-scan poll -> 200 completed; second poll -> 410 Gone
      const aliStart = await ctx.http.post('/api/v1/auth/alipay/start', { device_name: 'OHOS Alipay' }, {});
      assert.httpStatus(aliStart, 200, 'POST /api/v1/auth/alipay/start');
      const attemptId = aliStart.json.attempt_id;

      const aliScan = await ctx.http.post('/api/v1/auth/alipay/simulate-scan', { attempt_id: attemptId }, {});
      assert.httpStatus(aliScan, 200, 'POST /api/v1/auth/alipay/simulate-scan');

      const aliClaim1 = await ctx.http.get(`/api/v1/auth/alipay/poll/${attemptId}`);
      assert.httpStatus(aliClaim1, 200, 'First Alipay poll claims OAuth session');
      assert.equal(aliClaim1.json?.status, 'completed', 'First claim must report completed');

      const aliClaimReplay = await ctx.http.get(`/api/v1/auth/alipay/poll/${attemptId}`);
      assert.httpStatus(aliClaimReplay, 410, 'Second Alipay poll after session delivery must return 410 Gone');
      assert.equal(
        aliClaimReplay.json?.error,
        'session_already_delivered',
        'Replayed Alipay poll must return session_already_delivered',
      );
    },
  }),
];

export default tests;
