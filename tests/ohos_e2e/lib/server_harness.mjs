import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { TargetNotBuiltError } from './constants.mjs';
import { allocateFreePort } from './port_alloc.mjs';
import { sanitizePathSegment } from './sandbox.mjs';

function isExecutableFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveServerLauncher(repoRoot, port, dataDir, options = {}) {
  const explicitServerBin = options.serverBin || process.env.GPUI_TELEGRAM_SERVER_BIN;
  if (explicitServerBin) {
    const resolved = path.resolve(explicitServerBin);
    if (!isExecutableFile(resolved)) {
      throw new TargetNotBuiltError(`Configured GPUI_TELEGRAM_SERVER_BIN is missing or not executable: ${resolved}`);
    }
    return { mode: 'direct', command: resolved, args: [] };
  }

  const releaseBin = path.join(repoRoot, 'target', 'release', 'gpui_telegram_server');
  if (isExecutableFile(releaseBin)) {
    return { mode: 'direct', command: releaseBin, args: [] };
  }

  const debugBin = path.join(repoRoot, 'target', 'debug', 'gpui_telegram_server');
  if (isExecutableFile(debugBin)) {
    return { mode: 'direct', command: debugBin, args: [] };
  }

  const cliBin = path.resolve(options.cliBin || process.env.OHOS_APP_CLI_BIN || path.join(repoRoot, 'scripts', 'ohos-app-cli'));
  if (isExecutableFile(cliBin)) {
    return {
      mode: 'cli-server-start',
      command: cliBin,
      args: ['server-start', '--port', String(port), '--data-dir', dataDir],
    };
  }

  throw new TargetNotBuiltError(
    `Neither gpui_telegram_server (${releaseBin} / ${debugBin}) nor scripts/ohos-app-cli (${cliBin}) is built yet`,
  );
}

function probeHealthOnce(port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').trim();
          resolve(res.statusCode === 200 && body === 'OK');
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    req.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    req.end();
  });
}

function killProcessGroupOrPid(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fallback to direct child kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited
  }
}

export async function spawnLiveServer({
  repoRoot,
  serverDir,
  mediaDir,
  tmpDir,
  options = {},
  trackChildProcess,
}) {
  const instanceLabel = options.label ? sanitizePathSegment(options.label, 'srv') : null;
  const dataDir = instanceLabel ? path.join(serverDir, instanceLabel) : serverDir;
  const resolvedMediaDir = instanceLabel ? path.join(dataDir, 'media') : mediaDir;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(resolvedMediaDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // Validate binary availability immediately before allocating port so missing builds fail fast
  resolveServerLauncher(repoRoot, 8080, dataDir, options);

  const port = options.port || (await allocateFreePort('127.0.0.1'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/api/v1/ws`;
  const derpWsUrl = `ws://127.0.0.1:${port}/api/v1/tailnet/derp`;
  const dbFilePath = path.join(dataDir, 'gpui_telegram.db');
  const databaseUrl = `sqlite://${dbFilePath}`;

  let currentChild = null;
  let running = false;
  let recentLogs = '';
  let activeEnvOverrides = { ...(options.env || {}) };

  function appendLog(chunk) {
    recentLogs += chunk.toString('utf8');
    if (recentLogs.length > 16_384) {
      recentLogs = recentLogs.slice(-16_384);
    }
  }

  async function stop() {
    const child = currentChild;
    currentChild = null;
    running = false;
    if (!child) return;

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
        clearTimeout(hardCapTimer);
        resolve();
      };

      child.once('close', done);
      killProcessGroupOrPid(child, 'SIGTERM');

      const killTimer = setTimeout(() => {
        killProcessGroupOrPid(child, 'SIGKILL');
      }, 2_000);
      killTimer.unref?.();

      const hardCapTimer = setTimeout(done, 3_000);
      hardCapTimer.unref?.();
    });
  }

  async function startProcess(extraEnv) {
    if (extraEnv && typeof extraEnv === 'object') {
      activeEnvOverrides = { ...activeEnvOverrides, ...extraEnv };
    }
    const launcher = resolveServerLauncher(repoRoot, port, dataDir, options);
    const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;

    const childEnv = {
      ...process.env,
      HARMONY_TELEGRAM_ROOT: repoRoot,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      MEDIA_STORAGE_PATH: resolvedMediaDir,
      TMPDIR: tmpDir,
      TEMP: tmpDir,
      TMP: tmpDir,
      GPUI_OFFLINE_TEST: '1',
      ...activeEnvOverrides,
    };

    const maxBindRetries = 3;
    for (let bindAttempt = 0; bindAttempt < maxBindRetries; bindAttempt++) {
      recentLogs = '';
      const child = spawn(launcher.command, launcher.args, {
        cwd: repoRoot,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      currentChild = child;
      if (typeof trackChildProcess === 'function') {
        trackChildProcess(child);
      }

      let earlyExit = null;
      let spawnError = null;
      child.stdout?.on('data', appendLog);
      child.stderr?.on('data', appendLog);
      child.once('error', (err) => {
        spawnError = err;
      });
      child.once('close', (code, signal) => {
        earlyExit = { code, signal };
        if (currentChild === child) {
          running = false;
        }
      });

      const deadline = Date.now() + startupTimeoutMs;
      let healthy = false;
      while (Date.now() < deadline) {
        if (spawnError) {
          await stop();
          throw spawnError;
        }
        if (earlyExit !== null) {
          break;
        }
        if (await probeHealthOnce(port, 800)) {
          healthy = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (healthy) {
        running = true;
        return;
      }

      await stop();

      if (/TARGET_NOT_BUILT|not built|No such file/i.test(recentLogs) && launcher.mode === 'cli-server-start') {
        throw new TargetNotBuiltError(
          `Server launcher reported unbuilt binary: ${recentLogs.trim().slice(0, 400)}`,
        );
      }

      const isAddrInUse = /Address already in use|EADDRINUSE/i.test(recentLogs);
      if (isAddrInUse && bindAttempt + 1 < maxBindRetries) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }

      const exitDesc = earlyExit
        ? `exited early (code=${earlyExit.code}, signal=${earlyExit.signal})`
        : `did not pass GET /health within ${startupTimeoutMs}ms`;
      throw new Error(
        `gpui_telegram_server on 127.0.0.1:${port} ${exitDesc}. Recent logs:\n${recentLogs.trim().slice(-1200)}`,
      );
    }
  }

  await startProcess();

  async function restart(overrideEnv) {
    await stop();
    await startProcess(overrideEnv);
    return handle;
  }

  const handle = {
    host: '127.0.0.1',
    port,
    baseUrl,
    wsUrl,
    derpWsUrl,
    dataDir,
    mediaDir: resolvedMediaDir,
    databaseUrl,
    get isRunning() {
      return running;
    },
    get logs() {
      return recentLogs;
    },
    stop,
    restart,
  };

  return handle;
}
