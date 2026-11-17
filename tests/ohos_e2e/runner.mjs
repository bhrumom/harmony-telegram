#!/usr/bin/env node
import { createArtifactInspector } from './lib/artifact_inspector.mjs';
import { createCliDriver } from './lib/cli_driver.mjs';
import { resolveRepoRoot, TargetNotBuiltError, VALID_TIERS } from './lib/constants.mjs';
import cryptoHelpers from './lib/crypto_helpers.mjs';
import { createHttpClient, startMockHttpServer } from './lib/http_client.mjs';
import { loadAllTests } from './lib/registry.mjs';
import { cleanupRunRoot, createRunSandbox } from './lib/sandbox.mjs';
import { runSelfCheck } from './lib/self_check.mjs';
import { spawnLiveServer } from './lib/server_harness.mjs';
import { connectWsClient } from './lib/ws_client.mjs';

function parseCliArgs(argv) {
  const parsed = {
    selfCheck: false,
    tiers: null,
    features: null,
    filter: null,
    concurrency: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--self-check') {
      parsed.selfCheck = true;
    } else if (arg === '--tier' || arg.startsWith('--tier=')) {
      const val = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!val) throw new Error('Missing value for --tier');
      if (val.toLowerCase() === 'all') {
        parsed.tiers = [...VALID_TIERS];
      } else {
        parsed.tiers = val.split(',').map((part) => {
          const n = Number(part.trim());
          if (!VALID_TIERS.includes(n)) {
            throw new Error(`Invalid tier '${part}' in --tier (expected 1, 2, 3, 4, or all)`);
          }
          return n;
        });
      }
    } else if (arg === '--features' || arg.startsWith('--features=')) {
      const val = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!val) throw new Error('Missing value for --features');
      parsed.features = val
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (arg === '--filter' || arg.startsWith('--filter=')) {
      const val = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (val === undefined) throw new Error('Missing value for --filter');
      parsed.filter = val;
    } else if (arg === '--concurrency' || arg.startsWith('--concurrency=')) {
      const val = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 16) {
        throw new Error(`Invalid --concurrency '${val}' (expected integer 1..16)`);
      }
      parsed.concurrency = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node runner.mjs [options]',
          '  --self-check               Validate static anti-cheat rules, registry & coverage matrix',
          '  --tier <1|2|3|4|all|3,4>   Select test tier(s) to execute or check',
          '  --features <F1,F2,...>     Filter by feature IDs',
          '  --filter <substr>          Filter by test ID, name, file, or exact feature',
          '  --concurrency <n>          Parallel test worker count (default: 1)',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown CLI argument: '${arg}'`);
    }
  }

  return parsed;
}

function killRemainingChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('close', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore
      }
    }, 2_000).unref?.();
    setTimeout(finish, 2_500).unref?.();
  });
}

async function executeSingleTest(test, runId, repoRoot) {
  const startedAt = Date.now();
  const sandbox = createRunSandbox(runId, test.id);
  const childProcesses = new Set();
  const serverHandles = [];
  const wsClients = [];
  const mockServers = [];

  let primaryServer = null;
  const trackChildProcess = (child) => {
    if (!child) return;
    childProcesses.add(child);
    child.once('close', () => childProcesses.delete(child));
  };
  const getDefaultServerUrl = () => (primaryServer ? primaryServer.baseUrl : null);

  const artifacts = createArtifactInspector(repoRoot);
  const httpClient = createHttpClient({ getDefaultServerUrl });
  const cliDriver = createCliDriver({
    repoRoot,
    tmpDir: sandbox.tmpDir,
    getDefaultSandbox: () => sandbox.createClientSandbox('default'),
    getDefaultServerUrl,
    trackChildProcess,
  });

  async function ensureServer(options = {}) {
    if (primaryServer && !options.isolated && !options.label) {
      return primaryServer;
    }
    const handle = await spawnLiveServer({
      repoRoot,
      serverDir: sandbox.serverDir,
      mediaDir: sandbox.mediaDir,
      tmpDir: sandbox.tmpDir,
      options,
      trackChildProcess,
    });
    serverHandles.push(handle);
    if (!primaryServer) {
      primaryServer = handle;
    }
    return handle;
  }

  async function startTrackedMockHttpServer(handlerFn) {
    const mock = await startMockHttpServer(handlerFn);
    mockServers.push(mock);
    return mock;
  }

  async function connectWs(token, opts = {}) {
    const res = await connectWsClient(token, opts, { getDefaultServerUrl });
    if (res && typeof res.close === 'function') {
      wsClients.push(res);
    }
    return res;
  }

  const ctx = Object.freeze({
    testId: test.id,
    workDir: sandbox.workDir,
    tmpDir: sandbox.tmpDir,
    repoRoot,
    createClientSandbox: (label = 'default') => sandbox.createClientSandbox(label),
    ensureServer,
    startMockHttpServer: startTrackedMockHttpServer,
    http: httpClient,
    connectWs,
    ws: Object.freeze({
      connect: (token, opts) => connectWs(token, opts),
    }),
    cli: cliDriver,
    artifacts,
    crypto: cryptoHelpers,
  });

  let error = null;
  let timeoutTimer = null;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`Test '${test.id}' timed out after ${test.timeoutMs}ms`));
      }, test.timeoutMs);
      timeoutTimer.unref?.();
    });
    await Promise.race([Promise.resolve().then(() => test.run(ctx)), timeoutPromise]);
  } catch (err) {
    error = err;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);

    for (const ws of wsClients.splice(0)) {
      try {
        await ws.close();
      } catch {
        // Ignore teardown errors
      }
    }
    for (const mock of mockServers.splice(0)) {
      try {
        await mock.close();
      } catch {
        // Ignore teardown errors
      }
    }
    for (const srv of serverHandles.splice(0)) {
      try {
        await srv.stop();
      } catch {
        // Ignore teardown errors
      }
    }
    for (const child of Array.from(childProcesses)) {
      await killRemainingChild(child);
    }
    sandbox.cleanup();
  }

  const durationMs = Date.now() - startedAt;
  const isTargetNotBuilt =
    error instanceof TargetNotBuiltError ||
    error?.code === 'TARGET_NOT_BUILT' ||
    Boolean(error?.message && error.message.includes('[TARGET_NOT_BUILT]'));

  return {
    id: test.id,
    name: test.name,
    tier: test.tier,
    features: test.features,
    ok: error === null,
    isTargetNotBuilt,
    durationMs,
    error,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.selfCheck) {
    const report = await runSelfCheck({
      features: args.features,
      tiers: args.tiers,
    });
    process.exit(report.ok ? 0 : 1);
  }

  const targetTiers = args.tiers || [...VALID_TIERS];
  const repoRoot = resolveRepoRoot();
  const { tests } = await loadAllTests({
    tiers: targetTiers,
    features: args.features,
    filter: args.filter,
  });

  if (tests.length === 0) {
    console.error(
      `[E2E-RUNNER] ERROR: 0 tests matched criteria (tiers=${targetTiers.join(',')}, features=${args.features?.join(',') || '*'}, filter=${args.filter || '*'})`,
    );
    process.exit(1);
  }

  const runId = `run_${Date.now()}_${process.pid}`;
  const suiteStartedAt = Date.now();
  const results = [];

  const handleSignal = () => {
    cleanupRunRoot(runId);
    process.exit(130);
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  console.log(
    `[E2E-RUNNER] Executing ${tests.length} opaque-box E2E test(s) against repoRoot=${repoRoot} (concurrency=${args.concurrency})`,
  );

  try {
    let cursor = 0;
    async function workerLoop() {
      while (cursor < tests.length) {
        const idx = cursor++;
        const test = tests[idx];
        const res = await executeSingleTest(test, runId, repoRoot);
        results[idx] = res;
        if (res.ok) {
          console.log(`[PASS] (${res.durationMs}ms) [T${res.tier}] ${res.id} — ${res.name}`);
        } else {
          const msg = res.error?.message || String(res.error);
          const reasonTag = res.isTargetNotBuilt && !msg.startsWith('[TARGET_NOT_BUILT]') ? '[TARGET_NOT_BUILT] ' : '';
          console.error(`[FAIL] (${res.durationMs}ms) [T${res.tier}] ${res.id} — ${reasonTag}${msg}`);
        }
      }
    }

    const workers = Array.from({ length: Math.min(args.concurrency, tests.length) }, () => workerLoop());
    await Promise.all(workers);
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    cleanupRunRoot(runId);
  }

  const totalDurationMs = Date.now() - suiteStartedAt;
  const passed = results.filter((r) => r?.ok).length;
  const failed = results.length - passed;
  const targetNotBuiltCount = results.filter((r) => !r?.ok && r?.isTargetNotBuilt).length;

  console.log(
    `[E2E-RUNNER] Summary: total=${results.length}, passed=${passed}, failed=${failed}, targetNotBuilt=${targetNotBuiltCount}, skipped=0, durationMs=${totalDurationMs}`,
  );

  process.exit(failed === 0 && passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(`[E2E-RUNNER] Fatal error: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
