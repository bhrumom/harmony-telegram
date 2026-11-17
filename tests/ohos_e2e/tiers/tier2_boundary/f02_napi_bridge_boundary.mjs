import * as assert from '../../lib/assert.mjs';
import {
  ALLOWED_OHOS_DT_NEEDED,
  CANONICAL_ARTIFACTS,
  FORBIDDEN_UNDEFINED_NAPI_SYMBOLS,
  STAGE_MODEL_FILES,
} from '../../lib/constants.mjs';
import { defineTest } from '../../lib/registry.mjs';

// Uses ctx.artifacts.stripSourceComments & ctx.artifacts.inspectModuleImports

function extractWaveformPackedBytes(data) {
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (data && typeof data === 'object') {
    for (const k of ['packed63Bytes', 'waveformBytes', 'packedBytes', 'bytes']) {
      if (Array.isArray(data[k])) return Buffer.from(data[k]);
      if (typeof data[k] === 'string') return Buffer.from(data[k], 'base64');
    }
    for (const k of ['packedBase64', 'waveformBase64', 'base64']) {
      if (typeof data[k] === 'string') return Buffer.from(data[k], 'base64');
    }
  }
  if (typeof data === 'string' && data.length > 0) return Buffer.from(data, 'base64');
  return null;
}

export const tests = [
  defineTest({
    id: 'T2-F02-01-elf64-dt-needed-ndk-allowlist-and-libcxx-copackaging',
    name: 'F2 Boundary: arm64-v8a and x86_64 .so DT_NEEDED strictly match OpenHarmony NDK allowlist, forbid glibc/OpenSSL, and enforce libc++_shared.so co-packaging',
    tier: 2,
    features: ['F2'],
    timeoutMs: 20_000,
    async run(ctx) {
      const armElf = ctx.artifacts.inspectElf(CANONICAL_ARTIFACTS.arm64So);
      const x64Elf = ctx.artifacts.inspectElf(CANONICAL_ARTIFACTS.x86_64So);
      const signedHap = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedHap);

      const allowedSet = new Set(ALLOWED_OHOS_DT_NEEDED);
      const forbiddenGlibcOrHost = [
        'libc.so.6',
        'libm.so.6',
        'libpthread.so.0',
        'libdl.so.2',
        'ld-linux-x86-64.so.2',
        'ld-linux-aarch64.so.1',
        'libstdc++.so.6',
        'libgcc_s.so.1',
      ];

      for (const [abiDir, elf] of [
        ['arm64-v8a', armElf],
        ['x86_64', x64Elf],
      ]) {
        assert.greaterThanOrEqual(elf.dtNeeded.length, 1, `${abiDir} .so must declare >= 1 DT_NEEDED library`);

        for (const libName of elf.dtNeeded) {
          assert.equal(
            forbiddenGlibcOrHost.includes(libName),
            false,
            `${abiDir} libtelegram_core.so MUST NOT link Linux glibc/host library '${libName}'`,
          );
          assert.doesNotMatch(
            libName,
            /^lib(ssl|crypto|sqlite3)\.so/i,
            `${abiDir} libtelegram_core.so must embed rustls/bundled-sqlite rather than dynamic '${libName}'`,
          );
          assert.equal(
            allowedSet.has(libName),
            true,
            `${abiDir} DT_NEEDED '${libName}' must belong to OpenHarmony Public NDK allowlist`,
          );
        }

        if (elf.rpath || elf.runpath) {
          const combinedPath = `${elf.rpath || ''}:${elf.runpath || ''}`;
          assert.doesNotMatch(
            combinedPath,
            /\/(home|usr|opt)\//,
            `${abiDir} .so must not leak build-host RPATH/RUNPATH '${combinedPath}'`,
          );
        }

        // If libc++_shared.so is dynamically required, it MUST be co-packaged in entry/libs/<abi>/ AND inside the signed HAP!
        if (elf.dtNeeded.includes('libc++_shared.so')) {
          const diskLibcxx = `entry/libs/${abiDir}/libc++_shared.so`;
          assert.equal(
            ctx.artifacts.exists(diskLibcxx),
            true,
            `${abiDir} .so links libc++_shared.so so ${diskLibcxx} MUST exist on disk`,
          );
          assert.equal(
            signedHap.hasEntry(`libs/${abiDir}/libc++_shared.so`),
            true,
            `${abiDir} .so links libc++_shared.so so entry-default-signed.hap MUST package libs/${abiDir}/libc++_shared.so`,
          );
        }
      }
    },
  }),

  defineTest({
    id: 'T2-F02-02-elf64-zero-forbidden-napi-and-emutls-undefined-symbols',
    name: 'F2 Boundary: Both OHOS .so binaries import zero unsupported napi-rs or __emutls_get_address symbols (verified with and without ELF section headers)',
    tier: 2,
    features: ['F2'],
    timeoutMs: 20_000,
    async run(ctx) {
      const armBuf = ctx.artifacts.readBuffer(CANONICAL_ARTIFACTS.arm64So);
      const x64Buf = ctx.artifacts.readBuffer(CANONICAL_ARTIFACTS.x86_64So);

      const armElf = ctx.artifacts.parseElfBuffer(armBuf, 'arm64-v8a/libtelegram_core.so');
      const x64Elf = ctx.artifacts.parseElfBuffer(x64Buf, 'x86_64/libtelegram_core.so');

      for (const [label, elf] of [
        ['arm64-v8a', armElf],
        ['x86_64', x64Elf],
      ]) {
        for (const forbiddenSym of FORBIDDEN_UNDEFINED_NAPI_SYMBOLS) {
          assert.notIncludes(
            elf.undefinedSymbols,
            forbiddenSym,
            `${label} libtelegram_core.so MUST NOT have unresolved '${forbiddenSym}' (crashes OpenHarmony ArkRuntime)`,
          );
        }
      }

      // Strip section header table fields in in-memory copies of BOTH arm64-v8a and x86_64 .so to verify PT_DYNAMIC + DT_GNU_HASH/DT_HASH parity
      for (const [abiLabel, origBuf, origElf] of [
        ['arm64-v8a', armBuf, armElf],
        ['x86_64', x64Buf, x64Elf],
      ]) {
        const strippedCopy = Buffer.from(origBuf);
        strippedCopy.writeBigUInt64LE(0n, 40); // e_shoff = 0
        strippedCopy.writeUInt16LE(0, 58); // e_shentsize = 0
        strippedCopy.writeUInt16LE(0, 60); // e_shnum = 0
        strippedCopy.writeUInt16LE(0, 62); // e_shstrndx = 0

        const strippedElf = ctx.artifacts.parseElfBuffer(strippedCopy, `stripped-${abiLabel}.so`);
        assert.equal(
          strippedElf.hasSectionHeaders,
          false,
          `Stripped ${abiLabel} copy must report hasSectionHeaders=false`,
        );
        assert.deepEqual(
          strippedElf.dtNeeded,
          origElf.dtNeeded,
          `Stripped ${abiLabel} PT_DYNAMIC inspection must recover identical DT_NEEDED libraries`,
        );
        for (const forbiddenSym of FORBIDDEN_UNDEFINED_NAPI_SYMBOLS) {
          assert.notIncludes(
            strippedElf.undefinedSymbols,
            forbiddenSym,
            `Stripped ${abiLabel} PT_DYNAMIC symbol scan must confirm absence of '${forbiddenSym}'`,
          );
        }
      }
    },
  }),

  defineTest({
    id: 'T2-F02-03-arkts-bridge-forbids-ohos-buffer-and-named-so-value-imports',
    name: 'F2 Boundary: TelegramBridge.ets and index.d.ts forbid @ohos.buffer / Node Buffer and forbid multi-line, combined, namespace, or CommonJS value imports from libtelegram_core.so',
    tier: 2,
    features: ['F2'],
    timeoutMs: 20_000,
    async run(ctx) {
      const rawBridge = ctx.artifacts.readText(STAGE_MODEL_FILES.telegramBridgeEts);
      const rawDts = ctx.artifacts.readText(CANONICAL_ARTIFACTS.napiDts);
      const importInfo = ctx.artifacts.inspectModuleImports(rawBridge, 'libtelegram_core.so');
      const bridgeCode = importInfo.strippedSource;
      const dtsCode = ctx.artifacts.stripSourceComments(rawDts);

      assert.doesNotMatch(
        bridgeCode,
        /@ohos\.buffer\b/,
        'TelegramBridge.ets must use Uint8Array/ArrayBuffer, NEVER @ohos.buffer',
      );
      assert.doesNotMatch(
        dtsCode,
        /@ohos\.buffer\b|\bBuffer\b/,
        'libtelegram_core/index.d.ts must type binary arguments with Uint8Array/ArrayBuffer rather than Node Buffer',
      );

      // OpenHarmony ArkRuntime N-API loader exports default module object; non-type `import { fn }`, `import def, { fn }`, `import * as` resolve to undefined!
      assert.greaterThanOrEqual(
        importInfo.defaultImports.length,
        1,
        'TelegramBridge.ets must declare at least one pure default import `import <ident> from "libtelegram_core.so"`',
      );
      assert.equal(
        importInfo.invalidImports.length,
        0,
        `TelegramBridge.ets must only use pure default import or pure \`import type\` from libtelegram_core.so, found forbidden import(s): ${JSON.stringify(importInfo.invalidImports)}`,
      );
      assert.equal(
        importInfo.dynamicOrCommonJsLoads.length,
        0,
        `TelegramBridge.ets must not use require() or dynamic import() on libtelegram_core.so: ${JSON.stringify(importInfo.dynamicOrCommonJsLoads)}`,
      );
      assert.equal(
        importInfo.invalidReexports.length,
        0,
        `TelegramBridge.ets must not value-reexport from libtelegram_core.so: ${JSON.stringify(importInfo.invalidReexports)}`,
      );
    },
  }),

  defineTest({
    id: 'T2-F02-04-cli-invoke-rejects-unknown-domain-and-unknown-action',
    name: 'F2 Boundary: ohos-app-cli invoke cleanly rejects unknown domains and unknown actions with structured ok=false JSON envelopes',
    tier: 2,
    features: ['F2'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f02_neg_dispatch');

      const badDomainRes = await ctx.cli.invoke({
        sandbox,
        domain: '__nonexistent_domain_e2e__',
        action: 'ping',
        payload: {},
        expectOk: false,
      });
      assert.equal(badDomainRes.ok, false, 'Unknown domain must return ok=false');
      assert.notEqual(badDomainRes.exitCode, 0, 'Unknown domain must exit with non-zero code');
      assert.isNonEmptyString(
        badDomainRes.errorMessage || badDomainRes.errorCode,
        'Unknown domain must populate errorMessage or errorCode',
      );

      const badActionRes = await ctx.cli.invoke({
        sandbox,
        domain: 'media',
        action: '__nonexistent_action_e2e__',
        payload: {},
        expectOk: false,
      });
      assert.equal(badActionRes.ok, false, 'Unknown action on valid domain must return ok=false');
      assert.notEqual(badActionRes.exitCode, 0, 'Unknown action must exit with non-zero code');
      assert.isNonEmptyString(
        badActionRes.errorMessage || badActionRes.errorCode,
        'Unknown action must populate errorMessage or errorCode',
      );
    },
  }),

  defineTest({
    id: 'T2-F02-05-cli-invoke-rejects-malformed-json-and-handles-zero-byte-pcm-boundary',
    name: 'F2 Boundary: Bridge rejects malformed JSON payloads without crashing and safely encodes 0-byte / odd-byte PCM waveforms',
    tier: 2,
    features: ['F2'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f02_neg_payload');

      const badJsonRes = await ctx.cli.execRaw(
        [
          'invoke',
          '--sandbox',
          sandbox.rootDir,
          '--server',
          'http://127.0.0.1:9',
          '--domain',
          'settings',
          '--action',
          'getPreferences',
          '--payload',
          '{broken_json_payload',
        ],
        { expectOk: false },
      );
      assert.equal(badJsonRes.ok, false, 'Malformed --payload JSON must fail with ok=false');
      assert.notEqual(badJsonRes.exitCode, 0, 'Malformed --payload JSON must return non-zero exit code');

      const missingFlagsRes = await ctx.cli.execRaw(['invoke', '--sandbox', sandbox.rootDir], { expectOk: false });
      assert.equal(missingFlagsRes.ok, false, 'Missing --domain/--action flags must fail with ok=false');

      // Zero-byte and 1-byte odd PCM boundary must NOT panic with division-by-zero or slice out-of-bounds
      for (const byteLen of [0, 1]) {
        const tinyPcm = Buffer.alloc(byteLen, 0x7f);
        const encRes = await ctx.cli.invoke({
          sandbox,
          domain: 'media',
          action: 'encodeWaveform5Bit',
          payload: {
            pcmI16Bytes: Array.from(tinyPcm),
            pcmBase64: tinyPcm.toString('base64'),
          },
          expectOk: true,
        });
        const packed = extractWaveformPackedBytes(encRes.data);
        assert.ok(packed !== null, `${byteLen}-byte PCM encodeWaveform5Bit must return valid packed output`);
        assert.equal(packed.length, 63, `${byteLen}-byte PCM waveform must still pack to fixed 63 bytes`);
      }
    },
  }),

  defineTest({
    id: 'T2-F02-06-sandbox-isolation-between-independent-client-sandboxes',
    name: 'F2 Boundary: Two independent HarmonyOS client sandboxes maintain strictly isolated SQLite/preferences stores without cross-contamination',
    tier: 2,
    features: ['F2'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandboxA = ctx.createClientSandbox('isolated_a');
      const sandboxB = ctx.createClientSandbox('isolated_b');

      await ctx.cli.invoke({
        sandbox: sandboxA,
        domain: 'settings',
        action: 'setTheme',
        payload: { themeId: 'classic' },
        expectOk: true,
      });
      await ctx.cli.invoke({
        sandbox: sandboxA,
        domain: 'settings',
        action: 'setLocale',
        payload: { locale: 'en-US' },
        expectOk: true,
      });

      await ctx.cli.invoke({
        sandbox: sandboxB,
        domain: 'settings',
        action: 'setTheme',
        payload: { themeId: 'night' },
        expectOk: true,
      });
      await ctx.cli.invoke({
        sandbox: sandboxB,
        domain: 'settings',
        action: 'setLocale',
        payload: { locale: 'zh-CN' },
        expectOk: true,
      });

      const uiA = await ctx.cli.uiSession({
        sandbox: sandboxA,
        script: { initialWindowWidthVp: 360, steps: [{ op: 'resizeWindow', widthVp: 360 }] },
        expectOk: true,
      });
      const uiB = await ctx.cli.uiSession({
        sandbox: sandboxB,
        script: { initialWindowWidthVp: 1440, steps: [{ op: 'resizeWindow', widthVp: 1440 }] },
        expectOk: true,
      });

      assert.equal(uiA.data?.finalState?.themeId, 'classic', 'Sandbox A must retain themeId="classic"');
      assert.equal(uiA.data?.finalState?.locale, 'en-US', 'Sandbox A must retain locale="en-US"');

      assert.equal(uiB.data?.finalState?.themeId, 'night', 'Sandbox B must retain themeId="night"');
      assert.equal(uiB.data?.finalState?.locale, 'zh-CN', 'Sandbox B must retain locale="zh-CN"');
    },
  }),
];

export default tests;
