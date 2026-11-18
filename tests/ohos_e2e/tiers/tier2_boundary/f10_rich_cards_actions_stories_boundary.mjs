import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerRichBoundUser(ctx, label, prefix) {
  const sandbox = ctx.createClientSandbox(label);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const username = `${prefix}_${suffix}`;
  const res = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: 'registerPassword',
    payload: { username, password: 'RichBoundPass#2026!', displayName: prefix.toUpperCase() },
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

async function createRichBoundGroup(ctx, owner, title, memberIds) {
  const res = await ctx.cli.invoke({
    sandbox: owner.sandbox,
    domain: 'dialogs',
    action: 'createChat',
    payload: { title, chatType: 'group', memberIds },
    expectOk: true,
  });
  const chatId = Number(res.data?.chat_id ?? res.data?.id ?? 0);
  assert.greaterThan(chatId, 0, 'chatId must be positive');
  return chatId;
}

export const tests = [
  defineTest({
    id: 'T2-F10-01-utf16-surrogate-out-of-bounds-entities-rejected',
    name: 'F10 Boundary: UTF-16 emoji surrogate out-of-bounds MessageEntity offsets and empty rich card fields are rejected with HTTP 400',
    tier: 2,
    features: ['F10'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichBoundUser(ctx, 'f10_t2_01_alice', 'alice_f10_b1');
      const bob = await registerRichBoundUser(ctx, 'f10_t2_01_bob', 'bob_f10_b1');
      const chatId = await createRichBoundGroup(ctx, alice, 'F10 UTF-16 Bounds', [bob.userId]);

      // "Hi 👋" = 'H'(1) + 'i'(1) + ' '(1) + '👋'(2 UTF-16 surrogate code units) = 5 UTF-16 code units total
      const validSurrogate = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        {
          content: {
            type: 'Text',
            data: {
              text: 'Hi 👋',
              entities: [{ offset: 3, length: 2, entity_type: { type: 'Bold' } }],
            },
          },
        },
        { token: alice.token },
      );
      assert.httpStatus(validSurrogate, 201, 'Exact UTF-16 surrogate span [3..5] must succeed');

      const outOfBoundsSpan = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        {
          content: {
            type: 'Text',
            data: {
              text: 'Hi 👋',
              entities: [{ offset: 3, length: 3, entity_type: { type: 'Bold' } }],
            },
          },
        },
        { token: alice.token },
      );
      assert.httpStatus(outOfBoundsSpan, 400, 'Entity exceeding UTF-16 length (3+3 > 5) must fail with HTTP 400');
      assert.equal(outOfBoundsSpan.json?.error, 'invalid_entities', 'Error code must be invalid_entities');

      const pastEndOffset = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        {
          content: {
            type: 'Text',
            data: {
              text: 'Hi 👋',
              entities: [{ offset: 99, length: 1, entity_type: { type: 'Code' } }],
            },
          },
        },
        { token: alice.token },
      );
      assert.httpStatus(pastEndOffset, 400, 'Entity starting past UTF-16 end must fail with HTTP 400');
      assert.equal(pastEndOffset.json?.error, 'invalid_entities', 'Error code must be invalid_entities');

      const emptyPhotoFileId = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        { content: { type: 'Photo', data: { file_id: '   ', caption: 'bad', width: 10, height: 10 } } },
        { token: alice.token },
      );
      assert.httpStatus(emptyPhotoFileId, 400, 'Empty Photo.file_id must fail with HTTP 400');

      const emptyGenCard = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages`,
        {
          content: {
            type: 'GenerativeCard',
            data: { card_id: '', title: '', subtitle: null, layout: 'VerticalStack', components: [], status: 'idle' },
          },
        },
        { token: alice.token },
      );
      assert.httpStatus(emptyGenCard, 400, 'GenerativeCard with empty card_id/title must fail with HTTP 400');
    },
  }),

  defineTest({
    id: 'T2-F10-02-non-sender-non-admin-edit-delete-pin-and-forward-acl-403',
    name: 'F10 Boundary: Non-sender/non-admin message edit, delete, pin, and cross-chat unauthorized forward are rejected with HTTP 403',
    tier: 2,
    features: ['F10'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichBoundUser(ctx, 'f10_t2_02_alice', 'alice_f10_b2');
      const bob = await registerRichBoundUser(ctx, 'f10_t2_02_bob', 'bob_f10_b2');
      const eve = await registerRichBoundUser(ctx, 'f10_t2_02_eve', 'eve_f10_b2');

      const privateChat = await createRichBoundGroup(ctx, alice, 'Alice + Bob Private', [bob.userId]);
      const eveChat = await createRichBoundGroup(ctx, eve, 'Eve Own Group', [bob.userId]);

      const sent = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId: privateChat, text: 'Alice protected message' },
        expectOk: true,
      });
      const msgId = Number(sent.data?.message_id);

      const bobEdit = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'editMessage',
        payload: { chatId: privateChat, messageId: msgId, text: 'Bob unauthorized edit' },
        expectOk: false,
      });
      assert.oneOf(
        bobEdit.errorCode,
        ['PERMISSION_DENIED', 'FORBIDDEN'],
        'Non-sender Bob editing Alice message must fail with permission error',
      );

      const bobDel = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'deleteMessages',
        payload: { chatId: privateChat, messageIds: [msgId], revoke: true },
        expectOk: false,
      });
      assert.oneOf(
        bobDel.errorCode,
        ['PERMISSION_DENIED', 'FORBIDDEN'],
        'Non-admin Bob deleting Alice message must fail with permission error',
      );

      const bobPin = await ctx.http.post(
        `/api/v1/chats/${privateChat}/pins`,
        { message_id: msgId },
        { token: bob.token },
      );
      assert.httpStatus(bobPin, 403, 'Non-admin Bob pinning message must fail with HTTP 403');

      const eveForward = await ctx.http.post(
        `/api/v1/chats/${eveChat}/messages`,
        {
          forward_from_chat_id: privateChat,
          forward_from_msg_id: msgId,
        },
        { token: eve.token },
      );
      assert.httpStatus(eveForward, 403, 'Outsider Eve forwarding from privateChat must fail with HTTP 403');
    },
  }),

  defineTest({
    id: 'T2-F10-03-poll-closed-vote-out-of-range-option-and-quiz-revote-rejected',
    name: 'F10 Boundary: Voting on a closed poll, out-of-range option index, multi-select on single-choice poll, and changing a quiz vote are rejected',
    tier: 2,
    features: ['F10'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichBoundUser(ctx, 'f10_t2_03_alice', 'alice_f10_b3');
      const bob = await registerRichBoundUser(ctx, 'f10_t2_03_bob', 'bob_f10_b3');
      const chatId = await createRichBoundGroup(ctx, alice, 'F10 Poll Vote Bounds', [bob.userId]);

      const created = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'createPoll',
        payload: { chatId, question: 'Pick one option', options: ['Yes', 'No'] },
        expectOk: true,
      });
      const pollId = Number(created.data?.poll?.poll_id);

      const emptyVote = await ctx.http.post(`/api/v1/polls/${pollId}/vote`, { option_ids: [] }, { token: bob.token });
      assert.httpStatus(emptyVote, 400, 'Empty option_ids must fail with HTTP 400');

      const outOfRange = await ctx.http.post(`/api/v1/polls/${pollId}/vote`, { option_ids: [7] }, { token: bob.token });
      assert.httpStatus(outOfRange, 400, 'Out-of-range option index must fail with HTTP 400');

      const multiOnSingle = await ctx.http.post(
        `/api/v1/polls/${pollId}/vote`,
        { option_ids: [0, 1] },
        { token: bob.token },
      );
      assert.httpStatus(multiOnSingle, 400, 'Multiple options on single-choice poll must fail with HTTP 400');

      const bobCloseAttempt = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'closePoll',
        payload: { pollId },
        expectOk: false,
      });
      assert.oneOf(
        bobCloseAttempt.errorCode,
        ['PERMISSION_DENIED', 'FORBIDDEN'],
        'Non-creator closing poll must fail with permission error',
      );

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'closePoll',
        payload: { pollId },
        expectOk: true,
      });

      const voteAfterClose = await ctx.http.post(
        `/api/v1/polls/${pollId}/vote`,
        { option_ids: [0] },
        { token: bob.token },
      );
      assert.oneOf(voteAfterClose.status, [400, 409], 'Voting on closed poll must be rejected with 400/409');

      const quizCreate = await ctx.http.post(
        `/api/v1/chats/${chatId}/polls`,
        { question: 'Capital of China?', options: ['Beijing', 'Shanghai'], is_quiz: true, correct_option_id: 0 },
        { token: alice.token },
      );
      assert.httpStatus(quizCreate, 201, 'create quiz');
      const quizId = Number(quizCreate.json?.poll?.poll_id);

      const firstQuizVote = await ctx.http.post(
        `/api/v1/polls/${quizId}/vote`,
        { option_ids: [1] },
        { token: bob.token },
      );
      assert.httpStatus(firstQuizVote, 200, 'first quiz vote');

      const changeQuizVote = await ctx.http.post(
        `/api/v1/polls/${quizId}/vote`,
        { option_ids: [0] },
        { token: bob.token },
      );
      assert.oneOf(changeQuizVote.status, [400, 409], 'Changing an already-submitted quiz vote must be rejected');
    },
  }),

  defineTest({
    id: 'T2-F10-04-poll-invalid-option-count-and-invalid-quiz-answer-rejected',
    name: 'F10 Boundary: Poll creation with <2 or >10 options, empty question, or missing/out-of-bounds quiz correct_option_id is rejected with HTTP 400',
    tier: 2,
    features: ['F10'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichBoundUser(ctx, 'f10_t2_04_alice', 'alice_f10_b4');
      const bob = await registerRichBoundUser(ctx, 'f10_t2_04_bob', 'bob_f10_b4');
      const chatId = await createRichBoundGroup(ctx, alice, 'F10 Poll Schema Bounds', [bob.userId]);

      const oneOptionCli = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'createPoll',
        payload: { chatId, question: 'Invalid 1-option poll', options: ['OnlyOne'] },
        expectOk: false,
      });
      assert.equal(oneOptionCli.errorCode, 'VALIDATION_ERROR', 'CLI <2 options must fail with VALIDATION_ERROR');

      const oneOptionHttp = await ctx.http.post(
        `/api/v1/chats/${chatId}/polls`,
        { question: 'Invalid 1-option poll', options: ['OnlyOne'] },
        { token: alice.token },
      );
      assert.httpStatus(oneOptionHttp, 400, 'Server <2 options must fail with HTTP 400');

      const elevenOptions = Array.from({ length: 11 }, (_, idx) => `Opt ${idx + 1}`);
      const tooManyHttp = await ctx.http.post(
        `/api/v1/chats/${chatId}/polls`,
        { question: 'Too many options', options: elevenOptions },
        { token: alice.token },
      );
      assert.httpStatus(tooManyHttp, 400, 'Server >10 options must fail with HTTP 400');

      const emptyQuestionCli = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'createPoll',
        payload: { chatId, question: '   ', options: ['A', 'B'] },
        expectOk: false,
      });
      assert.equal(emptyQuestionCli.errorCode, 'VALIDATION_ERROR', 'Empty poll question must fail CLI validation');

      const eve = await registerRichBoundUser(ctx, 'f10_t2_04_eve', 'eve_f10_b4');
      const outsiderPoll = await ctx.http.post(
        `/api/v1/chats/${chatId}/polls`,
        { question: 'Outsider poll?', options: ['A', 'B'] },
        { token: eve.token },
      );
      assert.httpStatus(outsiderPoll, 403, 'Non-member creating poll in private chat must fail with HTTP 403');

      const quizNoCorrect = await ctx.http.post(
        `/api/v1/chats/${chatId}/polls`,
        { question: 'Quiz missing correct index', options: ['A', 'B'], is_quiz: true },
        { token: alice.token },
      );
      assert.httpStatus(quizNoCorrect, 400, 'Quiz without correct_option_id must fail with HTTP 400');

      const quizOobCorrect = await ctx.http.post(
        `/api/v1/chats/${chatId}/polls`,
        { question: 'Quiz OOB correct index', options: ['A', 'B'], is_quiz: true, correct_option_id: 5 },
        { token: alice.token },
      );
      assert.httpStatus(quizOobCorrect, 400, 'Quiz with out-of-bounds correct_option_id must fail with HTTP 400');
    },
  }),

  defineTest({
    id: 'T2-F10-05-story-missing-media-and-invalid-reaction-or-instant-view-rejected',
    name: 'F10 Boundary: Story creation without media_id/media_url is rejected with HTTP 400 missing_media alongside invalid reaction and Instant View URL guards',
    tier: 2,
    features: ['F10'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichBoundUser(ctx, 'f10_t2_05_alice', 'alice_f10_b5');
      const bob = await registerRichBoundUser(ctx, 'f10_t2_05_bob', 'bob_f10_b5');
      const chatId = await createRichBoundGroup(ctx, alice, 'F10 Story & Reaction Bounds', [bob.userId]);

      const noMediaStory = await ctx.http.post(
        '/api/v1/stories',
        { caption: 'Story missing both media_id and media_url', privacy: 'everyone' },
        { token: alice.token },
      );
      assert.httpStatus(noMediaStory, 400, 'Story without media_id or media_url must fail with HTTP 400');
      assert.equal(noMediaStory.json?.error, 'missing_media', 'Error code must equal missing_media');

      const sent = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Reaction validation target' },
        expectOk: true,
      });
      const msgId = Number(sent.data?.message_id);

      const emptyReact = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages/${msgId}/reactions`,
        { emoji: '   ' },
        { token: bob.token },
      );
      assert.httpStatus(emptyReact, 400, 'Empty/whitespace reaction emoji must fail with HTTP 400');

      const eve = await registerRichBoundUser(ctx, 'f10_t2_05_eve', 'eve_f10_b5');
      const outsiderReact = await ctx.http.post(
        `/api/v1/chats/${chatId}/messages/${msgId}/reactions`,
        { emoji: '🔥' },
        { token: eve.token },
      );
      assert.httpStatus(outsiderReact, 403, 'Non-member reacting to private chat message must fail with HTTP 403');

      const badIvScheme = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'openInstantView',
        payload: { url: 'javascript:alert(1)' },
        expectOk: false,
      });
      assert.equal(badIvScheme.errorCode, 'VALIDATION_ERROR', 'Non-http(s) Instant View URL must be rejected');

      const emptyTranslate = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'translateMessage',
        payload: { text: '   ', targetLang: 'zh-CN' },
        expectOk: false,
      });
      assert.equal(emptyTranslate.errorCode, 'VALIDATION_ERROR', 'Empty translateMessage input must be rejected');
    },
  }),

  defineTest({
    id: 'T2-F10-06-non-owner-story-delete-and-view-deduplication',
    name: 'F10 Boundary: Non-owner story deletion is rejected while preserving owner story and deduplicating repeat viewer counts',
    tier: 2,
    features: ['F10'],
    timeoutMs: 30_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichBoundUser(ctx, 'f10_t2_06_alice', 'alice_f10_b6');
      const bob = await registerRichBoundUser(ctx, 'f10_t2_06_bob', 'bob_f10_b6');

      const up = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'uploadFile',
        payload: {
          filename: 'owner_story.png',
          mimeType: 'image/png',
          dataBase64: Buffer.from('alice-protected-story-image').toString('base64'),
        },
        expectOk: true,
      });

      const created = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'createStory',
        payload: { mediaId: up.data.file_id, mediaType: 'photo', caption: 'Owner Only', privacy: 'everyone' },
        expectOk: true,
      });
      const storyId = created.data?.story_id ?? created.data?.id;

      const bobDeleteCli = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'deleteStory',
        payload: { storyId },
        expectOk: false,
      });
      assert.oneOf(bobDeleteCli.errorCode, ['NOT_FOUND', 'FORBIDDEN'], 'Non-owner story deletion must fail');

      const bobDeleteHttp = await ctx.http.del(`/api/v1/stories/${storyId}`, { token: bob.token });
      assert.oneOf(bobDeleteHttp.status, [403, 404], 'Non-owner HTTP DELETE /api/v1/stories/{id} must fail');

      const stillListed = await ctx.http.get('/api/v1/stories', { token: alice.token });
      assert.httpStatus(stillListed, 200, 'list stories after unauthorized delete attempt');
      const found = (stillListed.json?.stories ?? []).some((s) => (s.story_id ?? s.id) === storyId);
      assert.equal(found, true, 'Alice story must remain intact after Bob failed delete attempt');

      for (let i = 0; i < 3; i++) {
        const vRes = await ctx.http.post(
          `/api/v1/stories/${storyId}/view`,
          { reaction: '🔥' },
          { token: bob.token },
        );
        assert.httpStatus(vRes, 200, `Bob story view #${i + 1}`);
        assert.equal(Number(vRes.json?.views_count), 1, 'Repeat views by same user must deduplicate at views_count=1');
      }

      const missingView = await ctx.http.post(
        '/api/v1/stories/nonexistent_story_999/view',
        {},
        { token: bob.token },
      );
      assert.httpStatus(missingView, 404, 'Viewing nonexistent story must fail with HTTP 404');
    },
  }),
];

export default tests;
