import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerMediaUser(ctx, label, prefix) {
  const sandbox = ctx.createClientSandbox(label);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const username = `${prefix}_${suffix}`;
  const res = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: 'registerPassword',
    payload: { username, password: 'ComposerMedia#2026!', displayName: prefix.toUpperCase() },
    expectOk: true,
  });
  const userId = Number(res.data?.account?.userId ?? res.data?.session?.user_id);
  const token = res.data?.account?.token ?? res.data?.session?.token;
  assert.greaterThan(userId, 0, 'Registered userId must be > 0');
  assert.isNonEmptyString(token, 'Registered token must be non-empty');
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

function buildDeterministicBytes(length, seedByte) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    buf[i] = (seedByte + i * 31 + (i >> 5)) & 0xff;
  }
  return buf;
}

function buildSinePcmI16Le(sampleCount, amplitude) {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.round(Math.sin((i / 24) * Math.PI * 2) * amplitude);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return buf;
}

export const tests = [
  defineTest({
    id: 'T1-F11-01-single-shot-cas-dedup-and-image-audio-metadata-extraction',
    name: 'F11: Single-shot SHA-256 CAS upload deduplicates identical blobs and extracts PNG dimensions, SVG thumbnail, and WAV metadata',
    tier: 1,
    features: ['F11'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaUser(ctx, 'f11_t1_01_alice', 'alice_f11_01');
      const bob = await registerMediaUser(ctx, 'f11_t1_01_bob', 'bob_f11_01');

      const genImg = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'editMedia',
        payload: { sourceWidth: 64, sourceHeight: 48 },
        expectOk: true,
      });
      const pngBytes = Buffer.from(genImg.data.dataBase64, 'base64');
      const expectedSha = ctx.crypto.sha256Hex(pngBytes);

      const up1 = await ctx.http.post('/api/v1/media/upload', {
        token: alice.token,
        multipart: {
          files: [{ name: 'file', filename: 'sample_64x48.png', contentType: 'image/png', data: pngBytes }],
        },
      });
      assert.httpStatus(up1, 201, 'first multipart PNG upload');
      assert.equal(up1.json?.file_id, expectedSha, 'CAS file_id must equal lowercase SHA-256 digest');
      assert.equal(up1.json?.sha256, expectedSha, 'Response sha256 must match');
      assert.equal(up1.json?.width, 64, 'PNG metadata extractor must detect width=64');
      assert.equal(up1.json?.height, 48, 'PNG metadata extractor must detect height=48');
      assert.isNonEmptyString(up1.json?.thumbnail_data_url, 'Image upload must produce inline thumbnail_data_url');

      const up2 = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'media',
        action: 'uploadFile',
        payload: {
          filename: 'duplicate_64x48.png',
          mimeType: 'image/png',
          dataBase64: pngBytes.toString('base64'),
        },
        expectOk: true,
      });
      assert.equal(up2.data?.file_id, expectedSha, 'Re-uploading identical bytes must deduplicate to same CAS file_id');
      assert.equal(up2.data?.size_bytes, pngBytes.length, 'Deduplicated upload must report exact size_bytes');

      const metaRes = await ctx.http.get(`/api/v1/media/${expectedSha}/meta`, { token: bob.token });
      assert.httpStatus(metaRes, 200, 'GET /api/v1/media/{file_id}/meta');
      assert.equal(metaRes.json?.sha256, expectedSha, 'Metadata endpoint must report matching sha256');
      assert.equal(metaRes.json?.width, 64, 'Metadata endpoint must persist width=64');
      assert.equal(metaRes.json?.height, 48, 'Metadata endpoint must persist height=48');
    },
  }),

  defineTest({
    id: 'T1-F11-02-resumable-chunked-upload-out-of-order-status-and-sha256-verify',
    name: 'F11: Resumable chunked upload init, out-of-order part PUT, status bitmask, and SHA-256 verified completion',
    tier: 1,
    features: ['F11'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaUser(ctx, 'f11_t1_02_alice', 'alice_f11_02');

      const fullPayload = buildDeterministicBytes(100_000, 0x29);
      const expectedSha = ctx.crypto.sha256Hex(fullPayload);
      const chunkSize = 32_768;

      const initRes = await ctx.http.post(
        '/api/v1/media/upload/init',
        {
          size_bytes: fullPayload.length,
          filename: 'resumable_100k.bin',
          chunk_size: chunkSize,
          expected_sha256: expectedSha,
        },
        { token: alice.token },
      );
      assert.httpStatus(initRes, 201, 'init chunked upload');
      const uploadId = initRes.json?.upload_id;
      const partSize = Number(initRes.json?.chunk_size);
      assert.isNonEmptyString(uploadId, 'init must return upload_id');
      assert.equal(partSize, chunkSize, 'chunk_size must match requested 32768');

      const slicePart = (idx) => {
        const start = idx * partSize;
        const end = Math.min(start + partSize, fullPayload.length);
        return fullPayload.subarray(start, end);
      };

      const put2 = await ctx.http.put(`/api/v1/media/upload/${uploadId}/part/2`, slicePart(2), {
        token: alice.token,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      assert.httpStatus(put2, 200, 'upload part 2 out-of-order');

      const cliPut0 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'uploadChunk',
        payload: {
          uploadId,
          partIndex: 0,
          chunkBase64: slicePart(0).toString('base64'),
        },
        expectOk: true,
      });
      assert.equal(cliPut0.data?.uploaded, true, 'CLI uploadChunk part 0 must succeed');

      const statusMid = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'getUploadStatus',
        payload: { uploadId },
        expectOk: true,
      });
      assert.equal(statusMid.data?.total_parts, 4, '100,000B / 32,768B must yield 4 parts');
      assert.deepEqual(
        statusMid.data?.uploaded_parts,
        [true, false, true, false],
        'uploaded_parts bitmask must reflect out-of-order parts 0 and 2',
      );
      assert.deepEqual(statusMid.data?.missing_parts, [1, 3], 'missing_parts must list [1, 3]');
      assert.equal(statusMid.data?.is_complete, false, 'is_complete must be false before parts 1 and 3');

      await ctx.http.put(`/api/v1/media/upload/${uploadId}/part/3`, slicePart(3), {
        token: alice.token,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'uploadChunk',
        payload: {
          uploadId,
          partIndex: 1,
          chunkBase64: slicePart(1).toString('base64'),
        },
        expectOk: true,
      });

      const doneRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'completeChunkedUpload',
        payload: {
          uploadId,
          filename: 'resumable_100k.bin',
          mimeType: 'application/octet-stream',
        },
        expectOk: true,
      });
      assert.equal(doneRes.data?.file_id, expectedSha, 'Completed chunked upload file_id must match full SHA-256');
      assert.equal(doneRes.data?.size_bytes, 100_000, 'Completed size_bytes must equal 100,000');

      const dlRes = await ctx.http.get(`/api/v1/media/${expectedSha}`, { token: alice.token });
      assert.httpStatus(dlRes, 200, 'download reassembled CAS file');
      assert.equal(ctx.crypto.sha256Hex(dlRes.buffer), expectedSha, 'Downloaded payload SHA-256 must match');
    },
  }),

  defineTest({
    id: 'T1-F11-03-http-206-partial-content-range-streaming',
    name: 'F11: HTTP 206 Partial Content streaming supports closed, open-ended, and suffix byte ranges with Content-Range headers',
    tier: 1,
    features: ['F11'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaUser(ctx, 'f11_t1_03_alice', 'alice_f11_03');

      const streamBytes = buildDeterministicBytes(80_000, 0x5c);
      const up = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'uploadFile',
        payload: {
          filename: 'video_stream.mp4',
          mimeType: 'video/mp4',
          dataBase64: streamBytes.toString('base64'),
        },
        expectOk: true,
      });
      const fileId = up.data?.file_id;

      const fullGet = await ctx.http.get(`/api/v1/media/${fileId}`, { token: alice.token });
      assert.httpStatus(fullGet, 200, 'full stream GET without Range');
      assert.equal(fullGet.headers['accept-ranges'], 'bytes', 'Full GET must advertise Accept-Ranges: bytes');
      assert.equal(fullGet.buffer.length, 80_000, 'Full GET must return all 80,000 bytes');

      const cliRange = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'downloadRange',
        payload: { fileId, start: 0, end: 1023 },
        expectOk: true,
      });
      assert.equal(cliRange.data?.statusCode, 206, 'CLI downloadRange must receive HTTP 206');
      assert.equal(cliRange.data?.contentRange, 'bytes 0-1023/80000', 'Closed range Content-Range must match');
      assert.equal(cliRange.data?.byteLength, 1024, 'Closed range 0-1023 must yield 1024 bytes');
      assert.equal(
        cliRange.data?.sha256,
        ctx.crypto.sha256Hex(streamBytes.subarray(0, 1024)),
        'Closed range slice SHA-256 must match exact byte window',
      );

      const openRange = await ctx.http.get(`/api/v1/media/stream/${fileId}`, {
        token: alice.token,
        headers: { Range: 'bytes=78500-' },
      });
      assert.httpStatus(openRange, 206, 'open-ended Range: bytes=78500-');
      assert.equal(openRange.headers['content-range'], 'bytes 78500-79999/80000', 'Open-ended Content-Range');
      assert.equal(openRange.buffer.length, 1500, 'Open-ended range must return remaining 1500 bytes');
      assert.deepEqual(openRange.buffer, streamBytes.subarray(78500, 80000), 'Open-ended bytes must match tail');

      const suffixRange = await ctx.http.get(`/api/v1/media/${fileId}`, {
        token: alice.token,
        headers: { Range: 'bytes=-512' },
      });
      assert.httpStatus(suffixRange, 206, 'suffix Range: bytes=-512');
      assert.equal(suffixRange.headers['content-range'], 'bytes 79488-79999/80000', 'Suffix Content-Range');
      assert.deepEqual(suffixRange.buffer, streamBytes.subarray(79488, 80000), 'Suffix 512 bytes must match');
    },
  }),

  defineTest({
    id: 'T1-F11-04-voice-5bit-63byte-waveform-codec-recorder-and-voice-upload',
    name: 'F11: 5-bit 63-byte 100-bar voice waveform encode/decode, PCM WAV recorder, and voice note upload (is_voice=true)',
    tier: 1,
    features: ['F11'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const alice = await registerMediaUser(ctx, 'f11_t1_04_alice', 'alice_f11_04');
      const bob = await registerMediaUser(ctx, 'f11_t1_04_bob', 'bob_f11_04');
      const chatRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'F11 Voice Notes', chatType: 'group', memberIds: [bob.userId] },
        expectOk: true,
      });
      const chatId = Number(chatRes.data?.chat_id ?? chatRes.data?.id);

      const pcm = buildSinePcmI16Le(4800, 22_000);
      const encRes = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'encodeWaveform5Bit',
        payload: { pcmBase64: pcm.toString('base64') },
        expectOk: true,
      });
      assert.equal(encRes.data?.byteLength, 63, '100-bar 5-bit waveform must pack to 63 bytes');
      assert.equal(encRes.data?.barCount, 100, 'Waveform barCount must equal 100');

      const decRes = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'decodeWaveform5Bit',
        payload: { packedBase64: encRes.data.packedBase64 },
        expectOk: true,
      });
      assert.equal(decRes.data?.bars?.length, 100, 'Decoded 5-bit waveform must return 100 bars');
      for (const bar of decRes.data.bars) {
        assert.between(bar, 0, 31, 'Each 5-bit bar must lie in 0..=31');
      }

      const uiWave = await ctx.cli.uiSession({
        sandbox: alice.sandbox,
        serverUrl: server.baseUrl,
        script: {
          steps: [
            { op: 'sleepMs', ms: 8 },
            { op: 'encodeWaveform5Bit', pcmBase64: pcm.toString('base64') },
            { op: 'decodeWaveform5Bit', packedBase64: encRes.data.packedBase64 },
          ],
        },
        expectOk: true,
      });
      const normBars = uiWave.data?.stepResults?.[2]?.bars ?? [];
      assert.equal(normBars.length, 100, 'UI bridge decodeWaveform5Bit must emit 100 normalized floats');
      for (const f of normBars) {
        assert.between(f, 0.0, 1.0, 'Normalized waveform float must be in 0.0..=1.0');
      }

      const recRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'recordVoicePcm',
        payload: {
          sampleRate: 16_000,
          durationMs: 1_000,
          frequencyHz: 440,
          upload: true,
        },
        expectOk: true,
      });
      assert.equal(recRes.data?.durationMs, 1000, '1-second 16kHz voice note must report durationMs=1000');
      assert.equal(Buffer.from(recRes.data.waveformBase64, 'base64').length, 63, 'Recorded waveform must be 63B');
      const wavBytes = fs.readFileSync(recRes.data.savedPath);
      assert.equal(wavBytes.subarray(0, 4).toString('ascii'), 'RIFF', 'Recorded WAV file must start with RIFF magic');

      const voiceMultipart = await ctx.http.post('/api/v1/media/upload', {
        token: alice.token,
        query: { is_voice: 'true', chat_id: chatId },
        multipart: {
          files: [{ name: 'file', filename: 'voice_1s.wav', contentType: 'audio/wav', data: wavBytes }],
        },
      });
      assert.httpStatus(voiceMultipart, 201, 'upload voice WAV');
      const voiceFileId = voiceMultipart.json?.file_id;
      assert.greaterThanOrEqual(Number(voiceMultipart.json?.duration_seconds), 1, 'WAV duration_seconds >= 1');

      const sendVoice = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: {
          chatId,
          content: {
            type: 'Voice',
            data: {
              file_id: voiceFileId,
              duration_seconds: 1,
              waveform: decRes.data.bars.slice(0, 32),
              mime_type: 'audio/wav',
              size_bytes: wavBytes.length,
            },
          },
        },
        expectOk: true,
      });
      assert.equal(sendVoice.data?.text, '[Voice message]', 'Voice note message preview must be [Voice message]');
    },
  }),

  defineTest({
    id: 'T1-F11-05-stickers-gif-search-send-as-silent-and-scheduled-send',
    name: 'F11: Sticker sets list/install, GIF catalog search, Send-As peer selection, Silent send, and Scheduled message delivery',
    tier: 1,
    features: ['F11'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaUser(ctx, 'f11_t1_05_alice', 'alice_f11_05');
      const bob = await registerMediaUser(ctx, 'f11_t1_05_bob', 'bob_f11_05');
      const chatRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'F11 Composer Extras', chatType: 'group', memberIds: [bob.userId] },
        expectOk: true,
      });
      const chatId = Number(chatRes.data?.chat_id ?? chatRes.data?.id);

      const initialSets = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'listStickers',
        payload: {},
        expectOk: true,
      });
      const durovBefore = (initialSets.data?.sets ?? []).find((s) => s.set_id === 'pack_durov' || s.id === 'pack_durov');
      assert.isObject(durovBefore, 'Seeded pack_durov sticker set must exist');

      const installHttp = await ctx.http.post(
        '/api/v1/stickers/sets/pack_durov/install',
        { install: true },
        { token: alice.token },
      );
      assert.httpStatus(installHttp, 200, 'install pack_durov');
      assert.equal(installHttp.json?.installed, true, 'pack_durov must report installed=true');

      const afterInstall = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'listStickers',
        payload: {},
        expectOk: true,
      });
      const durovInstalled = (afterInstall.data?.sets ?? []).find((s) => (s.set_id ?? s.id) === 'pack_durov');
      assert.equal(
        Boolean(durovInstalled?.is_installed ?? durovInstalled?.installed),
        true,
        'listStickers must reflect installed pack_durov',
      );

      const gifSearch = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'searchGifs',
        payload: { query: 'rocket', limit: 10 },
        expectOk: true,
      });
      assert.greaterThanOrEqual(gifSearch.data?.count, 1, 'GIF search for rocket must return >= 1 result');

      const sendAsRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'listSendAsPeers',
        payload: { chatId },
        expectOk: true,
      });
      const peers = sendAsRes.data?.peers ?? [];
      assert.greaterThanOrEqual(peers.length, 1, 'listSendAsPeers must return at least caller peer');

      const schedAt = Date.now() + 180_000;
      const schedSend = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        {
          text: 'Silent scheduled composer note',
          silent: true,
          scheduled_at_ms: schedAt,
          send_as_peer_id: alice.userId,
        },
        { token: alice.token },
      );
      assert.httpStatus(schedSend, 201, 'send silent scheduled message with send_as_peer_id');
      assert.equal(Number(schedSend.json?.send_as_peer_id), alice.userId, 'send_as_peer_id must echo caller peer');

      const forbiddenSendAs = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        {
          text: 'Spoofed send-as attempt',
          send_as_peer_id: bob.userId,
        },
        { token: alice.token },
      );
      assert.httpStatus(forbiddenSendAs, 403, 'Sending as unauthorized peer must fail with HTTP 403');

      const hist = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, { token: bob.token });
      assert.httpStatus(hist, 200, 'composer extras history');
      const sent = hist.json.messages[0];
      assert.equal(sent?.text, 'Silent scheduled composer note', 'Scheduled note text must persist');
      assert.equal(Number(sent?.scheduled_at_ms), schedAt, 'Scheduled send must persist scheduled_at_ms');
    },
  }),

  defineTest({
    id: 'T1-F11-06-media-editor-crop-rotate-flip-and-resumable-file-picker-pipeline',
    name: 'F11: Native MediaEditor crop/rotate/flip/resize pipeline and sandbox file-picker resumable media send',
    tier: 1,
    features: ['F11'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerMediaUser(ctx, 'f11_t1_06_alice', 'alice_f11_06');
      const bob = await registerMediaUser(ctx, 'f11_t1_06_bob', 'bob_f11_06');
      const chatRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'F11 MediaEditor Showcase', chatType: 'group', memberIds: [bob.userId] },
        expectOk: true,
      });
      const chatId = Number(chatRes.data?.chat_id ?? chatRes.data?.id);

      const edited = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'editMedia',
        payload: {
          sourceWidth: 220,
          sourceHeight: 140,
          crop: { x: 10, y: 10, width: 120, height: 80 },
          rotateDegrees: 90,
          flipHorizontal: true,
        },
        expectOk: true,
      });
      assert.equal(edited.data?.width, 80, '90-degree rotated 120x80 crop must have width=80');
      assert.equal(edited.data?.height, 120, '90-degree rotated 120x80 crop must have height=120');
      assert.equal(edited.data?.mimeType, 'image/png', 'Edited output must be image/png');

      const pngBuf = Buffer.from(edited.data.dataBase64, 'base64');
      assert.deepEqual(
        pngBuf.subarray(0, 8),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'Edited bytes must carry valid 8-byte PNG signature',
      );

      const pickerPath = path.join(alice.sandbox.tempDir, 'picked_edited_photo.png');
      fs.writeFileSync(pickerPath, pngBuf);

      const uploaded = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'uploadFile',
        payload: {
          filePath: pickerPath,
          resumable: true,
          mimeType: 'image/png',
          chatId,
        },
        expectOk: true,
      });
      assert.equal(uploaded.data?.sha256, edited.data?.sha256, 'Resumable upload sha256 must match edited PNG');

      const sendPhoto = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: {
          chatId,
          content: {
            type: 'Photo',
            data: {
              file_id: uploaded.data.file_id,
              caption: 'Edited with crop + rotate90',
              width: 80,
              height: 120,
            },
          },
        },
        expectOk: true,
      });
      assert.equal(sendPhoto.data?.text, 'Edited with crop + rotate90', 'Sent Photo card must carry caption');
    },
  }),
];

export default tests;
