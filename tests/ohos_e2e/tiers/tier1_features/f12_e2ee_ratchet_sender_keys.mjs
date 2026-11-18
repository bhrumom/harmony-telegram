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

async function registerE2eeDevice(ctx, label, usernamePrefix, existingCreds) {
  const sandbox = ctx.createClientSandbox(label);
  const password = existingCreds?.password ?? 'E2eeRatchet#2026!';
  const username =
    existingCreds?.username ??
    `${usernamePrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  const authRes = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: existingCreds ? 'loginPassword' : 'registerPassword',
    payload: existingCreds
      ? { username, password }
      : { username, password, displayName: usernamePrefix.toUpperCase() },
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
  assert.isNonEmptyString(idRes.data?.deviceId, `${label} deviceId must be initialized`);
  assert.isNonEmptyString(idRes.data?.x25519PublicKeyB64, `${label} X25519 identity pubkey must exist`);
  assert.isNonEmptyString(idRes.data?.ed25519PublicKeyB64, `${label} Ed25519 signing pubkey must exist`);

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

export const tests = [
  defineTest({
    id: 'T1-F12-01-identity-prekey-bundle-upload-and-ed25519-spk-verification',
    name: 'F12: X25519/Ed25519 identity generation, prekey bundle upload/fetch, and gpui-e2ee-spk-v1 signature verification',
    tier: 1,
    features: ['F12'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeDevice(ctx, 'f12_t1_01_alice', 'alice_f12_01', null);
      const bob = await registerE2eeDevice(ctx, 'f12_t1_01_bob', 'bob_f12_01', null);

      const repeatId = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'initIdentity',
        payload: {},
        expectOk: true,
      });
      assert.equal(repeatId.data?.deviceId, bob.deviceId, 'initIdentity must be persistent across invocations');
      assert.equal(repeatId.data?.x25519PublicKeyB64, bob.identityKey, 'X25519 identity key must persist');
      assert.equal(repeatId.data?.ed25519PublicKeyB64, bob.signingKey, 'Ed25519 signing key must persist');

      const uploadRes = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 8 },
        expectOk: true,
      });
      assert.equal(uploadRes.data?.success, true, 'uploadPrekeys must succeed');
      assert.equal(uploadRes.data?.remaining_one_time_prekeys, 8, 'Server must store 8 one-time prekeys');

      const countBefore = await ctx.http.get('/api/v1/e2ee/prekeys/count', {
        token: bob.token,
        query: { device_id: bob.deviceId },
      });
      assert.httpStatus(countBefore, 200, 'prekey count before fetch');
      assert.equal(countBefore.json?.remaining_one_time_prekeys, 8, 'Prekey count must be 8');
      assert.equal(countBefore.json?.has_signed_prekey, true, 'has_signed_prekey must be true');

      const bundleRes = await ctx.http.get(`/api/v1/e2ee/devices/${bob.userId}/prekeys`, {
        token: alice.token,
      });
      assert.httpStatus(bundleRes, 200, 'fetch Bob prekey bundle');
      const dev = bundleRes.json?.devices?.[0];
      assert.isObject(dev, 'Fetched bundle must contain Bob device');
      assert.isObject(dev.one_time_prekey, 'Bundle must pop 1 one-time prekey');

      const spkPubBytes = ctx.crypto.decodeKeyBytes(dev.signed_prekey.public_key, 32);
      const signedMsg = Buffer.concat([Buffer.from('gpui-e2ee-spk-v1', 'utf8'), spkPubBytes]);
      const sigValid = ctx.crypto.verifyEd25519(
        signedMsg,
        dev.signed_prekey.signature,
        dev.identity_signing_key,
      );
      assert.equal(sigValid, true, 'Signed prekey signature must verify against Ed25519 identity_signing_key');

      const countAfter = await ctx.http.get('/api/v1/e2ee/prekeys/count', {
        token: bob.token,
        query: { device_id: bob.deviceId },
      });
      assert.httpStatus(countAfter, 200, 'prekey count after fetch');
      assert.equal(countAfter.json?.remaining_one_time_prekeys, 7, 'Fetching bundle must decrement OTPK count to 7');

      const manualEd = ctx.crypto.generateEd25519KeyPairHex();
      const manualIk = ctx.crypto.generateX25519KeyPairHex();
      const manualSpk = ctx.crypto.generateX25519KeyPairHex();
      const manualSig = ctx.crypto.signE2eeSignedPrekeyBase64(
        manualSpk.publicKeyBase64,
        manualEd.privateKeyBase64,
      );
      const rawPubRes = await ctx.http.post(
        '/api/v1/e2ee/prekeys',
        {
          device_id: 'alice_aux_hw_key',
          device_name: 'Harmony Aux Key',
          identity_key: manualIk.publicKeyBase64,
          identity_signing_key: manualEd.publicKeyBase64,
          signed_prekey: {
            key_id: 1,
            public_key: manualSpk.publicKeyBase64,
            signature: manualSig,
            created_at_ms: Date.now(),
          },
          one_time_prekeys: [],
        },
        { token: alice.token },
      );
      assert.httpStatus(rawPubRes, 200, 'direct POST /api/v1/e2ee/prekeys with signE2eeSignedPrekeyBase64');
      assert.equal(rawPubRes.json?.success, true, 'Server must accept valid gpui-e2ee-spk-v1 signature');
    },
  }),

  defineTest({
    id: 'T1-F12-02-x3dh-session-establishment-initiator-and-responder',
    name: 'F12: X3DH initiator and responder session establishment over live prekey bundle exchange',
    tier: 1,
    features: ['F12'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeDevice(ctx, 'f12_t1_02_alice', 'alice_f12_02', null);
      const bob = await registerE2eeDevice(ctx, 'f12_t1_02_bob', 'bob_f12_02', null);

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

      const fetched = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'fetchPrekeyBundle',
        payload: { userId: bob.userId },
        expectOk: true,
      });
      const bobBundle = fetched.data?.devices?.[0];
      assert.isObject(bobBundle, 'fetchPrekeyBundle must return Bob bundle');

      const x3dhRes = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'establishX3dh',
        payload: { bundle: bobBundle },
        expectOk: true,
      });
      assert.equal(x3dhRes.data?.established, true, 'establishX3dh must return established=true');
      assert.equal(Number(x3dhRes.data?.peerUserId), bob.userId, 'peerUserId must match Bob');
      assert.equal(x3dhRes.data?.peerDeviceId, bob.deviceId, 'peerDeviceId must match Bob');
      assert.greaterThan(Number(x3dhRes.data?.signedPrekeyId), 0, 'signedPrekeyId must be recorded');
      assert.greaterThan(Number(x3dhRes.data?.usedOneTimePrekeyId), 0, '4-DH handshake must record OTPK ID');

      const enc = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'encryptDirect',
        payload: {
          recipientUserId: bob.userId,
          plaintext: 'Handshake initial payload over X3DH + Double Ratchet',
          send: false,
        },
        expectOk: true,
      });
      const env = enc.data?.envelope;
      assert.equal(env?.version, 1, 'EncryptedEnvelope version must equal 1');
      assert.equal(env?.kind?.kind, 'PairwiseFanout', 'Direct message must use PairwiseFanout');
      const ctForBob = env.kind.payload.recipients.find((r) => r.recipient_device_id === bob.deviceId);
      assert.isNonEmptyString(ctForBob?.ephemeral_key, 'Initial X3DH message must carry ephemeral_key');

      const dec = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: env },
        expectOk: true,
      });
      assert.equal(
        dec.data?.plaintext,
        'Handshake initial payload over X3DH + Double Ratchet',
        'Responder must derive identical X3DH root key and decrypt initial message',
      );
      assert.equal(
        dec.data?.byteLength,
        Buffer.byteLength('Handshake initial payload over X3DH + Double Ratchet'),
        'Decrypted byteLength must match UTF-8 plaintext byte count',
      );
    },
  }),

  defineTest({
    id: 'T1-F12-03-double-ratchet-bidirectional-exchange-ws-and-zero-knowledge',
    name: 'F12: 1:1 Double Ratchet multi-turn bidirectional exchange over live server/WS with zero-knowledge search indexing',
    tier: 1,
    features: ['F12'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeDevice(ctx, 'f12_t1_03_alice', 'alice_f12_03', null);
      const bob = await registerE2eeDevice(ctx, 'f12_t1_03_bob', 'bob_f12_03', null);

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 8 },
        expectOk: true,
      });
      await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 8 },
        expectOk: true,
      });

      const dmChatRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'E2EE Direct', chatType: 'direct', memberIds: [bob.userId] },
        expectOk: true,
      });
      const chatId = Number(dmChatRes.data?.chat_id ?? dmChatRes.data?.id);

      const bobWs = await ctx.connectWs(bob.token);
      await bobWs.subscribeChat(chatId);
      bobWs.clearBuffer();

      const secretMarker = `ZK_RATCHET_SECRET_${Date.now()}`;
      const sentDm = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'sendEncryptedDm',
        payload: {
          chatId,
          recipientUserId: bob.userId,
          plaintext: `Confidential turn 1: ${secretMarker}`,
        },
        expectOk: true,
      });
      assert.equal(sentDm.data?.sent?.text, '[Encrypted message]', 'Server response text must mask ciphertext');

      const wsFrame = await bobWs.waitForFrame(
        (f) =>
          f.type === 'PtsPush' &&
          Number(f.payload?.chat_id) === chatId &&
          f.payload?.event?.type === 'NewMessage',
        8_000,
      );
      const wsEnvelope = wsFrame.payload?.event?.data?.content?.data;
      assert.equal(wsFrame.payload?.event?.data?.content?.type, 'Encrypted', 'WS push content.type must be Encrypted');
      const aliceDh1 = wsEnvelope.kind.payload.recipients.find((r) => r.recipient_device_id === bob.deviceId)?.header
        ?.dh_pub;

      const bobDec1 = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: wsEnvelope },
        expectOk: true,
      });
      assert.equal(bobDec1.data?.plaintext, `Confidential turn 1: ${secretMarker}`, 'Bob must decrypt WS envelope');

      const histRes = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, { token: bob.token });
      assert.httpStatus(histRes, 200, 'encrypted chat history');
      assert.equal(histRes.json.messages[0]?.text, '[Encrypted message]', 'History must never leak plaintext');

      const searchRes = await ctx.http.get('/api/v1/search', {
        token: alice.token,
        query: { q: secretMarker },
      });
      assert.httpStatus(searchRes, 200, 'zero-knowledge search');
      const msgHits = searchRes.json?.messages ?? searchRes.json?.results ?? [];
      assert.equal(msgHits.length, 0, 'Server search index must have 0 hits for E2EE secret marker');

      const bobReply = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'encryptDirect',
        payload: {
          recipientUserId: alice.userId,
          plaintext: 'Bob turn 2 reply advancing DH ratchet',
          send: false,
        },
        expectOk: true,
      });
      const aliceDec2 = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: bobReply.data.envelope },
        expectOk: true,
      });
      assert.equal(aliceDec2.data?.plaintext, 'Bob turn 2 reply advancing DH ratchet', 'Alice must decrypt Bob reply');

      const aliceTurn3 = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'encryptDirect',
        payload: {
          recipientUserId: bob.userId,
          plaintext: 'Alice turn 3 with rotated DH ratchet key',
          send: false,
        },
        expectOk: true,
      });
      const ctTurn3 = aliceTurn3.data.envelope.kind.payload.recipients.find(
        (r) => r.recipient_device_id === bob.deviceId,
      );
      assert.notEqual(ctTurn3?.header?.dh_pub, aliceDh1, 'Ping-pong turn must rotate Alice DH ratchet public key');
      assert.equal(ctTurn3?.ephemeral_key ?? null, null, 'Post-ratchet turn must clear X3DH ephemeral_key');

      const bobDec3 = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'decryptDirect',
        payload: { envelope: aliceTurn3.data.envelope },
        expectOk: true,
      });
      assert.equal(bobDec3.data?.plaintext, 'Alice turn 3 with rotated DH ratchet key', 'Bob must decrypt rotated turn');
    },
  }),

  defineTest({
    id: 'T1-F12-04-multi-device-pairwise-fanout-and-device-revocation',
    name: 'F12: Multi-device PairwiseFanout encrypts per-device ciphertexts across all recipient and sender companion devices',
    tier: 1,
    features: ['F12'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice1 = await registerE2eeDevice(ctx, 'f12_t1_04_alice_d1', 'alice_f12_04', null);
      const alice2 = await registerE2eeDevice(ctx, 'f12_t1_04_alice_d2', 'alice_f12_04', {
        username: alice1.username,
        password: alice1.password,
      });
      const bob1 = await registerE2eeDevice(ctx, 'f12_t1_04_bob_d1', 'bob_f12_04', null);
      const bob2 = await registerE2eeDevice(ctx, 'f12_t1_04_bob_d2', 'bob_f12_04', {
        username: bob1.username,
        password: bob1.password,
      });

      for (const dev of [alice1, alice2, bob1, bob2]) {
        await ctx.cli.invoke({
          sandbox: dev.sandbox,
          domain: 'e2ee',
          action: 'uploadPrekeys',
          payload: { count: 6 },
          expectOk: true,
        });
      }

      const fanoutEnc = await invokeEngine(ctx, {
        sandbox: alice1.sandbox,
        domain: 'e2ee',
        action: 'encryptDirect',
        payload: {
          recipientUserId: bob1.userId,
          plaintext: 'Multi-device fanout secret across tablet + phone',
          send: false,
        },
        expectOk: true,
      });
      const recipients = fanoutEnc.data?.envelope?.kind?.payload?.recipients ?? [];
      const targetDeviceIds = recipients.map((r) => r.recipient_device_id);
      assert.includes(targetDeviceIds, bob1.deviceId, 'Fanout must include bob_dev1');
      assert.includes(targetDeviceIds, bob2.deviceId, 'Fanout must include bob_dev2');
      assert.includes(targetDeviceIds, alice2.deviceId, 'Fanout must include sender companion alice_dev2');

      for (const companion of [bob1, bob2, alice2]) {
        const dec = await invokeEngine(ctx, {
          sandbox: companion.sandbox,
          domain: 'e2ee',
          action: 'decryptDirect',
          payload: { envelope: fanoutEnc.data.envelope },
          expectOk: true,
        });
        assert.equal(
          dec.data?.plaintext,
          'Multi-device fanout secret across tablet + phone',
          `Device ${companion.deviceId} must decrypt its dedicated PairwiseFanout entry`,
        );
      }

      const revokeRes = await ctx.http.del(`/api/v1/e2ee/devices/${bob2.deviceId}`, {
        token: bob1.token,
      });
      assert.httpStatus(revokeRes, 200, 'DELETE /api/v1/e2ee/devices/{bob2}');
      assert.equal(revokeRes.json?.revoked, true, 'Revoke response must confirm revoked=true');
      assert.equal(revokeRes.json?.device_id, bob2.deviceId, 'Revoked device_id must match bob2');

      const bundlesAfterRevoke = await ctx.http.get(`/api/v1/e2ee/devices/${bob1.userId}/prekeys`, {
        token: alice2.token,
      });
      assert.httpStatus(bundlesAfterRevoke, 200, 'fetch Bob bundles after bob2 revocation');
      const activeBobDevIds = (bundlesAfterRevoke.json?.devices ?? []).map((d) => d.device_id);
      assert.includes(activeBobDevIds, bob1.deviceId, 'Active bob1 must remain in published bundles');
      assert.notIncludes(activeBobDevIds, bob2.deviceId, 'Revoked bob2 must be omitted from published bundles');

      const postRevokeEnc = await invokeEngine(ctx, {
        sandbox: alice2.sandbox,
        domain: 'e2ee',
        action: 'encryptDirect',
        payload: {
          recipientUserId: bob1.userId,
          plaintext: 'Post-revocation message from fresh companion',
          send: false,
        },
        expectOk: true,
      });
      const postRevokeDevs = postRevokeEnc.data.envelope.kind.payload.recipients.map(
        (r) => r.recipient_device_id,
      );
      assert.includes(postRevokeDevs, bob1.deviceId, 'Active bob1 must receive ciphertext');
      assert.notIncludes(postRevokeDevs, bob2.deviceId, 'Revoked bob2 must be excluded from new fanout');
    },
  }),

  defineTest({
    id: 'T1-F12-05-group-sender-keys-init-encrypt-and-out-of-order-decrypt',
    name: 'F12: GroupSenderKey initialization, pairwise distribution, and multi-member out-of-order group encryption/decryption',
    tier: 1,
    features: ['F12'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeDevice(ctx, 'f12_t1_05_alice', 'alice_f12_05', null);
      const bob = await registerE2eeDevice(ctx, 'f12_t1_05_bob', 'bob_f12_05', null);
      const charlie = await registerE2eeDevice(ctx, 'f12_t1_05_charlie', 'charlie_f12_05', null);

      for (const peer of [alice, bob, charlie]) {
        await ctx.cli.invoke({
          sandbox: peer.sandbox,
          domain: 'e2ee',
          action: 'uploadPrekeys',
          payload: { count: 8 },
          expectOk: true,
        });
      }

      const grpRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'F12 E2EE Group', chatType: 'group', memberIds: [bob.userId, charlie.userId] },
        expectOk: true,
      });
      const chatId = Number(grpRes.data?.chat_id ?? grpRes.data?.id);
      const memberIds = [alice.userId, bob.userId, charlie.userId];

      const initSk = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'initGroupSenderKey',
        payload: { chatId, memberUserIds: memberIds },
        expectOk: true,
      });
      assert.equal(Number(initSk.data?.chatId), chatId, 'initGroupSenderKey chatId must match');
      assert.isObject(initSk.data?.distributionEnvelope, 'initGroupSenderKey must emit distributionEnvelope');
      assert.equal(initSk.data?.bootstrapEnvelope?.kind?.kind, 'GroupSenderKey', 'bootstrapEnvelope must be GroupSenderKey');

      const g1 = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'encryptGroup',
        payload: { chatId, memberUserIds: memberIds, plaintext: 'Group msg #1', send: false },
        expectOk: true,
      });
      const g2 = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'encryptGroup',
        payload: { chatId, memberUserIds: memberIds, plaintext: 'Group msg #2 (arrives first)', send: false },
        expectOk: true,
      });
      assert.equal(g1.data?.distributionEnvelope ?? null, null, 'Subsequent group sends must skip re-distribution');
      assert.equal(g1.data?.envelope?.kind?.payload?.iteration, 1, 'g1 iteration must equal 1');
      assert.equal(g2.data?.envelope?.kind?.payload?.iteration, 2, 'g2 iteration must equal 2');

      for (const member of [bob, charlie]) {
        const d2 = await invokeEngine(ctx, {
          sandbox: member.sandbox,
          domain: 'e2ee',
          action: 'decryptGroup',
          payload: {
            distributionEnvelope: initSk.data.distributionEnvelope,
            envelope: g2.data.envelope,
          },
          expectOk: true,
        });
        assert.equal(d2.data?.plaintext, 'Group msg #2 (arrives first)', 'Out-of-order iteration 2 must decrypt');

        const d0 = await invokeEngine(ctx, {
          sandbox: member.sandbox,
          domain: 'e2ee',
          action: 'decryptGroup',
          payload: { envelope: initSk.data.bootstrapEnvelope },
          expectOk: true,
        });
        assert.equal(d0.data?.plaintext, '__sender_key_bootstrap__', 'Skipped iteration 0 must decrypt from cache');

        const d1 = await invokeEngine(ctx, {
          sandbox: member.sandbox,
          domain: 'e2ee',
          action: 'decryptGroup',
          payload: { envelope: g1.data.envelope },
          expectOk: true,
        });
        assert.equal(d1.data?.plaintext, 'Group msg #1', 'Skipped iteration 1 must decrypt from cache');
      }
    },
  }),

  defineTest({
    id: 'T1-F12-06-safety-number-emoji-fingerprint-symmetry-and-determinism',
    name: 'F12: Safety Number 4-emoji and numeric fingerprint derivation is symmetric and deterministic across peers',
    tier: 1,
    features: ['F12'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerE2eeDevice(ctx, 'f12_t1_06_alice', 'alice_f12_06', null);
      const bob = await registerE2eeDevice(ctx, 'f12_t1_06_bob', 'bob_f12_06', null);

      await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'uploadPrekeys',
        payload: { count: 4 },
        expectOk: true,
      });

      const aliceView = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'computeSafetyNumber',
        payload: { remoteIdentityKeyB64: bob.identityKey },
        expectOk: true,
      });
      const bobView = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'e2ee',
        action: 'computeSafetyNumber',
        payload: { remoteIdentityKeyB64: alice.identityKey },
        expectOk: true,
      });

      assert.isNonEmptyString(aliceView.data?.emojis, 'Safety number must emit non-empty emoji string');
      const baseEmojiCodepoints = [...String(aliceView.data.emojis)].filter((ch) => ch.codePointAt(0) !== 0xfe0f);
      assert.equal(baseEmojiCodepoints.length, 4, 'Safety number must emit 4 verification emojis');
      assert.equal(aliceView.data?.emojis, bobView.data?.emojis, 'Alice and Bob emoji fingerprints must match');
      assert.match(
        aliceView.data?.numericFingerprint,
        /^[0-9a-f]{32}$/,
        'Canonical safety fingerprint must be a 32-hex SHA-256 prefix',
      );
      assert.equal(
        aliceView.data?.numericFingerprint,
        bobView.data?.numericFingerprint,
        'Alice and Bob canonical safety fingerprints must match symmetrically',
      );

      const aliceByUserId = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'e2ee',
        action: 'computeSafetyNumber',
        payload: { peerUserId: bob.userId },
        expectOk: true,
      });
      assert.equal(
        aliceByUserId.data?.numericFingerprint,
        aliceView.data?.numericFingerprint,
        'Server-fetched peerUserId safety number must match direct remoteIdentityKeyB64 calculation',
      );
    },
  }),
];

export default tests;
