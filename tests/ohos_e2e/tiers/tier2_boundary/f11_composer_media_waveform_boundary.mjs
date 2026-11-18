import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerMediaBoundUser(ctx, label, prefix) {
  const sandbox = ctx.createClientSandbox(label);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const username = `${prefix}_${suffix}`;
  const res = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: 'registerPassword',
    payload: { username, password: 'MediaBoundPass#2026!', displayName: prefix.toUpperCase() },
    expectOk: true,
  });
  const userId = Number(res.data?.account?.userId ?? res.data?.session?.user_id);
  const token = res.data?.account?.token ?? res.data?.session?.token;
  assert.greaterThan(userId, 0, 'userId must be positive');
  assert.isNonEmptyString(token, 'token must be non-empty');
  return { sandbox, username, userId, token };
}

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

function buildUniqueBuffer(length, tag) {
  const buf = Buffer.alloc(length);
  const header = Buffer.from(`${tag}:${Date.now()}:${Math.random()}:`, 'utf8');
  header.copy(buf, 0, 0, Math.min(header.length, length));
  for (let i = header.length; i < length; i++) {
    buf[i] = (i * 17 + 0x3d) & 0xff;
  }
  return buf;
}

export const tests = [
  defineTest({
    id: 'T2-F11-01-zero-byte-upload-and-oversized-chunk-init-rejected',
    name: 'F11 Boundary: Zero-byte direct upload, size_bytes=0 chunked init, and oversized upload init are rejected cleanly',
    tier: 2,
    features: ['F11'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaBoundUser(ctx, 'f11_t2_01_alice', 'alice_f11_b1');

      const cliEmpty = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'uploadFile',
        payload: { filename: 'empty.bin', mimeType: 'application/octet-stream', dataBase64: '' },
        expectOk: false,
      });
      assert.equal(cliEmpty.errorCode, 'VALIDATION_ERROR', 'CLI 0-byte uploadFile must fail with VALIDATION_ERROR');

      const cliZeroChunk = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'initChunkedUpload',
        payload: { totalSize: 0, filename: 'zero_chunk.bin' },
        expectOk: false,
      });
      assert.equal(
        cliZeroChunk.errorCode,
        'VALIDATION_ERROR',
        'CLI totalSize=0 initChunkedUpload must fail with VALIDATION_ERROR',
      );

      const httpEmpty = await ctx.http.post('/api/v1/media/upload', Buffer.alloc(0), {
        token: alice.token,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      assert.httpStatus(httpEmpty, 400, 'Direct 0-byte POST /api/v1/media/upload must fail with HTTP 400');

      const httpEmptyJson = await ctx.http.post(
        '/api/v1/media/upload',
        { filename: 'empty.bin', mime_type: 'application/octet-stream', data_base64: '' },
        { token: alice.token },
      );
      assert.httpStatus(httpEmptyJson, 400, 'JSON empty data_base64 upload must fail with HTTP 400');

      const httpZeroChunkSize = await ctx.http.post(
        '/api/v1/media/upload/init',
        { size_bytes: 4096, chunk_size: 0, filename: 'zero_part.bin' },
        { token: alice.token },
      );
      assert.httpStatus(httpZeroChunkSize, 400, 'chunk_size=0 chunked init must fail with HTTP 400');

      const over64Mib = Buffer.alloc(65 * 1024 * 1024, 0x55);
      const httpOversizedBody = await ctx.http.post('/api/v1/media/upload', over64Mib, {
        token: alice.token,
        headers: { 'Content-Type': 'application/octet-stream' },
        timeoutMs: 20_000,
      });
      assert.httpStatus(httpOversizedBody, 413, 'Payload >64MiB body limit must fail with HTTP 413');
    },
  }),

  defineTest({
    id: 'T2-F11-02-chunked-upload-corrupted-sha256-missing-parts-and-part-bounds',
    name: 'F11 Boundary: Chunked upload rejects out-of-bounds or wrong-sized parts, incomplete sessions, and corrupted SHA-256 checksums on complete',
    tier: 2,
    features: ['F11'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaBoundUser(ctx, 'f11_t2_02_alice', 'alice_f11_b2');

      const initTwoPart = await ctx.http.post(
        '/api/v1/media/upload/init',
        { size_bytes: 40_000, filename: 'two_part.bin', chunk_size: 32_768 },
        { token: alice.token },
      );
      assert.httpStatus(initTwoPart, 201, 'init 2-part session');
      const uploadId = initTwoPart.json?.upload_id;
      const partSize = Number(initTwoPart.json?.chunk_size);

      const prematureComplete = await ctx.http.post(
        `/api/v1/media/upload/${uploadId}/complete`,
        { filename: 'two_part.bin' },
        { token: alice.token },
      );
      assert.httpStatus(prematureComplete, 400, 'Completing session with missing parts must fail with HTTP 400');

      const oobPart = await ctx.http.put(
        `/api/v1/media/upload/${uploadId}/part/9`,
        Buffer.alloc(1024, 0x11),
        { token: alice.token, headers: { 'Content-Type': 'application/octet-stream' } },
      );
      assert.httpStatus(oobPart, 400, 'Out-of-bounds part_index >= total_parts must fail with HTTP 400');

      const wrongPartLen = await ctx.http.put(
        `/api/v1/media/upload/${uploadId}/part/0`,
        Buffer.alloc(128, 0x22),
        { token: alice.token, headers: { 'Content-Type': 'application/octet-stream' } },
      );
      assert.httpStatus(wrongPartLen, 400, `Part 0 with 128B instead of ${partSize}B must fail with HTTP 400`);

      const bogusExpectedSha = 'a'.repeat(64);
      const initCorrupt = await ctx.http.post(
        '/api/v1/media/upload/init',
        {
          size_bytes: 4096,
          filename: 'corrupt.bin',
          chunk_size: 4096,
          expected_sha256: bogusExpectedSha,
        },
        { token: alice.token },
      );
      assert.httpStatus(initCorrupt, 201, 'init checksum session');
      const corruptUploadId = initCorrupt.json?.upload_id;

      const putCorrupt = await ctx.http.put(
        `/api/v1/media/upload/${corruptUploadId}/part/0`,
        Buffer.alloc(4096, 0x7a),
        { token: alice.token, headers: { 'Content-Type': 'application/octet-stream' } },
      );
      assert.httpStatus(putCorrupt, 200, 'upload corrupted part bytes');

      const completeCorrupt = await ctx.http.post(
        `/api/v1/media/upload/${corruptUploadId}/complete`,
        { filename: 'corrupt.bin' },
        { token: alice.token },
      );
      assert.httpStatus(completeCorrupt, 400, 'Corrupted SHA-256 mismatch on complete must fail with HTTP 400');
      assert.match(
        String(completeCorrupt.json?.message ?? completeCorrupt.text),
        /sha-?256|checksum|mismatch/i,
        'Error message must diagnose SHA-256 checksum mismatch',
      );
    },
  }),

  defineTest({
    id: 'T2-F11-03-cross-user-chunk-session-hijack-and-unsafe-upload-id-rejected',
    name: 'F11 Boundary: Cross-user chunk PUT, status GET, and complete POST are rejected with HTTP 403 alongside path-traversal upload_id guards',
    tier: 2,
    features: ['F11'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaBoundUser(ctx, 'f11_t2_03_alice', 'alice_f11_b3');
      const eve = await registerMediaBoundUser(ctx, 'f11_t2_03_eve', 'eve_f11_b3');

      const initRes = await ctx.http.post(
        '/api/v1/media/upload/init',
        { size_bytes: 32_768, filename: 'alice_private_upload.bin', chunk_size: 32_768 },
        { token: alice.token },
      );
      assert.httpStatus(initRes, 201, 'Alice init upload');
      const uploadId = initRes.json?.upload_id;

      const evePut = await ctx.http.put(
        `/api/v1/media/upload/${uploadId}/part/0`,
        Buffer.alloc(32_768, 0xee),
        { token: eve.token, headers: { 'Content-Type': 'application/octet-stream' } },
      );
      assert.httpStatus(evePut, 403, 'Eve PUT onto Alice upload_id must fail with HTTP 403');

      const eveStatusHttp = await ctx.http.get(`/api/v1/media/upload/${uploadId}/status`, { token: eve.token });
      assert.httpStatus(eveStatusHttp, 403, 'Eve GET status on Alice upload_id must fail with HTTP 403');

      const eveStatusCli = await ctx.cli.invoke({
        sandbox: eve.sandbox,
        domain: 'media',
        action: 'getUploadStatus',
        payload: { uploadId },
        expectOk: false,
      });
      assert.oneOf(
        eveStatusCli.errorCode,
        ['PERMISSION_DENIED', 'FORBIDDEN'],
        'CLI cross-user getUploadStatus must fail with permission error',
      );

      const eveComplete = await ctx.http.post(
        `/api/v1/media/upload/${uploadId}/complete`,
        { filename: 'hijack.bin' },
        { token: eve.token },
      );
      assert.httpStatus(eveComplete, 403, 'Eve POST complete on Alice upload_id must fail with HTTP 403');

      const unsafeIdRes = await ctx.http.put(
        '/api/v1/media/upload/..%2F..%2Fetc%2Fpasswd/part/0',
        Buffer.alloc(64, 0x01),
        { token: alice.token, headers: { 'Content-Type': 'application/octet-stream' } },
      );
      assert.oneOf(unsafeIdRes.status, [400, 404], 'Path-traversal upload_id must be rejected with 400/404');
    },
  }),

  defineTest({
    id: 'T2-F11-04-http-416-unsatisfiable-and-400-malformed-range-headers',
    name: 'F11 Boundary: Unsatisfiable Range headers return HTTP 416 with Content-Range */total and malformed Range headers return HTTP 400',
    tier: 2,
    features: ['F11'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaBoundUser(ctx, 'f11_t2_04_alice', 'alice_f11_b4');

      const blob1024 = buildUniqueBuffer(1024, 'range_416_probe');
      const up = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'uploadFile',
        payload: {
          filename: 'probe_1024.bin',
          mimeType: 'application/octet-stream',
          dataBase64: blob1024.toString('base64'),
        },
        expectOk: true,
      });
      const fileId = up.data?.file_id;

      for (const unsatisfiable of ['bytes=9999999-', 'bytes=1024-2048', 'bytes=600-100', 'bytes=-0']) {
        const res416 = await ctx.http.get(`/api/v1/media/${fileId}`, {
          token: alice.token,
          headers: { Range: unsatisfiable },
        });
        assert.httpStatus(res416, 416, `Unsatisfiable Range '${unsatisfiable}' must return HTTP 416`);
        assert.equal(
          res416.headers['content-range'],
          'bytes */1024',
          `416 response for '${unsatisfiable}' must carry Content-Range: bytes */1024`,
        );
      }

      for (const malformed of ['items=0-10', 'bytes=abc-def', 'bytes=-']) {
        const res400 = await ctx.http.get(`/api/v1/media/${fileId}`, {
          token: alice.token,
          headers: { Range: malformed },
        });
        assert.httpStatus(res400, 400, `Malformed Range '${malformed}' must return HTTP 400`);
      }

      const cliInverted = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'downloadRange',
        payload: { fileId, start: 500, end: 100 },
        expectOk: false,
      });
      assert.equal(cliInverted.errorCode, 'VALIDATION_ERROR', 'CLI end < start downloadRange must fail validation');
    },
  }),

  defineTest({
    id: 'T2-F11-05-unauthorized-restricted-chat-media-download-rejected-403',
    name: 'F11 Boundary: Non-member download and metadata access to private chat media are rejected with HTTP 403 Forbidden',
    tier: 2,
    features: ['F11'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaBoundUser(ctx, 'f11_t2_05_alice', 'alice_f11_b5');
      const bob = await registerMediaBoundUser(ctx, 'f11_t2_05_bob', 'bob_f11_b5');
      const eve = await registerMediaBoundUser(ctx, 'f11_t2_05_eve', 'eve_f11_b5');

      const grpRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Confidential Media Room', chatType: 'group', memberIds: [bob.userId] },
        expectOk: true,
      });
      const privateChatId = Number(grpRes.data?.chat_id ?? grpRes.data?.id);

      const secretMedia = buildUniqueBuffer(4096, 'restricted_chat_media');
      const initRes = await ctx.http.post(
        '/api/v1/media/upload/init',
        { size_bytes: secretMedia.length, filename: 'confidential.bin', chunk_size: 4096 },
        { token: alice.token },
      );
      assert.httpStatus(initRes, 201, 'init scoped upload');
      const uploadId = initRes.json?.upload_id;

      await ctx.http.put(`/api/v1/media/upload/${uploadId}/part/0`, secretMedia, {
        token: alice.token,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const compRes = await ctx.http.post(
        `/api/v1/media/upload/${uploadId}/complete`,
        { filename: 'confidential.bin', mime_type: 'application/octet-stream', chat_id: privateChatId },
        { token: alice.token },
      );
      assert.httpStatus(compRes, 200, 'complete scoped upload');
      const fileId = compRes.json?.file_id;

      const bobDl = await ctx.http.get(`/api/v1/media/${fileId}`, {
        token: bob.token,
        headers: { Range: 'bytes=0-31' },
      });
      assert.httpStatus(bobDl, 206, 'Authorized chat member Bob must stream 206 range');

      const eveStream = await ctx.http.get(`/api/v1/media/${fileId}`, { token: eve.token });
      assert.httpStatus(eveStream, 403, 'Non-member Eve downloading restricted chat media must get HTTP 403');

      const eveMeta = await ctx.http.get(`/api/v1/media/${fileId}/meta`, { token: eve.token });
      assert.httpStatus(eveMeta, 403, 'Non-member Eve reading restricted media metadata must get HTTP 403');

      const eveCliRange = await ctx.cli.invoke({
        sandbox: eve.sandbox,
        domain: 'media',
        action: 'downloadRange',
        payload: { fileId, start: 0, end: 15 },
        expectOk: false,
      });
      assert.oneOf(
        eveCliRange.errorCode,
        ['PERMISSION_DENIED', 'FORBIDDEN'],
        'CLI non-member downloadRange must fail with permission error',
      );

      const unauthGet = await ctx.http.get(`/api/v1/media/${fileId}`);
      assert.httpStatus(unauthGet, 401, 'Unauthenticated media download must fail with HTTP 401');
    },
  }),

  defineTest({
    id: 'T2-F11-06-waveform-zero-byte-short-pcm-saturation-and-editor-bounds',
    name: 'F11 Boundary: 5-bit waveform handles 0-byte, odd-byte, short PCM, and full-scale saturation while MediaEditor rejects out-of-bounds crops',
    tier: 2,
    features: ['F11'],
    timeoutMs: 30_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const alice = await registerMediaBoundUser(ctx, 'f11_t2_06_alice', 'alice_f11_b6');

      for (const byteLen of [0, 1]) {
        const tiny = Buffer.alloc(byteLen, 0xff);
        const enc = await invokeEngine(ctx, {
          sandbox: alice.sandbox,
          domain: 'media',
          action: 'encodeWaveform5Bit',
          payload: { pcmBase64: tiny.toString('base64') },
          expectOk: true,
        });
        assert.equal(enc.data?.byteLength, 63, `${byteLen}-byte PCM must encode to 63 zero-padded bytes`);
        const dec = await invokeEngine(ctx, {
          sandbox: alice.sandbox,
          domain: 'media',
          action: 'decodeWaveform5Bit',
          payload: { packedBase64: enc.data.packedBase64 },
          expectOk: true,
        });
        assert.equal(dec.data?.bars?.length, 100, `${byteLen}-byte decoded waveform must have 100 zero bars`);
      }

      const shortTenSamples = Buffer.alloc(20);
      for (let i = 0; i < 10; i++) {
        shortTenSamples.writeInt16LE(i % 2 === 0 ? 32767 : -32768, i * 2);
      }
      const uiShort = await ctx.cli.uiSession({
        sandbox: alice.sandbox,
        serverUrl: server.baseUrl,
        script: {
          steps: [
            { op: 'sleepMs', ms: 8 },
            { op: 'encodeWaveform5Bit', pcmBase64: shortTenSamples.toString('base64') },
          ],
        },
        expectOk: true,
      });
      const shortPackedB64 = uiShort.data?.stepResults?.[1]?.packedBase64;
      assert.isNonEmptyString(shortPackedB64, '10-sample saturated PCM must encode without panic');

      const uiDecShort = await ctx.cli.uiSession({
        sandbox: alice.sandbox,
        serverUrl: server.baseUrl,
        script: {
          steps: [
            { op: 'sleepMs', ms: 8 },
            { op: 'decodeWaveform5Bit', packedBase64: shortPackedB64 },
          ],
        },
        expectOk: true,
      });
      const floats = uiDecShort.data?.stepResults?.[1]?.bars ?? [];
      assert.equal(floats.length, 100, 'Short packed waveform decode must pad to 100 normalized bars');
      for (const v of floats) {
        assert.between(v, 0.0, 1.0, 'Saturated [-32768, 32767] bars must stay clamped within [0.0, 1.0]');
      }

      const emptyVoice = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'recordVoicePcm',
        payload: { pcmBase64: '' },
        expectOk: false,
      });
      assert.equal(emptyVoice.errorCode, 'VALIDATION_ERROR', 'Empty recordVoicePcm must fail with VALIDATION_ERROR');

      const oobCrop = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'editMedia',
        payload: {
          sourceWidth: 100,
          sourceHeight: 100,
          crop: { x: 50, y: 50, width: 80, height: 80 },
        },
        expectOk: false,
      });
      assert.equal(oobCrop.errorCode, 'VALIDATION_ERROR', 'Out-of-bounds crop rectangle must fail validation');

      const badRotate = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'editMedia',
        payload: { sourceWidth: 64, sourceHeight: 64, rotateDegrees: 45 },
        expectOk: false,
      });
      assert.equal(badRotate.errorCode, 'VALIDATION_ERROR', 'Unsupported rotateDegrees=45 must fail validation');
    },
  }),
];

export default tests;
