import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as assert from '../../lib/assert.mjs';
import { defineTest } from '../../lib/registry.mjs';

async function registerBoundaryUser(ctx, label, prefix) {
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
      deviceName: `OHOS_B13_${label}`,
    },
  });
  assert.equal(reg.ok, true, `registerPassword must succeed for ${username}`);
  const userId = Number(reg.data?.userId ?? reg.data?.user_id ?? reg.data?.session?.user_id);
  const token = String(reg.data?.token ?? reg.data?.session?.token ?? '');
  assert.greaterThan(userId, 0, 'userId must be positive');
  assert.isNonEmptyString(token, 'token must be non-empty');
  return { sandbox, username, userId, token };
}

function startRejectingConnectProxy() {
  const server = http.createServer((_req, res) => {
    res.writeHead(407);
    res.end();
  });
  server.on('connect', (_req, clientSocket) => {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    clientSocket.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
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
    id: 'T2-F13-01-revoked-expired-exhausted-and-unknown-invite-rejection',
    name: 'F13 Boundary: Reject joining via revoked, expired, usage-limit-exhausted, or nonexistent group invite links',
    tier: 2,
    features: ['F13'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'alice_inv_b', 'f13b_inv_a');
      const bob = await registerBoundaryUser(ctx, 'bob_inv_b', 'f13b_inv_b');
      const carol = await registerBoundaryUser(ctx, 'carol_inv_b', 'f13b_inv_c');

      const group = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: { title: 'Boundary Invite Group', chatType: 'group' },
      });
      const chatId = Number(group.data?.chat_id ?? group.data?.chatId);

      // 1. Revoked invite link
      const invRevoked = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'createInvite',
        payload: { chatId, title: 'Revoke Me' },
      });
      const revokedId = String(invRevoked.data?.invite_id ?? invRevoked.data?.code);
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'revokeInvite',
        payload: { chatId, inviteId: revokedId },
      });

      const joinRevokedCli = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'inspector',
        action: 'joinByInvite',
        payload: { inviteLink: invRevoked.data.link },
        expectOk: false,
      });
      assert.equal(joinRevokedCli.ok, false, 'Joining a revoked invite link via CLI must fail');

      const joinRevokedHttp = await ctx.http.post(
        '/api/v1/invites/join',
        { code: invRevoked.data.code },
        { token: bob.token },
      );
      assert.httpStatus(joinRevokedHttp, 400, 'Joining revoked invite via HTTP must return 400');

      // 2. Expired invite link
      const invExpired = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'createInvite',
        payload: {
          chatId,
          title: 'Already Expired',
          expireDateMs: Date.now() - 120_000,
        },
      });
      const joinExpiredCli = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'inspector',
        action: 'joinByInvite',
        payload: { inviteLink: invExpired.data.link },
        expectOk: false,
      });
      assert.equal(joinExpiredCli.ok, false, 'Joining an expired invite link must fail');

      // 3. Usage-limit (1) exhausted invite link
      const invSingle = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'inspector',
        action: 'createInvite',
        payload: {
          chatId,
          title: 'Single Seat Link',
          usageLimit: 1,
        },
      });
      const bobJoined = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'inspector',
        action: 'joinByInvite',
        payload: { inviteLink: invSingle.data.link },
      });
      assert.equal(bobJoined.ok, true, 'First join within usageLimit=1 must succeed');

      const carolOverLimit = await ctx.cli.invoke({
        sandbox: carol.sandbox,
        domain: 'inspector',
        action: 'joinByInvite',
        payload: { inviteLink: invSingle.data.link },
        expectOk: false,
      });
      assert.equal(carolOverLimit.ok, false, 'Second join exceeding usageLimit=1 must be rejected');

      // 4. Unknown invite code
      const unknownHttp = await ctx.http.post(
        '/api/v1/invites/join',
        { code: 'nonexistent_invite_code_999999' },
        { token: carol.token },
      );
      assert.httpStatus(unknownHttp, 404, 'Unknown invite code must return 404 Not Found');
    },
  }),

  defineTest({
    id: 'T2-F13-02-nonexistent-username-and-empty-peer-resolve-rejection',
    name: 'F13 Boundary: Nonexistent @username resolve (404/NOT_FOUND), empty resolve query (400), unknown settings section, and invalid export format',
    tier: 2,
    features: ['F13'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'alice_res_b', 'f13b_res');

      const missingHttp = await ctx.http.get('/api/v1/peers/resolve', {
        token: alice.token,
        query: { username: '@ghost_nobody_987654321' },
      });
      assert.httpStatus(missingHttp, 404, 'Resolving nonexistent @username over HTTP must return 404');
      assert.equal(missingHttp.json?.error, 'peer_not_found', 'error code must be peer_not_found');

      const missingCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'resolveUsername',
        payload: { username: '@ghost_nobody_987654321' },
        expectOk: false,
      });
      assert.equal(missingCli.ok, false, 'contacts.resolveUsername must fail for nonexistent handle');
      assert.equal(missingCli.errorCode, 'NOT_FOUND', 'CLI errorCode must be NOT_FOUND');

      const emptyQueryHttp = await ctx.http.get('/api/v1/peers/resolve', {
        token: alice.token,
      });
      assert.httpStatus(emptyQueryHttp, 400, 'Empty /api/v1/peers/resolve query must return 400');

      const badSection = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'getSection',
        payload: { sectionId: 'nonexistent_settings_page' },
        expectOk: false,
      });
      assert.equal(badSection.errorCode, 'NOT_FOUND', 'Unknown settings sectionId must return NOT_FOUND');

      const badExport = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'exportChatHistory',
        payload: { chatId: 1, format: 'xml' },
        expectOk: false,
      });
      assert.equal(badExport.errorCode, 'VALIDATION_ERROR', 'Unsupported export format xml must return VALIDATION_ERROR');
    },
  }),

  defineTest({
    id: 'T2-F13-03-blocked-peer-dm-enforcement-and-self-block-rejection',
    name: 'F13 Boundary: Bidirectional blocked-peer DM send rejection (403 user_is_blocked) and self-block rejection (400)',
    tier: 2,
    features: ['F13'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'alice_blk', 'f13b_blk_a');
      const bob = await registerBoundaryUser(ctx, 'bob_blk', 'f13b_blk_b');

      const selfBlockCli = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'blockUser',
        payload: { userId: alice.userId },
        expectOk: false,
      });
      assert.equal(selfBlockCli.ok, false, 'Blocking oneself via CLI must be rejected');

      const selfBlockHttp = await ctx.http.post(
        `/api/v1/users/${alice.userId}/block`,
        {},
        { token: alice.token },
      );
      assert.httpStatus(selfBlockHttp, 400, 'POST /api/v1/users/{self}/block must return 400');

      const contactCreated = await ctx.http.post(
        '/api/v1/contacts',
        { user_id: bob.userId, username: bob.username, first_name: 'Bob' },
        { token: alice.token },
      );
      assert.httpStatus(contactCreated, 201, 'POST /api/v1/contacts creates direct DM chat');
      const dmChatId = Number(contactCreated.json?.chat_id);
      assert.greaterThan(dmChatId, 0, 'Direct chat_id must be positive');

      const initialDm = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId: dmChatId, text: 'Hello before block' },
      });
      assert.equal(initialDm.ok, true, 'DM before block must succeed');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'blockUser',
        payload: { userId: bob.userId },
      });

      const bobBlockedCli = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId: dmChatId, text: 'Attempted message while blocked' },
        expectOk: false,
      });
      assert.equal(bobBlockedCli.ok, false, 'Blocked peer DM via CLI must fail');
      assert.equal(bobBlockedCli.errorCode, 'PERMISSION_DENIED', 'Blocked DM CLI errorCode must be PERMISSION_DENIED');

      const aliceBlockedHttp = await ctx.http.post(
        '/api/v1/messages/send',
        { chat_id: dmChatId, text: 'Blocker sending in blocked DM' },
        { token: alice.token },
      );
      assert.httpStatus(aliceBlockedHttp, 403, 'Sending in blocked direct chat must return 403 Forbidden');
      assert.equal(aliceBlockedHttp.json?.error, 'user_is_blocked', 'error slug must be user_is_blocked');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'contacts',
        action: 'unblockUser',
        payload: { userId: bob.userId },
      });

      const restoredDm = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'messages',
        action: 'sendMessage',
        payload: { chatId: dmChatId, text: 'Restored DM after unblock' },
      });
      assert.equal(restoredDm.ok, true, 'DM must succeed immediately after unblocking peer');
    },
  }),

  defineTest({
    id: 'T2-F13-04-wallet-insufficient-stars-ton-overdraft-and-redeem-conflicts',
    name: 'F13 Boundary: Non-positive topUpStars, insufficient Stars gift balance, TON overdraft, and malformed/already-redeemed VIP codes',
    tier: 2,
    features: ['F13'],
    timeoutMs: 40_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'alice_w_b', 'f13b_wal_a');
      const bob = await registerBoundaryUser(ctx, 'bob_w_b', 'f13b_wal_b');

      const zeroTopUp = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'topUpStars',
        payload: { amountStars: 0 },
        expectOk: false,
      });
      assert.equal(zeroTopUp.errorCode, 'VALIDATION_ERROR', 'topUpStars(0) must return VALIDATION_ERROR');

      const insufficientGift = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'sendStarGift',
        payload: {
          recipientUserId: bob.userId,
          amountStars: 250,
          giftId: 'star_crown',
        },
        expectOk: false,
      });
      assert.equal(insufficientGift.ok, false, 'sendStarGift exceeding Stars balance must fail');

      const insufficientHttp = await ctx.http.post(
        '/api/v1/wallet/gift',
        { to_user_id: bob.userId, amount_stars: 250 },
        { token: alice.token },
      );
      assert.httpStatus(insufficientHttp, 400, 'POST /api/v1/wallet/gift with 0 balance must return 400');
      assert.includes(String(insufficientHttp.json?.message || ''), 'Insufficient', 'error must cite Insufficient balance');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'getTonWalletState',
        payload: { createIfMissing: true },
      });

      const tonOverdraft = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'sendTon',
        payload: {
          sendAmountNanotons: 9_999_000_000,
          recipientAddress: `UQ${'d'.repeat(46)}`,
        },
        expectOk: false,
      });
      assert.equal(tonOverdraft.errorCode, 'VALIDATION_ERROR', 'TON transfer > cached 5 TON balance must fail');

      const malformedCode = await ctx.http.post(
        '/api/admin/use-redeem-code',
        { code: 'BAD' },
        { token: alice.token },
      );
      assert.httpStatus(malformedCode, 400, 'Short (<8 char) redeem code must return 400 invalid_code');

      const oneTimeCode = `ONCEONLY_${Date.now().toString(36).toUpperCase()}`;
      const createdCode = await ctx.http.post(
        '/api/admin/create-redeem-code',
        { code: oneTimeCode, plan: 'monthly', duration_days: 30 },
        { token: alice.token },
      );
      assert.httpStatus(createdCode, 200, 'mint one-time redeem code');

      const firstUse = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'wallet',
        action: 'redeemCode',
        payload: { code: oneTimeCode },
      });
      assert.equal(firstUse.ok, true, 'First redemption of valid code must succeed');

      const secondUse = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'wallet',
        action: 'redeemCode',
        payload: { code: oneTimeCode },
        expectOk: false,
      });
      assert.equal(secondUse.errorCode, 'CONFLICT', 'Re-redeeming an already consumed code must fail with CONFLICT (409)');
    },
  }),

  defineTest({
    id: 'T2-F13-05-proxy-probe-auth-required-closed-port-and-unconfigured-errors',
    name: 'F13 Boundary: Proxy health probe rejects unconfigured/Direct proxy, HTTP 407 proxy auth challenge, and unreachable closed port',
    tier: 2,
    features: ['F13'],
    timeoutMs: 35_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'alice_prx_b', 'f13b_prx');

      const noProxyConfigured = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'probeProxy',
        payload: {},
        expectOk: false,
      });
      assert.equal(noProxyConfigured.errorCode, 'VALIDATION_ERROR', 'Probing with no proxy and no host must fail');

      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'auth',
        action: 'setProxyConfig',
        payload: { kind: 'Direct', enabled: false },
      });

      const directProbe = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'probeProxy',
        payload: {},
        expectOk: false,
      });
      assert.equal(directProbe.errorCode, 'VALIDATION_ERROR', 'Probing a Direct proxy record must return VALIDATION_ERROR');

      const rejectingProxy = await startRejectingConnectProxy();
      const closedPort = rejectingProxy.port;
      try {
        const authFailProbe = await ctx.cli.invoke({
          sandbox: alice.sandbox,
          domain: 'settings',
          action: 'probeProxy',
          payload: {
            kind: 'HTTP',
            host: '127.0.0.1',
            port: rejectingProxy.port,
          },
          expectOk: false,
        });
        assert.equal(authFailProbe.ok, false, 'HTTP 407 CONNECT rejection must fail probeProxy');
        assert.equal(authFailProbe.errorCode, 'PROXY_ERROR', '407 CONNECT tunnel failure must report PROXY_ERROR');
      } finally {
        await rejectingProxy.close();
      }

      const closedPortProbe = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'settings',
        action: 'probeProxy',
        payload: {
          kind: 'SOCKS5',
          host: '127.0.0.1',
          port: closedPort,
        },
        expectOk: false,
      });
      assert.equal(closedPortProbe.errorCode, 'PROXY_ERROR', 'Unreachable closed proxy port must report PROXY_ERROR');
    },
  }),

  defineTest({
    id: 'T2-F13-06-unauthorized-channel-stats-admin-roles-and-passport-tamper',
    name: 'F13 Boundary: Non-member statistics 403, non-admin role/invite mutation 403, incomplete KYC scope, and Passport AEAD tamper detection',
    tier: 2,
    features: ['F13'],
    timeoutMs: 45_000,
    async run(ctx) {
      await ctx.ensureServer();
      const alice = await registerBoundaryUser(ctx, 'alice_acl_b', 'f13b_acl_a');
      const bob = await registerBoundaryUser(ctx, 'bob_acl_b', 'f13b_acl_b');
      const carol = await registerBoundaryUser(ctx, 'carol_acl_b', 'f13b_acl_c');

      const group = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'dialogs',
        action: 'createChat',
        payload: {
          title: 'ACL Boundary Group',
          chatType: 'group',
          memberIds: [bob.userId],
        },
      });
      const chatId = Number(group.data?.chat_id ?? group.data?.chatId);

      // Non-member Carol cannot read channel statistics
      const carolStatsCli = await ctx.cli.invoke({
        sandbox: carol.sandbox,
        domain: 'inspector',
        action: 'getChannelStatistics',
        payload: { chatId },
        expectOk: false,
      });
      assert.equal(carolStatsCli.errorCode, 'PERMISSION_DENIED', 'Non-member getChannelStatistics must fail with PERMISSION_DENIED');

      const carolStatsHttp = await ctx.http.get(`/api/v1/chats/${chatId}/statistics`, {
        token: carol.token,
      });
      assert.httpStatus(carolStatsHttp, 403, 'Non-member GET /api/v1/chats/{id}/statistics must return 403');

      // Regular member Bob (non-admin) cannot promote roles or create invite links
      const bobPromote = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'inspector',
        action: 'updateMemberRole',
        payload: { chatId, userId: bob.userId, role: 'admin' },
        expectOk: false,
      });
      assert.equal(bobPromote.errorCode, 'PERMISSION_DENIED', 'Regular member updateMemberRole must fail with PERMISSION_DENIED');

      const bobCreateInvite = await ctx.cli.invoke({
        sandbox: bob.sandbox,
        domain: 'inspector',
        action: 'createInvite',
        payload: { chatId, title: 'Unauthorized Link' },
        expectOk: false,
      });
      assert.equal(bobCreateInvite.errorCode, 'PERMISSION_DENIED', 'Regular member createInvite must fail with PERMISSION_DENIED');

      // Incomplete Passport KYC (missing scan on Passport document)
      await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'passport',
        action: 'savePassportDocument',
        payload: {
          documentType: 'passport',
          fields: { document_number: 'UNSCANNED_DOC_01' },
          hasScan: false,
        },
      });

      const incompleteAuth = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'passport',
        action: 'authorizePassportRequest',
        payload: {
          botId: 600001,
          nonce: 'kyc_incomplete_nonce',
          scope: ['passport'],
        },
        expectOk: false,
      });
      assert.equal(incompleteAuth.errorCode, 'PASSPORT_INCOMPLETE', 'Unfilled Passport document must fail with PASSPORT_INCOMPLETE');

      // Corrupt ChaCha20-Poly1305 ciphertext on disk and verify AEAD tamper rejection
      const statePath = path.join(alice.sandbox.filesDir, 'ohos_core_state.json');
      const stateJson = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const cipherBuf = Buffer.from(stateJson.passport_cipher_b64, 'base64');
      cipherBuf[cipherBuf.length - 1] ^= 0xff;
      stateJson.passport_cipher_b64 = cipherBuf.toString('base64');
      fs.writeFileSync(statePath, JSON.stringify(stateJson, null, 2));

      const tamperedRead = await ctx.cli.invoke({
        sandbox: alice.sandbox,
        domain: 'passport',
        action: 'getPassportState',
        payload: {},
        expectOk: false,
      });
      assert.equal(tamperedRead.ok, false, 'Tampered ChaCha20-Poly1305 Passport ciphertext must fail decryption');
    },
  }),
];

export default tests;
