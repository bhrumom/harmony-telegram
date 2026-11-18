import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerRichUser(ctx, label, prefix) {
  const sandbox = ctx.createClientSandbox(label);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const username = `${prefix}_${suffix}`;
  const res = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: 'registerPassword',
    payload: { username, password: 'RichCardsPass#2026!', displayName: prefix.toUpperCase() },
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

async function createRichGroup(ctx, owner, title, memberIds) {
  const res = await ctx.cli.invoke({
    sandbox: owner.sandbox,
    domain: 'dialogs',
    action: 'createChat',
    payload: { title, chatType: 'group', memberIds },
    expectOk: true,
  });
  const chatId = Number(res.data?.chat_id ?? res.data?.id ?? 0);
  assert.greaterThan(chatId, 0, 'Group chatId must be positive');
  return chatId;
}

export const tests = [
  defineTest({
    id: 'T1-F10-01-twelve-rich-card-types-utf16-entities-and-think-bubble',
    name: 'F10: All 12 rich message card types, UTF-16 MessageEntity spans, Bot Inline Keyboard, and <think> AI reasoning bubble round-trip',
    tier: 1,
    features: ['F10'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichUser(ctx, 'f10_t1_01_alice', 'alice_f10_01');
      const bob = await registerRichUser(ctx, 'f10_t1_01_bob', 'bob_f10_01');
      const chatId = await createRichGroup(ctx, alice, 'F10 Rich Cards Showcase', [bob.userId]);

      const mediaUpload = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'uploadFile',
        payload: {
          filename: 'card_asset.bin',
          mimeType: 'application/octet-stream',
          dataBase64: Buffer.from('rich-card-asset-payload-v1').toString('base64'),
        },
        expectOk: true,
      });
      const fileId = mediaUpload.data?.file_id;
      assert.isNonEmptyString(fileId, 'Uploaded card asset must return file_id');

      const richText = '<think>Verify UTF-16 surrogate math</think>Hi 👋 世界 bold code secret link';
      const boldStart = richText.indexOf('bold');
      const codeStart = richText.indexOf('code');
      const spoilerStart = richText.indexOf('secret');
      const linkStart = richText.indexOf('link');

      const entities = [
        { offset: boldStart, length: 4, entity_type: { type: 'Bold' } },
        { offset: codeStart, length: 4, entity_type: { type: 'Code' } },
        { offset: spoilerStart, length: 6, entity_type: { type: 'Spoiler' } },
        { offset: linkStart, length: 4, entity_type: { type: 'TextUrl', value: { url: 'https://example.org/docs' } } },
      ];
      const inlineKeyboard = [
        [
          { text: 'Approve', callback_data: 'act:approve', url: null, web_app_url: null },
          { text: 'Open Docs', callback_data: null, url: 'https://example.org', web_app_url: null },
        ],
      ];

      const richPayloads = [
        {
          content: { type: 'Text', data: { text: richText, entities } },
          inline_keyboard: inlineKeyboard,
        },
        { content: { type: 'Photo', data: { file_id: fileId, caption: 'Sunset Shot', width: 1280, height: 720 } } },
        { content: { type: 'Video', data: { file_id: fileId, duration: 14, width: 1920, height: 1080, caption: 'Demo Clip' } } },
        { content: { type: 'Voice', data: { file_id: fileId, duration_seconds: 6, waveform: [3, 12, 28, 19, 7], mime_type: 'audio/ogg', size_bytes: 2048 } } },
        { content: { type: 'VideoNote', data: { file_id: fileId, duration_seconds: 9, diameter: 360, thumbnail: null, size_bytes: 8192 } } },
        { content: { type: 'Media', data: { file_id: fileId, file_name: 'album_1.png', mime_type: 'image/png', size_bytes: 1024, width: 640, height: 480, duration_seconds: null, thumbnail: null, caption: 'Album Item #1' } } },
        { content: { type: 'Audio', data: { file_id: fileId, duration: 185, title: 'Zen Bell', performer: 'Fabushi Ensemble' } } },
        { content: { type: 'Document', data: { file_id: fileId, file_name: 'architecture.pdf', mime_type: 'application/pdf', size_bytes: 4096 } } },
        {
          content: {
            type: 'Todo',
            data: {
              id: 'todo_m3',
              list_id: 'todo_m3',
              title: 'Release Checklist',
              items: [{ id: 'item_1', title: 'Ship E2E', completed: false, assignee: 'alice' }],
              completed_count: 0,
              action_buttons: [{ id: 'btn_done', label: 'Toggle', action_type: 'toggle_todo', payload: 'item_1' }],
            },
          },
        },
        {
          content: {
            type: 'Invoice',
            data: {
              id: 'inv_stars_1',
              invoice_id: 'inv_stars_1',
              title: 'Harmony Pro Pass',
              description: '100 Stars',
              currency: 'XTR',
              amount_cents: 100,
              total_amount: 100,
              status: 'pending',
              is_paid: false,
              prices: [{ label: 'Pro Pass', amount_cents: 100 }],
            },
          },
        },
        {
          content: {
            type: 'GenerativeCard',
            data: {
              card_id: 'a2ui_deploy_1',
              title: 'Build Pipeline',
              subtitle: 'HarmonyOS API 20',
              layout: 'VerticalStack',
              components: [
                { type: 'Text', text: 'All checks green', bold: true, color: null },
                { type: 'Badge', label: 'READY', color: '#22c55e' },
                { type: 'Progress', value: 100.0, max: 100.0, label: '100%' },
                { type: 'Button', id: 'deploy_btn', label: 'Promote', action_payload: 'promote:v1.2.0' },
                { type: 'Divider' },
              ],
              status: 'completed',
            },
          },
        },
      ];

      for (const body of richPayloads) {
        const sendRes = await ctx.http.post(`/api/v1/chats/${chatId}/messages`, body, { token: alice.token });
        assert.httpStatus(sendRes, 201, `send rich card ${body.content.type}`);
      }

      const pollRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'createPoll',
        payload: { chatId, question: 'Favorite layout?', options: ['Phone sm', 'PC xl'] },
        expectOk: true,
      });
      assert.greaterThan(Number(pollRes.data?.poll?.poll_id), 0, '11th Poll card must create live poll_id');

      const storyRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'createStory',
        payload: { mediaId: fileId, mediaType: 'photo', caption: '12th Story Card', privacy: 'everyone' },
        expectOk: true,
      });
      assert.isNonEmptyString(storyRes.data?.story_id ?? storyRes.data?.id, '12th Story item must return story_id');

      const histRes = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, {
        token: bob.token,
        query: { limit: 50 },
      });
      assert.httpStatus(histRes, 200, 'fetch rich cards history');
      const messages = histRes.json?.messages ?? [];
      assert.equal(messages.length, 12, 'Chat transcript must contain all 12 rich message cards (11 + Poll)');

      const observedTypes = new Set(messages.map((m) => m.content?.type));
      for (const expectedType of [
        'Text',
        'Photo',
        'Video',
        'Voice',
        'VideoNote',
        'Media',
        'Audio',
        'Document',
        'Todo',
        'Invoice',
        'GenerativeCard',
        'Poll',
      ]) {
        assert.equal(observedTypes.has(expectedType), true, `History must preserve rich card variant ${expectedType}`);
      }

      const textMsg = messages[0];
      assert.includes(textMsg.text, '<think>Verify UTF-16 surrogate math</think>', '<think> reasoning span must survive');
      assert.equal(textMsg.content?.data?.entities?.length, 4, 'All 4 UTF-16 entities must round-trip');
      assert.equal(textMsg.inline_keyboard?.[0]?.[0]?.callback_data, 'act:approve', 'Inline keyboard must round-trip');
    },
  }),

  defineTest({
    id: 'T1-F10-02-reply-quote-forward-and-pin-banner-lifecycle',
    name: 'F10: Reply with quote_text, cross-chat Forward provenance, and Pin/Unpin banner with WS PinnedMessagesChanged',
    tier: 1,
    features: ['F10'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichUser(ctx, 'f10_t1_02_alice', 'alice_f10_02');
      const bob = await registerRichUser(ctx, 'f10_t1_02_bob', 'bob_f10_02');
      const chatA = await createRichGroup(ctx, alice, 'F10 Source Room', [bob.userId]);
      const chatB = await createRichGroup(ctx, alice, 'F10 Target Room', [bob.userId]);

      const bobWs = await ctx.connectWs(bob.token);
      await bobWs.subscribeChat(chatA);
      bobWs.clearBuffer();

      const rootMsg = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId: chatA, text: 'Canonical specification paragraph for quoting' },
        expectOk: true,
      });
      const rootId = Number(rootMsg.data?.message_id);

      const replyMsg = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: {
          chatId: chatA,
          text: 'Agreed on this quote!',
          replyTo: rootId,
          quoteText: 'Canonical specification',
        },
        expectOk: true,
      });
      assert.equal(Number(replyMsg.data?.reply_to), rootId, 'Reply response must reference parent message_id');

      const histA = await ctx.http.get(`/api/v1/chats/${chatA}/messages`, { token: alice.token });
      assert.httpStatus(histA, 200, 'chatA history');
      const storedReply = histA.json.messages.find((m) => Number(m.message_id) === Number(replyMsg.data.message_id));
      assert.equal(storedReply?.reply_to_info?.reply_to_msg_id, rootId, 'reply_to_info.reply_to_msg_id must match');
      assert.equal(storedReply?.reply_to_info?.quote_text, 'Canonical specification', 'quote_text must round-trip');

      const fwdCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'forwardMessages',
        payload: { fromChatId: chatA, toChatId: chatB, messageIds: [rootId] },
        expectOk: true,
      });
      assert.equal(fwdCli.data?.count, 1, 'forwardMessages must forward 1 message');

      const histB = await ctx.http.get(`/api/v1/chats/${chatB}/messages`, { token: bob.token });
      assert.httpStatus(histB, 200, 'chatB history');
      assert.equal(histB.json.messages.length, 1, 'chatB must contain forwarded message');
      assert.equal(
        Number(histB.json.messages[0]?.forward_info?.original_message_id),
        rootId,
        'forward_info.original_message_id must preserve source message ID',
      );

      const pinRes = await ctx.http.post(
        `/api/v1/chats/${chatA}/pins`,
        { message_id: rootId },
        { token: alice.token },
      );
      assert.httpStatus(pinRes, 200, 'pin message');
      assert.includes(pinRes.json?.pinned_message_ids ?? [], rootId, 'Pinned IDs must include rootId');

      const pinWs = await bobWs.waitForFrame(
        (f) => f.type === 'Update' && f.payload?.type === 'PinnedMessagesChanged',
        8_000,
      );
      assert.equal(Number(pinWs.payload?.data?.chat_id), chatA, 'PinnedMessagesChanged event must match chatA');

      const unpinCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'unpinMessage',
        payload: { chatId: chatA, messageId: rootId },
        expectOk: true,
      });
      assert.equal(unpinCli.data?.unpinned, true, 'CLI unpinMessage must succeed');

      const pinsAfter = await ctx.http.get(`/api/v1/chats/${chatA}/pins`, { token: bob.token });
      assert.httpStatus(pinsAfter, 200, 'list pins after unpin');
      assert.notIncludes(pinsAfter.json?.pinned_message_ids ?? [], rootId, 'Unpinned message must be removed from pins');
    },
  }),

  defineTest({
    id: 'T1-F10-03-edit-and-delete-revoke-monotonic-pts-and-ws-push',
    name: 'F10: Message Edit and Delete/Revoke advance monotonic PTS and broadcast live WS EditMessage and DeleteMessages updates',
    tier: 1,
    features: ['F10'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichUser(ctx, 'f10_t1_03_alice', 'alice_f10_03');
      const bob = await registerRichUser(ctx, 'f10_t1_03_bob', 'bob_f10_03');
      const chatId = await createRichGroup(ctx, alice, 'F10 Edit & Revoke', [bob.userId]);

      const bobWs = await ctx.connectWs(bob.token);
      await bobWs.subscribeChat(chatId);

      const m1 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Draft v1' },
        expectOk: true,
      });
      const m2 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Temporary message to revoke' },
        expectOk: true,
      });
      const msg1Id = Number(m1.data?.message_id);
      const msg2Id = Number(m2.data?.message_id);
      const ptsBeforeEdit = Number(m2.data?.pts);

      bobWs.clearBuffer();

      const editRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'editMessage',
        payload: { chatId, messageId: msg1Id, text: 'Published v2 (edited)' },
        expectOk: true,
      });
      assert.equal(editRes.data?.edited, true, 'editMessage must return edited=true');

      const editPush = await bobWs.waitForFrame(
        (f) =>
          f.type === 'PtsPush' &&
          Number(f.payload?.chat_id) === chatId &&
          f.payload?.event?.type === 'EditMessage',
        8_000,
      );
      const editPts = Number(editPush.payload?.pts);
      assert.equal(editPts, ptsBeforeEdit + 1, 'EditMessage must increment PTS by 1');

      const delRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'deleteMessages',
        payload: { chatId, messageIds: [msg2Id], revoke: true },
        expectOk: true,
      });
      assert.equal(delRes.data?.deleted, true, 'deleteMessages must return deleted=true');

      const delPush = await bobWs.waitForFrame(
        (f) =>
          f.type === 'PtsPush' &&
          Number(f.payload?.chat_id) === chatId &&
          f.payload?.event?.type === 'DeleteMessages',
        8_000,
      );
      assert.equal(Number(delPush.payload?.pts), editPts + 1, 'DeleteMessages must increment PTS by 1');

      const hist = await ctx.http.get(`/api/v1/chats/${chatId}/messages`, { token: bob.token });
      assert.httpStatus(hist, 200, 'history after edit and revoke');
      assert.equal(hist.json.messages.length, 1, 'Revoked message must be purged from history');
      assert.equal(hist.json.messages[0].text, 'Published v2 (edited)', 'Edited text must persist');
      assert.equal(hist.json.messages[0].is_edited, true, 'is_edited flag must be true');
      assert.greaterThan(Number(hist.json.messages[0].edit_date_ms), 0, 'edit_date_ms must be populated');
    },
  }),

  defineTest({
    id: 'T1-F10-04-emoji-reactions-toggle-add-remove-and-ws-push',
    name: 'F10: Multi-user Emoji Reactions toggle, add, and remove update ReactionCount and push WS ReactionUpdated',
    tier: 1,
    features: ['F10'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichUser(ctx, 'f10_t1_04_alice', 'alice_f10_04');
      const bob = await registerRichUser(ctx, 'f10_t1_04_bob', 'bob_f10_04');
      const chatId = await createRichGroup(ctx, alice, 'F10 Reactions Stage', [bob.userId]);

      const bobWs = await ctx.connectWs(bob.token);
      await bobWs.subscribeChat(chatId);

      const msg = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'React to this announcement!' },
        expectOk: true,
      });
      const msgId = Number(msg.data?.message_id);
      bobWs.clearBuffer();

      const r1 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'toggleReaction',
        payload: { chatId, messageId: msgId, emoji: '🚀', reactionAction: 'add' },
        expectOk: true,
      });
      assert.equal(r1.data?.success, true, 'Alice reaction add must succeed');

      const reactPush = await bobWs.waitForFrame(
        (f) =>
          f.type === 'PtsPush' &&
          Number(f.payload?.chat_id) === chatId &&
          f.payload?.event?.type === 'ReactionUpdated',
        8_000,
      );
      assert.greaterThan(Number(reactPush.payload?.pts), Number(msg.data?.pts), 'ReactionUpdated must advance PTS');

      const r2 = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'toggleReaction',
        payload: { chatId, messageId: msgId, emoji: '🚀', reactionAction: 'add' },
        expectOk: true,
      });
      const rocketEntry = (r2.data?.reactions ?? []).find((x) => x.emoji === '🚀');
      assert.equal(rocketEntry?.count, 2, 'Rocket reaction count must equal 2 after Alice + Bob react');
      assert.equal(rocketEntry?.is_chosen_by_me, true, 'Bob perspective must mark is_chosen_by_me=true');

      const r3 = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'toggleReaction',
        payload: { chatId, messageId: msgId, emoji: '🚀', reactionAction: 'remove' },
        expectOk: true,
      });
      const afterRemove = (r3.data?.reactions ?? []).find((x) => x.emoji === '🚀');
      assert.equal(afterRemove?.count, 1, 'Removing Alice reaction must decrement count to 1');
      assert.equal(afterRemove?.is_chosen_by_me, false, 'Alice perspective must mark is_chosen_by_me=false');
    },
  }),

  defineTest({
    id: 'T1-F10-05-polls-and-quiz-create-vote-retract-reveal-and-close',
    name: 'F10: Native Poll and Quiz create, vote, retract, quiz solution reveal, creator close, and WS PollUpdated',
    tier: 1,
    features: ['F10'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichUser(ctx, 'f10_t1_05_alice', 'alice_f10_05');
      const bob = await registerRichUser(ctx, 'f10_t1_05_bob', 'bob_f10_05');
      const chatId = await createRichGroup(ctx, alice, 'F10 Polls & Quizzes', [bob.userId]);

      const bobWs = await ctx.connectWs(bob.token);
      await bobWs.subscribeChat(chatId);

      const pollCreate = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'createPoll',
        payload: {
          chatId,
          question: 'Best mobile runtime?',
          options: ['HarmonyOS NEXT', 'Other'],
          isAnonymous: false,
        },
        expectOk: true,
      });
      const pollId = Number(pollCreate.data?.poll?.poll_id);
      assert.greaterThan(pollId, 0, 'Created poll_id must be positive');

      bobWs.clearBuffer();
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'votePoll',
        payload: { pollId, optionIds: [0] },
        expectOk: true,
      });
      const pollPush = await bobWs.waitForFrame(
        (f) => f.type === 'PtsPush' && f.payload?.event?.type === 'PollUpdated',
        8_000,
      );
      assert.equal(Number(pollPush.payload?.chat_id), chatId, 'PollUpdated push must target chatId');

      const bobVote = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'votePoll',
        payload: { pollId, optionIds: [1] },
        expectOk: true,
      });
      assert.equal(bobVote.data?.poll?.total_voters, 2, 'total_voters must reach 2');
      assert.equal(bobVote.data?.poll?.options?.[0]?.percentage, 50, 'Option 0 percentage must be 50%');
      assert.equal(bobVote.data?.poll?.options?.[1]?.percentage, 50, 'Option 1 percentage must be 50%');

      const aliceRetract = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'votePoll',
        payload: { pollId, optionIds: [0] },
        expectOk: true,
      });
      assert.equal(aliceRetract.data?.poll?.total_voters, 1, 'Re-submitting same single-choice vote must retract it');

      const quizCreate = await ctx.http.post(
        `/api/v1/chats/${chatId}/polls`,
        {
          question: '2 + 2 = ?',
          options: ['3', '4', '5'],
          is_quiz: true,
          correct_option_id: 1,
          solution: 'Elementary arithmetic: 2 + 2 = 4',
        },
        { token: alice.token },
      );
      assert.httpStatus(quizCreate, 201, 'create quiz poll');
      const quizId = Number(quizCreate.json?.poll?.poll_id);

      const preVoteQuiz = await ctx.http.get(`/api/v1/polls/${quizId}`, { token: bob.token });
      assert.httpStatus(preVoteQuiz, 200, 'get quiz before vote');
      assert.equal(preVoteQuiz.json?.correct_option_id ?? null, null, 'Quiz must hide correct_option_id before voting');
      assert.equal(preVoteQuiz.json?.solution ?? null, null, 'Quiz must hide solution before voting');

      const bobQuizVote = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'votePoll',
        payload: { pollId: quizId, optionIds: [0] },
        expectOk: true,
      });
      assert.equal(bobQuizVote.data?.poll?.correct_option_id, 1, 'Voting on quiz must reveal correct_option_id');
      assert.equal(
        bobQuizVote.data?.poll?.solution,
        'Elementary arithmetic: 2 + 2 = 4',
        'Voting on quiz must reveal solution explanation',
      );

      const closeQuiz = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'closePoll',
        payload: { pollId: quizId },
        expectOk: true,
      });
      assert.equal(closeQuiz.data?.poll?.is_closed, true, 'Creator closePoll must set is_closed=true');
    },
  }),

  defineTest({
    id: 'T1-F10-06-ephemeral-stories-24h-lifecycle-instant-view-translate-and-report',
    name: 'F10: Ephemeral 24h Stories create/list/view/delete plus Instant View reader, bilingual Translate, and Report via CLI',
    tier: 1,
    features: ['F10'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerRichUser(ctx, 'f10_t1_06_alice', 'alice_f10_06');
      const bob = await registerRichUser(ctx, 'f10_t1_06_bob', 'bob_f10_06');
      const chatId = await createRichGroup(ctx, alice, 'F10 Stories & IV', [bob.userId]);

      const aliceWs = await ctx.connectWs(alice.token);
      aliceWs.clearBuffer();

      const upload = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'media',
        action: 'uploadFile',
        payload: {
          filename: 'story_cover.png',
          mimeType: 'image/png',
          dataBase64: Buffer.from('story-image-bytes-v1').toString('base64'),
        },
        expectOk: true,
      });
      const mediaId = upload.data?.file_id;

      const createdStory = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'createStory',
        payload: {
          mediaId,
          mediaType: 'photo',
          caption: 'HarmonyOS Launch Day',
          privacy: 'everyone',
        },
        expectOk: true,
      });
      const storyId = createdStory.data?.story_id ?? createdStory.data?.id;
      assert.isNonEmptyString(storyId, 'Created story must have story_id');
      assert.equal(
        Number(createdStory.data?.expires_at_ms) - Number(createdStory.data?.created_at_ms),
        86_400_000,
        'Default story TTL must equal 24 hours (86,400,000 ms)',
      );

      const storyWs = await aliceWs.waitForFrame(
        (f) => f.type === 'Update' && f.payload?.type === 'StoryUpdated',
        8_000,
      );
      assert.isObject(storyWs.payload, 'StoryUpdated WS frame must be emitted');

      const listed = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'listStories',
        payload: {},
        expectOk: true,
      });
      assert.greaterThanOrEqual(listed.data?.count, 1, 'Bob listStories must include Alice active story');

      const viewed = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'viewStory',
        payload: { storyId },
        expectOk: true,
      });
      assert.equal(Number(viewed.data?.views_count), 1, 'First Bob viewStory must set views_count=1');

      const deleted = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'deleteStory',
        payload: { storyId },
        expectOk: true,
      });
      assert.equal(deleted.data?.deleted, true, 'Owner deleteStory must return deleted=true');

      const ivRes = await invokeEngine(ctx, {
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'openInstantView',
        payload: {
          url: 'https://harmony.example.org/release-v1-2',
          markdown: '# Harmony Native v1.2\n\n## Highlights\n\n> Zero-ACL security\n\nFull Rust + ArkTS parity.',
        },
        expectOk: true,
      });
      assert.equal(ivRes.data?.title, 'Harmony Native v1.2', 'Instant View must extract H1 title');
      assert.equal(ivRes.data?.blocks?.length, 4, 'Instant View must parse heading/subheading/quote/paragraph');
      assert.greaterThanOrEqual(Number(ivRes.data?.readingTimeSeconds), 5, 'readingTimeSeconds must be >= 5');

      const msg = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: 'Hello HarmonyOS world' },
        expectOk: true,
      });
      const trZh = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'translateMessage',
        payload: { chatId, messageId: msg.data.message_id, targetLang: 'zh-CN' },
        expectOk: true,
      });
      assert.equal(trZh.data?.detectedSourceLang, 'en-US', 'English text must detect source en-US');
      assert.includes(trZh.data?.translatedText, 'Hello HarmonyOS world', 'Translated output must carry content');

      const rpt = await invokeEngine(ctx, {
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'reportMessage',
        payload: { chatId, messageId: msg.data.message_id, reason: 'spam' },
        expectOk: true,
      });
      assert.equal(rpt.data?.reported, true, 'reportMessage must return reported=true');
      assert.isNonEmptyString(rpt.data?.reportId, 'reportMessage must generate reportId');
    },
  }),
];

export default tests;
