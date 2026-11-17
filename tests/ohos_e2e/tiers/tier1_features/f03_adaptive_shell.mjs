import * as assert from '../../lib/assert.mjs';
import { NAV_DESTINATIONS, STAGE_MODEL_FILES } from '../../lib/constants.mjs';
import { defineTest } from '../../lib/registry.mjs';

function extractStepState(stepRes) {
  if (!stepRes || typeof stepRes !== 'object') return {};
  return stepRes.state ?? stepRes.snapshot ?? stepRes.finalState ?? stepRes;
}

export const tests = [
  defineTest({
    id: 'T1-F03-01-sm-phone-breakpoint-layout-360vp',
    name: 'F3: Phone viewport (360vp < 600vp) computes breakpoint=sm single-column Stack+Tabs shell with inspector closed',
    tier: 1,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const indexSource = ctx.artifacts.readText(STAGE_MODEL_FILES.indexPageEts);
      const storeSource = ctx.artifacts.readText(STAGE_MODEL_FILES.appStoreEts);
      assert.greaterThan(indexSource.length, 50, 'Index.ets adaptive shell must exist and be non-empty');
      assert.includes(storeSource, 'breakpoint', 'AppStore.ets must define reactive breakpoint state');

      const sandbox = ctx.createClientSandbox('f03_sm');
      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 360,
          steps: [
            { op: 'resizeWindow', widthVp: 360 },
            { op: 'navigate', nav: 'chats' },
          ],
        },
        expectOk: true,
      });

      const finalState = res.data?.finalState;
      assert.isObject(finalState, 'ui-session must return data.finalState');
      assert.equal(finalState.breakpoint, 'sm', '360vp phone width must resolve to breakpoint="sm"');
      assert.equal(finalState.activeNav, 'chats', 'activeNav must equal "chats"');
      assert.equal(finalState.inspectorOpen, false, 'Phone sm layout must default inspectorOpen to false');
    },
  }),

  defineTest({
    id: 'T1-F03-02-md-foldable-split-breakpoint-700vp',
    name: 'F3: Unfolded foldable viewport (700vp in 600..839vp) computes breakpoint=md 2-pane Split layout',
    tier: 1,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f03_md');
      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 700,
          steps: [
            { op: 'resizeWindow', widthVp: 700 },
            { op: 'navigate', nav: 'folders' },
          ],
        },
        expectOk: true,
      });

      const finalState = res.data?.finalState;
      assert.isObject(finalState, 'ui-session must return data.finalState');
      assert.equal(finalState.breakpoint, 'md', '700vp foldable width must resolve to breakpoint="md"');
      assert.equal(finalState.activeNav, 'folders', 'activeNav must transition to "folders"');
    },
  }),

  defineTest({
    id: 'T1-F03-03-lg-tablet-three-pane-breakpoint-1024vp',
    name: 'F3: Tablet landscape viewport (1024vp in 840..1279vp) computes breakpoint=lg 3-pane NavRail+Sidebar+Stage layout',
    tier: 1,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f03_lg');
      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1024,
          steps: [
            { op: 'resizeWindow', widthVp: 1024 },
            { op: 'navigate', nav: 'calls' },
          ],
        },
        expectOk: true,
      });

      const finalState = res.data?.finalState;
      assert.isObject(finalState, 'ui-session must return data.finalState');
      assert.equal(finalState.breakpoint, 'lg', '1024vp tablet width must resolve to breakpoint="lg"');
      assert.equal(finalState.activeNav, 'calls', 'activeNav must equal "calls"');
    },
  }),

  defineTest({
    id: 'T1-F03-04-xl-2in1-pc-four-pane-breakpoint-1440vp',
    name: 'F3: HarmonyOS 2-in-1 PC viewport (1440vp >= 1280vp) computes breakpoint=xl 4-pane layout with persistent ContextInspector',
    tier: 1,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f03_xl');
      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1440,
          steps: [
            { op: 'resizeWindow', widthVp: 1440 },
            { op: 'navigate', nav: 'tasks' },
          ],
        },
        expectOk: true,
      });

      const finalState = res.data?.finalState;
      assert.isObject(finalState, 'ui-session must return data.finalState');
      assert.equal(finalState.breakpoint, 'xl', '1440vp 2-in-1 desktop width must resolve to breakpoint="xl"');
      assert.equal(finalState.activeNav, 'tasks', 'activeNav must equal "tasks"');
      assert.equal(
        finalState.inspectorOpen,
        true,
        'xl 2-in-1 4-pane desktop layout must expose persistent inspectorOpen=true',
      );
    },
  }),

  defineTest({
    id: 'T1-F03-05-live-four-tier-window-resize-sweep-preserves-nav-and-all-9-destinations',
    name: 'F3: Live windowSizeChange sweep across 360->700->1024->1440->360vp and all 9 NavRail destinations preserves active state',
    tier: 1,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const sandbox = ctx.createClientSandbox('f03_sweep');
      const steps = [
        { op: 'resizeWindow', widthVp: 360 },
        { op: 'resizeWindow', widthVp: 700 },
        { op: 'resizeWindow', widthVp: 1024 },
        { op: 'resizeWindow', widthVp: 1440 },
      ];
      for (const nav of NAV_DESTINATIONS) {
        steps.push({ op: 'navigate', nav });
      }
      steps.push({ op: 'resizeWindow', widthVp: 360 });

      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 360,
          steps,
        },
        expectOk: true,
      });

      const stepResults = res.data?.stepResults;
      assert.isArray(stepResults, 'ui-session must emit stepResults array');
      assert.equal(stepResults.length, steps.length, 'stepResults length must match input steps length');

      const observedBps = stepResults.slice(0, 4).map((s) => extractStepState(s).breakpoint);
      assert.deepEqual(
        observedBps,
        ['sm', 'md', 'lg', 'xl'],
        'First 4 resize steps must transition sm -> md -> lg -> xl in order',
      );

      assert.equal(res.data?.finalState?.breakpoint, 'sm', 'Final 360vp resize must return to sm');
      assert.equal(
        res.data?.finalState?.activeNav,
        'settings',
        'Window resize must preserve last navigated destination ("settings")',
      );
    },
  }),

  defineTest({
    id: 'T1-F03-06-xl-2in1-keyboard-shortcuts-and-arkts-shell-bindings',
    name: 'F3: 2-in-1 xl desktop shell supports Ctrl+K / Ctrl+I / Escape keyboard shortcuts and declares ArkUI key & context-menu bindings',
    tier: 1,
    features: ['F3'],
    timeoutMs: 25_000,
    async run(ctx) {
      const indexText = ctx.artifacts.readText(STAGE_MODEL_FILES.indexPageEts);
      assert.ok(
        indexText.includes('onKeyEvent') || indexText.includes('keyboardShortcut'),
        'Index.ets must wire ArkUI keyboard event / shortcut handlers for 2-in-1 PC',
      );
      assert.ok(
        indexText.includes('bindContextMenu'),
        'Index.ets must wire ArkUI .bindContextMenu for right-click / long-press actions',
      );

      const sandbox = ctx.createClientSandbox('f03_shortcuts');
      const res = await ctx.cli.uiSession({
        sandbox,
        script: {
          initialWindowWidthVp: 1440,
          steps: [
            { op: 'resizeWindow', widthVp: 1440 },
            { op: 'shortcut', key: 'k', ctrl: true },
            { op: 'shortcut', key: 'Escape', ctrl: false },
            { op: 'shortcut', key: 'i', ctrl: true },
          ],
        },
        expectOk: true,
      });

      assert.equal(res.ok, true, '2-in-1 keyboard shortcut scenario must succeed');
      assert.equal(res.data?.finalState?.breakpoint, 'xl', 'Viewport must remain at xl');
      assert.equal(
        typeof res.data?.finalState?.inspectorOpen,
        'boolean',
        'Ctrl+I shortcut must maintain valid boolean inspectorOpen state',
      );
    },
  }),
];

export default tests;
