import * as assert from '../../lib/assert.mjs';
import { STAGE_MODEL_FILES } from '../../lib/constants.mjs';
import { defineTest } from '../../lib/registry.mjs';

function extractStepState(stepRes) {
  if (!stepRes || typeof stepRes !== 'object') return {};
  return stepRes.state ?? stepRes.snapshot ?? stepRes.finalState ?? stepRes;
}

export const tests = [
  defineTest({
    id: 'T2-F03-01-exact-sm-to-md-threshold-599vp-vs-600vp',
    name: 'F3 Boundary: Exact 599vp/600vp threshold maps 599vp strictly to sm and 600vp strictly to md',
    tier: 2,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const storeText = ctx.artifacts.readText(STAGE_MODEL_FILES.appStoreEts);
      assert.includes(storeText, 'breakpoint', 'AppStore.ets must expose reactive breakpoint state');

      const sandbox = ctx.createClientSandbox('f03_edge_600');
      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 599,
          steps: [
            { op: 'resizeWindow', widthVp: 599 },
            { op: 'resizeWindow', widthVp: 600 },
            { op: 'resizeWindow', widthVp: 599 },
          ],
        },
        expectOk: true,
      });

      const bps = (res.data?.stepResults || []).map((s) => extractStepState(s).breakpoint);
      assert.deepEqual(bps, ['sm', 'md', 'sm'], '599vp -> 600vp -> 599vp must transition sm -> md -> sm');
      assert.equal(res.data?.finalState?.breakpoint, 'sm', 'Final 599vp width must be sm');
    },
  }),

  defineTest({
    id: 'T2-F03-02-exact-md-to-lg-threshold-839vp-vs-840vp',
    name: 'F3 Boundary: Exact 839vp/840vp threshold maps 839vp strictly to md and 840vp strictly to lg',
    tier: 2,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const storeText = ctx.artifacts.readText(STAGE_MODEL_FILES.appStoreEts);
      assert.includes(storeText, 'breakpoint', 'AppStore.ets must expose reactive breakpoint state');

      const sandbox = ctx.createClientSandbox('f03_edge_840');
      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 839,
          steps: [
            { op: 'resizeWindow', widthVp: 839 },
            { op: 'resizeWindow', widthVp: 840 },
            { op: 'resizeWindow', widthVp: 839 },
          ],
        },
        expectOk: true,
      });

      const bps = (res.data?.stepResults || []).map((s) => extractStepState(s).breakpoint);
      assert.deepEqual(bps, ['md', 'lg', 'md'], '839vp -> 840vp -> 839vp must transition md -> lg -> md');
      assert.equal(res.data?.finalState?.breakpoint, 'md', 'Final 839vp width must be md');
    },
  }),

  defineTest({
    id: 'T2-F03-03-exact-lg-to-xl-threshold-1279vp-vs-1280vp',
    name: 'F3 Boundary: Exact 1279vp/1280vp threshold maps 1279vp strictly to lg and 1280vp strictly to xl',
    tier: 2,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const storeText = ctx.artifacts.readText(STAGE_MODEL_FILES.appStoreEts);
      assert.includes(storeText, 'breakpoint', 'AppStore.ets must expose reactive breakpoint state');

      const sandbox = ctx.createClientSandbox('f03_edge_1280');
      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1279,
          steps: [
            { op: 'resizeWindow', widthVp: 1279 },
            { op: 'resizeWindow', widthVp: 1280 },
            { op: 'resizeWindow', widthVp: 1279 },
          ],
        },
        expectOk: true,
      });

      const bps = (res.data?.stepResults || []).map((s) => extractStepState(s).breakpoint);
      assert.deepEqual(bps, ['lg', 'xl', 'lg'], '1279vp -> 1280vp -> 1279vp must transition lg -> xl -> lg');
      assert.equal(res.data?.finalState?.breakpoint, 'lg', 'Final 1279vp width must be lg');
    },
  }),

  defineTest({
    id: 'T2-F03-04-extreme-compact-and-ultrawide-viewport-bounds-and-invalid-width-rejection',
    name: 'F3 Boundary: Ultra-compact 240vp and 4K 3840vp viewports succeed while non-positive widths (0, -360) are rejected',
    tier: 2,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f03_extremes');

      const validExtremes = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 240,
          steps: [
            { op: 'resizeWindow', widthVp: 240 },
            { op: 'resizeWindow', widthVp: 3840 },
          ],
        },
        expectOk: true,
      });
      const extremeBps = (validExtremes.data?.stepResults || []).map((s) => extractStepState(s).breakpoint);
      assert.deepEqual(extremeBps, ['sm', 'xl'], '240vp cover screen -> sm and 3840vp 4K display -> xl');

      const zeroWidthRes = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 360,
          steps: [{ op: 'resizeWindow', widthVp: 0 }],
        },
        expectOk: false,
      });
      assert.equal(zeroWidthRes.ok, false, 'Zero widthVp (0) must be rejected');

      const negativeWidthRes = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 360,
          steps: [{ op: 'resizeWindow', widthVp: -360 }],
        },
        expectOk: false,
      });
      assert.equal(negativeWidthRes.ok, false, 'Negative widthVp (-360) must be rejected');
    },
  }),

  defineTest({
    id: 'T2-F03-05-ui-session-rejects-unknown-nav-destination-and-unknown-op',
    name: 'F3 Boundary: ui-session rejects invalid NavRail destination names and unknown scenario step operations cleanly',
    tier: 2,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f03_bad_ops');

      const badNavRes = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1024,
          steps: [{ op: 'navigate', nav: '__nonexistent_nav_tab__' }],
        },
        expectOk: false,
      });
      assert.equal(badNavRes.ok, false, 'Unknown NavRail destination must fail with ok=false');
      assert.notEqual(badNavRes.exitCode, 0, 'Unknown NavRail destination must exit non-zero');

      const badOpRes = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1024,
          steps: [{ op: '__unsupported_ui_op__' }],
        },
        expectOk: false,
      });
      assert.equal(badOpRes.ok, false, 'Unsupported ui-session op must fail with ok=false');
      assert.notEqual(badOpRes.exitCode, 0, 'Unsupported ui-session op must exit non-zero');
    },
  }),

  defineTest({
    id: 'T2-F03-06-rapid-fold-unfold-oscillation-preserves-auth-theme-and-locale-state',
    name: 'F3 Boundary: Rapid 12-step fold/unfold/dock breakpoint oscillation preserves authenticated session, theme, locale, and activeNav',
    tier: 2,
    features: ['F3'],
    timeoutMs: 35_000,
    async run(ctx) {
      const server = await ctx.ensureServer();
      const sandbox = ctx.createClientSandbox('f03_oscillation');
      const username = `fold_user_${Date.now().toString(36)}`;

      const widths = [360, 1440, 599, 600, 839, 840, 1279, 1280, 700, 1024, 360, 1440];
      const steps = [
        {
          op: 'invoke',
          domain: 'auth',
          action: 'registerPassword',
          payload: { username, password: 'FoldableUser123!' },
        },
        { op: 'setTheme', themeId: 'tinted' },
        { op: 'setLocale', locale: 'en-US' },
        { op: 'navigate', nav: 'tasks' },
        ...widths.map((widthVp) => ({ op: 'resizeWindow', widthVp })),
      ];

      const res = await ctx.cli.uiSession({
        sandbox,
        serverUrl: server.baseUrl,
        script: {
          initialWindowWidthVp: 360,
          steps,
        },
        expectOk: true,
      });

      const finalState = res.data?.finalState;
      assert.isObject(finalState, 'Rapid resize ui-session must return finalState');
      assert.equal(finalState.breakpoint, 'xl', 'Final 1440vp resize must settle at breakpoint="xl"');
      assert.equal(finalState.authState, 'authenticated', 'Rapid fold/unfold resizes must preserve authState="authenticated"');
      assert.equal(finalState.themeId, 'tinted', 'Rapid fold/unfold resizes must preserve themeId="tinted"');
      assert.equal(finalState.locale, 'en-US', 'Rapid fold/unfold resizes must preserve locale="en-US"');
      assert.equal(finalState.activeNav, 'tasks', 'Rapid fold/unfold resizes must preserve activeNav="tasks"');
    },
  }),
];

export default tests;
