import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AssertionError } from './assert.mjs';
import { TargetNotBuiltError } from './constants.mjs';

function resolveCliBin(repoRoot, explicitCliBin) {
  const cliBin = path.resolve(
    explicitCliBin || process.env.OHOS_APP_CLI_BIN || path.join(repoRoot, 'scripts', 'ohos-app-cli'),
  );
  if (!fs.existsSync(cliBin)) {
    throw new TargetNotBuiltError(`Missing opaque-box CLI driver: ${cliBin}`);
  }
  let st;
  try {
    st = fs.statSync(cliBin);
  } catch (err) {
    throw new TargetNotBuiltError(`Unable to stat opaque-box CLI driver ${cliBin}: ${err.message}`);
  }
  if (!st.isFile()) {
    throw new TargetNotBuiltError(`Opaque-box CLI driver is not a regular file: ${cliBin}`);
  }
  try {
    fs.accessSync(cliBin, fs.constants.X_OK);
  } catch {
    throw new TargetNotBuiltError(`Opaque-box CLI driver is not executable (chmod +x missing): ${cliBin}`);
  }
  return cliBin;
}

function isValidCliEnvelope(val) {
  return typeof val === 'object' && val !== null && !Array.isArray(val) && typeof val.ok === 'boolean';
}

function parseCliStdoutJson(stdoutRaw) {
  const trimmed = stdoutRaw.trim();
  if (!trimmed) {
    return { validJson: false, parsed: null };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (isValidCliEnvelope(parsed)) {
      return { validJson: true, parsed };
    }
  } catch {
    // Fall through to multi-line scan
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{') && lines[i].endsWith('}')) {
      try {
        const lineParsed = JSON.parse(lines[i]);
        if (isValidCliEnvelope(lineParsed)) {
          return { validJson: true, parsed: lineParsed };
        }
      } catch {
        // Keep scanning
      }
    }
  }
  return { validJson: false, parsed: null };
}

function normalizeCliEnvelope(parsed, exitCode, stdout, stderr) {
  const ok = parsed.ok === true;
  let data = parsed?.data;
  let dataJson = typeof parsed?.dataJson === 'string' ? parsed.dataJson : '';

  if (data === undefined && typeof parsed?.dataJson === 'string') {
    if (parsed.dataJson.trim().length === 0) {
      data = null;
    } else {
      try {
        data = JSON.parse(parsed.dataJson);
      } catch {
        data = parsed.dataJson;
      }
    }
  } else if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    typeof data.dataJson === 'string' &&
    data.data === undefined
  ) {
    dataJson = data.dataJson;
    if (data.dataJson.trim().length > 0) {
      try {
        data = JSON.parse(data.dataJson);
      } catch {
        // Keep envelope object if inner dataJson is non-JSON
      }
    }
  } else if (!dataJson && data !== undefined) {
    try {
      dataJson = JSON.stringify(data);
    } catch {
      dataJson = '';
    }
  }

  const rawErr = parsed?.error;
  const errorCode =
    parsed?.errorCode ??
    (typeof rawErr === 'object' && rawErr !== null ? rawErr.code ?? rawErr.errorCode ?? '' : '');
  const errorMessage =
    parsed?.errorMessage ??
    (typeof rawErr === 'string'
      ? rawErr
      : typeof rawErr === 'object' && rawErr !== null
        ? rawErr.message ?? rawErr.errorMessage ?? JSON.stringify(rawErr)
        : '');

  const error = ok ? null : rawErr ?? (errorMessage || errorCode || 'CLI returned ok=false');
  const generation =
    typeof parsed?.generation === 'number'
      ? parsed.generation
      : typeof data?.generation === 'number'
        ? data.generation
        : 0;

  return {
    ok,
    data,
    dataJson,
    error,
    errorCode: String(errorCode || ''),
    errorMessage: String(errorMessage || ''),
    generation,
    exitCode,
    stdout,
    stderr,
  };
}

export function createCliDriver({
  repoRoot,
  tmpDir,
  getDefaultSandbox,
  getDefaultServerUrl,
  trackChildProcess,
  cliBinOverride,
}) {
  let scenarioSeq = 0;

  function resolveSandboxPath(sandbox) {
    if (!sandbox) {
      const def = typeof getDefaultSandbox === 'function' ? getDefaultSandbox() : null;
      if (!def) throw new Error('No client sandbox provided to ctx.cli');
      return typeof def === 'string' ? def : def.rootDir;
    }
    if (typeof sandbox === 'string') {
      fs.mkdirSync(sandbox, { recursive: true });
      return path.resolve(sandbox);
    }
    if (typeof sandbox === 'object' && typeof sandbox.rootDir === 'string') {
      return path.resolve(sandbox.rootDir);
    }
    throw new TypeError(`Invalid sandbox argument passed to ctx.cli: ${typeof sandbox}`);
  }

  async function execRaw(args, { expectOk = true, timeoutMs = 20_000, env: extraEnv } = {}) {
    // Always verify binary existence/executability FIRST, even when expectOk === false!
    const cliBin = resolveCliBin(repoRoot, cliBinOverride);
    const argList = Array.isArray(args) ? args.map(String) : [];

    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;

      const child = spawn(cliBin, argList, {
        cwd: repoRoot,
        env: {
          ...process.env,
          HARMONY_TELEGRAM_ROOT: repoRoot,
          TMPDIR: tmpDir,
          TEMP: tmpDir,
          TMP: tmpDir,
          GPUI_OFFLINE_TEST: '1',
          ...(extraEnv || {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (typeof trackChildProcess === 'function') {
        trackChildProcess(child);
      }

      const outChunks = [];
      const errChunks = [];
      child.stdout?.on('data', (c) => outChunks.push(c));
      child.stderr?.on('data', (c) => errChunks.push(c));

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore
            }
          }, 1_000).unref?.();
        } catch {
          // Ignore
        }
      }, timeoutMs);
      timer.unref?.();

      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err.code === 'ENOENT' || err.code === 'EACCES') {
          reject(new TargetNotBuiltError(`Failed to execute ${cliBin}: ${err.message}`));
        } else {
          reject(err);
        }
      });

      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const stdout = Buffer.concat(outChunks).toString('utf8');
        const stderr = Buffer.concat(errChunks).toString('utf8');
        const cmdPreview = `${path.basename(cliBin)} ${argList.slice(0, 6).join(' ')}`;

        if (timedOut) {
          reject(
            new Error(
              `ohos-app-cli timed out after ${timeoutMs}ms (${cmdPreview}). stderr=${stderr.slice(0, 400)}`,
            ),
          );
          return;
        }

        if (signal !== null) {
          reject(
            new Error(
              `ohos-app-cli terminated abnormally by signal ${signal} (${cmdPreview}). stderr=${stderr.slice(0, 400)}`,
            ),
          );
          return;
        }

        const { validJson, parsed } = parseCliStdoutJson(stdout);
        if (!validJson || !isValidCliEnvelope(parsed)) {
          if (/TARGET_NOT_BUILT|libtelegram_core.*not (found|built)/i.test(`${stdout}\n${stderr}`)) {
            reject(
              new TargetNotBuiltError(
                `ohos-app-cli reported unbuilt native component (${cmdPreview}): ${(stderr || stdout).trim().slice(0, 400)}`,
              ),
            );
            return;
          }
          reject(
            new AssertionError({
              message: `ohos-app-cli emitted invalid or non-envelope JSON stdout on '${cmdPreview}' (exitCode=${exitCode}): stdout=${JSON.stringify(stdout.slice(0, 300))} stderr=${JSON.stringify(stderr.slice(0, 300))}`,
              actual: stdout,
              expected: '{ "ok": boolean, ... }',
              operator: 'cliJsonEnvelope',
            }),
          );
          return;
        }

        const normalized = normalizeCliEnvelope(parsed, exitCode ?? 1, stdout, stderr);

        // Guard against fake-passing expectOk:false when the underlying native bridge is not built yet
        if (
          normalized.errorCode === 'TARGET_NOT_BUILT' ||
          /\[TARGET_NOT_BUILT\]|libtelegram_core.*not (found|built)/i.test(normalized.errorMessage)
        ) {
          reject(
            new TargetNotBuiltError(
              `ohos-app-cli target component not built (${cmdPreview}): ${normalized.errorMessage || normalized.errorCode}`,
            ),
          );
          return;
        }

        if (expectOk === true) {
          if (!normalized.ok || normalized.exitCode !== 0) {
            reject(
              new AssertionError({
                message: `Expected ohos-app-cli success (ok=true, exit=0) on '${cmdPreview}', got ok=${normalized.ok}, exit=${normalized.exitCode}, errorCode='${normalized.errorCode}', error='${normalized.errorMessage}' (stderr: ${stderr.trim().slice(0, 300)})`,
                actual: { ok: normalized.ok, exitCode: normalized.exitCode, error: normalized.error },
                expected: { ok: true, exitCode: 0 },
                operator: 'cliExpectOk',
              }),
            );
            return;
          }
        } else if (expectOk === false) {
          if (normalized.ok || normalized.exitCode === 0) {
            reject(
              new AssertionError({
                message: `Expected ohos-app-cli rejection (ok=false, non-zero exit) on '${cmdPreview}', got ok=${normalized.ok}, exit=${normalized.exitCode}, data=${(JSON.stringify(normalized.data) ?? 'undefined').slice(0, 300)}`,
                actual: { ok: normalized.ok, exitCode: normalized.exitCode },
                expected: { ok: false, exitCode: '<non-zero>' },
                operator: 'cliExpectError',
              }),
            );
            return;
          }
        }

        resolve(normalized);
      });
    });
  }

  async function inspectArtifacts({ expectOk = true, timeoutMs = 20_000 } = {}) {
    return execRaw(['inspect-artifacts'], { expectOk, timeoutMs });
  }

  async function invoke({
    sandbox,
    serverUrl,
    domain,
    action,
    payload = {},
    expectOk = true,
    timeoutMs = 20_000,
    env,
  } = {}) {
    const sandboxDir = resolveSandboxPath(sandbox);
    const resolvedServer =
      serverUrl || (typeof getDefaultServerUrl === 'function' ? getDefaultServerUrl() : null) || 'http://127.0.0.1:8080';
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});

    return execRaw(
      [
        'invoke',
        '--sandbox',
        sandboxDir,
        '--server',
        resolvedServer,
        '--domain',
        String(domain ?? ''),
        '--action',
        String(action ?? ''),
        '--payload',
        payloadStr,
      ],
      { expectOk, timeoutMs, env },
    );
  }

  async function uiSession({
    sandbox,
    serverUrl,
    script,
    expectOk = true,
    timeoutMs = 25_000,
    env,
  } = {}) {
    const sandboxDir = resolveSandboxPath(sandbox);
    const resolvedServer =
      serverUrl || (typeof getDefaultServerUrl === 'function' ? getDefaultServerUrl() : null) || 'http://127.0.0.1:8080';

    let scriptPath;
    if (typeof script === 'string') {
      scriptPath = path.resolve(script);
    } else if (typeof script === 'object' && script !== null) {
      scenarioSeq += 1;
      scriptPath = path.join(tmpDir, `ui_scenario_${scenarioSeq}.json`);
      fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2), 'utf8');
    } else {
      throw new TypeError('ctx.cli.uiSession requires a script object or JSON file path');
    }

    return execRaw(
      ['ui-session', '--sandbox', sandboxDir, '--server', resolvedServer, '--script', scriptPath],
      { expectOk, timeoutMs, env },
    );
  }

  return Object.freeze({
    inspectArtifacts,
    invoke,
    uiSession,
    execRaw,
  });
}
