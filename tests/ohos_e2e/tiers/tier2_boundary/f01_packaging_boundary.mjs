import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as assert from '../../lib/assert.mjs';
import {
  ArtifactValidationError,
  CANONICAL_ARTIFACTS,
  FORBIDDEN_ACL_PERMISSIONS,
  STAGE_MODEL_FILES,
  USER_GRANT_PERMISSIONS,
  ZERO_ACL_ALLOWED_PERMISSIONS,
} from '../../lib/constants.mjs';
import { defineTest } from '../../lib/registry.mjs';

function buildStringMap(resourceJson) {
  const map = new Map();
  for (const item of resourceJson?.string || []) {
    if (item && typeof item.name === 'string') {
      map.set(item.name, String(item.value ?? ''));
    }
  }
  return map;
}

function appendZipComment(unsignedZipBuf, commentText) {
  const commentBuf = Buffer.from(commentText, 'utf8');
  let eocdOffset = -1;
  for (let c = 0; c <= Math.min(unsignedZipBuf.length - 22, 0xffff); c++) {
    const pos = unsignedZipBuf.length - 22 - c;
    if (unsignedZipBuf.readUInt32LE(pos) === 0x06054b50 && unsignedZipBuf.readUInt16LE(pos + 20) === c) {
      eocdOffset = pos;
      break;
    }
  }
  assert.greaterThanOrEqual(eocdOffset, 0, 'Unsigned HAP must have valid EOCD');
  const prefix = Buffer.from(unsignedZipBuf.subarray(0, eocdOffset + 22));
  prefix.writeUInt16LE(commentBuf.length, eocdOffset + 20);
  return Buffer.concat([prefix, commentBuf]);
}

function injectCorruptHapSigBlock(unsignedZipBuf) {
  let eocdOffset = -1;
  for (let c = 0; c <= Math.min(unsignedZipBuf.length - 22, 0xffff); c++) {
    const pos = unsignedZipBuf.length - 22 - c;
    if (unsignedZipBuf.readUInt32LE(pos) === 0x06054b50 && unsignedZipBuf.readUInt16LE(pos + 20) === c) {
      eocdOffset = pos;
      break;
    }
  }
  const cdOffset = unsignedZipBuf.readUInt32LE(eocdOffset + 16);
  const beforeCd = unsignedZipBuf.subarray(0, cdOffset);
  const cdAndEocd = Buffer.from(unsignedZipBuf.subarray(cdOffset));

  // Build a fake 96-byte HAP signing block with valid V3 trailer magic, 1 descriptor (0x20000000),
  // but non-PKCS#7 garbage bytes instead of ASN.1 DER SignedData!
  const fakeBlockSize = 96;
  const fakeBlock = Buffer.alloc(fakeBlockSize, 0);
  // Descriptor 0 at +0: type=0x20000000, length=52, offset=12
  fakeBlock.writeUInt32LE(0x20000000, 0);
  fakeBlock.writeUInt32LE(52, 4);
  fakeBlock.writeUInt32LE(12, 8);
  // Garbage payload at +12..+64 (starts with 0xdeadbeef, NOT 0x30 ASN.1 SEQUENCE + SignedData OID)
  Buffer.from('DEADBEEF_FAKE_SIGNATURE_PAYLOAD_WITHOUT_PKCS7_DER', 'ascii').copy(fakeBlock, 12);
  // 32-byte trailer at +64..+96
  const trailer = 64;
  fakeBlock.writeUInt32LE(1, trailer); // blockCount = 1
  fakeBlock.writeBigUInt64LE(BigInt(fakeBlockSize), trailer + 4);
  Buffer.from('<hap sign block>', 'ascii').copy(fakeBlock, trailer + 12);
  fakeBlock.writeUInt32LE(3, trailer + 28); // version = 3

  // Update EOCD cdOffset in cdAndEocd
  const eocdRel = eocdOffset - cdOffset;
  cdAndEocd.writeUInt32LE(cdOffset + fakeBlockSize, eocdRel + 16);

  return Buffer.concat([beforeCd, fakeBlock, cdAndEocd]);
}

function appendStoredSpoofSigEntry(unsignedZipBuf, entryName = 'rawfile/sig_vector.bin') {
  let eocdOffset = -1;
  for (let c = 0; c <= Math.min(unsignedZipBuf.length - 22, 0xffff); c++) {
    const pos = unsignedZipBuf.length - 22 - c;
    if (unsignedZipBuf.readUInt32LE(pos) === 0x06054b50 && unsignedZipBuf.readUInt16LE(pos + 20) === c) {
      eocdOffset = pos;
      break;
    }
  }
  assert.greaterThanOrEqual(eocdOffset, 0, 'Unsigned HAP must have valid EOCD');

  const cdCount = unsignedZipBuf.readUInt16LE(eocdOffset + 10);
  const cdSize = unsignedZipBuf.readUInt32LE(eocdOffset + 12);
  const cdOffset = unsignedZipBuf.readUInt32LE(eocdOffset + 16);

  const existingEntries = unsignedZipBuf.subarray(0, cdOffset);
  const existingCd = unsignedZipBuf.subarray(cdOffset, cdOffset + cdSize);

  // Build a structurally valid 128-byte HAP Sign V3 block with ASN.1 DER PKCS#7 SignedData OID
  const sigBlockSize = 128;
  const sigPayload = Buffer.alloc(sigBlockSize, 0);
  sigPayload.writeUInt32LE(0x20000000, 0); // type = PKCS#7
  sigPayload.writeUInt32LE(84, 4); // length = 84
  sigPayload.writeUInt32LE(12, 8); // offset = 12
  // Valid ASN.1 DER SEQUENCE (0x30) + PKCS#7 SignedData OID (06 09 2a 86 48 86 f7 0d 01 07 02)
  Buffer.from('305206092a864886f70d010702a04530430201013100300b06092a864886f70d010701', 'hex').copy(sigPayload, 12);
  const trailerOff = sigBlockSize - 32;
  sigPayload.writeUInt32LE(1, trailerOff); // blockCount = 1
  sigPayload.writeBigUInt64LE(BigInt(sigBlockSize), trailerOff + 4);
  Buffer.from('<hap sign block>', 'ascii').copy(sigPayload, trailerOff + 12);
  sigPayload.writeUInt32LE(3, trailerOff + 28); // version = 3

  const nameBuf = Buffer.from(entryName, 'utf8');
  const crc = zlib.crc32(sigPayload) >>> 0;
  const lfhOffset = existingEntries.length;

  const lfh = Buffer.alloc(30 + nameBuf.length, 0);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6); // flags = 0
  lfh.writeUInt16LE(0, 8); // method = 0 (Stored)
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(sigPayload.length, 18);
  lfh.writeUInt32LE(sigPayload.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);
  nameBuf.copy(lfh, 30);

  const cdfh = Buffer.alloc(46 + nameBuf.length, 0);
  cdfh.writeUInt32LE(0x02014b50, 0);
  cdfh.writeUInt16LE(20, 4);
  cdfh.writeUInt16LE(20, 6);
  cdfh.writeUInt16LE(0, 8);
  cdfh.writeUInt16LE(0, 10); // method = 0 (Stored)
  cdfh.writeUInt32LE(crc, 16);
  cdfh.writeUInt32LE(sigPayload.length, 20);
  cdfh.writeUInt32LE(sigPayload.length, 24);
  cdfh.writeUInt16LE(nameBuf.length, 28);
  cdfh.writeUInt32LE(lfhOffset, 42);
  nameBuf.copy(cdfh, 46);

  const newCdOffset = existingEntries.length + lfh.length + sigPayload.length;
  const newCdSize = existingCd.length + cdfh.length;
  const newCount = cdCount + 1;

  const eocd = Buffer.alloc(22, 0);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(newCount, 8);
  eocd.writeUInt16LE(newCount, 10);
  eocd.writeUInt32LE(newCdSize, 12);
  eocd.writeUInt32LE(newCdOffset, 16);

  return Buffer.concat([existingEntries, lfh, sigPayload, existingCd, cdfh, eocd]);
}

export const tests = [
  defineTest({
    id: 'T2-F01-01-zero-acl-permission-denylist-source-and-packaged-hap',
    name: 'F1 Boundary: Source module.json5 and packaged module.json strictly enforce Zero-ACL permission allowlist and reject restricted ACL permissions',
    tier: 2,
    features: ['F1'],
    timeoutMs: 20_000,
    async run(ctx) {
      const sourceModuleJson5 = ctx.artifacts.readJson5(STAGE_MODEL_FILES.moduleJson5);
      const signedHap = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedHap);
      const packagedModuleJson = signedHap.extractEntryJson('module.json');

      const allowedSet = new Set(ZERO_ACL_ALLOWED_PERMISSIONS);
      const forbiddenSet = new Set(FORBIDDEN_ACL_PERMISSIONS);

      for (const [label, perms] of [
        ['entry/src/main/module.json5', sourceModuleJson5?.module?.requestPermissions || []],
        ['packaged entry-default-signed.hap!module.json', packagedModuleJson?.module?.requestPermissions || []],
      ]) {
        assert.isArray(perms, `${label} requestPermissions must be an Array`);
        assert.greaterThanOrEqual(perms.length, 1, `${label} must declare at least ohos.permission.INTERNET`);

        const seen = new Set();
        for (const perm of perms) {
          const permName = typeof perm === 'string' ? perm : perm?.name;
          assert.isNonEmptyString(permName, `${label} permission entry must have a non-empty name`);
          assert.equal(seen.has(permName), false, `${label} must not contain duplicate permission '${permName}'`);
          seen.add(permName);

          assert.equal(
            forbiddenSet.has(permName),
            false,
            `${label} MUST NOT request ACL-restricted permission '${permName}' (must use Zero-ACL Pickers/SaveButton/PasteButton)`,
          );
          assert.equal(
            allowedSet.has(permName),
            true,
            `${label} permission '${permName}' must belong strictly to normal-APL Zero-ACL allowlist`,
          );
        }
        assert.equal(seen.has('ohos.permission.INTERNET'), true, `${label} must request ohos.permission.INTERNET`);
      }
    },
  }),

  defineTest({
    id: 'T2-F01-02-user-grant-permissions-mandate-reason-and-inuse-scene',
    name: 'F1 Boundary: User-grant permissions (MICROPHONE, CAMERA) are structured objects with localized reason and usedScene.when="inuse" in both module.json5 and packaged module.json',
    tier: 2,
    features: ['F1'],
    timeoutMs: 20_000,
    async run(ctx) {
      const moduleJson5 = ctx.artifacts.readJson5(STAGE_MODEL_FILES.moduleJson5);
      const signedHap = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedHap);
      const packagedModuleJson = signedHap.extractEntryJson('module.json');
      const baseStrings = buildStringMap(ctx.artifacts.readJson(STAGE_MODEL_FILES.baseStringJson));
      const zhStrings = buildStringMap(ctx.artifacts.readJson(STAGE_MODEL_FILES.zhCnStringJson));
      const enStrings = buildStringMap(ctx.artifacts.readJson(STAGE_MODEL_FILES.enUsStringJson));

      const perms = moduleJson5?.module?.requestPermissions || [];
      assert.isArray(perms, 'entry/src/main/module.json5 requestPermissions must be an Array');
      for (const perm of perms) {
        assert.isObject(
          perm,
          'Every entry in entry/src/main/module.json5 requestPermissions must be a plain object (never a bare string)',
        );
        assert.isNonEmptyString(perm.name, 'module.json5 permission object must define non-empty string name');
      }

      const packagedPerms = packagedModuleJson?.module?.requestPermissions || [];
      assert.isArray(packagedPerms, 'Packaged module.json requestPermissions must be an Array');
      for (const perm of packagedPerms) {
        assert.isObject(
          perm,
          'Every entry in packaged entry-default-signed.hap!module.json requestPermissions must be a plain object',
        );
        assert.isNonEmptyString(perm.name, 'Packaged module.json permission object must define non-empty string name');
      }

      for (const requiredPerm of USER_GRANT_PERMISSIONS) {
        const entry = perms.find((p) => (typeof p === 'string' ? p : p?.name) === requiredPerm);
        if (entry !== undefined) {
          assert.isObject(entry, `${requiredPerm} in module.json5 must be an object`);
          assert.isNonEmptyString(entry.reason, `${requiredPerm} must specify a reason resource reference`);
          assert.match(entry.reason, /^\$string:[a-zA-Z0-9_]+$/, `${requiredPerm} reason must use $string:<key> format`);
          const reasonKey = entry.reason.slice('$string:'.length);

          for (const [packLabel, strMap] of [
            ['base/element/string.json', baseStrings],
            ['zh_CN/element/string.json', zhStrings],
            ['en_US/element/string.json', enStrings],
          ]) {
            assert.equal(
              strMap.has(reasonKey) && strMap.get(reasonKey).trim().length > 0,
              true,
              `${requiredPerm} reason key '${reasonKey}' must resolve to non-empty text in ${packLabel}`,
            );
          }

          assert.isObject(entry.usedScene, `${requiredPerm} must define usedScene object in module.json5`);
          assert.equal(entry.usedScene.when, 'inuse', `${requiredPerm} usedScene.when must equal 'inuse'`);
          assert.isArray(entry.usedScene.abilities, `${requiredPerm} usedScene.abilities must be an array`);
          assert.includes(entry.usedScene.abilities, 'EntryAbility', `${requiredPerm} usedScene.abilities must list EntryAbility`);
        }

        const pkgEntry = packagedPerms.find((p) => (typeof p === 'string' ? p : p?.name) === requiredPerm);
        if (entry !== undefined) {
          assert.isObject(
            pkgEntry,
            `Packaged module.json must retain user-grant permission '${requiredPerm}' declared in module.json5`,
          );
        }
        if (pkgEntry !== undefined) {
          assert.isObject(pkgEntry, `Packaged ${requiredPerm} entry must be an object`);
          const hasCompiledReason =
            (typeof pkgEntry.reason === 'string' && pkgEntry.reason.trim().length > 0) ||
            (Number.isInteger(pkgEntry.reasonId) && pkgEntry.reasonId > 0);
          assert.equal(
            hasCompiledReason,
            true,
            `Packaged module.json ${requiredPerm} must specify non-empty reason or positive integer reasonId`,
          );
          assert.isObject(pkgEntry.usedScene, `Packaged ${requiredPerm} must define usedScene object`);
          assert.equal(pkgEntry.usedScene.when, 'inuse', `Packaged ${requiredPerm} usedScene.when must equal 'inuse'`);
          assert.isArray(pkgEntry.usedScene.abilities, `Packaged ${requiredPerm} usedScene.abilities must be an array`);
          assert.includes(
            pkgEntry.usedScene.abilities,
            'EntryAbility',
            `Packaged ${requiredPerm} usedScene.abilities must list EntryAbility`,
          );
        }
      }
    },
  }),

  defineTest({
    id: 'T2-F01-03-release-build-forbids-debuggable-and-enforces-dts-keep',
    name: 'F1 Boundary: Release buildMode forbids debuggable=true, packaged release HAP disables debug flag, and ArkGuard never disables obfuscation',
    tier: 2,
    features: ['F1'],
    timeoutMs: 20_000,
    async run(ctx) {
      const rootProfile = ctx.artifacts.readJson5(STAGE_MODEL_FILES.rootBuildProfile);
      const obfRules = ctx.artifacts.readText(STAGE_MODEL_FILES.obfuscationRules);
      const signedHap = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedHap);

      const buildModes = rootProfile?.app?.buildModeSet || [];
      const releaseMode = buildModes.find((m) => m.name === 'release');
      assert.isObject(releaseMode, 'Root build-profile.json5 must declare release buildMode');
      assert.notEqual(
        releaseMode?.buildOption?.debuggable,
        true,
        'Release buildModeSet must not set buildOption.debuggable = true',
      );

      const packagedModule = signedHap.extractEntryJson('module.json');
      assert.notEqual(packagedModule?.app?.debug, true, 'Release HAP module.json app.debug must NOT be true');

      const packInfo = signedHap.extractEntryJson('pack.info');
      assert.notEqual(packInfo?.summary?.app?.debug, true, 'Release HAP pack.info summary.app.debug must NOT be true');

      assert.doesNotMatch(
        obfRules,
        /^\s*-disable-obfuscation\b/m,
        'entry/obfuscation-rules.txt must not disable ArkGuard obfuscation globally',
      );
      assert.includes(obfRules, '-keep-dts', 'entry/obfuscation-rules.txt must keep N-API .d.ts symbols via -keep-dts');
    },
  }),

  defineTest({
    id: 'T2-F01-04-unsigned-vs-signed-hap-signature-and-spoof-rejection',
    name: 'F1 Boundary: Unsigned HAP, Stored terminal entry signature spoofing, ZIP comment magic strings, and fake non-PKCS#7 signing blocks are strictly rejected',
    tier: 2,
    features: ['F1'],
    timeoutMs: 20_000,
    async run(ctx) {
      const unsignedBuf = ctx.artifacts.readBuffer(CANONICAL_ARTIFACTS.unsignedHap);
      const signedBuf = ctx.artifacts.readBuffer(CANONICAL_ARTIFACTS.signedHap);

      const unsignedInspected = ctx.artifacts.inspectZipBuffer(unsignedBuf, 'unsigned.hap');
      const signedInspected = ctx.artifacts.inspectZipBuffer(signedBuf, 'signed.hap');
      assert.equal(unsignedInspected.hasHapSignatureBlock, false, 'Real unsigned HAP must report hasHapSignatureBlock=false');
      assert.equal(signedInspected.hasHapSignatureBlock, true, 'Real signed HAP must report hasHapSignatureBlock=true');

      // Boundary Case A: Spoofed magic strings inside ZIP comment must NEVER fool HAP signature verifier
      const commentSpoofedBuf = appendZipComment(unsignedBuf, '<hap sign block> hw signed app   ');
      const spoofedFile = path.join(ctx.workDir, 'spoofed-comment.hap');
      fs.writeFileSync(spoofedFile, commentSpoofedBuf);
      const spoofedInspected = ctx.artifacts.inspectZip(spoofedFile);
      assert.equal(
        spoofedInspected.hasHapSignatureBlock,
        false,
        'ZIP comment containing HAP magic strings without trailer before Central Directory must NOT pass as signed',
      );

      // Boundary Case B: Unsigned HAP whose terminal Stored (method=0) entry contains a full HAP Sign V3 + PKCS#7 payload must NEVER pass as signed
      const storedSpoofBuf = appendStoredSpoofSigEntry(unsignedBuf, 'rawfile/sig_vector.bin');
      const storedSpoofFile = path.join(ctx.workDir, 'spoofed-stored-entry.hap');
      fs.writeFileSync(storedSpoofFile, storedSpoofBuf);
      const storedSpoofInspected = ctx.artifacts.inspectZip(storedSpoofFile);
      assert.equal(
        storedSpoofInspected.hasEntry('rawfile/sig_vector.bin'),
        true,
        'Mutated unsigned ZIP must contain terminal Stored entry rawfile/sig_vector.bin',
      );
      assert.equal(
        storedSpoofInspected.extractEntryBuffer('rawfile/sig_vector.bin').length,
        128,
        'Terminal Stored entry payload must remain valid and extractable',
      );
      assert.equal(
        storedSpoofInspected.hasHapSignatureBlock,
        false,
        'Unsigned HAP with Stored terminal entry touching cdOffset must report hasHapSignatureBlock=false',
      );

      // Boundary Case C: Out-of-entry trailer before cdOffset with valid magic but fake non-DER-PKCS#7 0x20000000 sub-block must throw
      const fakeBlockBuf = injectCorruptHapSigBlock(unsignedBuf);
      assert.throws(
        () => ctx.artifacts.inspectZipBuffer(fakeBlockBuf, 'fake-pkcs7.hap'),
        ArtifactValidationError,
        'Fake HAP signing block without ASN.1 DER PKCS#7 SignedData OID must be rejected',
      );
    },
  }),

  defineTest({
    id: 'T2-F01-05-tampered-signed-hap-crc-and-corrupted-pkcs7-rejection',
    name: 'F1 Boundary: Byte-level tampering of ets/modules.abc or PKCS#7 SignedData inside an isolated copy of signed HAP is caught immediately',
    tier: 2,
    features: ['F1'],
    timeoutMs: 20_000,
    async run(ctx) {
      const signedBuf = ctx.artifacts.readBuffer(CANONICAL_ARTIFACTS.signedHap);
      const cleanZip = ctx.artifacts.inspectZipBuffer(signedBuf, 'clean-signed.hap');
      const abcMeta = cleanZip.getEntryMeta('ets/modules.abc');
      assert.isObject(abcMeta, 'Signed HAP must contain ets/modules.abc metadata');

      // Mutation A: Flip 1 bit inside ets/modules.abc payload in an isolated copy under ctx.workDir
      const tamperedAbcCopy = Buffer.from(signedBuf);
      const lfhNameLen = tamperedAbcCopy.readUInt16LE(abcMeta.lfhOffset + 26);
      const lfhExtraLen = tamperedAbcCopy.readUInt16LE(abcMeta.lfhOffset + 28);
      const payloadStart = abcMeta.lfhOffset + 30 + lfhNameLen + lfhExtraLen;
      assert.greaterThan(abcMeta.compressedSize, 4, 'ets/modules.abc compressed payload must be > 4 bytes');
      tamperedAbcCopy[payloadStart + Math.floor(abcMeta.compressedSize / 2)] ^= 0xff;

      const tamperedCopyPath = path.join(ctx.workDir, 'tampered-abc.hap');
      fs.writeFileSync(tamperedCopyPath, tamperedAbcCopy);
      const tamperedZip = ctx.artifacts.inspectZip(tamperedCopyPath);
      assert.throws(
        () => tamperedZip.extractEntryBuffer('ets/modules.abc'),
        ArtifactValidationError,
        'Extracting tampered ets/modules.abc must fail CRC-32 or Deflate verification',
      );

      // Mutation B: Corrupt PKCS#7 sub-block 0x20000000 ASN.1 SEQUENCE tag in a second isolated copy
      const pkcs7Sub = cleanZip.hapSignature.subBlocks.find((b) => b.type === 0x20000000);
      assert.isObject(pkcs7Sub, 'Signed HAP must expose 0x20000000 sub-block descriptor');
      const corruptedSigCopy = Buffer.from(signedBuf);
      corruptedSigCopy[pkcs7Sub.absOffset] = 0x00; // Destroy 0x30 ASN.1 SEQUENCE tag

      assert.throws(
        () => ctx.artifacts.inspectZipBuffer(corruptedSigCopy, 'corrupted-sig.hap'),
        ArtifactValidationError,
        'Corrupted PKCS#7 sub-block 0x20000000 must fail HAP signature verification',
      );
    },
  }),

  defineTest({
    id: 'T2-F01-06-no-hidden-dotpaths-or-host-artifacts-leaked-into-hap',
    name: 'F1 Boundary: Packaged .hap and .app archives contain zero path traversal, hidden dot-files, private signing keys, or host binaries',
    tier: 2,
    features: ['F1'],
    timeoutMs: 20_000,
    async run(ctx) {
      const signedHap = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedHap);
      const ohosTestHap = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.ohosTestHap);
      const signedApp = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedApp);

      const forbiddenSuffixes = ['.p12', '.jks', '.keystore', '.key', '.rlib', '.node'];
      for (const [label, zip] of [
        ['entry-default-signed.hap', signedHap],
        ['entry-ohosTest-unsigned.hap', ohosTestHap],
        ['harmony-telegram-default-signed.app', signedApp],
      ]) {
        assert.greaterThan(zip.entryNames.length, 0, `${label} must have >= 1 entry`);
        for (const entryName of zip.entryNames) {
          assert.equal(entryName.startsWith('/'), false, `${label} entry '${entryName}' must not start with '/'`);
          assert.equal(entryName.includes('..'), false, `${label} entry '${entryName}' must not contain '..' traversal`);
          if (entryName !== '.pages.info') {
            const segments = entryName.split('/');
            for (const seg of segments) {
              if (!seg) continue;
              assert.equal(
                seg.startsWith('.'),
                false,
                `${label} must not package hidden dot-file or dot-directory '${entryName}'`,
              );
            }
          }
          for (const ext of forbiddenSuffixes) {
            assert.equal(
              entryName.toLowerCase().endsWith(ext),
              false,
              `${label} must not leak keystore or host build artifact '${entryName}'`,
            );
          }
          assert.equal(
            entryName.includes('gpui_telegram_server'),
            false,
            `${label} must not bundle host server binary inside client HAP/APP`,
          );
        }
      }
    },
  }),
];

export default tests;
