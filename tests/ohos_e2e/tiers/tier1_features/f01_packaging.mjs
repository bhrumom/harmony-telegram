import * as assert from '../../lib/assert.mjs';
import { CANONICAL_ARTIFACTS, STAGE_MODEL_FILES } from '../../lib/constants.mjs';
import { defineTest } from '../../lib/registry.mjs';

function buildStringMap(resourceJson) {
  const map = new Map();
  const list = Array.isArray(resourceJson?.string) ? resourceJson.string : [];
  for (const item of list) {
    if (item && typeof item.name === 'string') {
      map.set(item.name, String(item.value ?? ''));
    }
  }
  return map;
}

export const tests = [
  defineTest({
    id: 'T1-F01-01-app-scope-and-dual-product-build-profile',
    name: 'F1: AppScope manifest, Hvigor 5 non-daemon config, Hypium dependency, and dual OpenHarmony/HarmonyOS products',
    tier: 1,
    features: ['F1'],
    timeoutMs: 20_000,
    async run(ctx) {
      const appJson5 = ctx.artifacts.readJson5(STAGE_MODEL_FILES.appJson5);
      const appStrings = buildStringMap(ctx.artifacts.readJson(STAGE_MODEL_FILES.appStringJson));
      const rootProfile = ctx.artifacts.readJson5(STAGE_MODEL_FILES.rootBuildProfile);
      const hvigorCfg = ctx.artifacts.readJson5(STAGE_MODEL_FILES.hvigorConfig);
      const rootOhPkg = ctx.artifacts.readJson5(STAGE_MODEL_FILES.rootOhPackage);

      const app = appJson5?.app;
      assert.isObject(app, 'AppScope/app.json5 must contain top-level app object');
      assert.match(
        app.bundleName,
        /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+){2,}$/,
        'app.bundleName must have >= 3 reverse-DNS segments',
      );
      assert.between(app.bundleName.length, 7, 128, 'app.bundleName length must be within 7..128');
      assert.ok(Number.isInteger(app.versionCode), 'app.versionCode must be an integer');
      assert.between(app.versionCode, 1, 2_147_483_647, 'app.versionCode must be within 31-bit positive range');
      assert.equal(app.versionName, '1.2.0', 'app.versionName must equal 1.2.0');
      assert.ok(appStrings.has('app_name') && appStrings.get('app_name').trim().length > 0, 'AppScope must define app_name');

      const products = rootProfile?.app?.products;
      assert.isArray(products, 'Root build-profile.json5 must define app.products array');
      const defaultProduct = products.find((p) => p.name === 'default');
      const harmonyosProduct = products.find((p) => p.name === 'harmonyos');
      assert.isObject(defaultProduct, 'Root build-profile.json5 must define "default" product');
      assert.equal(defaultProduct.runtimeOS, 'OpenHarmony', 'default product runtimeOS must be OpenHarmony');
      assert.equal(defaultProduct.compileSdkVersion, 20, 'default product compileSdkVersion must be integer 20');
      assert.between(defaultProduct.compatibleSdkVersion, 12, 20, 'default compatibleSdkVersion must be in 12..20');

      assert.isObject(harmonyosProduct, 'Root build-profile.json5 must define "harmonyos" product');
      assert.equal(harmonyosProduct.runtimeOS, 'HarmonyOS', 'harmonyos product runtimeOS must be HarmonyOS');
      assert.isNonEmptyString(harmonyosProduct.compatibleSdkVersion, 'harmonyos compatibleSdkVersion must be version string');
      assert.includes(harmonyosProduct.compatibleSdkVersion, '(12)', 'harmonyos compatibleSdkVersion must target API 12 floor');
      assert.isNonEmptyString(harmonyosProduct.targetSdkVersion, 'harmonyos targetSdkVersion must be version string');
      assert.includes(harmonyosProduct.targetSdkVersion, '(20)', 'harmonyos targetSdkVersion must target API 20');

      assert.equal(
        hvigorCfg?.modelVersion,
        '5.0.0',
        'hvigor/hvigor-config.json5 modelVersion must be 5.0.0',
      );
      assert.equal(
        hvigorCfg?.execution?.daemon,
        false,
        'hvigor/hvigor-config.json5 must disable daemon mode for 7.8 GiB RAM safety',
      );

      const hypiumVer = rootOhPkg?.devDependencies?.['@ohos/hypium'] ?? rootOhPkg?.dependencies?.['@ohos/hypium'];
      assert.isNonEmptyString(hypiumVer, 'Root oh-package.json5 must declare @ohos/hypium');
      assert.includes(hypiumVer, '1.0.', '@ohos/hypium version must be 1.0.x');
    },
  }),

  defineTest({
    id: 'T1-F01-02-entry-stage-module-abilities-and-arkguard-config',
    name: 'F1: Entry stageMode profile, ArkGuard release obfuscation rules, multi-form-factor EntryAbility, and EntryBackupAbility',
    tier: 1,
    features: ['F1'],
    timeoutMs: 20_000,
    async run(ctx) {
      const entryProfile = ctx.artifacts.readJson5(STAGE_MODEL_FILES.entryBuildProfile);
      const obfRules = ctx.artifacts.readText(STAGE_MODEL_FILES.obfuscationRules);
      const moduleJson5 = ctx.artifacts.readJson5(STAGE_MODEL_FILES.moduleJson5);

      assert.equal(entryProfile?.apiType, 'stageMode', 'entry/build-profile.json5 must use stageMode');
      const arkTypes = entryProfile?.buildOption?.arkOptions?.types;
      assert.isArray(arkTypes, 'entry/build-profile.json5 must declare buildOption.arkOptions.types');
      assert.ok(
        arkTypes.some((t) => String(t).includes('libtelegram_core')),
        'arkOptions.types must register libtelegram_core type directory',
      );

      const releaseSet = (entryProfile?.buildOptionSet || []).find((b) => b.name === 'release');
      assert.isObject(releaseSet, 'entry/build-profile.json5 must configure release buildOptionSet');
      const ruleOpts = releaseSet?.arkOptions?.obfuscation?.ruleOptions;
      assert.equal(ruleOpts?.enable, true, 'Release ArkGuard obfuscation must be enabled');
      assert.isArray(ruleOpts?.files, 'ArkGuard ruleOptions.files must be an array');
      assert.ok(
        ruleOpts.files.some((f) => String(f).includes('obfuscation-rules.txt')),
        'ArkGuard ruleOptions.files must include obfuscation-rules.txt',
      );

      const targetNames = (entryProfile?.targets || []).map((t) => t.name);
      assert.includes(targetNames, 'default', 'entry targets must include default');
      assert.includes(targetNames, 'ohosTest', 'entry targets must include ohosTest');

      assert.includes(obfRules, '-keep-dts', 'obfuscation-rules.txt must include -keep-dts');
      assert.includes(
        obfRules,
        'libtelegram_core/index.d.ts',
        'obfuscation-rules.txt must preserve libtelegram_core/index.d.ts exports',
      );

      const mod = moduleJson5?.module;
      assert.isObject(mod, 'module.json5 must contain module object');
      assert.equal(mod.type, 'entry', 'module.type must be entry');
      assert.equal(mod.mainElement, 'EntryAbility', 'module.mainElement must be EntryAbility');
      assert.isArray(mod.deviceTypes, 'module.deviceTypes must be an array');
      for (const dev of ['phone', 'tablet', '2in1']) {
        assert.includes(mod.deviceTypes, dev, `module.deviceTypes must support ${dev}`);
      }

      const entryAbility = (mod.abilities || []).find((a) => a.name === 'EntryAbility');
      assert.isObject(entryAbility, 'module.abilities must define EntryAbility');
      if (entryAbility.supportWindowMode !== undefined) {
        assert.isArray(entryAbility.supportWindowMode, 'EntryAbility.supportWindowMode must be an array when specified');
        for (const winMode of ['fullscreen', 'split', 'floating']) {
          assert.includes(
            entryAbility.supportWindowMode,
            winMode,
            `EntryAbility.supportWindowMode must include ${winMode}`,
          );
        }
      }
      assert.isArray(entryAbility.backgroundModes, 'EntryAbility.backgroundModes must be an array');
      for (const bgMode of ['audioPlayback', 'voip']) {
        assert.includes(
          entryAbility.backgroundModes,
          bgMode,
          `EntryAbility.backgroundModes must include ${bgMode}`,
        );
      }

      const backupAbility = (mod.extensionAbilities || []).find(
        (ext) => ext.name === 'EntryBackupAbility' || ext.type === 'backup',
      );
      assert.isObject(backupAbility, 'module.extensionAbilities must define EntryBackupAbility (type=backup)');
      assert.equal(backupAbility.type, 'backup', 'EntryBackupAbility type must be backup');
    },
  }),

  defineTest({
    id: 'T1-F01-03-unsigned-and-signed-release-hap-zip-and-bytecode',
    name: 'F1: Release unsigned and signed .hap packages contain Panda .abc bytecode, resources.index, module.json, pack.info, and dual-ABI .so',
    tier: 1,
    features: ['F1'],
    timeoutMs: 25_000,
    async run(ctx) {
      const appJson5 = ctx.artifacts.readJson5(STAGE_MODEL_FILES.appJson5);
      const unsignedZip = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.unsignedHap);
      const signedZip = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedHap);

      const requiredEntries = [
        'module.json',
        'pack.info',
        'ets/modules.abc',
        'resources.index',
        'libs/arm64-v8a/libtelegram_core.so',
        'libs/x86_64/libtelegram_core.so',
      ];

      for (const [label, zip] of [
        ['entry-default-unsigned.hap', unsignedZip],
        ['entry-default-signed.hap', signedZip],
      ]) {
        for (const reqEntry of requiredEntries) {
          assert.ok(zip.hasEntry(reqEntry), `${label} must package '${reqEntry}'`);
        }
      }

      const abcBuf = signedZip.extractEntryBuffer('ets/modules.abc');
      assert.greaterThan(abcBuf.length, 64, 'ets/modules.abc must contain compiled ArkTS Panda bytecode');
      assert.equal(
        abcBuf.subarray(0, 5).toString('ascii'),
        'PANDA',
        'ets/modules.abc must start with official OpenHarmony PANDA bytecode magic',
      );

      const resIndexBuf = signedZip.extractEntryBuffer('resources.index');
      assert.greaterThan(resIndexBuf.length, 16, 'resources.index must be non-empty compiled restool index');

      const packagedModule = signedZip.extractEntryJson('module.json');
      assert.equal(
        packagedModule?.app?.bundleName,
        appJson5.app.bundleName,
        'Packaged module.json app.bundleName must match AppScope/app.json5',
      );
      assert.equal(
        packagedModule?.app?.versionName,
        '1.2.0',
        'Packaged module.json app.versionName must equal 1.2.0',
      );
      assert.equal(packagedModule?.module?.type, 'entry', 'Packaged module.json module.type must be entry');

      const packInfo = signedZip.extractEntryJson('pack.info');
      assert.equal(
        packInfo?.summary?.app?.bundleName,
        appJson5.app.bundleName,
        'Packaged pack.info bundleName must match AppScope/app.json5',
      );
    },
  }),

  defineTest({
    id: 'T1-F01-04-signed-hap-pkcs7-signature-block-verification',
    name: 'F1: Signed release .hap carries valid OpenHarmony HAP Signing Block and ASN.1 DER PKCS#7 SignedData sub-block',
    tier: 1,
    features: ['F1'],
    timeoutMs: 20_000,
    async run(ctx) {
      const unsignedZip = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.unsignedHap);
      const signedZip = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedHap);

      assert.equal(
        unsignedZip.hasHapSignatureBlock,
        false,
        'entry-default-unsigned.hap must NOT have an OpenHarmony HAP signature block',
      );
      assert.equal(
        signedZip.hasHapSignatureBlock,
        true,
        'entry-default-signed.hap MUST contain a valid OpenHarmony HAP signature block before Central Directory',
      );
      assert.equal(signedZip.hapSignature.valid, true, 'HAP signature block structural check must pass');
      assert.equal(signedZip.hapSignature.hasPkcs7Block, true, 'Sub-block 0x20000000 PKCS#7 signature must be present');
      assert.greaterThanOrEqual(signedZip.hapSignature.blockCount, 1, 'HAP signing block must have >= 1 sub-block');
      assert.greaterThanOrEqual(signedZip.hapSignature.sigBlockSize, 64, 'HAP signing block size must be >= 64 bytes');
      assert.greaterThan(
        signedZip.byteLength,
        unsignedZip.byteLength,
        'Signed .hap must be larger than unsigned .hap due to embedded PKCS#7 signing block',
      );
    },
  }),

  defineTest({
    id: 'T1-F01-05-ohostest-hap-and-signed-app-pack-integrity',
    name: 'F1: entry-ohosTest-unsigned.hap Hypium test package and harmony-telegram-default-signed.app release bundle integrity',
    tier: 1,
    features: ['F1'],
    timeoutMs: 25_000,
    async run(ctx) {
      const appJson5 = ctx.artifacts.readJson5(STAGE_MODEL_FILES.appJson5);
      const ohosTestZip = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.ohosTestHap);
      const signedAppZip = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedApp);

      assert.ok(ohosTestZip.hasEntry('module.json'), 'entry-ohosTest-unsigned.hap must contain module.json');
      assert.ok(ohosTestZip.hasEntry('pack.info'), 'entry-ohosTest-unsigned.hap must contain pack.info');
      assert.ok(ohosTestZip.hasEntry('ets/modules.abc'), 'entry-ohosTest-unsigned.hap must contain compiled Hypium ets/modules.abc');
      const testAbc = ohosTestZip.extractEntryBuffer('ets/modules.abc');
      assert.equal(testAbc.subarray(0, 5).toString('ascii'), 'PANDA', 'ohosTest ets/modules.abc must have PANDA magic');
      const testModuleJson = ohosTestZip.extractEntryJson('module.json');
      assert.equal(testModuleJson?.app?.bundleName, appJson5.app.bundleName, 'ohosTest bundleName must match app');

      assert.ok(signedAppZip.hasEntry('pack.info'), 'harmony-telegram-default-signed.app must contain pack.info');
      const appPackInfo = signedAppZip.extractEntryJson('pack.info');
      assert.equal(
        appPackInfo?.summary?.app?.bundleName,
        appJson5.app.bundleName,
        '.app pack.info bundleName must match AppScope/app.json5',
      );
      assert.isArray(appPackInfo?.summary?.modules, '.app pack.info summary.modules must be an array');
      assert.greaterThanOrEqual(appPackInfo.summary.modules.length, 1, '.app must list >= 1 packaged module');

      const hapEntries = signedAppZip.entryNames.filter((n) => n.endsWith('.hap'));
      assert.greaterThanOrEqual(hapEntries.length, 1, 'Signed .app archive must contain >= 1 .hap module entry');

      for (const hapEntryName of hapEntries) {
        const innerHapBuf = signedAppZip.extractEntryBuffer(hapEntryName);
        const innerHapZip = ctx.artifacts.inspectZipBuffer(innerHapBuf, `signed.app!${hapEntryName}`);
        assert.ok(innerHapZip.hasEntry('ets/modules.abc'), `Embedded ${hapEntryName} must contain ets/modules.abc`);
        const innerMod = innerHapZip.extractEntryJson('module.json');
        assert.equal(innerMod?.app?.bundleName, appJson5.app.bundleName, `Embedded ${hapEntryName} bundleName must match`);
      }

      const appIsSigned = signedAppZip.hasHapSignatureBlock || signedAppZip.hasEmbeddedSignedHap();
      assert.equal(
        appIsSigned,
        true,
        'harmony-telegram-default-signed.app must carry a valid OpenHarmony PKCS#7 signature block',
      );
    },
  }),

  defineTest({
    id: 'T1-F01-06-cli-inspect-artifacts-end-to-end-report',
    name: 'F1: Opaque-box ohos-app-cli inspect-artifacts validates Stage Model manifests, signed packages, and native libraries',
    tier: 1,
    features: ['F1'],
    timeoutMs: 25_000,
    async run(ctx) {
      const foundation = ctx.artifacts.validateStageModelFoundation();
      assert.equal(foundation.valid, true, 'Artifact inspector Stage Model check must pass');

      const cliRes = await ctx.cli.inspectArtifacts({ expectOk: true });
      assert.equal(cliRes.ok, true, 'ohos-app-cli inspect-artifacts must return ok: true');
      assert.equal(cliRes.exitCode, 0, 'ohos-app-cli inspect-artifacts must exit with code 0');
      assert.isObject(cliRes.data, 'ohos-app-cli inspect-artifacts must return structured data object');

      const serialized = JSON.stringify(cliRes.data);
      assert.greaterThan(serialized.length, 10, 'inspect-artifacts data report must be non-empty');
    },
  }),
];

export default tests;
