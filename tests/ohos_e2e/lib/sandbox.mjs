import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CA_CERT_PATH, WORK_ROOT } from './constants.mjs';

export function sanitizePathSegment(value, fallback = 'item') {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

export function createRunSandbox(runId, testId) {
  const safeRunId = sanitizePathSegment(runId, 'run');
  const safeTestId = sanitizePathSegment(testId, 'test');

  const runRootDir = path.join(WORK_ROOT, safeRunId);
  const workDir = path.join(runRootDir, safeTestId);
  const tmpDir = path.join(workDir, 'tmp');
  const serverDir = path.join(workDir, 'server');
  const mediaDir = path.join(serverDir, 'media');
  const clientsDir = path.join(workDir, 'clients');

  for (const dir of [workDir, tmpDir, serverDir, mediaDir, clientsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const clientSandboxes = new Map();

  function createClientSandbox(label = 'default') {
    const safeLabel = sanitizePathSegment(label, 'default');
    if (clientSandboxes.has(safeLabel)) {
      return clientSandboxes.get(safeLabel);
    }

    const rootDir = path.join(clientsDir, safeLabel);
    const filesDir = path.join(rootDir, 'files');
    const cacheDir = path.join(rootDir, 'cache');
    const tempDir = path.join(rootDir, 'temp');
    const databaseDir = path.join(rootDir, 'database');
    const resourceDir = path.join(rootDir, 'resources');

    for (const d of [rootDir, filesDir, cacheDir, tempDir, databaseDir, resourceDir]) {
      fs.mkdirSync(d, { recursive: true });
    }

    const handle = Object.freeze({
      label: safeLabel,
      rootDir,
      filesDir,
      cacheDir,
      tempDir,
      databaseDir,
      resourceDir,
      caCertPath: DEFAULT_CA_CERT_PATH,
    });
    clientSandboxes.set(safeLabel, handle);
    return handle;
  }

  function cleanup() {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  return {
    runRootDir,
    workDir,
    tmpDir,
    serverDir,
    mediaDir,
    clientsDir,
    createClientSandbox,
    cleanup,
  };
}

export function cleanupRunRoot(runId) {
  const safeRunId = sanitizePathSegment(runId, 'run');
  const runRootDir = path.join(WORK_ROOT, safeRunId);
  fs.rmSync(runRootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  if (fs.existsSync(WORK_ROOT)) {
    try {
      const remaining = fs.readdirSync(WORK_ROOT);
      if (remaining.length === 0) {
        fs.rmSync(WORK_ROOT, { recursive: true, force: true });
      }
    } catch {
      // Ignore concurrent directory removal
    }
  }
}
