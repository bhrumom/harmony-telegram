import crypto from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // 12B + 32B raw pubkey = 44B
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex'); // 16B + 32B raw seed = 48B
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex'); // 12B + 32B raw pubkey = 44B
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex'); // 16B + 32B raw scalar = 48B

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  throw new TypeError(`Expected Buffer, Uint8Array, or string; got ${typeof input}`);
}

export function decodeKeyBytes(rawOrEncoded, expectedLength = 32) {
  if (Buffer.isBuffer(rawOrEncoded) || rawOrEncoded instanceof Uint8Array) {
    const buf = Buffer.from(rawOrEncoded);
    if (expectedLength !== null && buf.length !== expectedLength) {
      throw new RangeError(`Expected ${expectedLength}-byte key buffer, got ${buf.length} bytes`);
    }
    return buf;
  }
  if (typeof rawOrEncoded !== 'string') {
    throw new TypeError(`Expected key string or byte buffer, got ${typeof rawOrEncoded}`);
  }
  const trimmed = rawOrEncoded.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && (expectedLength === null || trimmed.length === expectedLength * 2)) {
    return Buffer.from(trimmed, 'hex');
  }
  const normalizedB64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(normalizedB64, 'base64');
  if (expectedLength !== null && buf.length !== expectedLength) {
    throw new RangeError(`Decoded key length ${buf.length} !== expected ${expectedLength} bytes`);
  }
  return buf;
}

export function sha256Buffer(input) {
  return crypto.createHash('sha256').update(toBuffer(input)).digest();
}

export function sha256Hex(input) {
  return sha256Buffer(input).toString('hex');
}

export function hmacSha256Buffer(key, message) {
  return crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(message)).digest();
}

export function hmacSha256Hex(key, message) {
  return hmacSha256Buffer(key, message).toString('hex');
}

export function generateEd25519KeyPairHex() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const privBytes = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return {
    publicKeyHex: pubBytes.toString('hex'),
    privateKeyHex: privBytes.toString('hex'),
    publicKeyBase64: pubBytes.toString('base64'),
    privateKeyBase64: privBytes.toString('base64'),
  };
}

export function ed25519PublicKeyFromPrivateHex(privateKeyHexOrB64) {
  const seed32 = decodeKeyBytes(privateKeyHexOrB64, 32);
  const privObj = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed32]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubObj = crypto.createPublicKey(privObj);
  const pubBytes = pubObj.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    publicKeyHex: pubBytes.toString('hex'),
    publicKeyBase64: pubBytes.toString('base64'),
  };
}

export function signEd25519Buffer(message, privateKeyHexOrB64) {
  const seed32 = decodeKeyBytes(privateKeyHexOrB64, 32);
  const privObj = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed32]),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, toBuffer(message), privObj);
}

export function signEd25519Hex(message, privateKeyHexOrB64) {
  return signEd25519Buffer(message, privateKeyHexOrB64).toString('hex');
}

export function signEd25519Base64(message, privateKeyHexOrB64) {
  return signEd25519Buffer(message, privateKeyHexOrB64).toString('base64');
}

export function verifyEd25519(message, signatureHexOrB64OrBuf, publicKeyHexOrB64OrBuf) {
  try {
    const pub32 = decodeKeyBytes(publicKeyHexOrB64OrBuf, 32);
    const sig64 = decodeKeyBytes(signatureHexOrB64OrBuf, 64);
    const pubObj = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pub32]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, toBuffer(message), pubObj, sig64);
  } catch {
    return false;
  }
}

export const verifyEd25519Hex = verifyEd25519;

export function generateX25519KeyPairHex() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pubBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const privBytes = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return {
    publicKeyHex: pubBytes.toString('hex'),
    privateKeyHex: privBytes.toString('hex'),
    publicKeyBase64: pubBytes.toString('base64'),
    privateKeyBase64: privBytes.toString('base64'),
  };
}

export function x25519DiffieHellmanBuffer(privateKeyHexOrB64, peerPublicKeyHexOrB64) {
  const priv32 = decodeKeyBytes(privateKeyHexOrB64, 32);
  const pub32 = decodeKeyBytes(peerPublicKeyHexOrB64, 32);
  const privObj = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, priv32]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubObj = crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, pub32]),
    format: 'der',
    type: 'spki',
  });
  return crypto.diffieHellman({ privateKey: privObj, publicKey: pubObj });
}

export function x25519DiffieHellmanHex(privateKeyHexOrB64, peerPublicKeyHexOrB64) {
  return x25519DiffieHellmanBuffer(privateKeyHexOrB64, peerPublicKeyHexOrB64).toString('hex');
}

export function x25519DiffieHellmanBase64(privateKeyHexOrB64, peerPublicKeyHexOrB64) {
  return x25519DiffieHellmanBuffer(privateKeyHexOrB64, peerPublicKeyHexOrB64).toString('base64');
}

function isLikelyBotToken(val) {
  if (typeof val !== 'string') return false;
  if (val.includes('=') || val.includes('&') || val.includes('\n')) return false;
  return /^\d+:[A-Za-z0-9_-]+$/.test(val) || val.includes(':');
}

function resolveBotTokenAndParams(arg1, arg2) {
  if (typeof arg1 !== 'string' && typeof arg2 === 'string') {
    return { botToken: arg2, initDataOrParams: arg1 };
  }
  if (typeof arg1 === 'string' && typeof arg2 !== 'string') {
    return { botToken: arg1, initDataOrParams: arg2 };
  }
  if (typeof arg1 === 'string' && typeof arg2 === 'string') {
    if (isLikelyBotToken(arg1) && !isLikelyBotToken(arg2)) {
      return { botToken: arg1, initDataOrParams: arg2 };
    }
    if (isLikelyBotToken(arg2) && !isLikelyBotToken(arg1)) {
      return { botToken: arg2, initDataOrParams: arg1 };
    }
    if (!arg1.includes('=') && arg2.includes('=')) {
      return { botToken: arg1, initDataOrParams: arg2 };
    }
    if (arg1.includes('=') && !arg2.includes('=')) {
      return { botToken: arg2, initDataOrParams: arg1 };
    }
    return { botToken: arg1, initDataOrParams: arg2 };
  }
  throw new TypeError('computeTelegramWebAppInitDataHmac requires a botToken string and initData params/string');
}

function extractWebAppPairs(initDataOrParams) {
  const pairs = [];
  if (typeof initDataOrParams === 'string') {
    if (initDataOrParams.includes('\n') && !initDataOrParams.includes('&')) {
      for (const line of initDataOrParams.split('\n')) {
        if (!line) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx);
        const val = line.slice(eqIdx + 1);
        if (key !== 'hash') pairs.push([key, val]);
      }
    } else {
      const usp = new URLSearchParams(initDataOrParams);
      for (const [key, val] of usp.entries()) {
        if (key !== 'hash') pairs.push([key, val]);
      }
    }
    return pairs;
  }
  if (initDataOrParams instanceof URLSearchParams || initDataOrParams instanceof Map) {
    for (const [key, val] of initDataOrParams.entries()) {
      if (key !== 'hash' && val !== undefined && val !== null) {
        pairs.push([String(key), typeof val === 'object' ? JSON.stringify(val) : String(val)]);
      }
    }
    return pairs;
  }
  if (Array.isArray(initDataOrParams)) {
    for (const entry of initDataOrParams) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [key, val] = entry;
      if (key !== 'hash' && val !== undefined && val !== null) {
        pairs.push([String(key), typeof val === 'object' ? JSON.stringify(val) : String(val)]);
      }
    }
    return pairs;
  }
  if (typeof initDataOrParams === 'object' && initDataOrParams !== null) {
    for (const [key, val] of Object.entries(initDataOrParams)) {
      if (key !== 'hash' && val !== undefined && val !== null) {
        pairs.push([key, typeof val === 'object' ? JSON.stringify(val) : String(val)]);
      }
    }
    return pairs;
  }
  throw new TypeError(`Unsupported initDataOrParams type: ${typeof initDataOrParams}`);
}

export function computeTelegramWebAppInitDataHmac(arg1, arg2) {
  const { botToken, initDataOrParams } = resolveBotTokenAndParams(arg1, arg2);
  const pairs = extractWebAppPairs(initDataOrParams);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken, 'utf8').digest();
  return crypto.createHmac('sha256', secretKey).update(dataCheckString, 'utf8').digest('hex');
}

export function buildTelegramWebAppInitData(botToken, params) {
  const pairs = extractWebAppPairs(params);
  const hash = computeTelegramWebAppInitDataHmac(botToken, pairs);
  const usp = new URLSearchParams();
  for (const [k, v] of pairs) {
    usp.append(k, v);
  }
  usp.append('hash', hash);
  return usp.toString();
}

export function verifyTelegramWebAppInitData(botToken, initDataQueryString) {
  const usp = new URLSearchParams(initDataQueryString);
  const providedHash = usp.get('hash');
  if (!providedHash || providedHash.length !== 64) return false;
  const expectedHash = computeTelegramWebAppInitDataHmac(botToken, initDataQueryString);
  try {
    return crypto.timingSafeEqual(Buffer.from(providedHash, 'hex'), Buffer.from(expectedHash, 'hex'));
  } catch {
    return false;
  }
}

export function signE2eeSignedPrekeyBase64(spkPublicKeyB64OrHex, identitySigningPrivateKeyB64OrHex) {
  const spkPubBytes32 = decodeKeyBytes(spkPublicKeyB64OrHex, 32);
  const msg = Buffer.concat([Buffer.from('gpui-e2ee-spk-v1', 'utf8'), spkPubBytes32]);
  return signEd25519Base64(msg, identitySigningPrivateKeyB64OrHex);
}

export function signTailnetRegistrationHex(
  { ownerUserId, deviceId, machinePublicKeyHex, nodePublicKeyHex, discoPublicKeyHex, timestampMs },
  machinePrivateKeyHex,
) {
  const canonical = `gpui-tailnet-reg-v1|${ownerUserId}|${deviceId}|${machinePublicKeyHex}|${nodePublicKeyHex}|${discoPublicKeyHex}|${timestampMs}`;
  return signEd25519Hex(canonical, machinePrivateKeyHex);
}

export function buildMinimalWasmModuleBytes() {
  // Complete 33-byte WebAssembly v1 module exporting `ping() -> i32 (42)`
  const wasm = Buffer.from([
    0x00, 0x61, 0x73, 0x6d, // "\0asm" magic
    0x01, 0x00, 0x00, 0x00, // version 1
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, // Type section: 1 func () -> i32
    0x03, 0x02, 0x01, 0x00, // Function section: func 0 -> type 0
    0x07, 0x08, 0x01, 0x04, 0x70, 0x69, 0x6e, 0x67, 0x00, 0x00, // Export "ping" -> func 0
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b, // Code section: i32.const 42; end
  ]);
  if (!WebAssembly.validate(wasm)) {
    throw new Error('Internal error: minimal WebAssembly module failed WebAssembly.validate');
  }
  return wasm;
}

const cryptoHelpers = Object.freeze({
  decodeKeyBytes,
  sha256Buffer,
  sha256Hex,
  hmacSha256Buffer,
  hmacSha256Hex,
  generateEd25519KeyPairHex,
  ed25519PublicKeyFromPrivateHex,
  signEd25519Buffer,
  signEd25519Hex,
  signEd25519Base64,
  verifyEd25519,
  verifyEd25519Hex,
  generateX25519KeyPairHex,
  x25519DiffieHellmanBuffer,
  x25519DiffieHellmanHex,
  x25519DiffieHellmanBase64,
  computeTelegramWebAppInitDataHmac,
  buildTelegramWebAppInitData,
  verifyTelegramWebAppInitData,
  signE2eeSignedPrekeyBase64,
  signTailnetRegistrationHex,
  buildMinimalWasmModuleBytes,
});

export default cryptoHelpers;
