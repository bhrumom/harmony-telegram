import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

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

async function registerE2eeBoundDevice(ctx, label, prefix, existingCreds) {
  const sandbox = ctx.createClientSandbox(label);
  const password = existingCreds?.password ?? 'E2eeBoundPass#2026!';
  const username =
    existingCreds?.username ??
    `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  const authRes = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: existingCreds ? 'loginPassword' : 'registerPassword',
    payload: existingCreds
      ? { username, password }
      : { username, password, displayName: prefix.toUpperCase() },
    expectOk: true,
  });
  const userId = Number(authRes.data?.account?.userId ?? authRes.data?.session?.user_id);
  const token = authRes.data?.account?.token ?? authRes.data?.session?.token;
  assert.greaterThan(userId, 0, `${label} userId must be positive`);
  assert.isNonEmptyString(token, `${label} token must be non-empty`);

  const idRes = await invokeEngine(ctx, {
    sandbox,
    domain: 'e2ee',
    action: 'initIdentity',
    payload: {},
    expectOk: true,
  });

  return {
    sandbox,
    username,
    password,
    userId,
    token,
    deviceId: idRes.data.deviceId,
    identityKey: idRes.data.x25519PublicKeyB64,
    signingKey: idRes.data.ed25519PublicKeyB64,
  };
}

function flipBase64Bit(b64Str) {
  const buf = Buffer.from(b64Str, 'base64');
  buf[0] ^= 0x01;
  return buf.toString('base64');
}

export const tests = [
  defineTest({
    id: 'T2-F12-01-tampered-aead-ciphertext-aad-header-and-replay-rejection',
    name: 'F12 Boundary: Tampered Double Ratchet AEAD ciphertext, mutated header AAD, and duplicate replays are rejected without corrupting session state',
    tier: 2,
    features: ['F12'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeBoundDevice(ctx, 'f12_t2_01_alice', 'alice_f12_b1', null);
      const bob = await registerE2eeBoundDevice(ctx, 'f12_t2_01_bob', 'bob_f12_b1', null);

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 6 },
        expectOk: true,
      });
      await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 6 },
        expectOk: true,
      });

      const enc1 = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'encryptDirect',
        payload: { recipientUserId: bob.userId, plaintext: 'Authenticated message #1', send: false },
        expectOk: true,
      });
      const genuineEnv1 = enc1.data.envelope;

      const tamperedCtEnv = structuredClone(genuineEnv1);
      tamperedCtEnv.kind.payload.recipients[0].ciphertext = flipBase64Bit(
        tamperedCtEnv.kind.payload.recipients[0].ciphertext,
      );
      const badCtRes = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: tamperedCtEnv },
        expectOk: false,
      });
      assert.equal(badCtRes.errorCode, 'E2EE_ERROR', 'Bit-flipped AEAD ciphertext must fail with E2EE_ERROR');

      const tamperedAadEnv = structuredClone(genuineEnv1);
      tamperedAadEnv.kind.payload.recipients[0].header.prev_chain_len = 99;
      const badAadRes = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: tamperedAadEnv },
        expectOk: false,
      });
      assert.equal(badAadRes.errorCode, 'E2EE_ERROR', 'Mutated header AAD must fail AEAD verification');

      const okDec1 = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: genuineEnv1 },
        expectOk: true,
      });
      assert.equal(
        okDec1.data?.plaintext,
        'Authenticated message #1',
        'Genuine envelope #1 must still decrypt cleanly after rejected tamper attempts',
      );

      const replayRes = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: genuineEnv1 },
        expectOk: false,
      });
      assert.equal(replayRes.errorCode, 'E2EE_ERROR', 'Replaying already-decrypted envelope must fail');

      const enc2 = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'encryptDirect',
        payload: { recipientUserId: bob.userId, plaintext: 'Healthy follow-up #2', send: false },
        expectOk: true,
      });
      const okDec2 = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: enc2.data.envelope },
        expectOk: true,
      });
      assert.equal(
        okDec2.data?.plaintext,
        'Healthy follow-up #2',
        'Transactional staged rollback must preserve ratchet continuity for message #2',
      );
    },
  }),

  defineTest({
    id: 'T2-F12-02-invalid-ed25519-spk-signature-and-malformed-prekey-rejection',
    name: 'F12 Boundary: Server and X3DH client reject invalid Ed25519 signed-prekey signatures, malformed key lengths, and oversized OTPK batches',
    tier: 2,
    features: ['F12'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeBoundDevice(ctx, 'f12_t2_02_alice', 'alice_f12_b2', null);
      const bob = await registerE2eeBoundDevice(ctx, 'f12_t2_02_bob', 'bob_f12_b2', null);

      const unauthCount = await ctx.http.get('/api/v1/e2ee/prekeys/count');
      assert.httpStatus(unauthCount, 401, 'Unauthenticated prekeys/count must return HTTP 401');

      const edKeys = ctx.crypto.generateEd25519KeyPairHex();
      const wrongEd = ctx.crypto.generateEd25519KeyPairHex();
      const ik = ctx.crypto.generateX25519KeyPairHex();
      const spk = ctx.crypto.generateX25519KeyPairHex();
      const forgedSig = ctx.crypto.signE2eeSignedPrekeyBase64(spk.publicKeyBase64, wrongEd.privateKeyBase64);

      const badSigUpload = await ctx.http.post(
        '/api/v1/e2ee/prekeys',
        {
          device_id: 'forged_spk_dev',
          identity_key: ik.publicKeyBase64,
          identity_signing_key: edKeys.publicKeyBase64,
          signed_prekey: {
            key_id: 1,
            public_key: spk.publicKeyBase64,
            signature: forgedSig,
            created_at_ms: Date.now(),
          },
          one_time_prekeys: [],
        },
        { token: bob.token },
      );
      assert.httpStatus(badSigUpload, 400, 'Forged Ed25519 SPK signature must be rejected with HTTP 400');
      assert.equal(badSigUpload.json?.error, 'invalid_spk_signature', 'Error code must be invalid_spk_signature');

      const validSig = ctx.crypto.signE2eeSignedPrekeyBase64(spk.publicKeyBase64, edKeys.privateKeyBase64);

      const shortKeyUpload = await ctx.http.post(
        '/api/v1/e2ee/prekeys',
        {
          device_id: 'short_ik_dev',
          identity_key: Buffer.alloc(16, 0x11).toString('base64'),
          identity_signing_key: edKeys.publicKeyBase64,
          signed_prekey: { key_id: 1, public_key: spk.publicKeyBase64, signature: validSig, created_at_ms: Date.now() },
          one_time_prekeys: [],
        },
        { token: bob.token },
      );
      assert.httpStatus(shortKeyUpload, 400, '16-byte truncated identity_key must fail with HTTP 400');
      assert.oneOf(
        shortKeyUpload.json?.error,
        ['invalid_key_length', 'invalid_key'],
        'Error code must diagnose invalid key length',
      );

      const overlongDevIdRes = await ctx.http.post(
        '/api/v1/e2ee/prekeys',
        {
          device_id: 'd'.repeat(140),
          identity_key: ik.publicKeyBase64,
          identity_signing_key: edKeys.publicKeyBase64,
          signed_prekey: { key_id: 1, public_key: spk.publicKeyBase64, signature: validSig, created_at_ms: Date.now() },
          one_time_prekeys: [],
        },
        { token: bob.token },
      );
      assert.httpStatus(overlongDevIdRes, 400, '>128-char device_id must fail with HTTP 400');
      assert.equal(overlongDevIdRes.json?.error, 'invalid_device_id', 'Error code must be invalid_device_id');

      const badOtPkKeyRes = await ctx.http.post(
        '/api/v1/e2ee/prekeys',
        {
          device_id: 'bad_otpk_dev',
          identity_key: ik.publicKeyBase64,
          identity_signing_key: edKeys.publicKeyBase64,
          signed_prekey: { key_id: 1, public_key: spk.publicKeyBase64, signature: validSig, created_at_ms: Date.now() },
          one_time_prekeys: [{ key_id: 1, public_key: 'not-valid-base64!!!' }],
        },
        { token: bob.token },
      );
      assert.httpStatus(badOtPkKeyRes, 400, 'Malformed base64 one_time_prekey must fail with HTTP 400');
      assert.equal(badOtPkKeyRes.json?.error, 'invalid_key_encoding', 'Error code must be invalid_key_encoding');

      const noPrekeys404 = await ctx.http.get(`/api/v1/e2ee/devices/${bob.userId}/prekeys`, { token: alice.token });
      assert.httpStatus(noPrekeys404, 404, 'Fetching prekeys for user with 0 bundles must return HTTP 404');

      const clientTamperedBundle = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'establishX3dh',
        payload: {
          bundle: {
            user_id: bob.userId,
            device_id: 'tampered_bundle_dev',
            identity_key: ik.publicKeyBase64,
            identity_signing_key: edKeys.publicKeyBase64,
            signed_prekey: {
              key_id: 1,
              public_key: spk.publicKeyBase64,
              signature: forgedSig,
              created_at_ms: Date.now(),
            },
          },
        },
        expectOk: false,
      });
      assert.equal(clientTamperedBundle.errorCode, 'E2EE_ERROR', 'Client X3DH must reject invalid SPK signature');

      const zeroPointPub = Buffer.alloc(32, 0).toString('base64');
      const zeroPointSig = ctx.crypto.signE2eeSignedPrekeyBase64(zeroPointPub, edKeys.privateKeyBase64);
      const lowOrderBundle = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'establishX3dh',
        payload: {
          bundle: {
            user_id: bob.userId,
            device_id: 'low_order_dev',
            identity_key: ik.publicKeyBase64,
            identity_signing_key: edKeys.publicKeyBase64,
            signed_prekey: {
              key_id: 1,
              public_key: zeroPointPub,
              signature: zeroPointSig,
              created_at_ms: Date.now(),
            },
          },
        },
        expectOk: false,
      });
      assert.equal(lowOrderBundle.errorCode, 'E2EE_ERROR', 'Client X3DH must reject all-zero low-order X25519 key');
    },
  }),

  defineTest({
    id: 'T2-F12-03-otpk-concurrent-single-use-exhaustion-and-spk-fallback',
    name: 'F12 Boundary: Concurrent prekey bundle fetches enforce atomic single-use OTPK consumption and fall back cleanly to 3-DH signed prekey when exhausted',
    tier: 2,
    features: ['F12'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeBoundDevice(ctx, 'f12_t2_03_alice', 'alice_f12_b3', null);
      const bob = await registerE2eeBoundDevice(ctx, 'f12_t2_03_bob', 'bob_f12_b3', null);

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 4 },
        expectOk: true,
      });
      await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 3 },
        expectOk: true,
      });

      const concurrentFetches = await Promise.all(
        Array.from({ length: 6 }, () =>
          ctx.http.get(`/api/v1/e2ee/devices/${bob.userId}/prekeys`, { token: alice.token }),
        ),
      );
      const poppedIds = [];
      let exhaustedBundles = 0;
      for (const res of concurrentFetches) {
        assert.httpStatus(res, 200, 'concurrent bundle fetch');
        const otpk = res.json?.devices?.[0]?.one_time_prekey;
        if (otpk) {
          poppedIds.push(otpk.key_id);
        } else {
          exhaustedBundles += 1;
        }
      }
      assert.equal(poppedIds.length, 3, 'Exactly 3 of 6 concurrent fetches must receive OTPKs');
      assert.equal(new Set(poppedIds).size, 3, 'All 3 consumed OTPK key_ids must be distinct (zero double-spend)');
      assert.equal(exhaustedBundles, 3, 'Remaining 3 fetches must omit one_time_prekey cleanly');

      const countZero = await ctx.http.get('/api/v1/e2ee/prekeys/count', {
        token: bob.token,
        query: { device_id: bob.deviceId },
      });
      assert.httpStatus(countZero, 200, 'exhausted prekey count');
      assert.equal(countZero.json?.remaining_one_time_prekeys, 0, 'OTPK count must reach 0');

      const fallbackEnc = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'encryptDirect',
        payload: {
          recipientUserId: bob.userId,
          plaintext: '3-DH SPK-only fallback message after OTPK exhaustion',
          send: false,
        },
        expectOk: true,
      });
      const ct = fallbackEnc.data.envelope.kind.payload.recipients[0];
      assert.equal(ct.used_one_time_prekey_id ?? null, null, 'Exhausted fallback must omit used_one_time_prekey_id');

      const fallbackDec = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: fallbackEnc.data.envelope },
        expectOk: true,
      });
      assert.equal(
        fallbackDec.data?.plaintext,
        '3-DH SPK-only fallback message after OTPK exhaustion',
        'Responder must decrypt 3-DH SPK-only fallback handshake cleanly',
      );
    },
  }),

  defineTest({
    id: 'T2-F12-04-double-ratchet-out-of-order-skipped-keys-and-max-skip-cap',
    name: 'F12 Boundary: Out-of-order Double Ratchet messages decrypt via skipped-key cache while msg_num jumps exceeding MAX_SKIP (256) are rejected',
    tier: 2,
    features: ['F12'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeBoundDevice(ctx, 'f12_t2_04_alice', 'alice_f12_b4', null);
      const bob = await registerE2eeBoundDevice(ctx, 'f12_t2_04_bob', 'bob_f12_b4', null);

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 6 },
        expectOk: true,
      });
      await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 6 },
        expectOk: true,
      });

      const payloads = [
        { plaintextBase64: '', expected: '' },
        { plaintext: 'Seq #1 alpha', expected: 'Seq #1 alpha' },
        { plaintext: 'Seq #2 鸿蒙加密', expected: 'Seq #2 鸿蒙加密' },
        { plaintext: 'Seq #3 delta', expected: 'Seq #3 delta' },
      ];
      const envelopes = [];
      for (const item of payloads) {
        const reqPayload =
          item.plaintextBase64 !== undefined
            ? { recipientUserId: bob.userId, plaintextBase64: item.plaintextBase64, send: false }
            : { recipientUserId: bob.userId, plaintext: item.plaintext, send: false };
        const enc = await invokeEngine(ctx, {
          sandbox: alice.sandbox,
          domain: 'e2ee',
          action: 'encryptDirect',
          payload: reqPayload,
          expectOk: true,
        });
        envelopes.push(enc.data.envelope);
      }

      const maxSkipForged = structuredClone(envelopes[0]);
      maxSkipForged.kind.payload.recipients[0].header.msg_num = 300;
      const skipErr = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: maxSkipForged },
        expectOk: false,
      });
      assert.equal(skipErr.errorCode, 'E2EE_ERROR', 'msg_num=300 (> MAX_SKIP=256) must be rejected');

      for (const idx of [3, 1, 0, 2]) {
        const dec = await invokeEngine(ctx, {
          sandbox: bob.sandbox,
          domain: 'e2ee',
          action: 'decryptDirect',
          payload: { envelope: envelopes[idx] },
          expectOk: true,
        });
        assert.equal(
          dec.data?.plaintext,
          payloads[idx].expected,
          `Out-of-order message #${idx} must decrypt cleanly from skipped-key cache`,
        );
      }

      const replaySkipped = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: envelopes[1] },
        expectOk: false,
      });
      assert.equal(replaySkipped.errorCode, 'E2EE_ERROR', 'Consumed skipped key must reject second replay');
    },
  }),

  defineTest({
    id: 'T2-F12-05-group-sender-key-stale-epoch-unknown-key-tamper-and-member-removal',
    name: 'F12 Boundary: GroupSenderKey rejects unknown sender keys, stale chain_id epochs, tampered Ed25519 signatures, and removed group members',
    tier: 2,
    features: ['F12'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeBoundDevice(ctx, 'f12_t2_05_alice', 'alice_f12_b5', null);
      const bob = await registerE2eeBoundDevice(ctx, 'f12_t2_05_bob', 'bob_f12_b5', null);
      const charlie = await registerE2eeBoundDevice(ctx, 'f12_t2_05_charlie', 'charlie_f12_b5', null);

      for (const peer of [alice, bob, charlie]) {
        await ctx.cli.invoke({
          sandbox: peer.sandbox,
          domain: 'e2ee',
          action: 'uploadPrekeys',
          payload: { count: 6 },
          expectOk: true,
        });
      }

      const grp = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'F12 SenderKey Boundary', chatType: 'group', memberIds: [bob.userId, charlie.userId] },
        expectOk: true,
      });
      const chatId = Number(grp.data?.chat_id ?? grp.data?.id);

      const g0 = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'encryptGroup',
        payload: {
          chatId,
          memberUserIds: [alice.userId, bob.userId, charlie.userId],
          plaintext: 'Epoch 1 group secret',
          send: false,
        },
        expectOk: true,
      });

      const missingKeyErr = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptGroup',
        payload: { envelope: g0.data.envelope },
        expectOk: false,
      });
      assert.equal(missingKeyErr.errorCode, 'E2EE_ERROR', 'Decrypting before SenderKeyDistribution must fail');

      await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: g0.data.distributionEnvelope },
        expectOk: true,
      });

      const wrongEpochEnv = structuredClone(g0.data.envelope);
      wrongEpochEnv.kind.payload.chain_id = (wrongEpochEnv.kind.payload.chain_id ^ 0xffff) >>> 0;
      const staleEpochRes = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptGroup',
        payload: { envelope: wrongEpochEnv },
        expectOk: false,
      });
      assert.equal(staleEpochRes.errorCode, 'E2EE_ERROR', 'Mismatched chain_id epoch must fail decryption');

      const badSigEnv = structuredClone(g0.data.envelope);
      badSigEnv.kind.payload.signature = flipBase64Bit(badSigEnv.kind.payload.signature);
      const badSigRes = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptGroup',
        payload: { envelope: badSigEnv },
        expectOk: false,
      });
      assert.equal(badSigRes.errorCode, 'E2EE_ERROR', 'Tampered Ed25519 group signature must fail');

      const okGroupDec = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptGroup',
        payload: { envelope: g0.data.envelope },
        expectOk: true,
      });
      assert.equal(okGroupDec.data?.plaintext, 'Epoch 1 group secret', 'Valid group envelope must decrypt');

      const replayGroupRes = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptGroup',
        payload: { envelope: g0.data.envelope },
        expectOk: false,
      });
      assert.equal(replayGroupRes.errorCode, 'E2EE_ERROR', 'Duplicate group iteration replay must fail');

      const aliceRotated = await registerE2eeBoundDevice(ctx, 'f12_t2_05_alice_rot', 'alice_f12_b5', {
        username: alice.username,
        password: alice.password,
      });
      await ctx.cli.invoke({
        sandbox: aliceRotated.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 4 },
        expectOk: true,
      });

      const postRemoval = await invokeEngine(ctx, {
        sandbox: aliceRotated.sandbox,
        domain: 'e2ee',
        action: 'encryptGroup',
        payload: {
          chatId,
          memberUserIds: [alice.userId, bob.userId],
          plaintext: 'Epoch 2 after Charlie removal',
          send: false,
        },
        expectOk: true,
      });

      const bobEpoch2 = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptGroup',
        payload: {
          distributionEnvelope: postRemoval.data.distributionEnvelope,
          envelope: postRemoval.data.envelope,
        },
        expectOk: true,
      });
      assert.equal(bobEpoch2.data?.plaintext, 'Epoch 2 after Charlie removal', 'Retained member Bob must decrypt');

      const charlieDistFail = await invokeEngine(ctx, {
        sandbox: charlie.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: postRemoval.data.distributionEnvelope },
        expectOk: false,
      });
      assert.equal(charlieDistFail.errorCode, 'E2EE_ERROR', 'Excluded Charlie must not decrypt rotated distribution');

      const charlieMsgFail = await invokeEngine(ctx, {
        sandbox: charlie.sandbox,
        domain: 'e2ee',
        action: 'decryptGroup',
        payload: { envelope: postRemoval.data.envelope },
        expectOk: false,
      });
      assert.equal(charlieMsgFail.errorCode, 'E2EE_ERROR', 'Excluded Charlie must not decrypt rotated group message');
    },
  }),

  defineTest({
    id: 'T2-F12-06-mitm-identity-key-replacement-and-server-sender-spoofing-guards',
    name: 'F12 Boundary: MITM identity key replacement triggers Safety Number mismatch and server blocks HTTP/WS EncryptedEnvelope sender spoofing',
    tier: 2,
    features: ['F12'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeBoundDevice(ctx, 'f12_t2_06_alice', 'alice_f12_b6', null);
      const bob = await registerE2eeBoundDevice(ctx, 'f12_t2_06_bob', 'bob_f12_b6', null);
      const eve = await registerE2eeBoundDevice(ctx, 'f12_t2_06_eve', 'eve_f12_b6', null);

      for (const peer of [alice, bob, eve]) {
        await ctx.cli.invoke({
          sandbox: peer.sandbox,
          domain: 'e2ee',
          action: 'uploadPrekeys',
          payload: { count: 4 },
          expectOk: true,
        });
      }

      const genuineSafety = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'computeSafetyNumber',
        payload: { remoteIdentityKeyB64: bob.identityKey },
        expectOk: true,
      });
      const mitmSafety = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'computeSafetyNumber',
        payload: { remoteIdentityKeyB64: eve.identityKey },
        expectOk: true,
      });
      assert.notEqual(
        mitmSafety.data?.numericFingerprint,
        genuineSafety.data?.numericFingerprint,
        'MITM identity key substitution must change canonical safety fingerprint',
      );

      const grp = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'F12 Anti-Spoof Chat', chatType: 'group', memberIds: [bob.userId, eve.userId] },
        expectOk: true,
      });
      const chatId = Number(grp.data?.chat_id ?? grp.data?.id);

      const aliceEnc = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'encryptDirect',
        payload: { recipientUserId: bob.userId, plaintext: 'Legitimate Alice envelope', send: false },
        expectOk: true,
      });
      const spoofedEnvelope = aliceEnc.data.envelope;

      const httpSpoof = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { content: { type: 'Encrypted', data: spoofedEnvelope } },
        { token: eve.token },
      );
      assert.httpStatus(httpSpoof, 403, 'Eve posting EncryptedEnvelope with sender_user_id=Alice must return 403');
      assert.equal(httpSpoof.json?.error, 'e2ee_sender_mismatch', 'Error code must be e2ee_sender_mismatch');

      const badVersionEnv = structuredClone(spoofedEnvelope);
      badVersionEnv.version = 2;
      const badVerRes = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { content: { type: 'Encrypted', data: badVersionEnv } },
        { token: alice.token },
      );
      assert.httpStatus(badVerRes, 400, 'EncryptedEnvelope version != 1 must return HTTP 400');
      assert.equal(badVerRes.json?.error, 'invalid_e2ee_version', 'Error code must be invalid_e2ee_version');

      const emptyRecipsEnv = structuredClone(spoofedEnvelope);
      emptyRecipsEnv.kind.payload.recipients = [];
      const emptyRecipsRes = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { content: { type: 'Encrypted', data: emptyRecipsEnv } },
        { token: alice.token },
      );
      assert.httpStatus(emptyRecipsRes, 400, 'Empty PairwiseFanout recipients must return HTTP 400');

      const eveWs = await ctx.connectWs(eve.token);
      await eveWs.sendFrame('SendMessage', {
        chat_id: chatId,
        content: { type: 'Encrypted', data: spoofedEnvelope },
      });
      const wsErr = await eveWs.waitForFrame((f) => f.type === 'Error', 8_000);
      assert.oneOf(
        Number(wsErr.payload?.code),
        [400, 403],
        'WebSocket SendMessage spoofing sender_user_id must be rejected with Error frame (400/403)',
      );

      const postSpoofHist = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, { token: alice.token });
      assert.httpStatus(postSpoofHist, 200, 'chat history after spoof attempts');
      assert.equal(
        postSpoofHist.json?.messages?.length,
        0,
        'Zero spoofed or malformed EncryptedEnvelope messages may enter chat history',
      );
    },
  }),
];

export default tests;
