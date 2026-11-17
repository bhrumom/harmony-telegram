import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SUITE_ROOT = path.resolve(__dirname, '..');
export const TIERS_ROOT = path.join(SUITE_ROOT, 'tiers');
export const WORK_ROOT = path.join(SUITE_ROOT, 'work');
export const DEFAULT_REPO_ROOT = '/home/antigravity/harmony-telegram';
export const DEFAULT_CA_CERT_PATH = '/etc/ssl/certs/cacert.pem';

export function resolveRepoRoot(override) {
  const raw = override ?? process.env.HARMONY_TELEGRAM_ROOT ?? DEFAULT_REPO_ROOT;
  return path.resolve(raw);
}

export const ALL_FEATURES = Object.freeze([
  'F1', 'F2', 'F3', 'F4',
  'F5', 'F6', 'F7', 'F8',
  'F9', 'F10', 'F11', 'F12',
  'F13', 'F14', 'F15', 'F16',
]);

export const VALID_TIERS = Object.freeze([1, 2, 3, 4]);

export const TIER_DIRECTORIES = Object.freeze({
  1: 'tier1_features',
  2: 'tier2_boundary',
  3: 'tier3_cross',
  4: 'tier4_scenarios',
});

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 60_000;

export const SELF_CHECK_THRESHOLDS = Object.freeze({
  minTier1PerFeature: 5,
  minTier2PerFeature: 5,
  minTier1Total: 80,
  minTier2Total: 80,
  minTier3Total: 20,
  minTier4Total: 10,
  minGrandTotal: 190,
});

export const CANONICAL_ARTIFACTS = Object.freeze({
  arm64So: 'entry/libs/arm64-v8a/libtelegram_core.so',
  x86_64So: 'entry/libs/x86_64/libtelegram_core.so',
  napiDts: 'entry/src/main/cpp/types/libtelegram_core/index.d.ts',
  napiOhPackage: 'entry/src/main/cpp/types/libtelegram_core/oh-package.json5',
  unsignedHap: 'entry/build/default/outputs/default/entry-default-unsigned.hap',
  signedHap: 'entry/build/default/outputs/default/entry-default-signed.hap',
  ohosTestHap: 'entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap',
  signedApp: 'build/outputs/default/harmony-telegram-default-signed.app',
});

export const STAGE_MODEL_FILES = Object.freeze({
  appJson5: 'AppScope/app.json5',
  appStringJson: 'AppScope/resources/base/element/string.json',
  rootBuildProfile: 'build-profile.json5',
  hvigorConfig: 'hvigor/hvigor-config.json5',
  rootOhPackage: 'oh-package.json5',
  entryBuildProfile: 'entry/build-profile.json5',
  entryOhPackage: 'entry/oh-package.json5',
  obfuscationRules: 'entry/obfuscation-rules.txt',
  moduleJson5: 'entry/src/main/module.json5',
  telegramBridgeEts: 'entry/src/main/ets/bridge/TelegramBridge.ets',
  appStoreEts: 'entry/src/main/ets/model/AppStore.ets',
  indexPageEts: 'entry/src/main/ets/pages/Index.ets',
  baseColorJson: 'entry/src/main/resources/base/element/color.json',
  darkColorJson: 'entry/src/main/resources/dark/element/color.json',
  baseStringJson: 'entry/src/main/resources/base/element/string.json',
  zhCnStringJson: 'entry/src/main/resources/zh_CN/element/string.json',
  enUsStringJson: 'entry/src/main/resources/en_US/element/string.json',
});

export const ZERO_ACL_ALLOWED_PERMISSIONS = Object.freeze([
  'ohos.permission.INTERNET',
  'ohos.permission.GET_NETWORK_INFO',
  'ohos.permission.GET_WIFI_INFO',
  'ohos.permission.KEEP_BACKGROUND_RUNNING',
  'ohos.permission.RUNNING_LOCK',
  'ohos.permission.PUBLISH_AGENT_REMINDER',
  'ohos.permission.VIBRATE',
  'ohos.permission.ACCESS_BIOMETRIC',
  'ohos.permission.ACCELEROMETER',
  'ohos.permission.GYROSCOPE',
  'ohos.permission.STORE_PERSISTENT_DATA',
  'ohos.permission.MICROPHONE',
  'ohos.permission.CAMERA',
]);

export const USER_GRANT_PERMISSIONS = Object.freeze([
  'ohos.permission.MICROPHONE',
  'ohos.permission.CAMERA',
]);

export const FORBIDDEN_ACL_PERMISSIONS = Object.freeze([
  'ohos.permission.READ_IMAGEVIDEO',
  'ohos.permission.WRITE_IMAGEVIDEO',
  'ohos.permission.READ_MEDIA',
  'ohos.permission.WRITE_MEDIA',
  'ohos.permission.READ_AUDIO',
  'ohos.permission.WRITE_AUDIO',
  'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
  'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
  'ohos.permission.READ_CONTACTS',
  'ohos.permission.WRITE_CONTACTS',
  'ohos.permission.READ_PASTEBOARD',
  'ohos.permission.SYSTEM_FLOAT_WINDOW',
  'ohos.permission.RUN_DYN_CODE',
  'ohos.permission.APPROXIMATELY_LOCATION',
  'ohos.permission.LOCATION',
]);

export const ALLOWED_OHOS_DT_NEEDED = Object.freeze([
  'libace_napi.z.so',
  'libhilog_ndk.z.so',
  'libc.so',
  'libm.so',
  'libdl.so',
  'libpthread.so',
  'librt.so',
  'ld-musl-aarch64.so.1',
  'ld-musl-x86_64.so.1',
  'libc++_shared.so',
  'libz.so',
  'libuv.so',
  'librawfile.z.so',
  'libohaudio.so',
  'libohsensor.so',
  'libohpreferences.so',
  'libohnotification.so',
  'libohvibrator.z.so',
  'libohweb.so',
  'libohcamera.so',
  'libohcrypto.so',
  'libnative_window.so',
  'libnative_buffer.so',
  'libnative_drawing.so',
  'libnative_rdb_ndk.z.so',
  'libpixelmap.so',
  'libpixelmap_ndk.z.so',
  'libimage_ndk.z.so',
  'libohavplayer.so',
  'libohavcodec.so',
  'libasset_ndk.z.so',
  'libdeviceinfo_ndk.z.so',
]);

export const FORBIDDEN_UNDEFINED_NAPI_SYMBOLS = Object.freeze([
  'napi_adjust_external_memory',
  '__emutls_get_address',
  'node_api_create_external_string_latin1',
  'node_api_create_external_string_utf16',
]);

export const REQUIRED_NAPI_EXPORTS = Object.freeze([
  'initCore',
  'shutdownCore',
  'invokeAction',
  'subscribeDomainEvents',
  'encodeWaveform5Bit',
  'decodeWaveform5Bit',
  'feedVoiceRecorderPcm',
  'processTalkVadFrame',
  'uploadMediaChunk',
]);

export const THEMES = Object.freeze(['night', 'tinted', 'day', 'classic']);
export const DARK_THEMES = Object.freeze(['night', 'tinted']);
export const LIGHT_THEMES = Object.freeze(['day', 'classic']);
export const LOCALES = Object.freeze(['zh-CN', 'en-US']);

export const BREAKPOINTS = Object.freeze({
  sm: Object.freeze({ minVp: 0, maxVp: 599 }),
  md: Object.freeze({ minVp: 600, maxVp: 839 }),
  lg: Object.freeze({ minVp: 840, maxVp: 1279 }),
  xl: Object.freeze({ minVp: 1280, maxVp: Infinity }),
});

export const NAV_DESTINATIONS = Object.freeze([
  'chats',
  'folders',
  'calls',
  'tasks',
  'mcp',
  'talk',
  'computer',
  'saved',
  'settings',
]);

export class TargetNotBuiltError extends Error {
  constructor(message) {
    const formatted = String(message || 'Target artifact or binary is not built');
    super(formatted.startsWith('[TARGET_NOT_BUILT]') ? formatted : `[TARGET_NOT_BUILT] ${formatted}`);
    this.name = 'TargetNotBuiltError';
    this.code = 'TARGET_NOT_BUILT';
  }
}

export class PreconditionFailedError extends Error {
  constructor(message) {
    const formatted = String(message || 'Precondition failed');
    super(formatted.startsWith('[PRECONDITION_FAILED]') ? formatted : `[PRECONDITION_FAILED] ${formatted}`);
    this.name = 'PreconditionFailedError';
    this.code = 'PRECONDITION_FAILED';
  }
}

export class ArtifactValidationError extends Error {
  constructor(message) {
    super(String(message || 'Artifact validation failed'));
    this.name = 'ArtifactValidationError';
    this.code = 'ARTIFACT_INVALID';
  }
}
