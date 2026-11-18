import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

const EXPECTED_26_SECTIONS = [
  'profile',
  'account',
  'privacy',
  'security',
  'devices',
  'passcode',
  'two_factor',
  'passkeys',
  'notifications',
  'appearance',
  'themes',
  'chat_settings',
  'folders',
  'stickers_emoji',
  'data_storage',
  'network_proxy',
  'power_saving',
  'language',
  'premium',
  'stars_wallet',
  'ton_wallet',
  'passport',
  'business',
  'hermes_ai',
  'magpie_gateway',
  'about_updates',
];

async function registerSandboxUser(ctx, label, usernamePrefix) {
  const sandbox = ctx.createClientSandbox(label);
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const username = `${usernamePrefix}_${suffix}`;
  const password = 'Password123!';
  const reg = await ctx.cli.invoke({
    sandbox,
    domain: 'auth',
    action: 'registerPassword',
    payload: {
      username,
      password,
      firstName: usernamePrefix.toUpperCase(),
      deviceName: `OHOS_${label}`,
    },
  });
  assert.equal(reg.ok, true, `registerPassword must succeed for ${username}`);
  const userId = Number(reg.data?.userId ?? reg.data?.user_id ?? reg.data?.session?.user_id);
  const token = String(reg.data?.token ?? reg.data?.session?.token ?? '');
  assert.greaterThan(userId, 0, 'registered userId must be positive');
  assert.isNonEmptyString(token, 'registered session token must be non-empty');
  return { sandbox, username, password, userId, token };
}

function startHttpConnectProxy() {
  const connectedTargets = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('proxy-ok');
  });
  server.on('connect', (req, clientSocket) => {
    connectedTargets.push(String(req.url || ''));
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    clientSocket.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        connectedTargets,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

export const tests = [
  defineTest({
    id: 'T1-F13-01-inspector-profile-members-roles-invites',
    name: 'F13: ContextInspector peer/chat profiles, group member admin role promotion, and invite link CRUD + join + revoke',
    tier: 1,
    features: ['F13'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'alice', 'f13_alice');
      const bob = await registerSandboxUser(ctx, 'bob', 'f13_bob');
      const carol = await registerSandboxUser(ctx, 'carol', 'f13_carol');

      const createGroup = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: {
          title: 'Harmony Inspector Group',
          chatType: 'group',
          memberIds: [bob.userId],
          about: 'Group for ContextInspector verification',
        },
      });
      const chatId = Number(createGroup.data?.chat_id ?? createGroup.data?.chatId);
      assert.greaterThan(chatId, 0, 'created group chatId must be positive');

      const bobProfile = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'getPeerProfile',
        payload: { userId: bob.userId },
      });
      assert.equal(Number(bobProfile.data?.user_id), bob.userId, 'getPeerProfile(userId) must return Bob profile');
      assert.equal(bobProfile.data?.username, bob.username, 'getPeerProfile(userId) username must match');

      const chatProfile = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'getPeerProfile',
        payload: { chatId },
      });
      assert.equal(chatProfile.data?.title, 'Harmony Inspector Group', 'getPeerProfile(chatId) must return group title');

      const promoteBob = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'updateMemberRole',
        payload: {
          chatId,
          userId: bob.userId,
          role: 'admin',
          adminTitle: 'Core Maintainer',
          adminRights: 255,
        },
      });
      assert.equal(promoteBob.data?.updated, true, 'updateMemberRole must succeed for group creator');

      const membersHttp = await ctx.http.get(`/api/v1/chats/${chatId}/members`, {
        token: alice.token,
      });
      assert.httpStatus(membersHttp, 200, 'GET /api/v1/chats/{id}/members');
      const bobMember = (membersHttp.json?.members || []).find((m) => Number(m.user_id) === bob.userId);
      assert.isObject(bobMember, 'Bob must be listed in chat members');
      assert.equal(bobMember.role, 'admin', 'Bob role must be promoted to admin');
      assert.equal(bobMember.admin_title, 'Core Maintainer', 'Bob custom admin_title must persist');

      const inviteRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'createInvite',
        payload: {
          chatId,
          title: 'Carol Onboarding Link',
          usageLimit: 5,
        },
      });
      const inviteId = String(inviteRes.data?.invite_id ?? inviteRes.data?.code ?? '');
      const inviteLink = String(inviteRes.data?.link ?? '');
      assert.isNonEmptyString(inviteId, 'createInvite must return invite_id');
      assert.includes(inviteLink, 'https://t.me/+', 'createInvite must mint canonical invite link');

      const listInvites = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'listInvites',
        payload: { chatId },
      });
      assert.greaterThanOrEqual(listInvites.data?.count, 1, 'listInvites must include newly created link');

      const carolJoin = await ctx.cli.invoke({
        sandbox: carol.sandbox,
        domain: 'inspector',
        action: 'joinByInvite',
        payload: { inviteLink },
      });
      assert.equal(Number(carolJoin.data?.chat_id ?? carolJoin.data?.id ?? chatId), chatId, 'Carol must join target group');

      const membersAfterJoin = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'listMembers',
        payload: { chatId },
      });
      assert.equal(membersAfterJoin.data?.count, 3, 'Group must contain Alice, Bob, and Carol after invite join');

      const carolRemove = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'removeMember',
        payload: { chatId, userId: carol.userId },
      });
      assert.equal(carolRemove.data?.removed, true, 'removeMember must remove Carol cleanly');

      const reAddCarol = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'addMembers',
        payload: { chatId, userIds: [carol.userId] },
      });
      assert.equal(reAddCarol.data?.added, true, 'addMembers must re-add Carol cleanly');

      const revokeRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'revokeInvite',
        payload: { chatId, inviteId },
      });
      assert.equal(revokeRes.data?.revoked, true, 'revokeInvite must mark link revoked');
    },
  }),

  defineTest({
    id: 'T1-F13-02-shared-media-five-tabs-and-channel-statistics',
    name: 'F13: ContextInspector SharedMedia 5 sub-tabs (photos/videos/files/links/voice) and Channel Statistics analytics',
    tier: 1,
    features: ['F13'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'alice_media', 'f13_chan_owner');
      const bob = await registerSandboxUser(ctx, 'bob_media', 'f13_chan_sub');

      const createChannel = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: {
          title: 'OpenHarmony Releases Channel',
          chatType: 'channel',
          memberIds: [bob.userId],
          about: 'Broadcast channel with rich media and statistics',
        },
      });
      const chatId = Number(createChannel.data?.chat_id ?? createChannel.data?.chatId);
      assert.greaterThan(chatId, 0, 'created channel chatId must be positive');

      const sentPayloads = [
        { cardType: 'photo', fileId: 'cas_photo_f13_1', text: 'Stage UI screenshot alpha' },
        { cardType: 'video', fileId: 'cas_video_f13_1', text: 'Foldable transition demo beta' },
        {
          cardType: 'document',
          fileId: 'cas_doc_f13_1',
          fileName: 'harmony_architecture.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 16384,
          text: 'Architecture specification gamma',
        },
        { text: 'Official portal https://www.openharmony.cn/release/v6 for SDK docs' },
        { cardType: 'voice', fileId: 'cas_voice_f13_1', durationSecs: 9, text: 'Voice update delta' },
      ];

      let firstMsgId = 0;
      for (const item of sentPayloads) {
        const sent = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'messages',
          action: 'sendMessage',
          payload: { chatId, ...item },
        });
        const mid = Number(sent.data?.message_id ?? sent.data?.id ?? 0);
        assert.greaterThan(mid, 0, 'rich message send must return positive message_id');
        if (!firstMsgId) firstMsgId = mid;
      }

      await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'toggleReaction',
        payload: { chatId, messageId: firstMsgId, emoji: '🔥' },
      });

      const subTabs = ['photos', 'videos', 'files', 'links', 'voice'];
      let totalMatchedAcrossTabs = 0;
      for (const mediaType of subTabs) {
        const tabRes = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'inspector',
          action: 'listSharedMedia',
          payload: { chatId, mediaType, limit: 20 },
        });
        const hits = tabRes.data?.messages ?? tabRes.data?.results ?? tabRes.data?.items ?? [];
        assert.isArray(hits, `SharedMedia sub-tab '${mediaType}' must return message array`);
        totalMatchedAcrossTabs += hits.length;
      }
      assert.greaterThanOrEqual(totalMatchedAcrossTabs, 1, 'SharedMedia tabs must index sent rich media/link items');

      const statsCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'getChannelStatistics',
        payload: { chatId },
      });
      assert.equal(Number(statsCli.data?.chat_id), chatId, 'getChannelStatistics chat_id must match');
      assert.greaterThanOrEqual(Number(statsCli.data?.member_count), 2, 'Channel member_count must be >= 2');
      assert.greaterThanOrEqual(Number(statsCli.data?.total_messages), 5, 'Channel total_messages must be >= 5');
      assert.greaterThanOrEqual(Number(statsCli.data?.messages_last_7d), 5, 'Channel messages_last_7d must be >= 5');
      assert.isArray(statsCli.data?.daily_series, 'Channel statistics must include daily_series array');

      const statsHttp = await ctx.http.get(`/api/v1/chats/${chatId}/statistics`, {
        token: alice.token,
      });
      assert.httpStatus(statsHttp, 200, 'GET /api/v1/chats/{id}/statistics');
      assert.equal(Number(statsHttp.json?.total_messages), Number(statsCli.data?.total_messages), 'HTTP & CLI stats must match');
    },
  }),

  defineTest({
    id: 'T1-F13-03-contacts-mutual-resolve-block-and-privacy-settings',
    name: 'F13: Contacts CRUD with mutual detection, @username peer resolution, block/unblock lifecycle, and UserPrivacySettingsDto sync',
    tier: 1,
    features: ['F13'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'alice_contacts', 'f13_contact_a');
      const bob = await registerSandboxUser(ctx, 'bob_contacts', 'f13_contact_b');

      const resolved = await ctx.http.get('/api/v1/peers/resolve', {
        token: alice.token,
        query: { username: `@${bob.username}` },
      });
      assert.httpStatus(resolved, 200, 'GET /api/v1/peers/resolve');
      assert.equal(resolved.json?.kind, 'user', 'resolved peer kind must be user');
      assert.equal(Number(resolved.json?.user?.user_id), bob.userId, 'resolved user_id must match Bob');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'addContact',
        payload: {
          userId: bob.userId,
          username: bob.username,
          firstName: 'Bob',
          lastName: 'Harmony',
        },
      });

      const listBeforeMutual = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'listContacts',
        payload: {},
      });
      const bobEntryBefore = (listBeforeMutual.data?.contacts || []).find((c) => Number(c.user_id) === bob.userId);
      assert.isObject(bobEntryBefore, 'Bob must appear in Alice contact list');
      assert.equal(Boolean(bobEntryBefore.is_mutual), false, 'Contact must not be mutual before Bob adds Alice');

      await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'contacts',
        action: 'addContact',
        payload: {
          userId: alice.userId,
          username: alice.username,
          firstName: 'Alice',
        },
      });

      const listAfterMutual = await ctx.http.get('/api/v1/contacts', { token: alice.token });
      assert.httpStatus(listAfterMutual, 200, 'GET /api/v1/contacts');
      const bobEntryAfter = (listAfterMutual.json?.contacts || []).find((c) => Number(c.user_id) === bob.userId);
      assert.equal(bobEntryAfter?.is_mutual, true, 'Contact must become is_mutual: true once reciprocal');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'blockUser',
        payload: { userId: bob.userId },
      });
      const blockedList = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'listBlocked',
        payload: {},
      });
      assert.equal(blockedList.data?.count, 1, 'listBlocked must show 1 blocked user');
      assert.equal(Number(blockedList.data?.blocked?.[0]?.user_id), bob.userId, 'blocked user_id must be Bob');

      const unblockRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'unblockUser',
        payload: { userId: bob.userId },
      });
      assert.equal(unblockRes.data?.unblocked, true, 'unblockUser must return unblocked: true');

      const delContact = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'deleteContact',
        payload: { userId: bob.userId },
      });
      assert.equal(delContact.data?.deleted, true, 'deleteContact must remove Bob from contacts');

      const updatedPrivacy = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'updatePrivacy',
        payload: {
          phone_privacy: 'contacts',
          last_seen_privacy: 'nobody',
          calls_privacy: 'contacts',
          forwards_privacy: 'nobody',
          global_ttl_seconds: 86400,
          include_muted_in_badge: false,
        },
      });
      assert.equal(updatedPrivacy.data?.phone_privacy, 'contacts', 'phone_privacy must update to contacts');
      assert.equal(updatedPrivacy.data?.last_seen_privacy, 'nobody', 'last_seen_privacy must update to nobody');

      const serverPrivacy = await ctx.http.get('/api/v1/users/me/settings', { token: alice.token });
      assert.httpStatus(serverPrivacy, 200, 'GET /api/v1/users/me/settings');
      assert.equal(serverPrivacy.json?.forwards_privacy, 'nobody', 'server forwards_privacy must match');
      assert.equal(Number(serverPrivacy.json?.global_ttl_seconds), 86400, 'server global_ttl_seconds must match');
    },
  }),

  defineTest({
    id: 'T1-F13-04-all-26-settings-sections-badge-proxy-storage-export',
    name: 'F13: All 26 SettingsSectionType pages, NotificationKit app badge, HTTP CONNECT proxy probe, storage cache clear, and JSON/HTML chat export',
    tier: 1,
    features: ['F13'],
    timeoutMs: 45_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'alice_settings', 'f13_settings_u');

      const sectionsRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'listSections',
        payload: {},
      });
      assert.equal(sectionsRes.data?.count, 26, 'settings.listSections must expose all 26 sections');
      const returnedIds = (sectionsRes.data?.sections || []).map((s) => s.id);
      assert.deepEqual(returnedIds, EXPECTED_26_SECTIONS, '26 settings section IDs must match specification order');

      for (const sectionId of ['profile', 'privacy', 'themes', 'language', 'business', 'about_updates']) {
        const sec = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'settings',
          action: 'getSection',
          payload: { sectionId },
        });
        assert.equal(sec.data?.sectionId, sectionId, `getSection(${sectionId}) must return matching sectionId`);
        assert.isNonEmptyString(sec.data?.title, `getSection(${sectionId}) must have non-empty title`);
      }

      const badgeRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'setNotificationBadge',
        payload: { count: 14, muted: false },
      });
      assert.equal(badgeRes.data?.badgeCount, 14, 'setNotificationBadge must persist badgeCount=14');

      const proxyHandle = await startHttpConnectProxy();
      try {
        const probeRes = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'settings',
          action: 'probeProxy',
          payload: {
            kind: 'HTTP',
            host: '127.0.0.1',
            port: proxyHandle.port,
          },
        });
        assert.equal(probeRes.data?.reachable, true, 'probeProxy against HTTP CONNECT tunnel must succeed');
        assert.greaterThanOrEqual(Number(probeRes.data?.latencyMs), 0, 'probeProxy must report non-negative latencyMs');
        assert.includes(
          proxyHandle.connectedTargets,
          `127.0.0.1:${server.port}`,
          'HTTP CONNECT proxy must tunnel to live gpui_telegram_server host:port',
        );
      } finally {
        await proxyHandle.close();
      }

      const dummyCacheFile = path.join(alice.sandbox.cacheDir, 'media_thumb_01.cache');
      fs.writeFileSync(dummyCacheFile, Buffer.alloc(6144, 0x5a));
      const statsBefore = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'getStorageStats',
        payload: {},
      });
      assert.greaterThanOrEqual(Number(statsBefore.data?.cacheBytes), 6144, 'getStorageStats must measure cacheDir bytes');

      const cleared = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'clearStorageCache',
        payload: {},
      });
      assert.equal(cleared.data?.cleared, true, 'clearStorageCache must report cleared: true');
      assert.greaterThanOrEqual(Number(cleared.data?.freedBytes), 6144, 'clearStorageCache must free >= 6144 bytes');
      assert.equal(Number(cleared.data?.remainingCacheBytes), 0, 'remainingCacheBytes must drop to 0');

      const group = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Export Archive Group', chatType: 'group' },
      });
      const chatId = Number(group.data?.chat_id ?? group.data?.chatId);
      const uniqueExportMarker = `ARCHIVE_EXPORT_MARKER_${Date.now()}`;
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId, text: uniqueExportMarker },
      });

      for (const format of ['json', 'html']) {
        const exp = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'settings',
          action: 'exportChatHistory',
          payload: { chatId, format },
        });
        assert.equal(exp.data?.format, format, `exportChatHistory format must equal ${format}`);
        assert.greaterThan(Number(exp.data?.byteLength), 20, `${format} export byteLength must be > 20`);
        assert.isNonEmptyString(exp.data?.filePath, `${format} export must write sandbox file`);
        assert.equal(fs.existsSync(exp.data.filePath), true, `${format} exported file must exist on disk`);
        const diskContent = fs.readFileSync(exp.data.filePath, 'utf8');
        assert.includes(diskContent, uniqueExportMarker, `${format} exported file must include chat message text`);
      }
    },
  }),

  defineTest({
    id: 'T1-F13-05-stars-ledger-ton-wallet-and-redeem-membership',
    name: 'F13: Stars balance top-up, peer Star gift transfer, transaction ledger, TON self-custody wallet, and Premium code redemption',
    tier: 1,
    features: ['F13'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'alice_wallet', 'f13_wallet_a');
      const bob = await registerSandboxUser(ctx, 'bob_wallet', 'f13_wallet_b');

      const initialBal = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'getStarsBalance',
        payload: {},
      });
      assert.equal(Number(initialBal.data?.stars_balance ?? 0), 0, 'fresh account Stars balance must start at 0');

      const topUp = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'topUpStars',
        payload: { amountStars: 600 },
      });
      const afterTopUp = Number(topUp.data?.stars_balance ?? topUp.data?.balance?.stars_balance);
      assert.equal(afterTopUp, 600, 'topUpStars(600) must raise balance to 600');

      const giftRes = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'sendStarGift',
        payload: {
          recipientUserId: bob.userId,
          amountStars: 175,
          giftId: 'star_trophy',
          message: 'Great HarmonyOS release!',
        },
      });
      const aliceRemaining = Number(giftRes.data?.stars_balance ?? giftRes.data?.balance?.stars_balance);
      assert.equal(aliceRemaining, 425, 'Alice Stars balance must be debited to 425 after 175 gift');

      const bobBalHttp = await ctx.http.get('/api/v1/wallet/balance', { token: bob.token });
      assert.httpStatus(bobBalHttp, 200, 'Bob GET /api/v1/wallet/balance');
      assert.equal(Number(bobBalHttp.json?.stars_balance), 175, 'Bob Stars balance must be credited with 175');

      const txList = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'listTransactions',
        payload: {},
      });
      assert.greaterThanOrEqual(txList.data?.count, 2, 'Alice wallet ledger must record top-up and gift transactions');

      const tonCreated = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'getTonWalletState',
        payload: {
          createIfMissing: true,
          accountId: 'ton_ohos_main',
          label: 'HarmonyOS Self-Custody Vault',
        },
      });
      assert.match(String(tonCreated.data?.address || ''), /^UQ[0-9a-f]{46}$/i, 'TON wallet address must use UQ prefix');
      assert.equal(Number(tonCreated.data?.balanceNanotons), 5_000_000_000, 'Initial cached TON balance must be 5 TON');

      const tonSent = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'getTonWalletState',
        payload: {
          sendAmountNanotons: 300_000_000,
          recipientAddress: `UQ${'c'.repeat(46)}`,
          feeNanotons: 5_000_000,
        },
      });
      assert.equal(
        Number(tonSent.data?.balanceNanotons),
        4_695_000_000,
        'TON transfer must deduct sendAmountNanotons + feeNanotons',
      );
      assert.equal((tonSent.data?.transactions || []).length, 1, 'TON transaction log must append transfer record');

      const redeemCode = `OHOSPRO_${Date.now().toString(36).toUpperCase()}`;
      const mintCode = await ctx.http.post(
        '/api/admin/create-redeem-code',
        { code: redeemCode, plan: 'monthly', duration_days: 30 },
        { token: alice.token },
      );
      assert.httpStatus(mintCode, 200, 'POST /api/admin/create-redeem-code');

      const redeemed = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'wallet',
        action: 'redeemCode',
        payload: { code: redeemCode },
      });
      assert.equal(redeemed.data?.success, true, 'wallet.redeemCode must activate Premium plan');

      const checkVip = await ctx.http.get('/api/alipay/check-membership', { token: bob.token });
      assert.httpStatus(checkVip, 200, 'GET /api/alipay/check-membership');
      assert.equal(checkVip.json?.is_premium, true, 'Bob account must report is_premium: true after code redemption');
    },
  }),

  defineTest({
    id: 'T1-F13-06-business-ten-subpages-and-encrypted-passport-vault',
    name: 'F13: Telegram Business 10 sub-pages persistence and ChaCha20-Poly1305 encrypted-at-rest Telegram Passport KYC vault',
    tier: 1,
    features: ['F13'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerSandboxUser(ctx, 'alice_biz_kyc', 'f13_biz_kyc');

      const businessPayload = {
        greetingMessage: { enabled: true, text: 'Welcome to Harmony Studio!' },
        awayMessage: { enabled: true, text: 'Back at 09:00 CST' },
        quickReplies: [{ shortcut: '/ship', text: 'Your order has shipped.' }],
        businessHours: { timezone: 'Asia/Shanghai', open24x7: false },
        location: { address: 'Shenzhen Bantian Huawei Base', lat: 22.626, lng: 114.061 },
        chatbots: { connectedBotUsername: 'harmony_support_bot', canReply: true },
        chatLinks: [{ slug: 'vip-support', prefilledText: 'Hello VIP team' }],
        startPage: { title: 'Harmony Enterprise', subtitle: '24/7 Native Support' },
        folderTags: [{ folderId: 1, tagLabel: 'VIP' }],
        revenueSummary: { currency: 'XTR', monthlyStars: 12800 },
      };

      const bizSaved = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'updateBusinessSection',
        payload: businessPayload,
      });
      assert.equal(bizSaved.data?.enabled, true, 'updateBusinessSection must mark business enabled: true');

      const bizSection = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'getSection',
        payload: { sectionId: 'business' },
      });
      for (const subPageKey of Object.keys(businessPayload)) {
        assert.hasOwn(bizSection.data?.data, subPageKey, `business section must persist sub-page '${subPageKey}'`);
      }

      const secretDocNumber = 'PASSPORT_SECRET_X9928173';
      const savePersonal = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'passport',
        action: 'savePassportDocument',
        payload: {
          documentType: 'personal_details',
          fields: {
            first_name: 'Alice',
            last_name: 'Zhang',
            birth_date: '1996-05-18',
            country_code: 'CN',
          },
        },
      });
      assert.equal(savePersonal.data?.saved, true, 'savePassportDocument(personal_details) must succeed');
      assert.equal(savePersonal.data?.isFilled, true, 'personal_details with fields must be filled');

      const savePassport = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'passport',
        action: 'savePassportDocument',
        payload: {
          documentType: 'passport',
          fields: {
            document_number: secretDocNumber,
            expiry_date: '2034-10-01',
          },
          hasScan: true,
        },
      });
      assert.equal(savePassport.data?.saved, true, 'savePassportDocument(passport) must succeed');
      assert.equal(savePassport.data?.isFilled, true, 'passport with fields + scan must be filled');
      assert.equal(savePassport.data?.encryptedAtRest, true, 'passport vault must report encryptedAtRest: true');

      const coreStatePath = path.join(alice.sandbox.filesDir, 'ohos_core_state.json');
      const rawCoreState = fs.readFileSync(coreStatePath, 'utf8');
      assert.notIncludes(
        rawCoreState,
        secretDocNumber,
        'Plaintext passport document_number MUST NEVER appear in ohos_core_state.json',
      );
      const parsedState = JSON.parse(rawCoreState);
      assert.isNonEmptyString(parsedState.passport_cipher_b64, 'ChaCha20-Poly1305 ciphertext must be stored');
      assert.isNonEmptyString(parsedState.passport_nonce_b64, 'ChaCha20-Poly1305 12-byte nonce must be stored');

      const passportState = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'passport',
        action: 'getPassportState',
        payload: {},
      });
      assert.equal(passportState.data?.encryptedAtRest, true, 'getPassportState must confirm encryptedAtRest');

      const authKyc = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'passport',
        action: 'authorizePassportRequest',
        payload: {
          botId: 600001,
          nonce: 'kyc_req_nonce_2026',
          scope: ['personal_details', 'passport'],
          publicKey: 'pk_merchant_kyc_v1',
        },
      });
      assert.equal(authKyc.data?.authorized, true, 'authorizePassportRequest must succeed when scope is satisfied');
      assert.match(String(authKyc.data?.encryptedPayloadDigest || ''), /^[0-9a-f]{64}$/, 'must emit SHA-256 payload digest');

      const delDoc = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'passport',
        action: 'deletePassportDocument',
        payload: { documentType: 'passport' },
      });
      assert.equal(delDoc.data?.deleted, true, 'deletePassportDocument must delete stored Passport value');
    },
  }),
];

export default tests;
