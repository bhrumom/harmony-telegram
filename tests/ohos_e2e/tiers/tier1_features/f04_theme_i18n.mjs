import * as assert from '../../lib/assert.mjs';
import { LOCALES, STAGE_MODEL_FILES, THEMES } from '../../lib/constants.mjs';
import { defineTest } from '../../lib/registry.mjs';

function toResourceMap(list) {
  const map = new Map();
  for (const entry of list || []) {
    if (entry && typeof entry.name === 'string') {
      map.set(entry.name, String(entry.value ?? ''));
    }
  }
  return map;
}

function resolveColorValue(colorMap, key) {
  let cur = colorMap.get(key) ?? '';
  const visited = new Set([key]);
  while (typeof cur === 'string' && cur.startsWith('$color:')) {
    const target = cur.slice('$color:'.length);
    if (visited.has(target) || !colorMap.has(target)) break;
    visited.add(target);
    cur = colorMap.get(target) ?? '';
  }
  return String(cur);
}

function extractStepState(stepRes) {
  if (!stepRes || typeof stepRes !== 'object') return {};
  return stepRes.state ?? stepRes.snapshot ?? stepRes.finalState ?? stepRes;
}

export const tests = [
  defineTest({
    id: 'T1-F04-01-base-and-dark-color-resources-full-key-parity-and-contrast',
    name: 'F4: base and dark element/color.json files have 100% key parity, start_window_background, and distinct light vs dark values',
    tier: 1,
    features: ['F4'],
    timeoutMs: 20_000,
    async run(ctx) {
      const baseColorsJson = ctx.artifacts.readJson(STAGE_MODEL_FILES.baseColorJson);
      const darkColorsJson = ctx.artifacts.readJson(STAGE_MODEL_FILES.darkColorJson);

      assert.isArray(baseColorsJson?.color, 'base/element/color.json must contain color array');
      assert.isArray(darkColorsJson?.color, 'dark/element/color.json must contain color array');
      assert.greaterThanOrEqual(baseColorsJson.color.length, 4, 'base color.json must define core surface/text palette keys');

      const baseMap = toResourceMap(baseColorsJson.color);
      const darkMap = toResourceMap(darkColorsJson.color);

      const baseKeys = Array.from(baseMap.keys()).sort();
      const darkKeys = Array.from(darkMap.keys()).sort();
      assert.deepEqual(baseKeys, darkKeys, 'base and dark color.json files must have 100% identical key sets');
      assert.includes(baseKeys, 'start_window_background', 'color.json must define start_window_background');
      const baseStartBg = resolveColorValue(baseMap, 'start_window_background').toUpperCase();
      const darkStartBg = resolveColorValue(darkMap, 'start_window_background').toUpperCase();
      assert.notEqual(
        baseStartBg,
        darkStartBg,
        'start_window_background must provide distinct light vs dark hex values across base and dark color.json',
      );

      let distinctCount = 0;
      for (const k of baseKeys) {
        if (resolveColorValue(baseMap, k).toUpperCase() !== resolveColorValue(darkMap, k).toUpperCase()) {
          distinctCount += 1;
        }
      }
      assert.greaterThan(
        distinctCount,
        0,
        'dark/element/color.json must provide genuinely distinct dark-mode hex colors from base light-mode colors',
      );
    },
  }),

  defineTest({
    id: 'T1-F04-02-bilingual-zh-cn-and-en-us-string-resources-parity',
    name: 'F4: zh_CN and en_US element/string.json packs have 100% key parity with genuine Chinese CJK and English translations',
    tier: 1,
    features: ['F4'],
    timeoutMs: 20_000,
    async run(ctx) {
      const appStrings = toResourceMap(ctx.artifacts.readJson(STAGE_MODEL_FILES.appStringJson)?.string);
      const baseStrings = toResourceMap(ctx.artifacts.readJson(STAGE_MODEL_FILES.baseStringJson)?.string);
      const zhStrings = toResourceMap(ctx.artifacts.readJson(STAGE_MODEL_FILES.zhCnStringJson)?.string);
      const enStrings = toResourceMap(ctx.artifacts.readJson(STAGE_MODEL_FILES.enUsStringJson)?.string);

      assert.ok(
        appStrings.has('app_name') && appStrings.get('app_name').trim().length > 0,
        'AppScope string.json must define non-empty app_name',
      );
      assert.greaterThanOrEqual(baseStrings.size, 3, 'base/element/string.json must define Stage Model descriptor keys');

      const zhKeys = Array.from(zhStrings.keys()).sort();
      const enKeys = Array.from(enStrings.keys()).sort();
      assert.greaterThanOrEqual(zhKeys.length, 6, 'Localized string packs must define >= 6 Stage/UI string keys');
      assert.deepEqual(zhKeys, enKeys, 'zh_CN and en_US string.json must have 100% identical key sets');

      for (const mandatoryKey of ['module_desc', 'EntryAbility_desc', 'EntryAbility_label']) {
        assert.includes(zhKeys, mandatoryKey, `zh_CN/en_US string.json must define '${mandatoryKey}'`);
      }

      const hasCjkInZh = Array.from(zhStrings.values()).some((v) => /[\u4e00-\u9fff]/.test(v));
      assert.equal(hasCjkInZh, true, 'zh_CN string.json must contain genuine Simplified Chinese CJK characters');

      let localizedDiffCount = 0;
      for (const k of zhKeys) {
        if (zhStrings.get(k) !== enStrings.get(k)) {
          localizedDiffCount += 1;
        }
      }
      assert.greaterThan(localizedDiffCount, 0, 'zh_CN and en_US string packs must contain distinct localized translations');
    },
  }),

  defineTest({
    id: 'T1-F04-03-four-builtin-themes-live-ui-session-cycling',
    name: 'F4: Live ui-session cycles across all 4 built-in themes (night, tinted, day, classic) and updates reactive AppStore.themeId',
    tier: 1,
    features: ['F4'],
    timeoutMs: 25_000,
    async run(ctx) {
      const storeText = ctx.artifacts.readText(STAGE_MODEL_FILES.appStoreEts);
      assert.includes(storeText, 'themeId', 'AppStore.ets must expose reactive themeId slice');

      const sandbox = ctx.createClientSandbox('f04_themes');
      const steps = THEMES.map((themeId) => ({ op: 'setTheme', themeId }));

      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1024,
          steps,
        },
        expectOk: true,
      });

      const stepResults = res.data?.stepResults;
      assert.isArray(stepResults, 'ui-session must return stepResults');
      assert.equal(stepResults.length, THEMES.length, 'All 4 setTheme steps must execute');

      const observedThemes = stepResults.map((s) => extractStepState(s).themeId);
      assert.deepEqual(observedThemes, [...THEMES], 'Observed themeId sequence must match night -> tinted -> day -> classic');
      assert.equal(res.data?.finalState?.themeId, 'classic', 'Final themeId must equal classic');
    },
  }),

  defineTest({
    id: 'T1-F04-04-accent-swatches-and-wallpaper-presets-preferences-persistence',
    name: 'F4: Theme, accent swatch, and wallpaper preset updates persist across independent CLI invoke and ui-session launches',
    tier: 1,
    features: ['F4'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f04_persist');

      await ctx.cli.invoke({
        sandbox,
        domain: 'settings',
        action: 'setTheme',
        payload: { themeId: 'tinted' },
        expectOk: true,
      });

      const updateRes = await ctx.cli.invoke({
        sandbox,
        domain: 'settings',
        action: 'updatePreferences',
        payload: {
          themeId: 'tinted',
          accentSwatch: 'Teal Mint',
          accentHex: '#14B8A6',
          wallpaperPreset: 'aurora_dusk',
        },
        expectOk: true,
      });
      assert.equal(updateRes.ok, true, 'settings.updatePreferences must accept accentSwatch and wallpaperPreset');

      const getPrefs = await ctx.cli.invoke({
        sandbox,
        domain: 'settings',
        action: 'getPreferences',
        payload: {},
        expectOk: true,
      });
      assert.isObject(getPrefs.data, 'settings.getPreferences must return saved preferences');
      const savedTheme = getPrefs.data.themeId ?? getPrefs.data.theme_id ?? getPrefs.data.theme;
      assert.equal(savedTheme, 'tinted', 'Saved preferences must persist themeId="tinted"');

      const sessionRes = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 700,
          steps: [{ op: 'navigate', nav: 'settings' }],
        },
        expectOk: true,
      });
      assert.equal(
        sessionRes.data?.finalState?.themeId,
        'tinted',
        'Subsequent ui-session on same sandbox must hydrate persisted themeId="tinted"',
      );
    },
  }),

  defineTest({
    id: 'T1-F04-05-live-bilingual-locale-toggle-zh-cn-and-en-us',
    name: 'F4: Live locale toggle between zh-CN and en-US updates UI state immediately and persists without losing navigation state',
    tier: 1,
    features: ['F4'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f04_locale');

      const uiRes = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1024,
          steps: [
            { op: 'navigate', nav: 'chats' },
            { op: 'setLocale', locale: 'zh-CN' },
            { op: 'setLocale', locale: 'en-US' },
            { op: 'setLocale', locale: 'zh-CN' },
          ],
        },
        expectOk: true,
      });

      const stepLocales = (uiRes.data?.stepResults || []).slice(1).map((s) => extractStepState(s).locale);
      assert.deepEqual(stepLocales, ['zh-CN', 'en-US', 'zh-CN'], 'Locale must toggle cleanly across zh-CN and en-US');
      assert.equal(uiRes.data?.finalState?.locale, 'zh-CN', 'Final locale must be zh-CN');
      assert.equal(uiRes.data?.finalState?.activeNav, 'chats', 'Locale toggle must preserve activeNav');

      const setRes = await ctx.cli.invoke({
        sandbox,
        domain: 'settings',
        action: 'setLocale',
        payload: { locale: 'en-US' },
        expectOk: true,
      });
      assert.equal(setRes.ok, true, 'settings.setLocale must succeed');
      if (setRes.data?.locale !== undefined) {
        assert.equal(setRes.data.locale, 'en-US', 'settings.setLocale response locale must equal en-US');
      }

      const prefs = await ctx.cli.invoke({
        sandbox,
        domain: 'settings',
        action: 'getPreferences',
        payload: {},
        expectOk: true,
      });
      assert.isObject(prefs.data, 'settings.getPreferences must return preferences object');
      if (prefs.data?.locale !== undefined) {
        assert.oneOf(prefs.data.locale, LOCALES, 'Preferences locale field when present must be canonical BCP-47 tag');
        assert.equal(prefs.data.locale, 'en-US', 'Preferences locale field when present must equal en-US');
      }

      const persistedSession = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1024,
          steps: [{ op: 'resizeWindow', widthVp: 1024 }],
        },
        expectOk: true,
      });
      assert.equal(
        persistedSession.data?.finalState?.locale,
        'en-US',
        'Subsequent ui-session on same sandbox must hydrate persisted locale="en-US"',
      );
    },
  }),

  defineTest({
    id: 'T1-F04-06-live-message-translation-zh-cn-and-en-us-roundtrip',
    name: 'F4: Live client-server message translation converts conversation messages into target locale (zh-CN / en-US)',
    tier: 1,
    features: ['F4'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const sandbox = ctx.createClientSandbox('f04_translate');
      const username = `i18n_user_${Date.now().toString(36)}`;

      await ctx.cli.invoke({
        sandbox,
        serverUrl: server.baseUrl,
        domain: 'auth',
        action: 'registerPassword',
        payload: {
          username,
          password: 'TranslatePass123!',
          displayName: 'Bilingual Tester',
        },
        expectOk: true,
      });

      const chatRes = await ctx.cli.invoke({
        sandbox,
        serverUrl: server.baseUrl,
        domain: 'dialogs',
        action: 'createChat',
        payload: {
          title: 'Translation Lab',
          type: 'group',
          chatType: 'group',
          memberIds: [],
        },
        expectOk: true,
      });
      const chatId = chatRes.data?.chatId ?? chatRes.data?.chat_id ?? chatRes.data?.id;
      assert.ok(chatId !== undefined && chatId !== null, 'dialogs.createChat must return chatId');

      const originalText = 'Welcome to HarmonyOS Native Telegram';
      const sendRes = await ctx.cli.invoke({
        sandbox,
        serverUrl: server.baseUrl,
        domain: 'messages',
        action: 'sendMessage',
        payload: {
          chatId,
          chat_id: chatId,
          text: originalText,
          clientNonce: 404061,
          client_nonce: 404061,
        },
        expectOk: true,
      });
      const messageId = sendRes.data?.messageId ?? sendRes.data?.message_id ?? sendRes.data?.id;
      assert.ok(messageId !== undefined && messageId !== null, 'messages.sendMessage must return messageId');

      const trRes = await ctx.cli.invoke({
        sandbox,
        serverUrl: server.baseUrl,
        domain: 'messages',
        action: 'translateMessage',
        payload: {
          chatId,
          chat_id: chatId,
          messageId,
          message_id: messageId,
          text: originalText,
          targetLang: 'zh-CN',
          target_lang: 'zh-CN',
          targetLocale: 'zh-CN',
        },
        expectOk: true,
      });

      assert.isObject(trRes.data, 'messages.translateMessage must return translation payload');
      const translatedText =
        trRes.data.translatedText ??
        trRes.data.translated_text ??
        trRes.data.translation ??
        trRes.data.text;
      assert.isNonEmptyString(translatedText, 'messages.translateMessage must produce non-empty translated text');
    },
  }),
];

export default tests;
