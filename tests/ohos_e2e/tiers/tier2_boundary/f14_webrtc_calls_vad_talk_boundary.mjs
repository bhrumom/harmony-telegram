import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerRtcBoundaryUser(ctx, label, prefix) {
  const sandbox = ctx.createClientSandbox(label);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const username = `${prefix}_${suffix}`;
  const reg = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: 'registerPassword',
    payload: {
      username,
      password: 'Password123!',
      firstName: prefix.toUpperCase(),
      deviceName: `OHOS_B14_${label}`,
    },
  });
  assert.equal(reg.ok, true, `registerPassword must succeed for ${username}`);
  const userId = Number(reg.data?.userId ?? reg.data?.user_id ?? reg.data?.session?.user_id);
  const token = String(reg.data?.token ?? reg.data?.session?.token ?? '');
  assert.greaterThan(userId, 0, 'userId must be positive');
  assert.isNonEmptyString(token, 'token must be non-empty');
  return { sandbox, username, userId, token };
}

export const tests = [
  defineTest({
    id: 'T2-F14-01-caller-self-accept-and-self-call-rejection',
    name: 'F14 Boundary: Reject calling oneself (400), caller accepting own outgoing call (400), and accepting already-declined terminal call (409)',
    tier: 2,
    features: ['F14'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRtcBoundaryUser(ctx, 'alice_self_c', 'f14b_self_a');
      const bob = await registerRtcBoundaryUser(ctx, 'bob_self_c', 'f14b_self_b');

      const selfCallHttp = await ctx.http.post(
        '/api/v1/calls/invite',
        { callee_id: alice.userId, is_video: false },
        { token: alice.token },
      );
      assert.httpStatus(selfCallHttp, 400, 'Calling oneself over HTTP must return 400 Bad Request');

      const selfCallCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'startCall',
        payload: { calleeId: alice.userId },
        expectOk: false,
      });
      assert.equal(selfCallCli.ok, false, 'calls.startCall to self must fail');

      const started = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'startCall',
        payload: { calleeId: bob.userId, isVideo: false },
      });
      const callId = String(started.data?.callId ?? '');

      const callerSelfAcceptHttp = await ctx.http.post(
        '/api/v1/calls/signal',
        { call_id: callId, signal_type: 'accept' },
        { token: alice.token },
      );
      assert.httpStatus(callerSelfAcceptHttp, 400, 'Caller attempting to accept own outgoing call must return 400');

      const callerSelfAcceptCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'acceptCall',
        payload: { callId },
        expectOk: false,
      });
      assert.equal(callerSelfAcceptCli.ok, false, 'CLI acceptCall by caller must fail');

      const declined = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'calls',
        action: 'rejectCall',
        payload: { callId },
      });
      assert.equal(declined.data?.state, 'declined', 'Bob rejectCall must transition call to declined');

      const acceptAfterDecline = await ctx.http.post(
        '/api/v1/calls/signal',
        { call_id: callId, signal_type: 'accept' },
        { token: bob.token },
      );
      assert.httpStatus(acceptAfterDecline, 409, 'Accepting an already-declined terminal call must return 409 Conflict');
    },
  }),

  defineTest({
    id: 'T2-F14-02-third-party-call-signal-hijack-and-rating-rejection',
    name: 'F14 Boundary: Non-participant third party cannot inject WebRTC SDP/hangup signals (REST 403 & WS Error 403) or rate foreign calls',
    tier: 2,
    features: ['F14'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRtcBoundaryUser(ctx, 'alice_hijack', 'f14b_hj_a');
      const bob = await registerRtcBoundaryUser(ctx, 'bob_hijack', 'f14b_hj_b');
      const mallory = await registerRtcBoundaryUser(ctx, 'mallory_hijack', 'f14b_hj_m');

      const started = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'startCall',
        payload: { calleeId: bob.userId, isVideo: true },
      });
      const callId = String(started.data?.callId ?? '');

      const mallorySignalCli = await ctx.cli.invoke({
        sandbox: mallory.sandbox,
        domain: 'calls',
        action: 'sendSignal',
        payload: { callId, signalType: 'hangup' },
        expectOk: false,
      });
      assert.equal(mallorySignalCli.errorCode, 'PERMISSION_DENIED', 'Third-party CLI sendSignal must return PERMISSION_DENIED');

      const mallorySignalHttp = await ctx.http.post(
        '/api/v1/calls/signal',
        { call_id: callId, signal_type: 'offer', sdp: 'v=0\r\ns=HIJACK\r\n' },
        { token: mallory.token },
      );
      assert.httpStatus(mallorySignalHttp, 403, 'Third-party POST /api/v1/calls/signal must return 403');

      const wsMallory = await ctx.connectWs(mallory.token);
      await wsMallory.sendFrame('CallSignal', {
        call_id: callId,
        signal_type: 'hangup',
      });
      const wsErrFrame = await wsMallory.waitForFrame((f) => f?.type === 'Error', 10_000);
      assert.equal(Number(wsErrFrame?.payload?.code ?? wsErrFrame?.code), 403, 'WS CallSignal from non-participant must emit 403 Error frame');
      await wsMallory.close();

      // Verify Alice/Bob call was NOT terminated by Mallory
      const bobAccept = await ctx.http.post(
        '/api/v1/calls/signal',
        { call_id: callId, signal_type: 'accept' },
        { token: bob.token },
      );
      assert.httpStatus(bobAccept, 200, 'Legitimate callee Bob can still accept call after thwarted hijack');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'endCall',
        payload: { callId },
      });

      const malloryRate = await ctx.http.post(
        `/api/v1/calls/${callId}/rate`,
        { rating: 1 },
        { token: mallory.token },
      );
      assert.httpStatus(malloryRate, 403, 'Non-participant rating foreign call must return 403');
    },
  }),

  defineTest({
    id: 'T2-F14-03-unknown-call-id-and-unsupported-signal-type-validation',
    name: 'F14 Boundary: Signaling nonexistent call_id returns 404/NOT_FOUND, missing calleeId returns VALIDATION_ERROR, and bogus signalType returns 400',
    tier: 2,
    features: ['F14'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRtcBoundaryUser(ctx, 'alice_val', 'f14b_val_a');
      const bob = await registerRtcBoundaryUser(ctx, 'bob_val', 'f14b_val_b');

      const missingCallHttp = await ctx.http.post(
        '/api/v1/calls/signal',
        { call_id: 'call_00000000_nonexistent', signal_type: 'hangup' },
        { token: alice.token },
      );
      assert.httpStatus(missingCallHttp, 404, 'Signaling unknown call_id over HTTP must return 404');

      const missingCallCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'acceptCall',
        payload: { callId: 'call_00000000_nonexistent' },
        expectOk: false,
      });
      assert.equal(missingCallCli.errorCode, 'NOT_FOUND', 'acceptCall on unknown callId must return NOT_FOUND');

      const noCallee = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'startCall',
        payload: {},
        expectOk: false,
      });
      assert.equal(noCallee.errorCode, 'VALIDATION_ERROR', 'startCall without calleeId/chatId must return VALIDATION_ERROR');

      const started = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'startCall',
        payload: { calleeId: bob.userId },
      });
      const callId = String(started.data?.callId ?? '');

      const bogusCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'sendSignal',
        payload: { callId, signalType: 'unsupported_sdp_mutation' },
        expectOk: false,
      });
      assert.equal(bogusCli.errorCode, 'VALIDATION_ERROR', 'Unsupported signalType in CLI must return VALIDATION_ERROR');

      const bogusHttp = await ctx.http.post(
        '/api/v1/calls/signal',
        { call_id: callId, signal_type: 'unsupported_sdp_mutation' },
        { token: alice.token },
      );
      assert.httpStatus(bogusHttp, 400, 'Unsupported signal_type over HTTP must return 400');
    },
  }),

  defineTest({
    id: 'T2-F14-04-out-of-range-call-ratings-and-unauthenticated-rtc-endpoints',
    name: 'F14 Boundary: Call star ratings outside 1..=5 (0, -3, 6) rejected with 400/VALIDATION_ERROR and unauthenticated TURN/WS rejected with 401',
    tier: 2,
    features: ['F14'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRtcBoundaryUser(ctx, 'alice_r_b', 'f14b_rt_a');
      const bob = await registerRtcBoundaryUser(ctx, 'bob_r_b', 'f14b_rt_b');

      const unauthTurn = await ctx.http.get('/api/v1/webrtc/turn_credentials');
      assert.httpStatus(unauthTurn, 401, 'Unauthenticated GET /api/v1/webrtc/turn_credentials must return 401');

      const unauthWs = await ctx.connectWs('', { expectRejectStatus: 401 });
      assert.equal(unauthWs.rejected, true, 'Unauthenticated WebSocket upgrade must be rejected with 401');

      const started = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'startCall',
        payload: { calleeId: bob.userId },
      });
      const callId = String(started.data?.callId ?? '');
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'endCall',
        payload: { callId },
      });

      for (const badRating of [0, -3, 6, 100]) {
        const rateCli = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'calls',
          action: 'rateCall',
          payload: { callId, rating: badRating },
          expectOk: false,
        });
        assert.equal(rateCli.errorCode, 'VALIDATION_ERROR', `Out-of-range rating=${badRating} must fail in CLI`);
      }

      const rateZeroHttp = await ctx.http.post(
        `/api/v1/calls/${callId}/rate`,
        { rating: 0 },
        { token: alice.token },
      );
      assert.httpStatus(rateZeroHttp, 400, 'HTTP rating=0 must return 400 Bad Request');

      const rateSixHttp = await ctx.http.post(
        `/api/v1/calls/${callId}/rate`,
        { rating: 6 },
        { token: alice.token },
      );
      assert.httpStatus(rateSixHttp, 400, 'HTTP rating=6 must return 400 Bad Request');
    },
  }),

  defineTest({
    id: 'T2-F14-05-vad-noise-floor-hysteresis-no-false-positive-bargein',
    name: 'F14 Boundary: Ambient low-RMS noise and single 20ms transient clicks do NOT trigger false-positive VAD barge-in',
    tier: 2,
    features: ['F14'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRtcBoundaryUser(ctx, 'alice_vad_b', 'f14b_vad');

      const started = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'startTalkSession',
        payload: { sampleRate: 48000, ttsPreloadChunks: 10 },
      });
      assert.equal(started.data?.state, 'speaking', 'Talk session must start in speaking state');
      assert.equal(Number(started.data?.bufferedChunks), 10, '10 TTS chunks must be queued');

      // 1. Sustained ambient room noise well below 0.025 RMS threshold (amplitude=60 / 32768 ~= 0.0018)
      const quietFrames = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'processVadFrame',
        payload: {
          sampleRate: 48000,
          amplitude: 60,
          frameCount: 10,
        },
      });
      assert.equal(quietFrames.data?.speechDetected, false, 'Ambient noise floor must not report speechDetected');
      assert.equal(quietFrames.data?.shouldAbortPlayback, false, 'Ambient noise must NOT abort TTS playback');
      assert.equal(Number(quietFrames.data?.flushedChunks), 0, 'Zero TTS chunks should be flushed on ambient noise');
      assert.equal(quietFrames.data?.talkState, 'speaking', 'Talk session must remain speaking');

      // 2. Single 20ms transient impulse (< 60ms min_speech_ms) followed by silence
      const transientPop = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'processVadFrame',
        payload: {
          sampleRate: 48000,
          amplitude: 16000,
          frameCount: 1,
        },
      });
      assert.equal(
        transientPop.data?.shouldAbortPlayback,
        false,
        'Single 20ms impulse (< 60ms min_speech_ms) must NOT trigger barge-in',
      );

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'processVadFrame',
        payload: { sampleRate: 48000, amplitude: 0, frameCount: 2 },
      });

      // 3. Sustained >= 60ms speech (3 x 20ms frames) genuinely triggers barge-in and flushes all 10 chunks
      const realSpeech = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'processVadFrame',
        payload: {
          sampleRate: 48000,
          amplitude: 16000,
          frameCount: 3,
        },
      });
      assert.equal(realSpeech.data?.shouldAbortPlayback, true, '3 consecutive 20ms speech frames must trigger barge-in');
      assert.equal(Number(realSpeech.data?.flushedChunks), 10, 'All 10 buffered chunks must flush upon real speech');
    },
  }),

  defineTest({
    id: 'T2-F14-06-talk-320-chunk-ring-buffer-cap-and-empty-transcript-validation',
    name: 'F14 Boundary: TalkCoordinator enforces 320-chunk bounded audio queue cap and rejects empty transcripts & corrupt base64 PCM',
    tier: 2,
    features: ['F14'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRtcBoundaryUser(ctx, 'alice_cap_b', 'f14b_cap');

      const cappedSession = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'startTalkSession',
        payload: {
          sampleRate: 16000,
          ttsPreloadChunks: 600,
        },
      });
      assert.equal(
        Number(cappedSession.data?.bufferedChunks),
        320,
        'TalkCoordinator ring buffer must clamp preloaded audio queue to MAX_BUFFERED_CHUNKS=320',
      );

      const emptyTurnCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'submitTalkTurn',
        payload: { transcript: '    ' },
        expectOk: false,
      });
      assert.equal(emptyTurnCli.errorCode, 'VALIDATION_ERROR', 'Whitespace-only transcript must return VALIDATION_ERROR');

      const emptyTurnHttp = await ctx.http.post(
        '/api/v1/hermes/talk/turn',
        { transcript: '' },
        { token: alice.token },
      );
      assert.httpStatus(emptyTurnHttp, 400, 'Empty transcript POST /api/v1/hermes/talk/turn must return 400');

      const corruptPcmCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'processVadFrame',
        payload: { pcmBase64: '@@@INVALID_BASE64@@@' },
        expectOk: false,
      });
      assert.equal(corruptPcmCli.errorCode, 'VALIDATION_ERROR', 'Corrupt base64 PCM in processVadFrame must return VALIDATION_ERROR');

      const corruptAudioHttp = await ctx.http.post(
        '/api/v1/talk/audio',
        { audio_b64: '@@@INVALID_BASE64@@@' },
        { token: alice.token },
      );
      assert.httpStatus(corruptAudioHttp, 400, 'Corrupt base64 POST /api/v1/talk/audio must return 400');
    },
  }),
];

export default tests;
