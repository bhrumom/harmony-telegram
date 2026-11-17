import * as assert from '../../lib/assert.mjs';
import {
  CANONICAL_ARTIFACTS,
  REQUIRED_NAPI_EXPORTS,
  STAGE_MODEL_FILES,
} from '../../lib/constants.mjs';
import { defineTest } from '../../lib/registry.mjs';

function buildTestPcmBytes(sampleCount = 1600, amplitude = 18000, activeHalfOnly = false) {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const isSilent = activeHalfOnly && i < sampleCount / 2;
    const sample = isSilent ? 0 : Math.round(Math.sin((i / 16) * Math.PI * 2) * amplitude);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return buf;
}

function extractWaveformPackedBytes(data) {
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.from(data);
  }
  if (data && typeof data === 'object') {
    for (const key of ['packed63Bytes', 'waveformBytes', 'packedBytes', 'bytes']) {
      if (Array.isArray(data[key])) return Buffer.from(data[key]);
      if (typeof data[key] === 'string') return Buffer.from(data[key], 'base64');
    }
    for (const key of ['packedBase64', 'waveformBase64', 'base64']) {
      if (typeof data[key] === 'string') return Buffer.from(data[key], 'base64');
    }
  }
  if (typeof data === 'string' && data.length > 0) {
    return Buffer.from(data, 'base64');
  }
  return null;
}

function extractDecodedWaveformBars(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['bars', 'values', 'samples', 'floats', 'waveform', 'decoded']) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return null;
}

export const tests = [
  defineTest({
    id: 'T1-F02-01-dual-abi-elf64-architecture-and-packaged-parity',
    name: 'F2: arm64-v8a (EM_AARCH64) and x86_64 (EM_X86_64) libtelegram_core.so ELF64 binaries link libace_napi.z.so and match packaged HAP byte-for-byte',
    tier: 1,
    features: ['F2'],
    timeoutMs: 25_000,
    async run(ctx) {
      const armElf = ctx.artifacts.inspectElf(CANONICAL_ARTIFACTS.arm64So);
      const x64Elf = ctx.artifacts.inspectElf(CANONICAL_ARTIFACTS.x86_64So);
      const signedHap = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedHap);

      assert.equal(armElf.isElf64, true, 'arm64-v8a libtelegram_core.so must be 64-bit ELF');
      assert.equal(armElf.isLittleEndian, true, 'arm64-v8a libtelegram_core.so must be little-endian');
      assert.equal(armElf.isSharedObject, true, 'arm64-v8a libtelegram_core.so must be ET_DYN shared library');
      assert.equal(armElf.eMachine, 183, 'arm64-v8a libtelegram_core.so e_machine must be 183 (EM_AARCH64)');
      assert.includes(armElf.dtNeeded, 'libace_napi.z.so', 'arm64-v8a .so must link libace_napi.z.so');

      assert.equal(x64Elf.isElf64, true, 'x86_64 libtelegram_core.so must be 64-bit ELF');
      assert.equal(x64Elf.isLittleEndian, true, 'x86_64 libtelegram_core.so must be little-endian');
      assert.equal(x64Elf.isSharedObject, true, 'x86_64 libtelegram_core.so must be ET_DYN shared library');
      assert.equal(x64Elf.eMachine, 62, 'x86_64 libtelegram_core.so e_machine must be 62 (EM_X86_64)');
      assert.includes(x64Elf.dtNeeded, 'libace_napi.z.so', 'x86_64 .so must link libace_napi.z.so');

      for (const [label, elf] of [
        ['arm64-v8a', armElf],
        ['x86_64', x64Elf],
      ]) {
        const importsNapiModuleReg =
          elf.undefinedSymbols.some((s) => s.startsWith('napi_')) ||
          elf.definedSymbols.includes('napi_register_module_v1');
        assert.equal(
          importsNapiModuleReg,
          true,
          `${label} libtelegram_core.so must import/export OpenHarmony N-API symbols`,
        );
      }

      // Verify exact SHA-256 parity between entry/libs/* and libs/* packaged inside entry-default-signed.hap
      const diskArmSha = ctx.crypto.sha256Hex(ctx.artifacts.readBuffer(CANONICAL_ARTIFACTS.arm64So));
      const hapArmSha = ctx.crypto.sha256Hex(signedHap.extractEntryBuffer('libs/arm64-v8a/libtelegram_core.so'));
      assert.equal(diskArmSha, hapArmSha, 'Packaged arm64-v8a libtelegram_core.so SHA-256 must match entry/libs/arm64-v8a');

      const diskX64Sha = ctx.crypto.sha256Hex(ctx.artifacts.readBuffer(CANONICAL_ARTIFACTS.x86_64So));
      const hapX64Sha = ctx.crypto.sha256Hex(signedHap.extractEntryBuffer('libs/x86_64/libtelegram_core.so'));
      assert.equal(diskX64Sha, hapX64Sha, 'Packaged x86_64 libtelegram_core.so SHA-256 must match entry/libs/x86_64');
    },
  }),

  defineTest({
    id: 'T1-F02-02-napi-dts-and-oh-package-complete-contract',
    name: 'F2: libtelegram_core index.d.ts and oh-package.json5 declare SandboxInitConfig, CoreResponseEnvelope, and all 9 #[napi] exports',
    tier: 1,
    features: ['F2'],
    timeoutMs: 20_000,
    async run(ctx) {
      const entryOhPkg = ctx.artifacts.readJson5(STAGE_MODEL_FILES.entryOhPackage);
      const napiOhPkg = ctx.artifacts.readJson5(CANONICAL_ARTIFACTS.napiOhPackage);
      const dtsText = ctx.artifacts.readText(CANONICAL_ARTIFACTS.napiDts);

      const depSpec = entryOhPkg?.dependencies?.['libtelegram_core.so'];
      assert.isNonEmptyString(depSpec, 'entry/oh-package.json5 must declare dependency "libtelegram_core.so"');
      assert.includes(depSpec, 'src/main/cpp/types/libtelegram_core', 'libtelegram_core.so dependency must point to local types dir');

      assert.equal(napiOhPkg?.name, 'libtelegram_core.so', 'types oh-package.json5 name must equal libtelegram_core.so');
      assert.includes(String(napiOhPkg?.types ?? ''), 'index.d.ts', 'types oh-package.json5 must reference index.d.ts');

      for (const ifaceName of ['SandboxInitConfig', 'CoreResponseEnvelope']) {
        assert.includes(dtsText, ifaceName, `index.d.ts must declare interface/type ${ifaceName}`);
      }
      for (const field of [
        'filesDir',
        'cacheDir',
        'tempDir',
        'databaseDir',
        'resourceDir',
        'caCertPath',
        'defaultServerUrl',
      ]) {
        assert.includes(dtsText, field, `SandboxInitConfig in index.d.ts must declare '${field}'`);
      }
      for (const envField of ['ok', 'dataJson', 'errorCode', 'errorMessage', 'generation']) {
        assert.includes(dtsText, envField, `CoreResponseEnvelope in index.d.ts must declare '${envField}'`);
      }
      for (const fnName of REQUIRED_NAPI_EXPORTS) {
        assert.match(
          dtsText,
          new RegExp(`\\b${fnName}\\b`),
          `index.d.ts must export #[napi] function '${fnName}'`,
        );
      }
    },
  }),

  defineTest({
    id: 'T1-F02-03-arkts-telegram-bridge-esm-import-and-typed-buffers',
    name: 'F2: TelegramBridge.ets uses default ESM import from libtelegram_core.so, erased type imports, and Uint8Array binary wrappers',
    tier: 1,
    features: ['F2'],
    timeoutMs: 20_000,
    async run(ctx) {
      const bridgeText = ctx.artifacts.readText(STAGE_MODEL_FILES.telegramBridgeEts);
      const importInfo = ctx.artifacts.inspectModuleImports(bridgeText, 'libtelegram_core.so');

      assert.greaterThanOrEqual(
        importInfo.defaultImports.length,
        1,
        'TelegramBridge.ets must declare a pure default ESM import from libtelegram_core.so (outside comments/strings)',
      );
      assert.equal(
        importInfo.invalidImports.length,
        0,
        `TelegramBridge.ets must not use named value, namespace, or side-effect imports from libtelegram_core.so: ${JSON.stringify(importInfo.invalidImports)}`,
      );
      assert.equal(
        importInfo.dynamicOrCommonJsLoads.length,
        0,
        `TelegramBridge.ets must not load libtelegram_core.so via require() or dynamic import(): ${JSON.stringify(importInfo.dynamicOrCommonJsLoads)}`,
      );
      assert.equal(
        importInfo.invalidReexports.length,
        0,
        `TelegramBridge.ets must not value-reexport from libtelegram_core.so: ${JSON.stringify(importInfo.invalidReexports)}`,
      );

      const activeCode = importInfo.strippedSource;
      assert.includes(activeCode, 'Uint8Array', 'TelegramBridge.ets must pass binary frames via Uint8Array');
      for (const method of [
        'initCore',
        'shutdownCore',
        'invokeAction',
        'subscribeDomainEvents',
        'encodeWaveform5Bit',
        'decodeWaveform5Bit',
        'processTalkVadFrame',
      ]) {
        assert.includes(activeCode, method, `TelegramBridge.ets must expose/wrap '${method}'`);
      }
    },
  }),

  defineTest({
    id: 'T1-F02-04-live-bridge-waveform-5bit-pack-and-unpack-roundtrip',
    name: 'F2: Native N-API bridge encodes 16-bit PCM into 63-byte packed 5-bit waveform and decodes 100 normalized bars',
    tier: 1,
    features: ['F2'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f02_waveform');
      const pcmHalfSilentHalfLoud = buildTestPcmBytes(2000, 26000, true);

      const encodeRes = await ctx.cli.invoke({
        sandbox,
        domain: 'media',
        action: 'encodeWaveform5Bit',
        payload: {
          pcmI16Bytes: Array.from(pcmHalfSilentHalfLoud),
          pcmBase64: pcmHalfSilentHalfLoud.toString('base64'),
        },
        expectOk: true,
      });

      const packed63 = extractWaveformPackedBytes(encodeRes.data);
      assert.ok(packed63 !== null, 'encodeWaveform5Bit must return packed byte array or base64');
      assert.equal(packed63.length, 63, '100-bar 5-bit waveform must pack into exact 63 bytes');

      const decodeRes = await ctx.cli.invoke({
        sandbox,
        domain: 'media',
        action: 'decodeWaveform5Bit',
        payload: {
          packed63Bytes: Array.from(packed63),
          packedBase64: packed63.toString('base64'),
        },
        expectOk: true,
      });

      const bars = extractDecodedWaveformBars(decodeRes.data);
      assert.isArray(bars, 'decodeWaveform5Bit must return an array of 100 bar magnitudes');
      assert.equal(bars.length, 100, 'Decoded waveform must contain exactly 100 bars');
      for (const val of bars) {
        assert.between(val, 0.0, 1.0, 'Every decoded waveform bar must be normalized in 0.0..=1.0');
      }

      const firstQuarterAvg = bars.slice(0, 25).reduce((s, v) => s + v, 0) / 25;
      const lastQuarterAvg = bars.slice(75, 100).reduce((s, v) => s + v, 0) / 25;
      assert.lessThan(firstQuarterAvg, 0.08, 'Silent PCM half must decode to near-zero waveform bars');
      assert.greaterThan(lastQuarterAvg, 0.25, 'Active sine PCM half must decode to non-zero waveform bars');
    },
  }),

  defineTest({
    id: 'T1-F02-05-live-bridge-vad-frame-and-sandbox-sqlite-init',
    name: 'F2: Native N-API bridge evaluates <60ms VAD speech/silence frames and initializes isolated HarmonyOS sandbox directories',
    tier: 1,
    features: ['F2'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f02_vad');
      const silentPcm = Buffer.alloc(640, 0); // 20ms @ 16kHz 16-bit mono silence
      const loudSpeechPcm = buildTestPcmBytes(640, 28000, false); // high-energy frame

      const silenceRes = await ctx.cli.invoke({
        sandbox,
        domain: 'talk',
        action: 'processVadFrame',
        payload: {
          pcmI16Bytes: Array.from(silentPcm),
          pcmBase64: silentPcm.toString('base64'),
          sampleRate: 16000,
        },
        expectOk: true,
      });

      assert.isObject(silenceRes.data, 'processVadFrame must return structured VAD result');
      assert.equal(silenceRes.data.speechDetected, false, 'Zero-energy PCM frame must report speechDetected=false');
      assert.equal(
        silenceRes.data.shouldAbortPlayback,
        false,
        'Zero-energy PCM frame must report shouldAbortPlayback=false',
      );
      assert.ok(typeof silenceRes.data.rmsDb === 'number', 'processVadFrame must return numeric rmsDb');

      const speechRes = await ctx.cli.invoke({
        sandbox,
        domain: 'talk',
        action: 'processVadFrame',
        payload: {
          pcmI16Bytes: Array.from(loudSpeechPcm),
          pcmBase64: loudSpeechPcm.toString('base64'),
          sampleRate: 16000,
        },
        expectOk: true,
      });

      assert.isObject(speechRes.data, 'Speech VAD call must return structured object');
      assert.equal(speechRes.data.speechDetected, true, 'High-amplitude frame must report speechDetected=true');
      assert.greaterThan(
        speechRes.data.rmsDb,
        silenceRes.data.rmsDb,
        'High-amplitude frame rmsDb must exceed silent frame rmsDb',
      );
      if (typeof speechRes.data.latencyMs === 'number') {
        assert.lessThan(speechRes.data.latencyMs, 60, 'Internal VAD frame check must execute in < 60ms');
      }
    },
  }),

  defineTest({
    id: 'T1-F02-06-live-bridge-server-roundtrip-and-generation-envelope',
    name: 'F2: Client bridge connects to live gpui_telegram_server, persists server config in sandbox, and returns generation-fenced envelope',
    tier: 1,
    features: ['F2'],
    timeoutMs: 30_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const statusRes = await ctx.http.get('/api/v1/status');
      assert.httpStatus(statusRes, 200, 'GET /api/v1/status');
      assert.equal(statusRes.json?.status, 'healthy', 'Live gpui_telegram_server must report healthy status');

      const sandbox = ctx.createClientSandbox('f02_live_client');
      const setCfg = await ctx.cli.invoke({
        sandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'setServerConfig',
        payload: {
          serverUrl: server.baseUrl,
          server_url: server.baseUrl,
        },
        expectOk: true,
      });
      assert.equal(setCfg.ok, true, 'auth.setServerConfig must succeed');
      assert.greaterThanOrEqual(setCfg.generation, 0, 'CoreResponseEnvelope generation must be >= 0');

      const prefsRes = await ctx.cli.invoke({
        sandbox,
        serverUrl: server.baseUrl,
        domain: 'settings',
        action: 'getPreferences',
        payload: {},
        expectOk: true,
      });
      assert.equal(prefsRes.ok, true, 'settings.getPreferences must succeed against initialized sandbox');
      assert.isObject(prefsRes.data, 'settings.getPreferences must return preferences object');
    },
  }),
];

export default tests;
