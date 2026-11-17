import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { AssertionError } from './assert.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeClientFrame(opcode, payloadInput) {
  const payload = Buffer.isBuffer(payloadInput)
    ? payloadInput
    : payloadInput instanceof Uint8Array
      ? Buffer.from(payloadInput)
      : Buffer.from(String(payloadInput ?? ''), 'utf8');

  const len = payload.length;
  let headerLen;
  if (len < 126) headerLen = 2;
  else if (len <= 0xffff) headerLen = 4;
  else headerLen = 10;

  const maskKey = crypto.randomBytes(4);
  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f); // FIN=1 + opcode

  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }

  maskKey.copy(frame, headerLen);
  const maskedStart = headerLen + 4;
  for (let i = 0; i < len; i++) {
    frame[maskedStart + i] = payload[i] ^ maskKey[i & 3];
  }
  return frame;
}

function tryDecodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    const bigLen = buffer.readBigUInt64BE(2);
    if (bigLen > BigInt(64 * 1024 * 1024)) {
      throw new Error(`WebSocket frame exceeds 64 MiB safety cap: ${bigLen}`);
    }
    payloadLen = Number(bigLen);
    offset = 10;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLen) return null;

  const rawPayload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
  if (maskKey) {
    for (let i = 0; i < rawPayload.length; i++) {
      rawPayload[i] ^= maskKey[i & 3];
    }
  }

  return {
    fin,
    opcode,
    payload: rawPayload,
    bytesConsumed: offset + payloadLen,
  };
}

export function connectWsClient(token, opts = {}, { getDefaultServerUrl } = {}) {
  const {
    serverUrl,
    url,
    path: explicitPath,
    headers: customHeaders = {},
    query = {},
    useBearerHeader = false,
    expectRejectStatus,
    timeoutMs = 10_000,
  } = opts;

  const rawBase = url || serverUrl || (typeof getDefaultServerUrl === 'function' ? getDefaultServerUrl() : null);
  const effectivePathForErr = explicitPath ?? '/api/v1/ws';
  if (!rawBase && !(typeof explicitPath === 'string' && /^wss?:\/\/|^https?:\/\//i.test(explicitPath))) {
    return Promise.reject(
      new Error(
        `No serverUrl available for WebSocket '${effectivePathForErr}' (call ctx.ensureServer() first or pass { serverUrl })`,
      ),
    );
  }

  let targetUrl;
  if (typeof explicitPath === 'string' && /^wss?:\/\/|^https?:\/\//i.test(explicitPath)) {
    targetUrl = new URL(explicitPath.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:'));
  } else {
    const normalizedBase = String(rawBase).replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    const baseUrlObj = new URL(normalizedBase);
    if (explicitPath !== undefined) {
      const normalizedPath = String(explicitPath).replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
      targetUrl = new URL(normalizedPath, baseUrlObj.origin);
    } else if (baseUrlObj.pathname && baseUrlObj.pathname !== '/') {
      targetUrl = baseUrlObj;
    } else {
      targetUrl = new URL('/api/v1/ws', baseUrlObj.origin);
      for (const [k, v] of baseUrlObj.searchParams.entries()) {
        targetUrl.searchParams.append(k, v);
      }
    }
  }

  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) targetUrl.searchParams.set(k, String(v));
  }

  const headers = {};
  for (const [k, v] of Object.entries(customHeaders || {})) {
    if (v !== undefined && v !== null) headers[k] = String(v);
  }

  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (token !== undefined && token !== null && String(token).length > 0) {
    if (useBearerHeader) {
      if (!hasAuthHeader) headers.Authorization = `Bearer ${token}`;
    } else if (!targetUrl.searchParams.has('token')) {
      targetUrl.searchParams.set('token', String(token));
    }
  }

  const secKey = crypto.randomBytes(16).toString('base64');
  const expectedAccept = crypto.createHash('sha1').update(secKey + WS_GUID).digest('base64');
  headers.Connection = 'Upgrade';
  headers.Upgrade = 'websocket';
  headers['Sec-WebSocket-Version'] = '13';
  headers['Sec-WebSocket-Key'] = secKey;

  const isDerpEndpoint = targetUrl.pathname.includes('/tailnet/derp');
  const transport = targetUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let handshakeSettled = false;
    const settleHandshake = (fn, arg) => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      clearTimeout(handshakeTimer);
      fn(arg);
    };

    const req = transport.request(targetUrl, {
      method: 'GET',
      headers,
      agent: false,
    });

    const handshakeTimer = setTimeout(() => {
      req.destroy();
      settleHandshake(reject, new Error(`WebSocket handshake to ${targetUrl.href} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    handshakeTimer.unref?.();

    req.on('error', (err) => {
      settleHandshake(reject, err);
    });

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
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
        res.socket?.destroy();
        const status = res.statusCode ?? 0;

        if (expectRejectStatus !== undefined) {
          if (status === expectRejectStatus) {
            settleHandshake(resolve, {
              rejected: true,
              status,
              headers: res.headers,
              text,
              json,
              buffer,
            });
          } else {
            settleHandshake(
              reject,
              new AssertionError({
                message: `Expected WebSocket upgrade rejection HTTP ${expectRejectStatus}, got HTTP ${status} (body: ${text.slice(0, 300)})`,
                actual: status,
                expected: expectRejectStatus,
                operator: 'expectRejectStatus',
              }),
            );
          }
          return;
        }

        const err = new Error(`WebSocket upgrade failed with HTTP ${status}: ${text.slice(0, 300)}`);
        err.status = status;
        err.text = text;
        err.json = json;
        settleHandshake(reject, err);
      });
    });

    req.on('upgrade', (res, socket, head) => {
      if (expectRejectStatus !== undefined) {
        socket.destroy();
        settleHandshake(
          reject,
          new AssertionError({
            message: `Expected WebSocket upgrade rejection HTTP ${expectRejectStatus}, but server upgraded with 101 Switching Protocols`,
            actual: 101,
            expected: expectRejectStatus,
            operator: 'expectRejectStatus',
          }),
        );
        return;
      }

      const acceptHeader = res.headers['sec-websocket-accept'];
      if (acceptHeader !== expectedAccept) {
        socket.destroy();
        settleHandshake(
          reject,
          new Error(`Invalid Sec-WebSocket-Accept header: got '${acceptHeader}', expected '${expectedAccept}'`),
        );
        return;
      }

      socket.setNoDelay(true);

      let recvBuf = Buffer.alloc(0);
      let fragOpcode = 0;
      let fragChunks = [];
      let isClosed = false;
      let closeSent = false;
      let closeInfo = { code: 1005, reason: '' };

      const allFrames = [];
      const unconsumedFrames = [];
      const frameWaiters = [];
      const closeWaiters = [];

      function matchPredicate(predOrType, frame) {
        if (typeof predOrType === 'string') {
          return Boolean(frame && frame.type === predOrType);
        }
        if (typeof predOrType === 'function') {
          return Boolean(predOrType(frame));
        }
        return true;
      }

      function dispatchFrame(frame) {
        allFrames.push(frame);
        for (let i = 0; i < frameWaiters.length; i++) {
          const waiter = frameWaiters[i];
          let matched = false;
          try {
            matched = matchPredicate(waiter.predOrType, frame);
          } catch (err) {
            frameWaiters.splice(i, 1);
            clearTimeout(waiter.timer);
            waiter.reject(err);
            return;
          }
          if (matched) {
            frameWaiters.splice(i, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
            return;
          }
        }
        unconsumedFrames.push(frame);
      }

      function markClosed(code, reason) {
        if (isClosed) return;
        isClosed = true;
        closeInfo = { code, reason };
        while (closeWaiters.length > 0) {
          const cw = closeWaiters.shift();
          clearTimeout(cw.timer);
          cw.resolve(closeInfo);
        }
        while (frameWaiters.length > 0) {
          const fw = frameWaiters.shift();
          clearTimeout(fw.timer);
          fw.reject(
            new Error(`WebSocket closed (code=${code}, reason='${reason}') while waiting for frame`),
          );
        }
      }

      function handleCompletedMessage(opcode, payload) {
        if (opcode === 0x1) {
          const rawText = payload.toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(rawText);
          } catch {
            parsed = null;
          }
          if (parsed && typeof parsed === 'object') {
            Object.defineProperty(parsed, '_rawText', {
              value: rawText,
              enumerable: false,
            });
            dispatchFrame(parsed);
          } else {
            dispatchFrame({ type: '$raw', rawText });
          }
        } else if (opcode === 0x2) {
          dispatchFrame({ type: '$binary', binary: payload });
        }
      }

      function processIncomingChunk(chunk) {
        if (!chunk || chunk.length === 0) return;
        recvBuf = recvBuf.length === 0 ? Buffer.from(chunk) : Buffer.concat([recvBuf, chunk]);

        while (recvBuf.length >= 2) {
          let decoded;
          try {
            decoded = tryDecodeFrame(recvBuf);
          } catch (err) {
            socket.destroy();
            markClosed(1002, err.message);
            return;
          }
          if (!decoded) break;

          recvBuf = recvBuf.subarray(decoded.bytesConsumed);
          const { fin, opcode, payload } = decoded;

          if (opcode === 0x8) {
            let code = 1005;
            let reason = '';
            if (payload.length >= 2) {
              code = payload.readUInt16BE(0);
              reason = payload.subarray(2).toString('utf8');
            }
            if (!closeSent && !socket.destroyed) {
              closeSent = true;
              const echoPayload = Buffer.allocUnsafe(2);
              echoPayload.writeUInt16BE(code === 1005 ? 1000 : code, 0);
              socket.write(encodeClientFrame(0x8, echoPayload), () => socket.destroy());
            } else {
              socket.destroy();
            }
            markClosed(code, reason);
            return;
          }

          if (opcode === 0x9) {
            if (!isClosed && !socket.destroyed) {
              socket.write(encodeClientFrame(0x0a, payload));
            }
            continue;
          }

          if (opcode === 0x0a) {
            dispatchFrame({ type: '$pong', binary: payload });
            continue;
          }

          if (opcode === 0x0) {
            fragChunks.push(payload);
            if (fin) {
              const full = Buffer.concat(fragChunks);
              const origOp = fragOpcode;
              fragChunks = [];
              fragOpcode = 0;
              handleCompletedMessage(origOp, full);
            }
          } else if (opcode === 0x1 || opcode === 0x2) {
            if (fin) {
              handleCompletedMessage(opcode, payload);
            } else {
              fragOpcode = opcode;
              fragChunks = [payload];
            }
          }
        }
      }

      socket.on('data', processIncomingChunk);
      socket.on('error', () => {
        markClosed(1006, 'socket_error');
      });
      socket.on('close', () => {
        markClosed(closeInfo.code, closeInfo.reason);
      });

      function writeRawFrame(opcode, payload) {
        if (isClosed || socket.destroyed) {
          throw new Error('Cannot send frame on closed WebSocket');
        }
        const raw = encodeClientFrame(opcode, payload);
        return new Promise((resWrite, rejWrite) => {
          socket.write(raw, (err) => (err ? rejWrite(err) : resWrite()));
        });
      }

      function sendText(str) {
        return writeRawFrame(0x1, Buffer.from(String(str), 'utf8'));
      }

      function sendBinary(buf) {
        return writeRawFrame(0x2, Buffer.from(buf));
      }

      function sendJson(obj) {
        return sendText(JSON.stringify(obj));
      }

      function sendFrame(typeOrObj, payload) {
        if (typeof typeOrObj === 'object' && typeOrObj !== null) {
          return sendJson(typeOrObj);
        }
        if (isDerpEndpoint) {
          const merged = payload && typeof payload === 'object' ? { type: typeOrObj, ...payload } : { type: typeOrObj };
          return sendJson(merged);
        }
        const wrapped = payload !== undefined ? { type: typeOrObj, payload } : { type: typeOrObj };
        return sendJson(wrapped);
      }

      function waitForFrame(predOrType, waitTimeoutMs = 10_000) {
        for (let i = 0; i < unconsumedFrames.length; i++) {
          if (matchPredicate(predOrType, unconsumedFrames[i])) {
            const [matched] = unconsumedFrames.splice(i, 1);
            return Promise.resolve(matched);
          }
        }
        if (isClosed) {
          return Promise.reject(
            new Error(`WebSocket already closed (code=${closeInfo.code}, reason='${closeInfo.reason}')`),
          );
        }
        return new Promise((resWait, rejWait) => {
          const waiter = {
            predOrType,
            resolve: resWait,
            reject: rejWait,
            timer: null,
          };
          waiter.timer = setTimeout(() => {
            const idx = frameWaiters.indexOf(waiter);
            if (idx >= 0) frameWaiters.splice(idx, 1);
            const recentTypes = allFrames.slice(-5).map((f) => f?.type ?? 'unknown').join(', ');
            rejWait(
              new Error(
                `Timed out after ${waitTimeoutMs}ms waiting for WebSocket frame (recent frames: [${recentTypes}])`,
              ),
            );
          }, waitTimeoutMs);
          waiter.timer.unref?.();
          frameWaiters.push(waiter);
        });
      }

      async function ping(nonce = Date.now(), waitTimeoutMs = 10_000) {
        await sendFrame('Ping', { nonce });
        return waitForFrame((f) => f && f.type === 'Pong' && f.payload?.nonce === nonce, waitTimeoutMs);
      }

      function subscribeChat(chatId) {
        return sendFrame('SubscribeChat', { chat_id: chatId });
      }

      function unsubscribeChat(chatId) {
        return sendFrame('UnsubscribeChat', { chat_id: chatId });
      }

      function waitForClose(waitTimeoutMs = 5_000) {
        if (isClosed) return Promise.resolve(closeInfo);
        return new Promise((resClose, rejClose) => {
          const cw = { resolve: resClose, timer: null };
          cw.timer = setTimeout(() => {
            const idx = closeWaiters.indexOf(cw);
            if (idx >= 0) closeWaiters.splice(idx, 1);
            rejClose(new Error(`Timed out after ${waitTimeoutMs}ms waiting for WebSocket close`));
          }, waitTimeoutMs);
          cw.timer.unref?.();
          closeWaiters.push(cw);
        });
      }

      async function close(code = 1000, reason = '') {
        if (isClosed || socket.destroyed) return closeInfo;
        if (!closeSent) {
          closeSent = true;
          const reasonBuf = Buffer.from(String(reason), 'utf8');
          const closePayload = Buffer.allocUnsafe(2 + reasonBuf.length);
          closePayload.writeUInt16BE(code, 0);
          reasonBuf.copy(closePayload, 2);
          try {
            socket.write(encodeClientFrame(0x8, closePayload));
          } catch {
            // Socket already closing
          }
        }
        await Promise.race([
          waitForClose(250).catch(() => null),
          new Promise((r) => setTimeout(r, 200)),
        ]);
        if (!socket.destroyed) socket.destroy();
        markClosed(code, reason);
        return closeInfo;
      }

      const clientHandle = {
        url: targetUrl.href,
        frames: allFrames,
        get isClosed() {
          return isClosed;
        },
        get closeInfo() {
          return closeInfo;
        },
        clearBuffer: () => {
          unconsumedFrames.length = 0;
        },
        sendText,
        sendBinary,
        sendJson,
        sendFrame,
        waitForFrame,
        ping,
        subscribeChat,
        unsubscribeChat,
        waitForClose,
        close,
      };

      if (head && head.length > 0) {
        processIncomingChunk(head);
      }

      settleHandshake(resolve, clientHandle);
    });

    req.end();
  });
}
