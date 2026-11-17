import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const REQUEST_OPTION_KEYS = new Set([
  'serverUrl',
  'baseUrl',
  'token',
  'headers',
  'json',
  'rawBody',
  'multipart',
  'query',
  'timeoutMs',
]);

function isPlainNonArrayObject(val) {
  return (
    typeof val === 'object' &&
    val !== null &&
    !Array.isArray(val) &&
    !Buffer.isBuffer(val) &&
    !(val instanceof Uint8Array)
  );
}

function isOptionsObject(obj, allowDirectBodyFallback = false, isDelete = false) {
  if (!isPlainNonArrayObject(obj)) {
    return false;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return !allowDirectBodyFallback || isDelete;
  }
  if (!keys.every((k) => REQUEST_OPTION_KEYS.has(k))) {
    return false;
  }
  if ('query' in obj && obj.query !== undefined) {
    if (typeof obj.query !== 'object' || obj.query === null) {
      return false;
    }
  }
  if ('headers' in obj && obj.headers !== undefined) {
    if (!isPlainNonArrayObject(obj.headers)) {
      return false;
    }
  }
  if ('multipart' in obj && obj.multipart !== undefined) {
    if (!isPlainNonArrayObject(obj.multipart)) {
      return false;
    }
  }
  if ('token' in obj && obj.token !== undefined && typeof obj.token !== 'string') {
    return false;
  }
  if ('serverUrl' in obj && obj.serverUrl !== undefined && typeof obj.serverUrl !== 'string') {
    return false;
  }
  if ('baseUrl' in obj && obj.baseUrl !== undefined && typeof obj.baseUrl !== 'string') {
    return false;
  }
  if (
    'timeoutMs' in obj &&
    obj.timeoutMs !== undefined &&
    (typeof obj.timeoutMs !== 'number' || !Number.isFinite(obj.timeoutMs))
  ) {
    return false;
  }
  return true;
}

function normalizeMethodArgs(jsonOrOpts, maybeOpts, allowDirectBodyFallback, isDelete = false) {
  if (maybeOpts !== undefined) {
    const baseOpts = { ...(maybeOpts || {}) };
    if (Buffer.isBuffer(jsonOrOpts) || jsonOrOpts instanceof Uint8Array || typeof jsonOrOpts === 'string') {
      baseOpts.rawBody = jsonOrOpts;
    } else if (jsonOrOpts !== undefined) {
      baseOpts.json = jsonOrOpts;
    }
    return baseOpts;
  }
  if (jsonOrOpts === undefined || jsonOrOpts === null) {
    return {};
  }
  if (Buffer.isBuffer(jsonOrOpts) || jsonOrOpts instanceof Uint8Array) {
    return { rawBody: jsonOrOpts };
  }
  if (isOptionsObject(jsonOrOpts, allowDirectBodyFallback, isDelete)) {
    return jsonOrOpts;
  }
  if (allowDirectBodyFallback) {
    return { json: jsonOrOpts };
  }
  return jsonOrOpts;
}

function buildMultipartPayload(multipart) {
  const boundary = `----HarmonyTgE2EBoundary${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];

  if (multipart.fields && typeof multipart.fields === 'object') {
    for (const [name, value] of Object.entries(multipart.fields)) {
      if (value === undefined || value === null) continue;
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
          'utf8',
        ),
      );
    }
  }

  if (Array.isArray(multipart.files)) {
    for (const file of multipart.files) {
      const fieldName = file.name || file.fieldName || 'file';
      const filename = file.filename || 'upload.bin';
      const contentType = file.contentType || 'application/octet-stream';
      const dataBuf = Buffer.isBuffer(file.data)
        ? file.data
        : file.data instanceof Uint8Array
          ? Buffer.from(file.data)
          : Buffer.from(String(file.data ?? ''), 'utf8');
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(dataBuf);
      chunks.push(Buffer.from('\r\n', 'utf8'));
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    bodyBuffer: Buffer.concat(chunks),
  };
}

function resolveTargetUrl(urlOrPath, opts, getDefaultServerUrl) {
  let targetUrl;
  if (/^https?:\/\//i.test(urlOrPath)) {
    targetUrl = new URL(urlOrPath);
  } else {
    const base = opts.serverUrl || opts.baseUrl || (typeof getDefaultServerUrl === 'function' ? getDefaultServerUrl() : null);
    if (!base) {
      throw new Error(
        `No serverUrl provided for HTTP request '${urlOrPath}' (call ctx.ensureServer() first or pass { serverUrl })`,
      );
    }
    targetUrl = new URL(urlOrPath, base.endsWith('/') ? base : `${base}/`);
  }

  if (opts.query) {
    if (opts.query instanceof URLSearchParams) {
      for (const [k, v] of opts.query.entries()) {
        targetUrl.searchParams.append(k, v);
      }
    } else if (Array.isArray(opts.query)) {
      for (const [k, v] of opts.query) {
        if (v !== undefined && v !== null) targetUrl.searchParams.append(String(k), String(v));
      }
    } else if (typeof opts.query === 'object') {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) targetUrl.searchParams.set(k, String(v));
      }
    }
  }

  return targetUrl;
}

function buildRequestBodyAndHeaders(opts) {
  const headers = {};
  if (opts.headers && typeof opts.headers === 'object') {
    for (const [k, v] of Object.entries(opts.headers)) {
      if (v !== undefined && v !== null) headers[k] = String(v);
    }
  }

  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (opts.token && !hasAuthHeader) {
    headers.Authorization = `Bearer ${opts.token}`;
  }

  const hasContentType = () => Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');

  let bodyBuffer = null;
  if (opts.multipart) {
    const mp = buildMultipartPayload(opts.multipart);
    bodyBuffer = mp.bodyBuffer;
    if (!hasContentType()) headers['Content-Type'] = mp.contentType;
  } else if (opts.rawBody !== undefined && opts.rawBody !== null) {
    bodyBuffer = Buffer.isBuffer(opts.rawBody)
      ? opts.rawBody
      : opts.rawBody instanceof Uint8Array
        ? Buffer.from(opts.rawBody)
        : Buffer.from(String(opts.rawBody), 'utf8');
  } else if (opts.body !== undefined && opts.body !== null) {
    if (Buffer.isBuffer(opts.body) || opts.body instanceof Uint8Array || typeof opts.body === 'string') {
      bodyBuffer = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
    } else {
      bodyBuffer = Buffer.from(JSON.stringify(opts.body), 'utf8');
      if (!hasContentType()) headers['Content-Type'] = 'application/json';
    }
  } else if (opts.json !== undefined) {
    bodyBuffer = Buffer.from(JSON.stringify(opts.json), 'utf8');
    if (!hasContentType()) headers['Content-Type'] = 'application/json';
  }

  if (bodyBuffer !== null) {
    headers['Content-Length'] = String(bodyBuffer.length);
  }

  return { headers, bodyBuffer };
}

export function createHttpClient({ getDefaultServerUrl } = {}) {
  function request(method, urlOrPath, opts = {}) {
    const upperMethod = String(method || 'GET').toUpperCase();
    const targetUrl = resolveTargetUrl(urlOrPath, opts, getDefaultServerUrl);
    const { headers, bodyBuffer } = buildRequestBodyAndHeaders(opts);
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const transport = targetUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      const req = transport.request(
        targetUrl,
        {
          method: upperMethod,
          headers,
          agent: false,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', (err) => done(reject, err));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const text = buffer.toString('utf8');
            let json = null;
            if (text.length > 0) {
              try {
                json = JSON.parse(text);
              } catch {
                json = null;
              }
            }
            const status = res.statusCode ?? 0;
            done(resolve, {
              status,
              ok: status >= 200 && status < 300,
              headers: res.headers,
              text,
              json,
              buffer,
            });
          });
        },
      );

      const timer = setTimeout(() => {
        req.destroy();
        done(reject, new Error(`HTTP ${upperMethod} ${targetUrl.href} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      req.on('error', (err) => done(reject, err));

      if (bodyBuffer !== null) {
        req.write(bodyBuffer);
      }
      req.end();
    });
  }

  function parseSseFrames(rawBufferText) {
    const normalized = rawBufferText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split('\n\n');
    const events = [];
    let doneReceived = false;

    for (const block of blocks) {
      if (!block.trim()) continue;
      let eventName = 'message';
      let id = null;
      const dataLines = [];

      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colonIdx = line.indexOf(':');
        const field = colonIdx >= 0 ? line.slice(0, colonIdx) : line;
        let value = colonIdx >= 0 ? line.slice(colonIdx + 1) : '';
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        else if (field === 'id') id = value;
        else if (field === 'data') dataLines.push(value);
      }

      if (dataLines.length === 0 && eventName === 'message' && id === null) continue;
      const data = dataLines.join('\n');
      if (data.trim() === '[DONE]') {
        doneReceived = true;
      }
      let dataJson = null;
      if (data.length > 0 && data.trim() !== '[DONE]') {
        try {
          dataJson = JSON.parse(data);
        } catch {
          dataJson = null;
        }
      }
      events.push({ event: eventName, id, data, json: dataJson });
    }

    return { events, doneReceived };
  }

  function readSseEvents(arg1, arg2, arg3) {
    let method;
    let urlOrPath;
    let opts;
    if (typeof arg2 === 'string') {
      method = String(arg1 || 'GET').toUpperCase();
      urlOrPath = arg2;
      opts = arg3 || {};
    } else {
      urlOrPath = arg1;
      opts = arg2 || {};
      method = String(
        opts.method || (opts.json !== undefined || opts.rawBody !== undefined || opts.body !== undefined ? 'POST' : 'GET'),
      ).toUpperCase();
    }

    const mergedHeaders = { Accept: 'text/event-stream', ...(opts.headers || {}) };
    const reqOpts = { ...opts, headers: mergedHeaders };
    const targetUrl = resolveTargetUrl(urlOrPath, reqOpts, getDefaultServerUrl);
    const { headers, bodyBuffer } = buildRequestBodyAndHeaders(reqOpts);
    const timeoutMs = reqOpts.timeoutMs ?? 20_000;
    const maxEvents = reqOpts.maxEvents ?? Infinity;
    const stopWhen = typeof reqOpts.stopWhen === 'function' ? reqOpts.stopWhen : null;
    const transport = targetUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      const req = transport.request(
        targetUrl,
        {
          method,
          headers,
          agent: false,
        },
        (res) => {
          const chunks = [];
          const finalize = () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const { events, doneReceived } = parseSseFrames(text);
            const status = res.statusCode ?? 0;
            done(resolve, {
              status,
              ok: status >= 200 && status < 300,
              headers: res.headers,
              events,
              doneReceived,
              text,
            });
          };

          res.on('data', (chunk) => {
            chunks.push(chunk);
            if (maxEvents < Infinity || stopWhen) {
              const currentText = Buffer.concat(chunks).toString('utf8');
              const parsed = parseSseFrames(currentText);
              if (
                parsed.doneReceived ||
                parsed.events.length >= maxEvents ||
                (stopWhen && parsed.events.some((ev) => stopWhen(ev)))
              ) {
                req.destroy();
                finalize();
              }
            }
          });
          res.on('error', (err) => {
            if (!settled) done(reject, err);
          });
          res.on('end', finalize);
          res.on('close', finalize);
        },
      );

      const timer = setTimeout(() => {
        req.destroy();
        done(reject, new Error(`SSE ${method} ${targetUrl.href} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      req.on('error', (err) => done(reject, err));
      if (bodyBuffer !== null) req.write(bodyBuffer);
      req.end();
    });
  }

  return Object.freeze({
    request,
    get: (urlOrPath, opts = {}) => request('GET', urlOrPath, opts),
    post: (urlOrPath, jsonOrOpts, maybeOpts) =>
      request('POST', urlOrPath, normalizeMethodArgs(jsonOrOpts, maybeOpts, true)),
    put: (urlOrPath, jsonOrOpts, maybeOpts) =>
      request('PUT', urlOrPath, normalizeMethodArgs(jsonOrOpts, maybeOpts, true)),
    patch: (urlOrPath, jsonOrOpts, maybeOpts) =>
      request('PATCH', urlOrPath, normalizeMethodArgs(jsonOrOpts, maybeOpts, true)),
    del: (urlOrPath, jsonOrOpts, maybeOpts) =>
      request('DELETE', urlOrPath, normalizeMethodArgs(jsonOrOpts, maybeOpts, true, true)),
    delete: (urlOrPath, jsonOrOpts, maybeOpts) =>
      request('DELETE', urlOrPath, normalizeMethodArgs(jsonOrOpts, maybeOpts, true, true)),
    readSseEvents,
  });
}

export function startMockHttpServer(handlerFn) {
  if (typeof handlerFn !== 'function') {
    throw new TypeError('startMockHttpServer requires a handler function');
  }

  const requests = [];
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const bodyBuffer = Buffer.concat(chunks);
      const bodyText = bodyBuffer.toString('utf8');
      let bodyJson = null;
      if (bodyText.length > 0) {
        try {
          bodyJson = JSON.parse(bodyText);
        } catch {
          bodyJson = null;
        }
      }

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 80;
      const urlObj = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const recorded = {
        method: req.method || 'GET',
        url: req.url || '/',
        path: urlObj.pathname,
        query: Object.fromEntries(urlObj.searchParams.entries()),
        headers: req.headers,
        bodyBuffer,
        bodyText,
        bodyJson,
        timestampMs: Date.now(),
      };
      requests.push(recorded);

      try {
        const result = await handlerFn(recorded, res, req);
        if (res.writableEnded) return;
        if (res.headersSent) {
          res.end();
          return;
        }
        if (result && typeof result === 'object') {
          const status = result.status ?? 200;
          const outHeaders = { ...(result.headers || {}) };
          let outBody;
          if (result.json !== undefined) {
            outBody = Buffer.from(JSON.stringify(result.json), 'utf8');
            if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === 'content-type')) {
              outHeaders['Content-Type'] = 'application/json';
            }
          } else if (result.body !== undefined) {
            outBody = Buffer.isBuffer(result.body) || result.body instanceof Uint8Array
              ? Buffer.from(result.body)
              : Buffer.from(String(result.body), 'utf8');
          } else if (result.text !== undefined) {
            outBody = Buffer.from(String(result.text), 'utf8');
          } else {
            outBody = Buffer.alloc(0);
          }
          outHeaders['Content-Length'] = String(outBody.length);
          res.writeHead(status, outHeaders);
          res.end(outBody);
          return;
        }
        const defaultBody = Buffer.from('{"ok":true}', 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(defaultBody.length),
        });
        res.end(defaultBody);
      } catch (err) {
        if (!res.headersSent) {
          const errBody = Buffer.from(JSON.stringify({ error: String(err?.message || err) }), 'utf8');
          res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': String(errBody.length) });
          res.end(errBody);
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const sock of sockets) {
      sock.destroy();
    }
    sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        host: '127.0.0.1',
        port,
        baseUrl,
        url: baseUrl,
        requests,
        clearRequests: () => {
          requests.length = 0;
        },
        close,
      });
    });
  });
}
