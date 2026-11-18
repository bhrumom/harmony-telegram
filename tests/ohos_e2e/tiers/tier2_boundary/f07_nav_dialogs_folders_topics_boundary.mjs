import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

export const tests = [
  defineTest({
    id: 'T2-F07-01-non-admin-forum-topic-create-edit-delete-rejected-403',
    name: 'F7 Boundary: Non-admin group member creating, editing, or deleting a forum topic is rejected with 403 and CLI failure',
    tier: 2,
    features: ['F7'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const memberSb = ctx.createClientSandbox('f07_b_topic_member');

      const ownerReg = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_forum_owner', password: 'ForumOwnerPassword!1', first_name: 'Owner' },
        {},
      );
      assert.httpStatus(ownerReg, 201, 'Register forum owner');
      const ownerToken = ownerReg.json.token;

      const memberReg = await ctx.cli.invoke({
        sandbox: memberSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f07_b_forum_member',
          password: 'ForumMemberPassword!2',
          firstName: 'Regular Member',
        },
        expectOk: true,
      });
      const memberToken = memberReg.data.session.token;
      const memberUid = memberReg.data.session.user_id;

      const forum = await ctx.http.post(
        '/api/v1/chats/create',
        {
          title: 'Admin-Gated Forum',
          chat_type: 'supergroup',
          is_forum: true,
          member_ids: [memberUid],
        },
        { token: ownerToken },
      );
      assert.httpStatus(forum, 201, 'Create forum supergroup');
      const chatId = forum.json.chat_id;

      const ownerTopic = await ctx.http.post(
        `/api/v1/chats/${chatId}/topics`,
        { title: 'Protected Topic' },
        { token: ownerToken },
      );
      assert.httpStatus(ownerTopic, 201, 'Owner creates Protected Topic');
      const topicId = ownerTopic.json.topic_id;

      // 1. Regular member HTTP topic create / PUT update / DELETE -> all 403
      const memCreateHttp = await ctx.http.post(
        `/api/v1/chats/${chatId}/topics`,
        { title: 'Unauthorized Member Topic' },
        { token: memberToken },
      );
      assert.httpStatus(memCreateHttp, 403, 'Non-admin POST /topics must return 403');

      const memEditHttp = await ctx.http.put(
        `/api/v1/chats/${chatId}/topics/${topicId}`,
        { title: 'Hijacked Title', is_pinned: true },
        { token: memberToken },
      );
      assert.httpStatus(memEditHttp, 403, 'Non-admin PUT /topics/{id} must return 403');

      const memDelHttp = await ctx.http.del(
        `/api/v1/chats/${chatId}/topics/${topicId}`,
        undefined,
        { token: memberToken },
      );
      assert.httpStatus(memDelHttp, 403, 'Non-admin DELETE /topics/{id} must return 403');

      // 2. Regular member CLI topics.createTopic & deleteTopic -> expectOk: false
      const memCreateCli = await ctx.cli.invoke({
        sandbox: memberSb,
        serverUrl: server.baseUrl,
        domain: 'topics',
        action: 'createTopic',
        payload: { chatId, title: 'Unauthorized CLI Topic' },
        expectOk: false,
      });
      assert.equal(memCreateCli.ok, false, 'Non-admin CLI topics.createTopic must fail');

      const memDelCli = await ctx.cli.invoke({
        sandbox: memberSb,
        serverUrl: server.baseUrl,
        domain: 'topics',
        action: 'deleteTopic',
        payload: { chatId, topicId },
        expectOk: false,
      });
      assert.equal(memDelCli.ok, false, 'Non-admin CLI topics.deleteTopic must fail');

      // Verify Protected Topic remains intact
      const listAfter = await ctx.http.get(`/api/v1/chats/${chatId}/topics`, { token: ownerToken });
      const existing = (listAfter.json?.topics ?? []).find((t) => t.topic_id === topicId);
      assert.equal(existing?.title, 'Protected Topic', 'Protected Topic title must remain unmodified');
    },
  }),

  defineTest({
    id: 'T2-F07-02-non-admin-chat-info-ttl-pins-and-invite-rejected-403',
    name: 'F7 Boundary: Non-admin group member editing chat title/info, setting TTL, pinning messages, or creating invites rejected with 403',
    tier: 2,
    features: ['F7'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const memberSb = ctx.createClientSandbox('f07_b_chat_rbac');

      const owner = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_grp_owner', password: 'GroupOwnerPassword!2', first_name: 'Group Owner' },
        {},
      );
      const ownerToken = owner.json.token;

      const member = await ctx.cli.invoke({
        sandbox: memberSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f07_b_grp_member',
          password: 'GroupMemberPassword!2',
          firstName: 'Group Member',
        },
        expectOk: true,
      });
      const memberToken = member.data.session.token;
      const memberUid = member.data.session.user_id;

      const grp = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Immutable Charter Group', chat_type: 'group', member_ids: [memberUid] },
        { token: ownerToken },
      );
      const chatId = grp.json.chat_id;

      const msg = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: chatId, text: 'Charter message' },
        { token: ownerToken },
      );
      const msgId = msg.json?.message_id ?? msg.json?.id;

      // 1. Non-admin HTTP mutations -> 403
      const editTitle = await ctx.http.put(
        `/api/v1/chats/${chatId}`,
        { title: 'Unauthorized Rename', about: 'Defaced' },
        { token: memberToken },
      );
      assert.httpStatus(editTitle, 403, 'Non-admin PUT /api/v1/chats/{id} must return 403');

      const setTtl = await ctx.http.post(
        `/api/v1/chats/${chatId}/ttl`,
        { ttl_seconds: 60 },
        { token: memberToken },
      );
      assert.httpStatus(setTtl, 403, 'Non-admin POST /api/v1/chats/{id}/ttl must return 403');

      const createInv = await ctx.http.post(
        `/api/v1/chats/${chatId}/invites`,
        { title: 'Unauthorized Link' },
        { token: memberToken },
      );
      assert.httpStatus(createInv, 403, 'Non-admin POST /api/v1/chats/{id}/invites must return 403');

      const pinMsg = await ctx.http.post(
        `/api/v1/chats/${chatId}/pins`,
        { message_id: msgId },
        { token: memberToken },
      );
      assert.httpStatus(pinMsg, 403, 'Non-admin POST /api/v1/chats/{id}/pins must return 403');

      const delChat = await ctx.http.del(`/api/v1/chats/${chatId}`, undefined, { token: memberToken });
      assert.httpStatus(delChat, 403, 'Non-admin DELETE /api/v1/chats/{id} must return 403');

      // 2. Non-admin CLI dialogs.updateChat & setTtl -> expectOk: false
      const cliEdit = await ctx.cli.invoke({
        sandbox: memberSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'updateChat',
        payload: { chatId, title: 'Unauthorized CLI Rename' },
        expectOk: false,
      });
      assert.equal(cliEdit.ok, false, 'Non-admin CLI dialogs.updateChat must fail');

      const cliTtl = await ctx.cli.invoke({
        sandbox: memberSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'setTtl',
        payload: { chatId, ttlSeconds: 3600 },
        expectOk: false,
      });
      assert.equal(cliTtl.ok, false, 'Non-admin CLI dialogs.setTtl must fail');
    },
  }),

  defineTest({
    id: 'T2-F07-03-admin-privilege-escalation-guard-rejected-403',
    name: 'F7 Boundary: Delegated admin lacking ADD_ADMINS or attempting to grant unheld admin_rights bitmask bits rejected with 403',
    tier: 2,
    features: ['F7'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const owner = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_esc_owner', password: 'EscOwnerPassword!3', first_name: 'Owner' },
        {},
      );
      const limitedAdmin = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_esc_mod', password: 'EscModPassword!3', first_name: 'Limited Mod' },
        {},
      );
      const targetUser = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_esc_target', password: 'EscTargetPassword!3', first_name: 'Target' },
        {},
      );

      const ownerToken = owner.json.token;
      const modToken = limitedAdmin.json.token;
      const modUid = limitedAdmin.json.user_id;
      const targetUid = targetUser.json.user_id;

      const grp = await ctx.http.post(
        '/api/v1/chats/create',
        {
          title: 'RBAC Bitmask Escalation Test',
          chat_type: 'supergroup',
          member_ids: [modUid, targetUid],
        },
        { token: ownerToken },
      );
      const chatId = grp.json.chat_id;

      // 1. Owner grants mod ONLY ADMIN_RIGHTS_CHANGE_INFO (0x0001), WITHOUT ADD_ADMINS (0x0200)
      const grantLimited = await ctx.http.put(
        `/api/v1/chats/${chatId}/members/${modUid}`,
        { role: 'admin', admin_rights: 0x0001, admin_title: 'Info Editor' },
        { token: ownerToken },
      );
      assert.httpStatus(grantLimited, 200, 'Owner grants limited admin 0x0001');

      // Mod lacking ADD_ADMINS attempts to promote targetUser -> 403
      const promoteWithoutRight = await ctx.http.put(
        `/api/v1/chats/${chatId}/members/${targetUid}`,
        { role: 'admin', admin_rights: 0x0001 },
        { token: modToken },
      );
      assert.httpStatus(promoteWithoutRight, 403, 'Admin lacking ADD_ADMINS (0x0200) must be rejected with 403');

      // 2. Owner grants mod CHANGE_INFO | ADD_ADMINS (0x0201), still lacking BAN_USERS (0x0010)
      const grantAddAdmins = await ctx.http.put(
        `/api/v1/chats/${chatId}/members/${modUid}`,
        { role: 'admin', admin_rights: 0x0201 },
        { token: ownerToken },
      );
      assert.httpStatus(grantAddAdmins, 200, 'Owner grants 0x0201 to mod');

      // Mod attempts to grant BAN_USERS (0x0010) which mod does NOT hold -> 403 privilege escalation blocked!
      const escalateBitmask = await ctx.http.put(
        `/api/v1/chats/${chatId}/members/${targetUid}`,
        { role: 'admin', admin_rights: 0x0211 },
        { token: modToken },
      );
      assert.httpStatus(
        escalateBitmask,
        403,
        'Delegated admin granting bitmask rights they lack (0x0010) must be rejected with 403',
      );

      // Verify targetUser remains an unprivileged regular member
      const membersRes = await ctx.http.get(`/api/v1/chats/${chatId}/members`, { token: ownerToken });
      const targetRec = (membersRes.json?.members ?? []).find((m) => m.user_id === targetUid);
      assert.equal(targetRec?.role, 'member', 'Escalation target must remain regular member');
    },
  }),

  defineTest({
    id: 'T2-F07-04-kick-or-demote-group-owner-rejected-403',
    name: 'F7 Boundary: Full delegated admin attempting to kick or demote group creator (owner) is rejected with 403',
    tier: 2,
    features: ['F7'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const owner = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_creator', password: 'CreatorPassword!4', first_name: 'Creator' },
        {},
      );
      const coAdmin = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_coadmin', password: 'CoAdminPassword!4', first_name: 'CoAdmin' },
        {},
      );
      const ownerToken = owner.json.token;
      const ownerUid = owner.json.user_id;
      const coAdminToken = coAdmin.json.token;
      const coAdminUid = coAdmin.json.user_id;

      const grp = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Creator Immutability Group', chat_type: 'supergroup', member_ids: [coAdminUid] },
        { token: ownerToken },
      );
      const chatId = grp.json.chat_id;

      const promoteFull = await ctx.http.put(
        `/api/v1/chats/${chatId}/members/${coAdminUid}`,
        { role: 'admin', admin_rights: 0xffff, admin_title: 'Deputy' },
        { token: ownerToken },
      );
      assert.httpStatus(promoteFull, 200, 'Owner promotes coAdmin with 0xFFFF');

      // 1. CoAdmin attempts to kick group owner -> 403
      const kickOwner = await ctx.http.del(`/api/v1/chats/${chatId}/members/${ownerUid}`, undefined, {
        token: coAdminToken,
      });
      assert.httpStatus(kickOwner, 403, 'Kicking group creator (owner) must return 403');

      // 2. CoAdmin attempts to demote group owner -> 403
      const demoteOwner = await ctx.http.put(
        `/api/v1/chats/${chatId}/members/${ownerUid}`,
        { role: 'member', admin_rights: 0 },
        { token: coAdminToken },
      );
      assert.httpStatus(demoteOwner, 403, 'Demoting group creator (owner) must return 403');

      // Verify owner retains role='owner'
      const membersRes = await ctx.http.get(`/api/v1/chats/${chatId}/members`, { token: ownerToken });
      const ownerRec = (membersRes.json?.members ?? []).find((m) => m.user_id === ownerUid);
      assert.equal(ownerRec?.role, 'owner', 'Group creator must retain role=owner');
    },
  }),

  defineTest({
    id: 'T2-F07-05-non-member-chat-access-and-mutations-rejected-404-403',
    name: 'F7 Boundary: Non-member accessing GET /api/v1/chats/{id} returns 404 and non-member mutations return 403',
    tier: 2,
    features: ['F7'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const outsiderSb = ctx.createClientSandbox('f07_b_outsider');

      const owner = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_priv_owner', password: 'PrivOwnerPassword!5', first_name: 'Private Owner' },
        {},
      );
      const ownerToken = owner.json.token;

      const outsider = await ctx.cli.invoke({
        sandbox: outsiderSb,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username: 'f07_b_outsider',
          password: 'OutsiderPassword!5',
          firstName: 'Outsider',
        },
        expectOk: true,
      });
      const outsiderToken = outsider.data.session.token;

      const privateGrp = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Confidential Boardroom', chat_type: 'group' },
        { token: ownerToken },
      );
      const chatId = privateGrp.json.chat_id;

      // 1. Privacy-scoped GET /api/v1/chats/{id} returns 404 Not Found to non-member
      const getByOutsider = await ctx.http.get(`/api/v1/chats/${chatId}`, { token: outsiderToken });
      assert.httpStatus(getByOutsider, 404, 'Non-member GET /api/v1/chats/{id} must return 404');

      const cliGetOutsider = await ctx.cli.invoke({
        sandbox: outsiderSb,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'getChat',
        payload: { chatId },
        expectOk: false,
      });
      assert.equal(cliGetOutsider.ok, false, 'Non-member CLI dialogs.getChat must fail');

      // 2. Non-member mutations return 403
      const archRes = await ctx.http.post(`/api/v1/chats/${chatId}/archive`, { archived: true }, { token: outsiderToken });
      assert.httpStatus(archRes, 403, 'Non-member POST /archive must return 403');

      const pinRes = await ctx.http.post(`/api/v1/chats/${chatId}/pin`, { pinned: true }, { token: outsiderToken });
      assert.httpStatus(pinRes, 403, 'Non-member POST /pin must return 403');

      const draftRes = await ctx.http.put(
        `/api/v1/chats/${chatId}/draft`,
        { text: 'Intruder draft' },
        { token: outsiderToken },
      );
      assert.httpStatus(draftRes, 403, 'Non-member PUT /draft must return 403');

      const clearRes = await ctx.http.post(`/api/v1/chats/${chatId}/clear`, {}, { token: outsiderToken });
      assert.httpStatus(clearRes, 403, 'Non-member POST /clear must return 403');
    },
  }),

  defineTest({
    id: 'T2-F07-06-empty-and-oversized-chat-folder-topic-titles-rejected-400',
    name: 'F7 Boundary: Empty or >255-char group/channel chat titles, invalid chat_type, empty folder/topic titles (400), and foreign folder delete (404)',
    tier: 2,
    features: ['F7'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();

      const u1 = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_bounds_u1', password: 'BoundsPassword!6', first_name: 'Bounds 1' },
        {},
      );
      const u2 = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_bounds_u2', password: 'BoundsPassword!7', first_name: 'Bounds 2' },
        {},
      );
      const tok1 = u1.json.token;
      const tok2 = u2.json.token;

      // 1. Empty & >255-char group and channel titles -> 400 invalid_title
      const emptyGroup = await ctx.http.post(
        '/api/v1/chats/create',
        { title: '   ', chat_type: 'group' },
        { token: tok1 },
      );
      assert.httpStatus(emptyGroup, 400, 'Whitespace-only group title must return 400');
      assert.equal(emptyGroup.json?.error, 'invalid_title', 'Error must equal invalid_title');

      const longGroup = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'G'.repeat(256), chat_type: 'group' },
        { token: tok1 },
      );
      assert.httpStatus(longGroup, 400, '256-char group title must return 400');

      const longChannel = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'C'.repeat(256), chat_type: 'channel' },
        { token: tok1 },
      );
      assert.httpStatus(longChannel, 400, '256-char channel title must return 400');

      // 2. Invalid chat_type -> 400 invalid_chat_type; non-positive chat_id -> 400
      const badType = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Valid Title', chat_type: 'metaverse_room' },
        { token: tok1 },
      );
      assert.httpStatus(badType, 400, 'Unsupported chat_type must return 400');

      const zeroChatGet = await ctx.http.get('/api/v1/chats/0', { token: tok1 });
      assert.httpStatus(zeroChatGet, 400, 'GET /api/v1/chats/0 must return 400');

      // 3. Empty folder title -> 400; cross-user folder delete -> 404
      const emptyFolder = await ctx.http.post('/api/v1/folders', { title: '' }, { token: tok1 });
      assert.httpStatus(emptyFolder, 400, 'Empty folder title must return 400');

      const u1Folder = await ctx.http.post('/api/v1/folders', { title: 'U1 Private Folder' }, { token: tok1 });
      assert.httpStatus(u1Folder, 201, 'Create U1 folder');
      const u1FolderId = u1Folder.json?.id ?? u1Folder.json?.folder_id;

      const crossFolderDel = await ctx.http.del(`/api/v1/folders/${u1FolderId}`, undefined, { token: tok2 });
      assert.httpStatus(crossFolderDel, 404, 'Deleting another user folder must return 404');

      // 4. Empty forum topic title -> 400
      const forum = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Bounds Forum', chat_type: 'supergroup', is_forum: true },
        { token: tok1 },
      );
      const emptyTopic = await ctx.http.post(
        `/api/v1/chats/${forum.json.chat_id}/topics`,
        { title: '  ' },
        { token: tok1 },
      );
      assert.httpStatus(emptyTopic, 400, 'Whitespace-only topic title must return 400');
    },
  }),

  defineTest({
    id: 'T2-F07-07-revoked-expired-exhausted-invites-and-invalid-nav-rejected',
    name: 'F7 Boundary: Revoked, expired, and usage-limit-exhausted invite links (400), unknown code (404), and invalid uiSession nav destination rejected',
    tier: 2,
    features: ['F7'],
    timeoutMs: 40_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const uiSb = ctx.createClientSandbox('f07_b_invites_nav');

      const owner = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_inv_owner', password: 'InviteOwnerPass!7', first_name: 'Owner' },
        {},
      );
      const joiner1 = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_inv_j1', password: 'InviteJoinerPass!1', first_name: 'Joiner 1' },
        {},
      );
      const joiner2 = await ctx.http.post(
        '/api/v1/auth/register',
        { username: 'f07_b_inv_j2', password: 'InviteJoinerPass!2', first_name: 'Joiner 2' },
        {},
      );
      const ownerToken = owner.json.token;
      const j1Token = joiner1.json.token;
      const j2Token = joiner2.json.token;

      const grp = await ctx.http.post(
        '/api/v1/chats/create',
        { title: 'Invite Boundary Group', chat_type: 'group' },
        { token: ownerToken },
      );
      const chatId = grp.json.chat_id;

      // 1. Unknown invite code -> 404
      const unknownJoin = await ctx.http.post('/api/v1/invites/join', { code: 'nonexistent_code_xyz' }, { token: j1Token });
      assert.httpStatus(unknownJoin, 404, 'Joining unknown invite code must return 404');

      // 2. Revoked invite -> 400
      const revInv = await ctx.http.post(
        `/api/v1/chats/${chatId}/invites`,
        { title: 'Revocable Link' },
        { token: ownerToken },
      );
      const revInvId = revInv.json?.invite_id ?? revInv.json?.code;
      const revCode = revInv.json?.code ?? revInvId;
      const delInv = await ctx.http.del(`/api/v1/chats/${chatId}/invites/${revInvId}`, undefined, {
        token: ownerToken,
      });
      assert.httpStatus(delInv, 200, 'Revoke invite link');

      const joinRevoked = await ctx.http.post('/api/v1/invites/join', { code: revCode }, { token: j1Token });
      assert.httpStatus(joinRevoked, 400, 'Joining revoked invite link must return 400');

      // 3. Expired invite -> 400
      const expInv = await ctx.http.post(
        `/api/v1/chats/${chatId}/invites`,
        { title: 'Already Expired Link', expire_date_ms: Date.now() - 60_000 },
        { token: ownerToken },
      );
      const expCode = expInv.json?.code ?? expInv.json?.invite_id;
      const joinExpired = await ctx.http.post('/api/v1/invites/join', { code: expCode }, { token: j1Token });
      assert.httpStatus(joinExpired, 400, 'Joining expired invite link must return 400');

      // 4. usage_limit=1 invite -> 1st joiner 200, 2nd joiner 400
      const singleUseInv = await ctx.http.post(
        `/api/v1/chats/${chatId}/invites`,
        { title: 'Single Use Link', usage_limit: 1 },
        { token: ownerToken },
      );
      const singleCode = singleUseInv.json?.code ?? singleUseInv.json?.invite_id;

      const joinFirst = await ctx.http.post('/api/v1/invites/join', { code: singleCode }, { token: j1Token });
      assert.httpStatus(joinFirst, 200, '1st joiner within usage_limit=1 must succeed');

      const joinSecond = await ctx.http.post('/api/v1/invites/join', { code: singleCode }, { token: j2Token });
      assert.httpStatus(joinSecond, 400, '2nd joiner exceeding usage_limit=1 must return 400');

      // 5. Invalid NavRail destination in uiSession -> VALIDATION_ERROR
      const badNavUi = await ctx.cli.uiSession({
        sandbox: uiSb,
        serverUrl: server.baseUrl,
        script: {
          initialWindowWidthVp: 1280,
          steps: [{ op: 'navigate', nav: 'nonexistent_destination_tab' }],
        },
        expectOk: false,
      });
      assert.equal(badNavUi.errorCode, 'VALIDATION_ERROR', 'Invalid NavRail tab in uiSession must return VALIDATION_ERROR');
    },
  }),
];

export default tests;
