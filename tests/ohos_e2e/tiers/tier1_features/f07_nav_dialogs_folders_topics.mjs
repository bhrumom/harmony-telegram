import * as assert from '../../lib/assert.mjs';
import { NAV_DESTINATIONS } from '../../lib/constants.mjs';
import { defineTest } from '../../lib/registry.mjs';

export const tests = [
  defineTest({
    id: 'T1-F07-01-nine-destination-navrail-and-main-menu-drawer-ui-session',
    name: 'F7: 9-destination NavRail (chats..settings), MainMenuDrawer toggle, night toggle, and chat/topic navigation via ohos-app-cli uiSession',
    tier: 1,
    features: ['F7'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const navSb = ctx.createClientSandbox('f07_nav_shell');

      await ctx.cli.invoke({
        sandbox: navSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f07_nav_user',
          password: 'NavUserPassword!1',
          firstName: 'Nav Explorer',
        },
        expectOk: true,
      });

      const forumChat = await ctx.cli.invoke({
        sandbox: navSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: {
          title: 'NavRail Forum Hub',
          chatType: 'supergroup',
          isForum: true,
        },
        expectOk: true,
      });
      const chatId = forumChat.data.chat_id;

      const topicRes = await ctx.cli.invoke({
        sandbox: navSb,
        serverUrl: server.baseUrl,
        domain: 'topics',
        action: 'createTopic',
        payload: { chatId, title: 'Architecture Announcements' },
        expectOk: true,
      });
      const topicId = topicRes.data?.topic_id ?? topicRes.data?.id;
      assert.greaterThan(topicId, 0, 'createTopic must allocate positive topicId');

      const steps = [
        { op: 'resizeWindow', widthVp: 1280 },
        { op: 'toggleDrawer', open: true },
        { op: 'setTheme', themeId: 'night' },
        { op: 'toggleDrawer', open: false },
      ];
      for (const nav of NAV_DESTINATIONS) {
        steps.push({ op: 'navigate', nav });
      }
      steps.push(
        { op: 'shortcut', key: 'b', ctrl: true },
        { op: 'shortcut', key: 'Escape', ctrl: false },
        { op: 'navigate', nav: 'chats', chatId, topicId },
        { op: 'invoke', domain: 'dialogs', action: 'listChats', payload: {} },
      );

      const uiRes = await ctx.cli.uiSession({
        sandbox: navSb,
        serverUrl: server.baseUrl,
        script: {
          initialWindowWidthVp: 1280,
          steps,
        },
        expectOk: true,
      });

      const stepResults = uiRes.data?.stepResults;
      assert.isArray(stepResults, 'uiSession must return stepResults array');
      assert.equal(stepResults.length, steps.length, 'All uiSession steps must execute');
      assert.equal(stepResults[1]?.drawerOpen, true, 'MainMenuDrawer open step must set drawerOpen=true');
      assert.equal(stepResults[3]?.drawerOpen, false, 'MainMenuDrawer close step must set drawerOpen=false');

      const navigatedTabs = stepResults.slice(4, 4 + NAV_DESTINATIONS.length).map((s) => s.activeNav);
      assert.deepEqual(navigatedTabs, Array.from(NAV_DESTINATIONS), 'All 9 NavRail destinations must activate in order');

      const finalState = uiRes.data?.finalState;
      assert.equal(finalState?.authState, 'authenticated', 'uiSession must preserve authenticated state');
      assert.equal(finalState?.activeNav, 'chats', 'Final navigate step must target chats');
      assert.equal(finalState?.activeChatId, chatId, 'Final state must track activeChatId');
      assert.equal(finalState?.activeTopicId, topicId, 'Final state must track activeTopicId');
      assert.equal(finalState?.drawerOpen, false, 'Escape shortcut must close MainMenuDrawer');
    },
  }),

  defineTest({
    id: 'T1-F07-02-chat-creation-and-dialog-listing-all-peer-kinds',
    name: 'F7: Chat creation, update, and dialog listing across Group, Channel, Direct DM (idempotent dedup), Saved, and Welcome Bot',
    tier: 1,
    features: ['F7'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const aliceSb = ctx.createClientSandbox('f07_dialogs_alice');

      const aliceReg = await ctx.cli.invoke({
        sandbox: aliceSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f07_dialogs_alice',
          password: 'DialogsPassword!1',
          firstName: 'Alice Dialogs',
        },
        expectOk: true,
      });
      const aliceToken = aliceReg.data.session.token;

      const bobReg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_dialogs_bob', password: 'DialogsPassword!2', first_name: 'Bob Peer' },
        {},
      );
      assert.httpStatus(bobReg, 201, 'Register peer Bob');
      const bobUid = bobReg.json.user_id;

      // 1. Group via CLI createChat + updateChat
      const grpCli = await ctx.cli.invoke({
        sandbox: aliceSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: {
          title: 'Harmony Core Team',
          chatType: 'group',
          memberIds: [bobUid],
          about: 'Initial group description',
        },
        expectOk: true,
      });
      const groupId = grpCli.data.chat_id;
      assert.greaterThan(groupId, 0, 'CLI createChat (group) must allocate chat_id');

      const updCli = await ctx.cli.invoke({
        sandbox: aliceSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'updateChat',
        payload: {
          chatId: groupId,
          title: 'Harmony Core Engineering',
          about: 'Updated Stage Model engineering group',
        },
        expectOk: true,
      });
      assert.equal(updCli.data?.chatId, groupId, 'CLI updateChat must confirm updated chatId');

      // 2. Channel via HTTP POST /api/v1/chats/create
      const chanRes = await ctx.http.post(
        '/api/v1/chats/create',
        {
          title: 'Fabushi Broadcast Channel',
          chat_type: 'channel',
          about: 'Official release announcements',
        },
        { token: aliceToken },
      );
      assert.httpStatus(chanRes, 201, 'POST /api/v1/chats/create (channel)');
      assert.equal(chanRes.json?.is_channel, true, 'Created channel must set is_channel=true');

      // 3. Direct DM idempotent deduplication
      const dm1 = await ctx.http.post(
        '/api/v1/chats/create',
        { chat_type: 'direct', peer_user_id: bobUid },
        { token: aliceToken },
      );
      const dm2 = await ctx.http.post(
        '/api/v1/chats/create',
        { chat_type: 'direct', peer_user_id: bobUid },
        { token: aliceToken },
      );
      assert.httpStatus(dm1, 201, 'First DM create');
      assert.httpStatus(dm2, 201, 'Second DM create');
      assert.equal(dm1.json?.chat_id, dm2.json?.chat_id, 'Repeated Direct DM creation with same peer must deduplicate');

      // 4. Saved Messages idempotent deduplication
      const saved1 = await ctx.http.post('/api/v1/chats/create', { chat_type: 'saved' }, { token: aliceToken });
      const saved2 = await ctx.http.post('/api/v1/chats/create', { chat_type: 'saved' }, { token: aliceToken });
      assert.httpStatus(saved1, 201, 'First Saved chat create');
      assert.equal(saved1.json?.chat_id, saved2.json?.chat_id, 'Saved Messages chat must deduplicate idempotently');

      // 5. Official Welcome Bot chat via CLI provisionWelcomeChat
      const welcomeCli = await ctx.cli.invoke({
        sandbox: aliceSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'provisionWelcomeChat',
        payload: {},
        expectOk: true,
      });
      assert.greaterThan(welcomeCli.data?.chat_id ?? welcomeCli.data?.id, 0, 'provisionWelcomeChat must return chat');

      // 6. Verify GET /api/v1/chats and CLI dialogs.listChats / dialogs.getChat
      const httpDialogs = await ctx.http.get('/api/v1/chats', { token: aliceToken });
      assert.httpStatus(httpDialogs, 200, 'GET /api/v1/chats');
      const chatIds = httpDialogs.json.chats.map((c) => c.chat_id);
      assert.includes(chatIds, groupId, 'Dialog list must include Group');
      assert.includes(chatIds, chanRes.json.chat_id, 'Dialog list must include Channel');
      assert.includes(chatIds, dm1.json.chat_id, 'Dialog list must include Direct DM');
      assert.includes(chatIds, saved1.json.chat_id, 'Dialog list must include Saved Messages');

      const cliDialogs = await ctx.cli.invoke({
        sandbox: aliceSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'listChats',
        payload: {},
        expectOk: true,
      });
      assert.greaterThanOrEqual(cliDialogs.data?.count, 5, 'CLI listChats must return all 5 dialog kinds');

      const getGrp = await ctx.cli.invoke({
        sandbox: aliceSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'getChat',
        payload: { chatId: groupId },
        expectOk: true,
      });
      assert.equal(getGrp.data?.title, 'Harmony Core Engineering', 'getChat must reflect updated group title');
    },
  }),

  defineTest({
    id: 'T1-F07-03-custom-chat-folders-crud-and-ws-folder-changed-push',
    name: 'F7: Custom Chat Folders CRUD (/api/v1/folders* + ohos-app-cli folders) and live WebSocket FolderChanged push events',
    tier: 1,
    features: ['F7'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const folderSb = ctx.createClientSandbox('f07_folders');

      const reg = await ctx.cli.invoke({
        sandbox: folderSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f07_folder_user',
          password: 'FolderUserPass!3',
          firstName: 'Folder User',
        },
        expectOk: true,
      });
      const token = reg.data.session.token;

      const chatA = await ctx.cli.invoke({
        sandbox: folderSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Work Engineering', chatType: 'group' },
        expectOk: true,
      });
      const chatB = await ctx.cli.invoke({
        sandbox: folderSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Muted Noise', chatType: 'group' },
        expectOk: true,
      });

      const ws = await ctx.connectWs(token);
      await ws.ping(70301);
      ws.clearBuffer();

      // 1. Create folder via CLI folders.createFolder -> assert WS FolderChanged
      const created = await ctx.cli.invoke({
        sandbox: folderSb,
        serverUrl: server.baseUrl,
        domain: 'folders',
        action: 'createFolder',
        payload: {
          title: 'HarmonyOS Work',
          icon: '💼',
          includedChatIds: [chatA.data.chat_id],
          excludedChatIds: [chatB.data.chat_id],
          includeGroups: true,
          includeChannels: false,
        },
        expectOk: true,
      });
      const folderId = created.data?.id ?? created.data?.folder_id;
      assert.greaterThan(folderId, 0, 'createFolder must return positive folder id');

      const wsCreateEvt = await ws.waitForFrame(
        (f) => f.type === 'Update' && f.payload?.type === 'FolderChanged',
        8_000,
      );
      assert.equal(
        wsCreateEvt.payload?.data?.folder?.title,
        'HarmonyOS Work',
        'WebSocket FolderChanged push must broadcast newly created folder title',
      );

      // 2. List folders via HTTP and CLI
      const httpList = await ctx.http.get('/api/v1/folders', { token });
      assert.httpStatus(httpList, 200, 'GET /api/v1/folders');
      assert.equal(httpList.json?.folders?.length, 1, 'GET /api/v1/folders must return 1 folder');
      assert.includes(
        httpList.json.folders[0].include_chats,
        chatA.data.chat_id,
        'Folder include_chats must contain chatA',
      );

      const cliList = await ctx.cli.invoke({
        sandbox: folderSb,
        serverUrl: server.baseUrl,
        domain: 'folders',
        action: 'listFolders',
        payload: {},
        expectOk: true,
      });
      assert.equal(cliList.data?.count, 1, 'CLI listFolders must return count=1');

      // 3. Update folder via CLI folders.updateFolder (PUT /api/v1/folders/{id}) -> assert WS FolderChanged
      ws.clearBuffer();
      const updated = await ctx.cli.invoke({
        sandbox: folderSb,
        serverUrl: server.baseUrl,
        domain: 'folders',
        action: 'updateFolder',
        payload: {
          folderId,
          title: 'HarmonyOS Priority',
          icon: '🚀',
          includedChatIds: [chatA.data.chat_id, chatB.data.chat_id],
          excludedChatIds: [],
          includeGroups: true,
          includeChannels: true,
        },
        expectOk: true,
      });
      assert.equal(updated.data?.title, 'HarmonyOS Priority', 'updateFolder must return updated title');

      const wsUpdateEvt = await ws.waitForFrame(
        (f) => f.type === 'Update' && f.payload?.type === 'FolderChanged',
        8_000,
      );
      assert.equal(
        wsUpdateEvt.payload?.data?.folder?.title,
        'HarmonyOS Priority',
        'WebSocket FolderChanged push must reflect updated folder title',
      );

      // 4. Delete folder via CLI folders.deleteFolder -> verify empty list
      const delRes = await ctx.cli.invoke({
        sandbox: folderSb,
        serverUrl: server.baseUrl,
        domain: 'folders',
        action: 'deleteFolder',
        payload: { folderId },
        expectOk: true,
      });
      assert.equal(delRes.data?.deleted, true, 'deleteFolder must return deleted=true');

      const afterDel = await ctx.cli.invoke({
        sandbox: folderSb,
        serverUrl: server.baseUrl,
        domain: 'folders',
        action: 'listFolders',
        payload: {},
        expectOk: true,
      });
      assert.equal(afterDel.data?.count, 0, 'listFolders must be empty after deleteFolder');
    },
  }),

  defineTest({
    id: 'T1-F07-04-forum-topics-crud-and-group-to-supergroup-auto-upgrade',
    name: 'F7: Forum Topics CRUD (/api/v1/chats/{id}/topics* + CLI topics), is_forum group(1)->supergroup(2) auto-upgrade, and topic-isolated history',
    tier: 1,
    features: ['F7'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const topicSb = ctx.createClientSandbox('f07_topics');

      const reg = await ctx.cli.invoke({
        sandbox: topicSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f07_forum_admin',
          password: 'ForumAdminPass!4',
          firstName: 'Forum Admin',
        },
        expectOk: true,
      });
      const token = reg.data.session.token;

      // 1. Create chat with chat_type=1 (group) + is_forum=true -> server must auto-upgrade to chat_type=2 (supergroup)
      const createForum = await ctx.http.post(
        '/api/v1/chats/create',
        {
          title: 'OpenHarmony Kernel Forum',
          chat_type: 1,
          is_forum: true,
        },
        { token },
      );
      assert.httpStatus(createForum, 201, 'POST /api/v1/chats/create with chat_type=1 & is_forum=true');
      assert.equal(createForum.json?.is_forum, true, 'Created chat must set is_forum=true');
      assert.equal(createForum.json?.chat_type, 2, 'is_forum=true on group(1) must auto-upgrade chat_type to supergroup(2)');
      assert.equal(createForum.json?.kind, 'supergroup', 'Auto-upgraded forum chat kind must equal supergroup');
      const forumChatId = createForum.json.chat_id;

      // 2. Create 2 topics (one via CLI, one via HTTP)
      const t1Cli = await ctx.cli.invoke({
        sandbox: topicSb,
        serverUrl: server.baseUrl,
        domain: 'topics',
        action: 'createTopic',
        payload: {
          chatId: forumChatId,
          title: 'ArkTS UI Layout',
          iconColor: 0x6FB9F0,
        },
        expectOk: true,
      });
      const topic1Id = t1Cli.data?.topic_id ?? t1Cli.data?.id;
      assert.greaterThan(topic1Id, 0, 'CLI createTopic must allocate topic1Id');

      const t2Http = await ctx.http.post(
        `/api/v1/chats/${forumChatId}/topics`,
        { title: 'Rust N-API FFI', icon_color: 0xFFD67E },
        { token },
      );
      assert.httpStatus(t2Http, 201, 'POST /api/v1/chats/{id}/topics');
      const topic2Id = t2Http.json?.topic_id;
      assert.greaterThan(topic2Id, 0, 'HTTP create topic must allocate topic2Id');
      assert.notEqual(topic1Id, topic2Id, 'Distinct forum topics must have distinct topic_ids');

      // 3. Update topic1 (rename + pin + close) via CLI topics.updateTopic (PUT)
      const updT1 = await ctx.cli.invoke({
        sandbox: topicSb,
        serverUrl: server.baseUrl,
        domain: 'topics',
        action: 'updateTopic',
        payload: {
          chatId: forumChatId,
          topicId: topic1Id,
          title: 'ArkTS V2 Adaptive Shell',
          isPinned: true,
          isClosed: true,
        },
        expectOk: true,
      });
      assert.equal(updT1.data?.updated, true, 'CLI updateTopic must succeed');

      const listTopicsCli = await ctx.cli.invoke({
        sandbox: topicSb,
        serverUrl: server.baseUrl,
        domain: 'topics',
        action: 'listTopics',
        payload: { chatId: forumChatId },
        expectOk: true,
      });
      assert.greaterThanOrEqual(listTopicsCli.data?.count, 2, 'listTopics must include both created topics');
      const foundT1 = listTopicsCli.data.topics.find((t) => (t.topic_id ?? t.id) === topic1Id);
      assert.equal(foundT1?.title, 'ArkTS V2 Adaptive Shell', 'Updated topic title must persist');

      // 4. Send messages scoped to topic1 vs topic2 and verify isolated per-topic history
      const sendM1 = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: forumChatId, topic_id: topic1Id, text: 'Message strictly in Topic One' },
        { token },
      );
      const sendM2 = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: forumChatId, topic_id: topic2Id, text: 'Message strictly in Topic Two' },
        { token },
      );
      assert.httpStatus(sendM1, [200, 201], 'Send message to topic1');
      assert.httpStatus(sendM2, [200, 201], 'Send message to topic2');

      const histT1 = await ctx.http.get(`/api/v1/chats/${forumChatId}/messages`, {
        token,
        query: { topic_id: topic1Id },
      });
      assert.httpStatus(histT1, 200, 'GET topic1 message history');
      const histT1Str = JSON.stringify(histT1.json);
      assert.includes(histT1Str, 'Message strictly in Topic One', 'Topic 1 history must include Topic 1 message');
      assert.notIncludes(histT1Str, 'Message strictly in Topic Two', 'Topic 1 history must exclude Topic 2 message');

      // 5. Delete topic2 via CLI topics.deleteTopic
      const delT2 = await ctx.cli.invoke({
        sandbox: topicSb,
        serverUrl: server.baseUrl,
        domain: 'topics',
        action: 'deleteTopic',
        payload: { chatId: forumChatId, topicId: topic2Id },
        expectOk: true,
      });
      assert.equal(delT2.data?.deleted, true, 'CLI deleteTopic must delete topic2');
    },
  }),

  defineTest({
    id: 'T1-F07-05-dialog-flags-archive-pin-mute-ttl-and-per-user-isolation',
    name: 'F7: Dialog archive, pin, mute, and auto-delete TTL via REST and CLI with pinned sort priority and per-user flag isolation',
    tier: 1,
    features: ['F7'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const userASb = ctx.createClientSandbox('f07_flags_a');

      const regA = await ctx.cli.invoke({
        sandbox: userASb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f07_flags_alice',
          password: 'FlagsPassword!5',
          firstName: 'Alice Flags',
        },
        expectOk: true,
      });
      const tokenA = regA.data.session.token;

      const regB = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_flags_bob', password: 'FlagsPassword!6', first_name: 'Bob Flags' },
        {},
      );
      assert.httpStatus(regB, 201, 'Register Bob');
      const tokenB = regB.json.token;
      const bobUid = regB.json.user_id;

      const sharedGroup1 = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Shared Unpinned Group', chat_type: 'group', member_ids: [bobUid] },
        { token: tokenA },
      );
      const sharedGroup2 = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Shared Pinned Group', chat_type: 'group', member_ids: [bobUid] },
        { token: tokenA },
      );
      const gid1 = sharedGroup1.json.chat_id;
      const gid2 = sharedGroup2.json.chat_id;

      // Send a newer message to gid1 so without pinning gid1 would sort above gid2
      await ctx.http.post('/api/v1/messages/send', { chat_id: gid1, text: 'Latest unpinned activity' }, { token: tokenA });

      // User A pins gid2, archives gid1, mutes gid2, and sets 86400s TTL on gid2 via CLI
      const pinRes = await ctx.cli.invoke({
        sandbox: userASb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'setPin',
        payload: { chatId: gid2, pinned: true },
        expectOk: true,
      });
      assert.equal(pinRes.data?.pinned, true, 'setPin must return pinned=true');

      const archRes = await ctx.cli.invoke({
        sandbox: userASb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'setArchive',
        payload: { chatId: gid1, archived: true },
        expectOk: true,
      });
      assert.equal(archRes.data?.archived, true, 'setArchive must return archived=true');

      const muteUntil = Date.now() + 3_600_000;
      const muteRes = await ctx.cli.invoke({
        sandbox: userASb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'setMute',
        payload: { chatId: gid2, muted: true, muteUntilMs: muteUntil },
        expectOk: true,
      });
      assert.equal(muteRes.data?.muted, true, 'setMute must return muted=true');

      const ttlRes = await ctx.cli.invoke({
        sandbox: userASb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'setTtl',
        payload: { chatId: gid2, ttlSeconds: 86_400 },
        expectOk: true,
      });
      assert.equal(ttlRes.data?.ttlSeconds, 86_400, 'setTtl must apply 86400s TTL');

      // Verify User A dialog list: gid2 sorts first (is_pinned=true) and carries muted + TTL; gid1 has is_archived=true
      const listA = await ctx.http.get('/api/v1/chats', { token: tokenA });
      assert.httpStatus(listA, 200, 'GET /api/v1/chats for User A');
      assert.equal(listA.json.chats[0].chat_id, gid2, 'Pinned chat gid2 must sort first in User A dialog list');
      assert.equal(listA.json.chats[0].is_pinned, true, 'gid2 must report is_pinned=true for User A');
      assert.equal(listA.json.chats[0].is_muted, true, 'gid2 must report is_muted=true for User A');
      assert.equal(listA.json.chats[0].message_ttl_seconds, 86_400, 'gid2 must report message_ttl_seconds=86400');

      const gid1ForA = listA.json.chats.find((c) => c.chat_id === gid1);
      assert.equal(gid1ForA?.is_archived, true, 'gid1 must report is_archived=true for User A');

      // Verify User B's personal pin/archive/mute flags on shared groups remain untouched (false)
      const listB = await ctx.http.get('/api/v1/chats', { token: tokenB });
      assert.httpStatus(listB, 200, 'GET /api/v1/chats for User B');
      const gid1ForB = listB.json.chats.find((c) => c.chat_id === gid1);
      const gid2ForB = listB.json.chats.find((c) => c.chat_id === gid2);
      assert.equal(gid1ForB?.is_archived, false, 'User A archive flag must not leak to User B');
      assert.equal(gid2ForB?.is_pinned, false, 'User A pin flag must not leak to User B');
      assert.equal(gid2ForB?.is_muted, false, 'User A mute flag must not leak to User B');
    },
  }),

  defineTest({
    id: 'T1-F07-06-cloud-drafts-crud-and-ws-draft-updated-push',
    name: 'F7: Cloud Drafts CRUD (PUT/GET/DELETE /api/v1/chats/{id}/draft + saveDraft/getDraft/clearDraft) and live WebSocket DraftUpdated push',
    tier: 1,
    features: ['F7'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const draftSb = ctx.createClientSandbox('f07_drafts');

      const reg = await ctx.cli.invoke({
        sandbox: draftSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f07_draft_author',
          password: 'DraftAuthorPass!6',
          firstName: 'Draft Author',
        },
        expectOk: true,
      });
      const token = reg.data.session.token;

      const chatRes = await ctx.cli.invoke({
        sandbox: draftSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Cloud Draft Sync Room', chatType: 'supergroup', isForum: true },
        expectOk: true,
      });
      const chatId = chatRes.data.chat_id;

      const ws = await ctx.connectWs(token);
      await ws.ping(70601);
      ws.clearBuffer();

      // 1. Save cloud draft via PUT /api/v1/chats/{id}/draft -> assert WS DraftUpdated frame
      const putDraft = await ctx.http.put(
        `/api/v1/chats/${chatId}/draft`,
        { text: 'Unsent HarmonyOS NEXT release checklist' },
        { token },
      );
      assert.httpStatus(putDraft, 200, 'PUT /api/v1/chats/{id}/draft');
      assert.equal(
        putDraft.json?.draft?.text,
        'Unsent HarmonyOS NEXT release checklist',
        'PUT draft response must echo saved draft text',
      );

      const wsDraftEvt = await ws.waitForFrame(
        (f) => f.type === 'Update' && f.payload?.type === 'DraftUpdated',
        8_000,
      );
      assert.equal(wsDraftEvt.payload?.data?.chat_id, chatId, 'WS DraftUpdated must match chat_id');
      assert.equal(
        wsDraftEvt.payload?.data?.draft?.text,
        'Unsent HarmonyOS NEXT release checklist',
        'WS DraftUpdated must broadcast draft text',
      );

      // 2. Read draft via GET /api/v1/chats/{id}/draft and CLI dialogs.getDraft
      const getHttp = await ctx.http.get(`/api/v1/chats/${chatId}/draft`, { token });
      assert.httpStatus(getHttp, 200, 'GET /api/v1/chats/{id}/draft');
      assert.equal(getHttp.json?.draft?.text, 'Unsent HarmonyOS NEXT release checklist', 'GET draft must match');

      const getCli = await ctx.cli.invoke({
        sandbox: draftSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'getDraft',
        payload: { chatId },
        expectOk: true,
      });
      assert.equal(
        getCli.data?.draft?.text,
        'Unsent HarmonyOS NEXT release checklist',
        'CLI dialogs.getDraft must return saved cloud draft',
      );

      // 3. Clear draft via CLI dialogs.clearDraft & verify DELETE /api/v1/chats/{id}/draft
      const clearCli = await ctx.cli.invoke({
        sandbox: draftSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'clearDraft',
        payload: { chatId },
        expectOk: true,
      });
      assert.equal(clearCli.data?.cleared, true, 'CLI dialogs.clearDraft must return cleared=true');

      const afterClear = await ctx.http.get(`/api/v1/chats/${chatId}/draft`, { token });
      assert.httpStatus(afterClear, 200, 'GET draft after clearDraft');
      assert.equal(afterClear.json?.draft, null, 'Cleared draft must return null');

      // 4. Exercise CLI dialogs.saveDraft -> getDraft -> HTTP DELETE /draft
      const saveCli = await ctx.cli.invoke({
        sandbox: draftSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'saveDraft',
        payload: { chatId, text: 'Draft written via ohos-app-cli saveDraft' },
        expectOk: true,
      });
      assert.isObject(saveCli.data, 'CLI dialogs.saveDraft must return saved draft DTO');

      const delHttp = await ctx.http.del(`/api/v1/chats/${chatId}/draft`, undefined, { token });
      assert.httpStatus(delHttp, 200, 'DELETE /api/v1/chats/{id}/draft');
      assert.equal(delHttp.json?.cleared, true, 'DELETE draft must return cleared=true');
    },
  }),

  defineTest({
    id: 'T1-F07-07-invites-members-pinned-messages-clear-and-leave',
    name: 'F7: Group invite links, join, message pinning (WS PinnedMessagesChanged), clearHistory (WS DeleteMessages), and leaveChat',
    tier: 1,
    features: ['F7'],
    timeoutMs: 45_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const ownerSb = ctx.createClientSandbox('f07_owner_ops');
      const joinerSb = ctx.createClientSandbox('f07_joiner_ops');

      const ownerAuth = await ctx.cli.invoke({
        sandbox: ownerSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: { username: 'f07_ops_owner', password: 'OpsOwnerPass!7', firstName: 'Ops Owner' },
        expectOk: true,
      });
      const ownerToken = ownerAuth.data.session.token;

      const joinerAuth = await ctx.cli.invoke({
        sandbox: joinerSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: { username: 'f07_ops_joiner', password: 'OpsJoinerPass!8', firstName: 'Ops Joiner' },
        expectOk: true,
      });
      const joinerToken = joinerAuth.data.session.token;
      const joinerUid = joinerAuth.data.session.user_id;

      const groupRes = await ctx.cli.invoke({
        sandbox: ownerSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Invite & Pin Lifecycle Group', chatType: 'group' },
        expectOk: true,
      });
      const chatId = groupRes.data.chat_id;

      // 1. Create invite link and let joiner join via /api/v1/invites/join
      const invRes = await ctx.http.post(
        `/api/v1/chats/${chatId}/invites`,
        { title: 'Engineering Onboarding', usage_limit: 5 },
        { token: ownerToken },
      );
      assert.httpStatus(invRes, 201, 'POST /api/v1/chats/{id}/invites');
      const inviteCode = invRes.json?.code ?? invRes.json?.invite_id;
      assert.isNonEmptyString(inviteCode, 'Created invite must expose invite code');

      const joinRes = await ctx.http.post('/api/v1/invites/join', { code: inviteCode }, { token: joinerToken });
      assert.httpStatus(joinRes, 200, 'POST /api/v1/invites/join');
      assert.equal(joinRes.json?.joined, true, 'invites/join must return joined=true');

      const membersRes = await ctx.http.get(`/api/v1/chats/${chatId}/members`, { token: ownerToken });
      assert.httpStatus(membersRes, 200, 'GET /api/v1/chats/{id}/members');
      const memberIds = (membersRes.json?.members ?? []).map((m) => m.user_id);
      assert.includes(memberIds, joinerUid, 'Joined user must appear in group member list');

      // 2. Pin message -> verify WS PinnedMessagesChanged push
      const wsOwner = await ctx.connectWs(ownerToken);
      await wsOwner.ping(70701);

      const msgRes = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: chatId, text: 'Pinned architecture charter v1.2.0' },
        { token: ownerToken },
      );
      assert.httpStatus(msgRes, [200, 201], 'Send message to pin');
      const msgId = msgRes.json?.message_id ?? msgRes.json?.id;
      assert.greaterThan(msgId, 0, 'Sent message must return message_id');

      wsOwner.clearBuffer();
      const pinMsgRes = await ctx.http.post(
        `/api/v1/chats/${chatId}/pins`,
        { message_id: msgId },
        { token: ownerToken },
      );
      assert.httpStatus(pinMsgRes, 200, 'POST /api/v1/chats/{id}/pins');
      assert.includes(pinMsgRes.json?.pinned_message_ids ?? [], msgId, 'Pinned message ID must be listed');

      const wsPinEvt = await wsOwner.waitForFrame(
        (f) => f.type === 'Update' && f.payload?.type === 'PinnedMessagesChanged',
        8_000,
      );
      assert.includes(wsPinEvt.payload?.data?.pinned_ids ?? [], msgId, 'WS PinnedMessagesChanged must carry msgId');

      // 3. Clear history via CLI dialogs.clearHistory -> verify WS DeleteMessages
      wsOwner.clearBuffer();
      const clearRes = await ctx.cli.invoke({
        sandbox: ownerSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'clearHistory',
        payload: { chatId },
        expectOk: true,
      });
      assert.equal(clearRes.data?.cleared, true, 'CLI dialogs.clearHistory must succeed');

      const wsDelEvt = await wsOwner.waitForFrame(
        (f) => f.type === 'Update' && f.payload?.type === 'DeleteMessages',
        8_000,
      );
      assert.isObject(wsDelEvt.payload?.data, 'WS DeleteMessages frame must be emitted on clearHistory');

      // 4. Non-creator joiner leaves group via CLI dialogs.leaveChat -> owner still retains group
      const leaveRes = await ctx.cli.invoke({
        sandbox: joinerSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'leaveChat',
        payload: { chatId },
        expectOk: true,
      });
      assert.equal(leaveRes.data?.left, true, 'Non-creator leaveChat must succeed');

      const ownerStillHas = await ctx.http.get(`/api/v1/chats/${chatId}`, { token: ownerToken });
      assert.httpStatus(ownerStillHas, 200, 'Group must remain active for owner after member leaves');
    },
  }),
];

export default tests;
