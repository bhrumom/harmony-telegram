import * as assert from '../../lib/assert.mjs';
import { CANONICAL_ARTIFACTS, STAGE_MODEL_FILES } from '../../lib/constants.mjs';
import { defineTest } from '../../lib/registry.mjs';

function extractFormatPlaceholders(str) {
  const tokens = str.match(/%(?:\d+\$)?[sdfox%]|\{\d+\}|\{\{[a-zA-Z0-9_]+\}\}/g) || [];
  return tokens.filter((t) => t !== '%%').sort();
}

function collectResourceRefs(value, outStrings = new Set(), outColors = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('$string:')) {
      outStrings.add(value.slice('$string:'.length));
    } else if (value.startsWith('$color:')) {
      outColors.add(value.slice('$color:'.length));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectResourceRefs(item, outStrings, outColors);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) {
      collectResourceRefs(v, outStrings, outColors);
    }
  }
}

export const tests = [
  defineTest({
    id: 'T2-F04-01-reject-invalid-theme-ids-in-cli-and-ui-session',
    name: 'F4 Boundary: Unsupported or wrong-case theme IDs ("solarized", "NIGHT", "") are rejected without corrupting persisted theme',
    tier: 2,
    features: ['F4'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f04_bad_theme');

      await ctx.cli.invoke({
        sandbox,
        domain: 'settings',
        action: 'setTheme',
        payload: { themeId: 'day' },
        expectOk: true,
      });

      for (const invalidTheme of ['solarized', 'NIGHT', '']) {
        const invRes = await ctx.cli.invoke({
          sandbox,
          domain: 'settings',
          action: 'setTheme',
          payload: { themeId: invalidTheme },
          expectOk: false,
        });
        assert.equal(invRes.ok, false, `Invalid themeId '${invalidTheme}' must fail in settings.setTheme`);

        const uiRes = await ctx.cli.uiSession({
          sandbox,
          script: {
            initialWindowWidthVp: 360,
            steps: [{ op: 'setTheme', themeId: invalidTheme }],
          },
          expectOk: false,
        });
        assert.equal(uiRes.ok, false, `Invalid themeId '${invalidTheme}' must fail in ui-session setTheme`);
      }

      const verifySession = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 360,
          steps: [{ op: 'navigate', nav: 'settings' }],
        },
        expectOk: true,
      });
      assert.equal(
        verifySession.data?.finalState?.themeId,
        'day',
        'Persisted valid themeId="day" must remain intact after rejected theme mutations',
      );
    },
  }),

  defineTest({
    id: 'T2-F04-02-reject-unsupported-locales-in-cli-and-ui-session',
    name: 'F4 Boundary: Unsupported locale tags ("fr-FR", "ja-JP", "") are rejected without corrupting persisted locale',
    tier: 2,
    features: ['F4'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f04_bad_locale');

      await ctx.cli.invoke({
        sandbox,
        domain: 'settings',
        action: 'setLocale',
        payload: { locale: 'zh-CN' },
        expectOk: true,
      });

      for (const invalidLocale of ['fr-FR', 'ja-JP', '']) {
        const invRes = await ctx.cli.invoke({
          sandbox,
          domain: 'settings',
          action: 'setLocale',
          payload: { locale: invalidLocale },
          expectOk: false,
        });
        assert.equal(invRes.ok, false, `Unsupported locale '${invalidLocale}' must fail in settings.setLocale`);

        const uiRes = await ctx.cli.uiSession({
          sandbox,
          script: {
            initialWindowWidthVp: 360,
            steps: [{ op: 'setLocale', locale: invalidLocale }],
          },
          expectOk: false,
        });
        assert.equal(uiRes.ok, false, `Unsupported locale '${invalidLocale}' must fail in ui-session setLocale`);
      }

      const verifySession = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 360,
          steps: [{ op: 'navigate', nav: 'chats' }],
        },
        expectOk: true,
      });
      assert.equal(
        verifySession.data?.finalState?.locale,
        'zh-CN',
        'Persisted valid locale="zh-CN" must remain intact after rejected locale mutations',
      );
    },
  }),

  defineTest({
    id: 'T2-F04-03-i18n-printf-placeholder-parity-and-no-empty-or-duplicate-keys',
    name: 'F4 Boundary: base, zh_CN, and en_US string.json packs contain zero duplicate/empty entries and 100% printf/template placeholder parity',
    tier: 2,
    features: ['F4'],
    timeoutMs: 20_000,
    async run(ctx) {
      const packs = [
        ['base', ctx.artifacts.readJson(STAGE_MODEL_FILES.baseStringJson)],
        ['zh_CN', ctx.artifacts.readJson(STAGE_MODEL_FILES.zhCnStringJson)],
        ['en_US', ctx.artifacts.readJson(STAGE_MODEL_FILES.enUsStringJson)],
      ];

      const maps = {};
      for (const [label, json] of packs) {
        assert.isArray(json?.string, `${label}/element/string.json must contain string array`);
        const seen = new Map();
        for (const item of json.string) {
          assert.isNonEmptyString(item?.name, `${label} string entry must have non-empty name`);
          assert.match(
            item.name,
            /^[a-zA-Z_][a-zA-Z0-9_]*$/,
            `${label} string key '${item.name}' must be a valid OpenHarmony resource identifier`,
          );
          assert.equal(seen.has(item.name), false, `${label} string.json must not contain duplicate key '${item.name}'`);
          assert.isNonEmptyString(item?.value, `${label} string '${item.name}' must have non-empty value`);
          seen.set(item.name, item.value);
        }
        maps[label] = seen;
      }

      const zhKeys = Array.from(maps.zh_CN.keys()).sort();
      const enKeys = Array.from(maps.en_US.keys()).sort();
      assert.deepEqual(
        zhKeys,
        enKeys,
        'zh_CN and en_US string.json files must maintain symmetric 100% two-way key parity',
      );

      for (const [key, zhVal] of maps.zh_CN.entries()) {
        const enVal = maps.en_US.get(key);
        const zhPlaceholders = extractFormatPlaceholders(zhVal);
        const enPlaceholders = extractFormatPlaceholders(enVal);
        assert.deepEqual(
          zhPlaceholders,
          enPlaceholders,
          `Format placeholders for string key '${key}' must match between zh_CN (${JSON.stringify(zhVal)}) and en_US (${JSON.stringify(enVal)})`,
        );

        if (maps.base.has(key)) {
          const baseVal = maps.base.get(key);
          const basePlaceholders = extractFormatPlaceholders(baseVal);
          assert.deepEqual(
            basePlaceholders,
            zhPlaceholders,
            `Format placeholders for shared string key '${key}' in base (${JSON.stringify(baseVal)}) must match zh_CN/en_US (${JSON.stringify(zhVal)})`,
          );
        }
      }
    },
  }),

  defineTest({
    id: 'T2-F04-04-color-json-strict-hex-format-and-no-duplicate-names',
    name: 'F4 Boundary: base and dark color.json entries strictly conform to OpenHarmony restool hex/#RGB/#ARGB/$color: grammar with zero duplicates or dangling refs',
    tier: 2,
    features: ['F4'],
    timeoutMs: 20_000,
    async run(ctx) {
      const baseColors = ctx.artifacts.readJson(STAGE_MODEL_FILES.baseColorJson);
      const darkColors = ctx.artifacts.readJson(STAGE_MODEL_FILES.darkColorJson);
      const signedHap = ctx.artifacts.inspectZip(CANONICAL_ARTIFACTS.signedHap);

      assert.equal(signedHap.hasEntry('resources.index'), true, 'Signed HAP must contain compiled resources.index');

      const restoolColorRegex =
        /^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|\$color:[a-zA-Z_][a-zA-Z0-9_]*)$/;
      for (const [label, json] of [
        ['base/element/color.json', baseColors],
        ['dark/element/color.json', darkColors],
      ]) {
        assert.isArray(json?.color, `${label} must define color array`);
        const seenNames = new Set();
        for (const item of json.color) {
          assert.isNonEmptyString(item?.name, `${label} color entry must have non-empty name`);
          assert.match(
            item.name,
            /^[a-zA-Z_][a-zA-Z0-9_]*$/,
            `${label} color name '${item.name}' must be valid restool identifier`,
          );
          assert.equal(seenNames.has(item.name), false, `${label} must not contain duplicate color '${item.name}'`);
          seenNames.add(item.name);

          assert.match(
            item?.value,
            restoolColorRegex,
            `${label} color '${item.name}' value '${item?.value}' must use valid restool #RGB, #ARGB, #RRGGBB, #AARRGGBB, or $color:<name> format`,
          );
        }

        for (const item of json.color) {
          if (typeof item.value === 'string' && item.value.startsWith('$color:')) {
            const refName = item.value.slice('$color:'.length);
            assert.notEqual(refName, item.name, `${label} color '${item.name}' must not self-reference`);
            assert.equal(
              seenNames.has(refName),
              true,
              `${label} color '${item.name}' references missing $color:${refName} in ${label}`,
            );
          }
        }
      }
    },
  }),

  defineTest({
    id: 'T2-F04-05-module-json5-resource-references-all-resolve-in-bilingual-packs',
    name: 'F4 Boundary: Every $string: and $color: reference in AppScope/app.json5 and entry/src/main/module.json5 resolves across base, dark, zh_CN, and en_US',
    tier: 2,
    features: ['F4'],
    timeoutMs: 20_000,
    async run(ctx) {
      const appJson5 = ctx.artifacts.readJson5(STAGE_MODEL_FILES.appJson5);
      const moduleJson5 = ctx.artifacts.readJson5(STAGE_MODEL_FILES.moduleJson5);

      const appStrings = new Set(
        (ctx.artifacts.readJson(STAGE_MODEL_FILES.appStringJson)?.string || []).map((s) => s.name),
      );
      const baseStrings = new Set(
        (ctx.artifacts.readJson(STAGE_MODEL_FILES.baseStringJson)?.string || []).map((s) => s.name),
      );
      const zhStrings = new Set(
        (ctx.artifacts.readJson(STAGE_MODEL_FILES.zhCnStringJson)?.string || []).map((s) => s.name),
      );
      const enStrings = new Set(
        (ctx.artifacts.readJson(STAGE_MODEL_FILES.enUsStringJson)?.string || []).map((s) => s.name),
      );
      const baseColors = new Set(
        (ctx.artifacts.readJson(STAGE_MODEL_FILES.baseColorJson)?.color || []).map((c) => c.name),
      );
      const darkColors = new Set(
        (ctx.artifacts.readJson(STAGE_MODEL_FILES.darkColorJson)?.color || []).map((c) => c.name),
      );

      const appStrRefs = new Set();
      const appColorRefs = new Set();
      collectResourceRefs(appJson5, appStrRefs, appColorRefs);
      for (const ref of appStrRefs) {
        assert.equal(appStrings.has(ref), true, `AppScope/app.json5 $string:${ref} must exist in AppScope string.json`);
      }

      const modStrRefs = new Set();
      const modColorRefs = new Set();
      collectResourceRefs(moduleJson5, modStrRefs, modColorRefs);
      assert.greaterThanOrEqual(modStrRefs.size, 2, 'module.json5 must reference localized $string:* descriptors');

      for (const ref of modStrRefs) {
        const inAppScope = appStrings.has(ref);
        if (!inAppScope) {
          assert.equal(baseStrings.has(ref), true, `module.json5 $string:${ref} must exist in base string.json`);
          assert.equal(zhStrings.has(ref), true, `module.json5 $string:${ref} must exist in zh_CN string.json`);
          assert.equal(enStrings.has(ref), true, `module.json5 $string:${ref} must exist in en_US string.json`);
        }
      }

      for (const colorRef of modColorRefs) {
        assert.equal(baseColors.has(colorRef), true, `module.json5 $color:${colorRef} must exist in base color.json`);
        assert.equal(darkColors.has(colorRef), true, `module.json5 $color:${colorRef} must exist in dark color.json`);
      }
    },
  }),

  defineTest({
    id: 'T2-F04-06-rapid-theme-and-locale-toggling-idempotency-and-state-preservation',
    name: 'F4 Boundary: 16 rapid alternating theme and locale switches interleaved with navigation and resize settle deterministically without state loss',
    tier: 2,
    features: ['F4'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f04_rapid_switch');
      const steps = [
        { op: 'resizeWindow', widthVp: 1024 },
        { op: 'navigate', nav: 'mcp' },
        { op: 'setTheme', themeId: 'night' },
        { op: 'setLocale', locale: 'zh-CN' },
        { op: 'setTheme', themeId: 'day' },
        { op: 'setLocale', locale: 'en-US' },
        { op: 'setTheme', themeId: 'tinted' },
        { op: 'setLocale', locale: 'zh-CN' },
        { op: 'setTheme', themeId: 'classic' },
        { op: 'setLocale', locale: 'en-US' },
        { op: 'setTheme', themeId: 'night' },
        { op: 'setTheme', themeId: 'night' }, // Idempotent repeat
        { op: 'setLocale', locale: 'zh-CN' },
        { op: 'setLocale', locale: 'zh-CN' }, // Idempotent repeat
        { op: 'setTheme', themeId: 'tinted' },
        { op: 'setLocale', locale: 'en-US' },
      ];

      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1024,
          steps,
        },
        expectOk: true,
      });

      const finalState = res.data?.finalState;
      assert.isObject(finalState, 'Rapid toggle ui-session must emit finalState');
      assert.equal(finalState.breakpoint, 'lg', 'Breakpoint must remain lg (1024vp)');
      assert.equal(finalState.activeNav, 'mcp', 'Active navigation must remain mcp');
      assert.equal(finalState.themeId, 'tinted', 'Final themeId must settle at tinted');
      assert.equal(finalState.locale, 'en-US', 'Final locale must settle at en-US');
    },
  }),
];

export default tests;
