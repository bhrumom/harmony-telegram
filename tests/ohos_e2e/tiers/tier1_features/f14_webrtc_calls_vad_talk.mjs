import fs from 'node:fs';
import path from 'node:path';
import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerCallUser(ctx, label, prefix) {
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
      deviceName: `OHOS_RTC_${label}`,
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
    id: 'T1-F14-01-webrtc-1to1-call-lifecycle-and-ws-signaling',
    name: 'F14: 1:1 WebRTC voice/video call invite, accept, SDP/ICE signal exchange, hangup, and real-time WebSocket CallUpdated delivery',
    tier: 1,
    features: ['F14'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerCallUser(ctx, 'alice_rtc', 'f14_caller');
      const bob = await registerCallUser(ctx, 'bob_rtc', 'f14_callee');

      const wsAlice = await ctx.connectWs(alice.token);
      const wsBob = await ctx.connectWs(bob.token);

      const started = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'startCall',
        payload: {
          calleeId: bob.userId,
          isVideo: true,
        },
      });
      const callId = String(started.data?.callId ?? '');
      assert.match(callId, /^call_/, 'startCall must return canonical call_<uuid> identifier');
      assert.equal(started.data?.isVideo, true, 'startCall must preserve isVideo: true');
      assert.equal(started.data?.state, 'ringing', '1:1 human call must start in ringing state');
      assert.isNonEmptyString(started.data?.emojiFingerprint, 'startCall must compute E2EE safety emoji fingerprint');

      const bobRingFrame = await wsBob.waitForFrame(
        (f) =>
          f?.type === 'Update' &&
          f?.payload?.type === 'CallUpdated' &&
          f?.payload?.data?.call_id === callId &&
          f?.payload?.data?.state === 'ringing',
        10_000,
      );
      assert.equal(bobRingFrame.payload.data.call_id, callId, 'Bob WS must receive ringing CallUpdated frame');

      const acceptHttp = await ctx.http.post(
        '/api/v1/calls/signal',
        { call_id: callId, signal_type: 'accept' },
        { token: bob.token },
      );
      assert.httpStatus(acceptHttp, 200, 'Bob POST /api/v1/calls/signal accept');
      assert.equal(acceptHttp.json?.state, 'active', 'accept signal must transition call to active');

      const aliceActiveFrame = await wsAlice.waitForFrame(
        (f) =>
          f?.type === 'Update' &&
          f?.payload?.type === 'CallUpdated' &&
          f?.payload?.data?.call_id === callId &&
          f?.payload?.data?.state === 'active',
        10_000,
      );
      assert.equal(aliceActiveFrame.payload.data.state, 'active', 'Alice WS must observe active call transition');

      const offerSdp = 'v=0\r\no=- 1001 1 IN IP4 127.0.0.1\r\ns=OHOS_WEBRTC_OFFER\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
      const offerRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'sendSignal',
        payload: {
          callId,
          signalType: 'offer',
          sdp: offerSdp,
          targetUserId: bob.userId,
        },
      });
      assert.equal(offerRes.data?.sent, true, 'Alice sendSignal(offer) must succeed');

      const bobOfferFrame = await wsBob.waitForFrame(
        (f) =>
          f?.type === 'Update' &&
          f?.payload?.type === 'CallUpdated' &&
          f?.payload?.data?.signal?.signal_type === 'offer',
        10_000,
      );
      assert.includes(bobOfferFrame.payload.data.signal.sdp, 'OHOS_WEBRTC_OFFER', 'Bob WS must receive SDP offer');

      const answerSdp = 'v=0\r\no=- 2002 1 IN IP4 127.0.0.1\r\ns=OHOS_WEBRTC_ANSWER\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
      await wsBob.sendFrame('CallSignal', {
        call_id: callId,
        signal_type: 'answer',
        sdp: answerSdp,
        target_user_id: alice.userId,
      });

      const aliceAnswerFrame = await wsAlice.waitForFrame(
        (f) =>
          f?.type === 'Update' &&
          f?.payload?.type === 'CallUpdated' &&
          f?.payload?.data?.signal?.signal_type === 'answer',
        10_000,
      );
      assert.includes(aliceAnswerFrame.payload.data.signal.sdp, 'OHOS_WEBRTC_ANSWER', 'Alice WS must receive SDP answer');

      const iceRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'sendSignal',
        payload: {
          callId,
          signalType: 'ice',
          candidate: 'candidate:1 1 UDP 2122252543 192.168.1.10 54400 typ host',
          sdpMid: '0',
          sdpMlineIndex: 0,
        },
      });
      assert.equal(iceRes.data?.sent, true, 'Alice sendSignal(ice) must succeed');

      const hangupRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'sendSignal',
        payload: {
          callId,
          signalType: 'hangup',
        },
      });
      assert.equal(hangupRes.data?.sent, true, 'Alice sendSignal(hangup) must end call');

      const bobEndedFrame = await wsBob.waitForFrame(
        (f) =>
          f?.type === 'Update' &&
          f?.payload?.type === 'CallUpdated' &&
          f?.payload?.data?.call_id === callId &&
          f?.payload?.data?.state === 'ended',
        10_000,
      );
      assert.equal(bobEndedFrame.payload.data.state, 'ended', 'Bob WS must receive ended CallUpdated frame');

      await wsAlice.close();
      await wsBob.close();
    },
  }),

  defineTest({
    id: 'T1-F14-02-stun-turn-ephemeral-hmac-credentials',
    name: 'F14: Ephemeral HMAC-authenticated STUN/TURN server credentials via REST and calls.getTurnCredentials',
    tier: 1,
    features: ['F14'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerCallUser(ctx, 'alice_turn', 'f14_turn_u');

      const turnHttp = await ctx.http.get('/api/v1/webrtc/turn_credentials', {
        token: alice.token,
      });
      assert.httpStatus(turnHttp, 200, 'GET /api/v1/webrtc/turn_credentials');
      assert.equal(Number(turnHttp.json?.ttl_seconds), 43200, 'TURN ttl_seconds must equal 43200 (12h)');
      assert.isNonEmptyString(turnHttp.json?.credential, 'TURN HMAC credential must be non-empty');
      assert.match(
        String(turnHttp.json?.username || ''),
        new RegExp(`^\\d+:${alice.userId}$`),
        'TURN username must encode <expiry_epoch>:<user_id>',
      );

      const turnCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'getTurnCredentials',
        payload: {},
      });
      const uriList = turnCli.data?.urls ?? turnCli.data?.uris ?? [];
      assert.isArray(uriList, 'calls.getTurnCredentials must return urls/uris array');
      assert.equal(uriList.some((u) => String(u).startsWith('stun:')), true, 'ICE server list must include stun: URI');
      assert.equal(uriList.some((u) => String(u).startsWith('turn:')), true, 'ICE server list must include turn: URI');
      assert.isNonEmptyString(turnCli.data?.credential, 'CLI getTurnCredentials must include HMAC credential');
    },
  }),

  defineTest({
    id: 'T1-F14-03-sfu-group-conference-room-and-ai-bot-call',
    name: 'F14: Multi-participant SFU group voice room PCM routing and AI companion bot auto-active SFU call session',
    tier: 1,
    features: ['F14'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerCallUser(ctx, 'alice_sfu', 'f14_sfu_a');
      const bob = await registerCallUser(ctx, 'bob_sfu', 'f14_sfu_b');
      const carol = await registerCallUser(ctx, 'carol_sfu', 'f14_sfu_c');

      const groupRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: {
          title: 'Harmony SFU Voice Room',
          chatType: 'group',
          memberIds: [bob.userId, carol.userId],
        },
      });
      const chatId = Number(groupRes.data?.chat_id ?? groupRes.data?.chatId);
      assert.greaterThan(chatId, 0, 'SFU group chatId must be positive');

      const joinedSfu = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'joinSfuRoom',
        payload: {
          roomId: `sfu_room_${chatId}`,
          chatId,
          participantIds: [bob.userId, carol.userId],
        },
      });
      assert.equal(joinedSfu.data?.sfuActive, true, 'joinSfuRoom must report sfuActive: true');
      assert.equal(Number(joinedSfu.data?.selfUserId), alice.userId, 'selfUserId must match Alice');
      assert.greaterThanOrEqual(Number(joinedSfu.data?.peerCount), 1, 'SFU room must register active audio subscribers');
      assert.isNonEmptyString(joinedSfu.data?.emojiFingerprint, 'SFU room must derive safety emoji fingerprint');

      const leftSfu = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'leaveSfuRoom',
        payload: { chatId },
      });
      assert.equal(leftSfu.data?.left, true, 'leaveSfuRoom must cleanly unsubscribe participant');

      const botCreated = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'bots',
        action: 'createBot',
        payload: {
          isAiCompanion: true,
          displayName: 'Harmony Voice AI',
          systemPrompt: 'You are a concise voice assistant.',
        },
      });
      const botUserId = Number(botCreated.data?.bot_user_id ?? botCreated.data?.bot_id ?? botCreated.data?.bot?.bot_user_id);
      assert.greaterThanOrEqual(botUserId, 600_000, 'Companion bot user_id must be in 600_000+ range');

      const botCall = await ctx.http.post(
        '/api/v1/calls/invite',
        { callee_id: botUserId, is_video: false },
        { token: alice.token },
      );
      assert.httpStatus(botCall, 201, 'POST /api/v1/calls/invite to AI bot');
      assert.equal(botCall.json?.state, 'active', 'Calling an AI companion bot must auto-answer into active state');
      assert.equal(botCall.json?.mode, 'ai_talk', 'Bot call record must report mode: ai_talk');
    },
  }),

  defineTest({
    id: 'T1-F14-04-call-star-rating-feedback-and-history',
    name: 'F14: 1-to-5 star post-call quality rating with feedback and synchronized caller/callee call history',
    tier: 1,
    features: ['F14'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerCallUser(ctx, 'alice_rate', 'f14_rate_a');
      const bob = await registerCallUser(ctx, 'bob_rate', 'f14_rate_b');

      const started = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'startCall',
        payload: { calleeId: bob.userId, isVideo: false },
      });
      const callId = String(started.data?.callId ?? '');
      assert.isNonEmptyString(callId, 'startCall must yield callId');

      const accepted = await ctx.http.post(
        '/api/v1/calls/signal',
        { call_id: callId, signal_type: 'accept' },
        { token: bob.token },
      );
      assert.httpStatus(accepted, 200, 'Bob accept call');

      await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'calls',
        action: 'sendSignal',
        payload: { callId, signalType: 'hangup' },
      });

      const rated = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'rateCall',
        payload: {
          callId,
          rating: 5,
          feedback: 'Zero packet loss over OpenHarmony AudioRenderer',
        },
      });
      assert.equal(Number(rated.data?.rating), 5, 'rateCall(5) must persist rating=5 on CallRecordDto');
      assert.equal(rated.data?.state, 'ended', 'rated call record must remain in ended state');

      const aliceHistory = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'listCallHistory',
        payload: {},
      });
      assert.greaterThanOrEqual(aliceHistory.data?.count, 1, 'Alice call history must contain >= 1 record');
      const aliceRec = (aliceHistory.data?.calls || []).find((c) => c.call_id === callId);
      assert.equal(Number(aliceRec?.rating), 5, 'Alice listCallHistory must reflect 5-star rating');

      const bobHistoryHttp = await ctx.http.get('/api/v1/calls', { token: bob.token });
      assert.httpStatus(bobHistoryHttp, 200, 'Bob GET /api/v1/calls');
      const bobRec = (bobHistoryHttp.json?.calls || []).find((c) => c.call_id === callId);
      assert.isObject(bobRec, 'Bob GET /api/v1/calls must include shared call record');
      assert.equal(Number(bobRec.rating), 5, 'Shared call record rating must be visible on server');
    },
  }),

  defineTest({
    id: 'T1-F14-05-background-tasks-kit-voip-and-audio-playback',
    name: 'F14: BackgroundTasksKit continuous voip and audioPlayback task lifecycle with ohos.permission.KEEP_BACKGROUND_RUNNING',
    tier: 1,
    features: ['F14'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerCallUser(ctx, 'alice_bg', 'f14_bg_a');
      const bob = await registerCallUser(ctx, 'bob_bg', 'f14_bg_b');

      const callRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'startCall',
        payload: { calleeId: bob.userId, isVideo: false },
      });
      const callId = String(callRes.data?.callId ?? '');

      const voipOn = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'setBackgroundVoipTask',
        payload: {
          active: true,
          callId,
          mode: 'voip',
        },
      });
      assert.equal(voipOn.data?.active, true, 'setBackgroundVoipTask must activate continuous task');
      assert.equal(voipOn.data?.callId, callId, 'background task must bind active callId');
      assert.equal(voipOn.data?.mode, 'voip', 'background task mode must be voip');
      assert.equal(
        voipOn.data?.permission,
        'ohos.permission.KEEP_BACKGROUND_RUNNING',
        'background task must declare Zero-ACL KEEP_BACKGROUND_RUNNING permission',
      );

      const playbackSwitch = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'setBackgroundVoipTask',
        payload: {
          active: true,
          callId,
          mode: 'audioPlayback',
        },
      });
      assert.equal(playbackSwitch.data?.mode, 'audioPlayback', 'must support switching continuous task to audioPlayback');

      const stateFile = path.join(alice.sandbox.filesDir, 'ohos_core_state.json');
      const persistedOn = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(persistedOn.voip_background_task?.active, true, 'ohos_core_state.json must persist active task');
      assert.equal(persistedOn.voip_background_task?.mode, 'audioPlayback', 'persisted mode must be audioPlayback');

      const voipOff = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'calls',
        action: 'setBackgroundVoipTask',
        payload: {
          active: false,
          callId,
          mode: 'voip',
        },
      });
      assert.equal(voipOff.data?.active, false, 'setBackgroundVoipTask(active: false) must release continuous task');
    },
  }),

  defineTest({
    id: 'T1-F14-06-full-duplex-ai-talk-mode-and-sub60ms-vad-bargein',
    name: 'F14: Full-duplex AI Talk Mode session, Hermes TTS turn streaming, and <60ms VAD speech barge-in playback flush',
    tier: 1,
    features: ['F14'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerCallUser(ctx, 'alice_talk', 'f14_talk_u');

      const session = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'startTalkSession',
        payload: {
          sampleRate: 48000,
          ttsPreloadChunks: 8,
        },
      });
      const sessionId = String(session.data?.sessionId ?? '');
      assert.isNonEmptyString(sessionId, 'startTalkSession must return sessionId');
      assert.equal(session.data?.state, 'speaking', 'preloaded TTS chunks must enter speaking state');
      assert.equal(Number(session.data?.bufferedChunks), 8, '8 preloaded audio chunks must be queued');

      const vadBarge = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'processVadFrame',
        payload: {
          sampleRate: 48000,
          amplitude: 16000,
          frameCount: 3,
        },
      });
      assert.equal(vadBarge.data?.speechDetected, true, 'high-RMS PCM frames must detect human speech');
      assert.equal(vadBarge.data?.shouldAbortPlayback, true, '3 consecutive speech frames while speaking must trigger barge-in');
      assert.equal(Number(vadBarge.data?.flushedChunks), 8, 'VAD barge-in must flush all 8 queued TTS chunks');
      assert.equal(vadBarge.data?.talkState, 'interrupted', 'talkState must transition to interrupted');
      assert.lessThan(Number(vadBarge.data?.latencyMs), 60, 'VAD barge-in check must complete in < 60ms');

      const turnRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'submitTalkTurn',
        payload: {
          sessionId,
          transcript: 'Give me a quick status check on HarmonyOS NEXT audio pipeline.',
        },
      });
      assert.equal(turnRes.data?.talkState, 'speaking', 'submitTalkTurn must transition session back to speaking');
      assert.greaterThanOrEqual(Number(turnRes.data?.bufferedChunks), 2, 'submitTalkTurn must enqueue synthesized TTS chunks');
      assert.isObject(turnRes.data?.turn, 'submitTalkTurn must return Hermes turn response');

      const abortRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'bargeInAbort',
        payload: {},
      });
      assert.equal(abortRes.data?.aborted, true, 'bargeInAbort must confirm playback abort');
      assert.equal(abortRes.data?.talkState, 'listening', 'bargeInAbort must resume listening state');
      assert.lessThan(Number(abortRes.data?.latencyMs), 60, 'bargeInAbort latency must be < 60ms');

      const stopped = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'talk',
        action: 'stopTalkSession',
        payload: {},
      });
      assert.equal(stopped.data?.state, 'closed', 'stopTalkSession must close TalkCoordinator cleanly');
    },
  }),
];

export default tests;
