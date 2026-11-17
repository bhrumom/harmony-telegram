import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  ArtifactValidationError,
  FORBIDDEN_ACL_PERMISSIONS,
  STAGE_MODEL_FILES,
  TargetNotBuiltError,
  USER_GRANT_PERMISSIONS,
  ZERO_ACL_ALLOWED_PERMISSIONS,
} from './constants.mjs';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const DD_SIG = 0x08074b50;

const HAP_SIG_MAGIC_V3 = '<hap sign block>';
const HAP_SIG_MAGIC_V2 = 'HAP Sig Block 42';
const HAP_SIG_MAGIC_LEGACY = 'hw signed app   ';
const HAP_BLOCK_PKCS7_V1 = 0x20000000;
const HAP_BLOCK_ROTATION = 0x20000001;
const HAP_BLOCK_PROFILE = 0x20000002;
const HAP_BLOCK_PROPERTY = 0x20000003;
const PKCS7_SIGNED_DATA_OID = Buffer.from('06092a864886f70d010702', 'hex'); // 1.2.840.113549.1.7.2

export function parseJson5(input, source = '<json5>') {
  if (typeof input !== 'string') {
    throw new SyntaxError(`${source}: JSON5 input must be a string`);
  }
  const len = input.length;
  let pos = 0;
  let line = 1;
  let col = 1;
  if (pos < len && input.charCodeAt(0) === 0xfeff) {
    pos++;
    col++;
  }

  const fail = (msg) => {
    throw new SyntaxError(`${source}:${line}:${col}: ${msg}`);
  };

  const advance = (n = 1) => {
    for (let i = 0; i < n && pos < len; i++) {
      const ch = input.charCodeAt(pos++);
      if (ch === 0x0d) {
        if (pos < len && input.charCodeAt(pos) === 0x0a) pos++;
        line++;
        col = 1;
      } else if (ch === 0x0a || ch === 0x2028 || ch === 0x2029) {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
  };

  const isWs = (ch) =>
    ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d ||
    ch === 0x0b || ch === 0x0c || ch === 0x00a0 || ch === 0xfeff ||
    ch === 0x2028 || ch === 0x2029 || (ch > 0x7f && /\s/u.test(String.fromCharCode(ch)));

  const skipWsAndComments = () => {
    while (pos < len) {
      const ch = input.charCodeAt(pos);
      if (isWs(ch)) {
        advance();
        continue;
      }
      if (ch === 0x2f && pos + 1 < len) {
        const next = input.charCodeAt(pos + 1);
        if (next === 0x2f) {
          advance(2);
          while (pos < len) {
            const c = input.charCodeAt(pos);
            if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) break;
            advance();
          }
          continue;
        }
        if (next === 0x2a) {
          advance(2);
          let closed = false;
          while (pos < len) {
            if (input.charCodeAt(pos) === 0x2a && pos + 1 < len && input.charCodeAt(pos + 1) === 0x2f) {
              advance(2);
              closed = true;
              break;
            }
            advance();
          }
          if (!closed) fail('Unterminated block comment');
          continue;
        }
      }
      break;
    }
  };

  const readHexDigits = (count) => {
    if (pos + count > len) fail('Unexpected end of hex escape');
    const sub = input.slice(pos, pos + count);
    if (!/^[0-9a-fA-F]+$/.test(sub)) fail(`Invalid hex escape \\${sub}`);
    advance(count);
    return parseInt(sub, 16);
  };

  const parseString = () => {
    const quote = input.charCodeAt(pos);
    advance();
    let out = '';
    while (pos < len) {
      const ch = input.charCodeAt(pos);
      if (ch === quote) {
        advance();
        return out;
      }
      if (ch === 0x0a || ch === 0x0d) fail('Unescaped line terminator in string literal');
      if (ch === 0x5c) {
        advance();
        if (pos >= len) fail('Unterminated escape sequence in string literal');
        const esc = input.charCodeAt(pos);
        if (esc === 0x0a || esc === 0x0d || esc === 0x2028 || esc === 0x2029) {
          advance();
          continue;
        }
        advance();
        switch (esc) {
          case 0x27: out += "'"; break;
          case 0x22: out += '"'; break;
          case 0x5c: out += '\\'; break;
          case 0x2f: out += '/'; break;
          case 0x62: out += '\b'; break;
          case 0x66: out += '\f'; break;
          case 0x6e: out += '\n'; break;
          case 0x72: out += '\r'; break;
          case 0x74: out += '\t'; break;
          case 0x76: out += '\v'; break;
          case 0x30:
            if (pos < len && input.charCodeAt(pos) >= 0x30 && input.charCodeAt(pos) <= 0x39) {
              fail('Octal escape sequences are not allowed in JSON5');
            }
            out += '\0';
            break;
          case 0x78: out += String.fromCharCode(readHexDigits(2)); break;
          case 0x75: out += String.fromCharCode(readHexDigits(4)); break;
          default:
            if (esc >= 0x31 && esc <= 0x39) fail('Numeric escape sequences \\1..\\9 are not allowed in JSON5');
            out += String.fromCharCode(esc);
            break;
        }
        continue;
      }
      const cp = input.codePointAt(pos);
      if (cp > 0xffff) {
        out += String.fromCodePoint(cp);
        pos += 2;
        col += 2;
      } else {
        out += input[pos];
        advance();
      }
    }
    fail('Unterminated string literal');
  };

  const isIdStart = (cp) =>
    cp === 0x24 || cp === 0x5f || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) ||
    (cp > 0x7f && /^[\p{ID_Start}$_]$/u.test(String.fromCodePoint(cp)));
  const isIdContinue = (cp) =>
    isIdStart(cp) || (cp >= 0x30 && cp <= 0x39) || cp === 0x200c || cp === 0x200d ||
    (cp > 0x7f && /^[\p{ID_Continue}$_\u200c\u200d]$/u.test(String.fromCodePoint(cp)));

  const parseIdentifierName = () => {
    let id = '';
    let first = true;
    while (pos < len) {
      let cp;
      if (input.charCodeAt(pos) === 0x5c) {
        if (input[pos + 1] !== 'u') fail('Invalid escape in unquoted property name');
        advance(2);
        cp = readHexDigits(4);
        if (!(first ? isIdStart(cp) : isIdContinue(cp))) fail('Invalid escaped identifier character');
        id += String.fromCodePoint(cp);
      } else {
        cp = input.codePointAt(pos);
        if (!(first ? isIdStart(cp) : isIdContinue(cp))) break;
        id += String.fromCodePoint(cp);
        if (cp > 0xffff) {
          pos += 2;
          col += 2;
        } else {
          advance();
        }
      }
      first = false;
    }
    if (!id) fail('Expected object property name');
    return id;
  };

  const parseObject = () => {
    advance(); // '{'
    const obj = {};
    skipWsAndComments();
    if (pos < len && input[pos] === '}') {
      advance();
      return obj;
    }
    while (pos < len) {
      skipWsAndComments();
      if (pos < len && input[pos] === '}') {
        advance();
        return obj;
      }
      const ch = input[pos];
      const key = ch === '"' || ch === "'" ? parseString() : parseIdentifierName();
      skipWsAndComments();
      if (input[pos] !== ':') fail("Expected ':' after object property name");
      advance();
      skipWsAndComments();
      const val = parseValue();
      if (key === '__proto__') {
        Object.defineProperty(obj, '__proto__', {
          value: val,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        obj[key] = val;
      }
      skipWsAndComments();
      if (input[pos] === ',') {
        advance();
        skipWsAndComments();
        if (input[pos] === ',') fail('Unexpected consecutive comma in object');
        continue;
      }
      if (input[pos] === '}') {
        advance();
        return obj;
      }
      fail("Expected ',' or '}' in object");
    }
    fail('Unterminated object');
  };

  const parseArray = () => {
    advance(); // '['
    const arr = [];
    skipWsAndComments();
    if (pos < len && input[pos] === ']') {
      advance();
      return arr;
    }
    while (pos < len) {
      skipWsAndComments();
      if (pos < len && input[pos] === ']') {
        advance();
        return arr;
      }
      arr.push(parseValue());
      skipWsAndComments();
      if (input[pos] === ',') {
        advance();
        skipWsAndComments();
        if (input[pos] === ',') fail('Unexpected sparse comma in array');
        continue;
      }
      if (input[pos] === ']') {
        advance();
        return arr;
      }
      fail("Expected ',' or ']' in array");
    }
    fail('Unterminated array');
  };

  const parseNumber = () => {
    const start = pos;
    let sign = 1;
    if (input[pos] === '+' || input[pos] === '-') {
      if (input[pos] === '-') sign = -1;
      advance();
    }
    if (input.startsWith('Infinity', pos)) {
      advance(8);
      return sign * Infinity;
    }
    if (input.startsWith('NaN', pos)) {
      advance(3);
      return NaN;
    }
    if (input[pos] === '0' && (input[pos + 1] === 'x' || input[pos + 1] === 'X')) {
      advance(2);
      const hexStart = pos;
      while (pos < len && /[0-9a-fA-F]/.test(input[pos])) advance();
      if (pos === hexStart) fail('Invalid hexadecimal literal');
      return sign * parseInt(input.slice(hexStart, pos), 16);
    }
    const numStart = pos;
    if (input[pos] === '0') {
      advance();
      if (pos < len && input[pos] >= '0' && input[pos] <= '9') {
        fail('Leading zeros are not allowed in JSON5 decimal numbers');
      }
    } else if (input[pos] >= '1' && input[pos] <= '9') {
      while (pos < len && input[pos] >= '0' && input[pos] <= '9') advance();
    } else if (input[pos] !== '.') {
      fail(`Unexpected token '${input[pos] || 'EOF'}'`);
    }
    if (input[pos] === '.') {
      advance();
      const fracStart = pos;
      while (pos < len && input[pos] >= '0' && input[pos] <= '9') advance();
      if (numStart + 1 === pos && fracStart === pos) fail('Lone decimal point is not a valid number');
    }
    if (input[pos] === 'e' || input[pos] === 'E') {
      advance();
      if (input[pos] === '+' || input[pos] === '-') advance();
      const expStart = pos;
      while (pos < len && input[pos] >= '0' && input[pos] <= '9') advance();
      if (pos === expStart) fail('Invalid exponent in number');
    }
    const raw = input.slice(start, pos);
    const n = Number(raw);
    if (Number.isNaN(n)) fail(`Invalid number '${raw}'`);
    return n;
  };

  function parseValue() {
    skipWsAndComments();
    if (pos >= len) fail('Unexpected end of JSON5 input');
    const ch = input[pos];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"' || ch === "'") return parseString();
    if (input.startsWith('true', pos) && !isIdContinue(input.codePointAt(pos + 4) || 0)) {
      advance(4);
      return true;
    }
    if (input.startsWith('false', pos) && !isIdContinue(input.codePointAt(pos + 5) || 0)) {
      advance(5);
      return false;
    }
    if (input.startsWith('null', pos) && !isIdContinue(input.codePointAt(pos + 4) || 0)) {
      advance(4);
      return null;
    }
    if (
      ch === '+' || ch === '-' || ch === '.' || (ch >= '0' && ch <= '9') ||
      input.startsWith('Infinity', pos) || input.startsWith('NaN', pos)
    ) {
      return parseNumber();
    }
    fail(`Unexpected token '${ch}'`);
  }

  const result = parseValue();
  skipWsAndComments();
  if (pos !== len) fail(`Unexpected trailing token '${input[pos]}'`);
  return result;
}

function readCString(buf, startOffset, limitEnd = buf.length) {
  if (startOffset < 0 || startOffset >= limitEnd) return '';
  let end = startOffset;
  const max = Math.min(limitEnd, buf.length);
  while (end < max && buf[end] !== 0) end++;
  return buf.subarray(startOffset, end).toString('utf8');
}

export function parseElfBuffer(rawBuf, sourceLabel = '<elf>') {
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  if (buf.length < 64) {
    throw new ArtifactValidationError(`${sourceLabel}: Truncated ELF (< 64 bytes)`);
  }
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new ArtifactValidationError(`${sourceLabel}: Invalid ELF magic (expected 0x7f 'ELF')`);
  }
  const eiClass = buf[4];
  const eiData = buf[5];
  if (eiClass !== 2) {
    throw new ArtifactValidationError(`${sourceLabel}: Expected ELFCLASS64 (2), got ${eiClass}`);
  }
  if (eiData !== 1) {
    throw new ArtifactValidationError(`${sourceLabel}: Expected ELFDATA2LSB little-endian (1), got ${eiData}`);
  }

  const eType = buf.readUInt16LE(16);
  const eMachine = buf.readUInt16LE(18);
  const ePhoff = buf.readBigUInt64LE(32);
  const eShoff = buf.readBigUInt64LE(40);
  const ePhentsize = buf.readUInt16LE(54);
  let ePhnum = buf.readUInt16LE(56);
  const eShentsize = buf.readUInt16LE(58);
  let eShnum = buf.readUInt16LE(60);
  let eShstrndx = buf.readUInt16LE(62);

  // Optional Section Headers (may be stripped on release builds: e_shoff = 0, e_shnum = 0)
  const sections = [];
  let hasSectionHeaders = false;
  if (eShoff > 0n && eShentsize >= 64) {
    const shoffNum = Number(eShoff);
    if (eShnum === 0 && shoffNum + 64 <= buf.length) {
      eShnum = Number(buf.readBigUInt64LE(shoffNum + 32));
    }
    if (eShstrndx === 0xffff && shoffNum + 64 <= buf.length) {
      eShstrndx = buf.readUInt32LE(shoffNum + 40);
    }
    if (ePhnum === 0xffff && shoffNum + 64 <= buf.length) {
      ePhnum = buf.readUInt32LE(shoffNum + 44);
    }
    if (eShnum > 0 && shoffNum + eShnum * eShentsize <= buf.length) {
      hasSectionHeaders = true;
      for (let i = 0; i < eShnum; i++) {
        const off = shoffNum + i * eShentsize;
        sections.push({
          index: i,
          shNameOffset: buf.readUInt32LE(off),
          shType: buf.readUInt32LE(off + 4),
          shFlags: buf.readBigUInt64LE(off + 8),
          shAddr: buf.readBigUInt64LE(off + 16),
          shOffset: buf.readBigUInt64LE(off + 24),
          shSize: buf.readBigUInt64LE(off + 32),
          shLink: buf.readUInt32LE(off + 40),
          shInfo: buf.readUInt32LE(off + 44),
          shAddralign: buf.readBigUInt64LE(off + 48),
          shEntsize: buf.readBigUInt64LE(off + 56),
          name: '',
        });
      }
      if (eShstrndx < sections.length) {
        const shstr = sections[eShstrndx];
        const strStart = Number(shstr.shOffset);
        const strEnd = Math.min(buf.length, strStart + Number(shstr.shSize));
        for (const sec of sections) {
          sec.name = readCString(buf, strStart + sec.shNameOffset, strEnd);
        }
      }
    }
  }

  // Program Headers (authoritative runtime loader view)
  const phdrs = [];
  if (ePhnum > 0) {
    const phoffNum = Number(ePhoff);
    if (ePhentsize < 56 || phoffNum + ePhnum * ePhentsize > buf.length) {
      throw new ArtifactValidationError(`${sourceLabel}: Truncated ELF64 program header table`);
    }
    for (let i = 0; i < ePhnum; i++) {
      const off = phoffNum + i * ePhentsize;
      phdrs.push({
        pType: buf.readUInt32LE(off),
        pFlags: buf.readUInt32LE(off + 4),
        pOffset: buf.readBigUInt64LE(off + 8),
        pVaddr: buf.readBigUInt64LE(off + 16),
        pPaddr: buf.readBigUInt64LE(off + 24),
        pFilesz: buf.readBigUInt64LE(off + 32),
        pMemsz: buf.readBigUInt64LE(off + 40),
        pAlign: buf.readBigUInt64LE(off + 48),
      });
    }
  }

  const ptLoadSegments = phdrs.filter((p) => p.pType === 1 && p.pFilesz > 0n);

  function vaddrToFileOffset(vaddrBig) {
    if (vaddrBig === null || vaddrBig === undefined) return -1;
    for (const seg of ptLoadSegments) {
      if (vaddrBig >= seg.pVaddr && vaddrBig < seg.pVaddr + seg.pFilesz) {
        const fileOff = Number(vaddrBig - seg.pVaddr + seg.pOffset);
        return fileOff >= 0 && fileOff < buf.length ? fileOff : -1;
      }
    }
    return -1;
  }

  // Parse Elf64_Dyn entries from PT_DYNAMIC or SHT_DYNAMIC
  const shtDynamic = sections.find((s) => s.shType === 6);
  const ptDynamic = phdrs.find((p) => p.pType === 2);
  let dynOffset = -1;
  let dynSize = 0;
  if (ptDynamic && ptDynamic.pFilesz >= 16n) {
    dynOffset = Number(ptDynamic.pOffset);
    dynSize = Number(ptDynamic.pFilesz);
  } else if (shtDynamic && shtDynamic.shSize >= 16n) {
    dynOffset = Number(shtDynamic.shOffset);
    dynSize = Number(shtDynamic.shSize);
  }

  const neededOffsets = [];
  let dtHashVaddr = null;
  let dtGnuHashVaddr = null;
  let dtStrtabVaddr = null;
  let dtStrsz = 0;
  let dtSymtabVaddr = null;
  let dtSyment = 24;
  let sonameOffset = null;
  let rpathOffset = null;
  let runpathOffset = null;

  if (dynOffset >= 0 && dynOffset + 16 <= buf.length) {
    const dynEnd = Math.min(buf.length, dynOffset + dynSize);
    for (let p = dynOffset; p + 16 <= dynEnd; p += 16) {
      const dTag = buf.readBigUInt64LE(p);
      const dVal = buf.readBigUInt64LE(p + 8);
      if (dTag === 0n) break; // DT_NULL
      if (dTag === 1n) neededOffsets.push(Number(dVal)); // DT_NEEDED
      else if (dTag === 4n) dtHashVaddr = dVal; // DT_HASH
      else if (dTag === 5n) dtStrtabVaddr = dVal; // DT_STRTAB
      else if (dTag === 6n) dtSymtabVaddr = dVal; // DT_SYMTAB
      else if (dTag === 10n) dtStrsz = Number(dVal); // DT_STRSZ
      else if (dTag === 11n && dVal > 0n) dtSyment = Number(dVal); // DT_SYMENT
      else if (dTag === 14n) sonameOffset = Number(dVal); // DT_SONAME
      else if (dTag === 15n) rpathOffset = Number(dVal); // DT_RPATH
      else if (dTag === 29n) runpathOffset = Number(dVal); // DT_RUNPATH
      else if (dTag === 0x6ffffef5n) dtGnuHashVaddr = dVal; // DT_GNU_HASH
    }
  }

  // Locate .dynstr
  let dynstrStart = -1;
  let dynstrEnd = buf.length;
  if (dtStrtabVaddr !== null) {
    dynstrStart = vaddrToFileOffset(dtStrtabVaddr);
    if (dynstrStart >= 0 && dtStrsz > 0) {
      dynstrEnd = Math.min(buf.length, dynstrStart + dtStrsz);
    }
  }
  if (dynstrStart < 0 && shtDynamic && shtDynamic.shLink < sections.length) {
    const strSec = sections[shtDynamic.shLink];
    dynstrStart = Number(strSec.shOffset);
    dynstrEnd = Math.min(buf.length, dynstrStart + Number(strSec.shSize));
  }

  const needed = dynstrStart >= 0
    ? neededOffsets.map((off) => readCString(buf, dynstrStart + off, dynstrEnd)).filter(Boolean)
    : [];
  const soname = dynstrStart >= 0 && sonameOffset !== null
    ? readCString(buf, dynstrStart + sonameOffset, dynstrEnd)
    : null;
  const rpath = dynstrStart >= 0 && rpathOffset !== null
    ? readCString(buf, dynstrStart + rpathOffset, dynstrEnd)
    : null;
  const runpath = dynstrStart >= 0 && runpathOffset !== null
    ? readCString(buf, dynstrStart + runpathOffset, dynstrEnd)
    : null;

  function parseSymbolTable(symOff, symCount, entrySize, strStart, strEnd) {
    const out = [];
    if (symOff < 0 || symCount <= 1 || strStart < 0 || entrySize < 24) return out;
    const maxCount = Math.min(symCount, Math.floor((buf.length - symOff) / entrySize));
    // Skip index 0 (STN_UNDEF)
    for (let idx = 1; idx < maxCount; idx++) {
      const p = symOff + idx * entrySize;
      const stName = buf.readUInt32LE(p);
      const stInfo = buf[p + 4];
      const stOther = buf[p + 5];
      const stShndx = buf.readUInt16LE(p + 6);
      const stValue = buf.readBigUInt64LE(p + 8);
      const stSize = buf.readBigUInt64LE(p + 16);
      const bind = stInfo >> 4;
      const symType = stInfo & 0x0f;
      const visibility = stOther & 0x03;
      const name = stName > 0 ? readCString(buf, strStart + stName, strEnd) : '';
      out.push({
        index: idx,
        name,
        bind,
        symType,
        visibility,
        shndx: stShndx,
        isUndefined: stShndx === 0,
        value: stValue,
        size: stSize,
      });
    }
    return out;
  }

  function inferStrippedDynsymCount() {
    let count = 0;
    if (dtHashVaddr !== null) {
      const off = vaddrToFileOffset(dtHashVaddr);
      if (off >= 0 && off + 8 <= buf.length) {
        const nchain = buf.readUInt32LE(off + 4);
        if (nchain > count) count = nchain;
      }
    }
    if (dtGnuHashVaddr !== null) {
      const off = vaddrToFileOffset(dtGnuHashVaddr);
      if (off >= 0 && off + 16 <= buf.length) {
        const nbuckets = buf.readUInt32LE(off);
        const symoffset = buf.readUInt32LE(off + 4);
        const bloomSize = buf.readUInt32LE(off + 8);
        const bucketsOff = off + 16 + bloomSize * 8;
        const chainsOff = bucketsOff + nbuckets * 4;
        if (bucketsOff >= 0 && chainsOff <= buf.length) {
          let maxSym = 0;
          for (let b = 0; b < nbuckets; b++) {
            const symIdx = buf.readUInt32LE(bucketsOff + b * 4);
            if (symIdx > maxSym) maxSym = symIdx;
          }
          let gnuCount;
          if (maxSym < symoffset) {
            gnuCount = symoffset;
          } else {
            let idx = maxSym;
            while (chainsOff + (idx - symoffset) * 4 + 4 <= buf.length) {
              const chainWord = buf.readUInt32LE(chainsOff + (idx - symoffset) * 4);
              if ((chainWord & 1) !== 0) break;
              idx++;
            }
            gnuCount = idx + 1;
          }
          if (gnuCount > count) count = gnuCount;
        }
      }
    }
    return count;
  }

  let ptDynamicSymbols = [];
  if (dtSymtabVaddr !== null && dynstrStart >= 0) {
    const symOff = vaddrToFileOffset(dtSymtabVaddr);
    const count = inferStrippedDynsymCount();
    if (symOff >= 0 && count > 0) {
      ptDynamicSymbols = parseSymbolTable(symOff, count, dtSyment, dynstrStart, dynstrEnd);
    }
  }

  let shtDynamicSymbols = [];
  const shtDynsym = sections.find((s) => s.shType === 11);
  if (shtDynsym && shtDynsym.shSize >= 24n) {
    const entSize = shtDynsym.shEntsize >= 24n ? Number(shtDynsym.shEntsize) : 24;
    const count = Math.floor(Number(shtDynsym.shSize) / entSize);
    let strStart = dynstrStart;
    let strEnd = dynstrEnd;
    if (shtDynsym.shLink < sections.length) {
      const linkSec = sections[shtDynsym.shLink];
      strStart = Number(linkSec.shOffset);
      strEnd = Math.min(buf.length, strStart + Number(linkSec.shSize));
    }
    shtDynamicSymbols = parseSymbolTable(Number(shtDynsym.shOffset), count, entSize, strStart, strEnd);
  }

  // Union PT_DYNAMIC (authoritative ld-musl runtime view first) and SHT_DYNSYM
  const dynamicSymbols = [];
  const seenDynSymKeys = new Set();
  for (const sym of [...ptDynamicSymbols, ...shtDynamicSymbols]) {
    const dedupKey = `${sym.name}\0${sym.bind}\0${sym.symType}\0${sym.visibility}\0${sym.shndx}\0${sym.value}`;
    if (!seenDynSymKeys.has(dedupKey)) {
      seenDynSymKeys.add(dedupKey);
      dynamicSymbols.push(sym);
    }
  }

  let dynsymSource = 'none';
  if (ptDynamicSymbols.length > 0 && shtDynamicSymbols.length > 0) {
    dynsymSource = 'PT_DYNAMIC+SHT_DYNSYM';
  } else if (ptDynamicSymbols.length > 0) {
    dynsymSource = 'PT_DYNAMIC_HASH';
  } else if (shtDynamicSymbols.length > 0) {
    dynsymSource = 'SHT_DYNSYM';
  }

  let symtabSymbols = [];
  const shtSymtab = sections.find((s) => s.shType === 2);
  if (shtSymtab && shtSymtab.shSize >= 24n && shtSymtab.shLink < sections.length) {
    const entSize = shtSymtab.shEntsize >= 24n ? Number(shtSymtab.shEntsize) : 24;
    const count = Math.floor(Number(shtSymtab.shSize) / entSize);
    const linkSec = sections[shtSymtab.shLink];
    const strStart = Number(linkSec.shOffset);
    const strEnd = Math.min(buf.length, strStart + Number(linkSec.shSize));
    symtabSymbols = parseSymbolTable(Number(shtSymtab.shOffset), count, entSize, strStart, strEnd);
  }

  const isGlobalLike = (sym) => sym.name.length > 0 && (sym.bind === 1 || sym.bind === 2 || sym.bind === 10);

  const undefinedSymbols = Array.from(
    new Set(dynamicSymbols.filter((s) => isGlobalLike(s) && s.isUndefined).map((s) => s.name)),
  );
  const definedSymbols = Array.from(
    new Set(dynamicSymbols.filter((s) => isGlobalLike(s) && !s.isUndefined).map((s) => s.name)),
  );
  const exportedSymbols = Array.from(
    new Set(
      dynamicSymbols
        .filter((s) => isGlobalLike(s) && !s.isUndefined && (s.visibility === 0 || s.visibility === 3))
        .map((s) => s.name),
    ),
  );

  const machineMap = {
    183: { machineName: 'EM_AARCH64', abi: 'arm64-v8a' },
    62: { machineName: 'EM_X86_64', abi: 'x86_64' },
  };
  const typeMap = {
    1: 'ET_REL',
    2: 'ET_EXEC',
    3: 'ET_DYN',
    4: 'ET_CORE',
  };

  return {
    path: sourceLabel,
    byteLength: buf.length,
    isElf64: true,
    isLittleEndian: true,
    eiClass,
    eiData,
    eType,
    typeName: typeMap[eType] || `ET_${eType}`,
    isSharedObject: eType === 3,
    eMachine,
    machine: eMachine,
    machineName: machineMap[eMachine]?.machineName || `EM_${eMachine}`,
    abi: machineMap[eMachine]?.abi || 'unknown',
    hasSectionHeaders,
    sectionNames: sections.map((s) => s.name).filter(Boolean),
    soname,
    rpath,
    runpath,
    needed,
    dtNeeded: needed,
    dynamicSymbols,
    symtabSymbols,
    undefinedSymbols,
    definedSymbols,
    exportedSymbols,
    dynsymSource,
  };
}

export function parseHapSignatureBlock(rawBuf, cdOffset, minStartOffset = 0) {
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  if (minStartOffset < 0 || cdOffset < 32 || cdOffset > buf.length || cdOffset - minStartOffset < 32) {
    return {
      present: false,
      valid: false,
      reason: 'No signing block region between ZIP entries and Central Directory',
    };
  }
  const trailerPos = cdOffset - 32;
  const blockCount = buf.readUInt32LE(trailerPos);
  const sigBlockSizeBig = buf.readBigUInt64LE(trailerPos + 4);
  const magic = buf.subarray(trailerPos + 12, trailerPos + 28).toString('ascii');
  const version = buf.readUInt32LE(trailerPos + 28);

  const magicValid =
    (magic === HAP_SIG_MAGIC_V3 && version >= 3) ||
    (magic === HAP_SIG_MAGIC_V2 && version === 2) ||
    (magic === HAP_SIG_MAGIC_LEGACY && version >= 1);

  if (!magicValid) {
    return {
      present: false,
      valid: false,
      magic,
      version,
      reason: 'No OpenHarmony HAP signing block magic before Central Directory',
    };
  }

  const maxAllowedSizeBig = BigInt(cdOffset - minStartOffset);
  if (sigBlockSizeBig < 32n || sigBlockSizeBig > maxAllowedSizeBig || sigBlockSizeBig > 0x7ffffff7n) {
    return {
      present: true,
      valid: false,
      magic,
      version,
      reason: `Invalid HAP signing block size ${sigBlockSizeBig} (available out-of-entry region: ${maxAllowedSizeBig})`,
    };
  }

  const sigBlockSize = Number(sigBlockSizeBig);
  const sigBlockStart = cdOffset - sigBlockSize;
  if (sigBlockStart < minStartOffset) {
    return {
      present: true,
      valid: false,
      magic,
      version,
      sigBlockStart,
      reason: `HAP signing block start (${sigBlockStart}) overlaps ZIP entry payload end (${minStartOffset})`,
    };
  }
  const descriptorsBytes = blockCount * 12;
  if (blockCount < 1 || blockCount > 32 || descriptorsBytes + 32 > sigBlockSize) {
    return {
      present: true,
      valid: false,
      magic,
      version,
      blockCount,
      reason: `Invalid HAP sub-block count: ${blockCount}`,
    };
  }

  const subBlocks = [];
  const payloadEndRel = sigBlockSize - 32;
  for (let i = 0; i < blockCount; i++) {
    const dPos = sigBlockStart + i * 12;
    const type = buf.readUInt32LE(dPos);
    const length = buf.readUInt32LE(dPos + 4);
    const offset = buf.readUInt32LE(dPos + 8);
    if (offset < descriptorsBytes || offset + length > payloadEndRel) {
      return {
        present: true,
        valid: false,
        magic,
        version,
        blockCount,
        reason: `Sub-block ${i} (type=0x${type.toString(16)}) out of bounds: offset=${offset}, length=${length}, max=${payloadEndRel}`,
      };
    }
    subBlocks.push({
      type,
      length,
      offset,
      absOffset: sigBlockStart + offset,
    });
  }

  const pkcs7Sub = subBlocks.find((b) => b.type === HAP_BLOCK_PKCS7_V1);
  if (!pkcs7Sub || pkcs7Sub.length < 32) {
    return {
      present: true,
      valid: false,
      magic,
      version,
      blockCount,
      subBlocks,
      reason: 'Missing or truncated 0x20000000 PKCS#7 signature sub-block',
    };
  }

  const pkcs7Bytes = buf.subarray(pkcs7Sub.absOffset, pkcs7Sub.absOffset + pkcs7Sub.length);
  const isDerPkcs7 = pkcs7Bytes[0] === 0x30 && pkcs7Bytes.subarray(0, 64).includes(PKCS7_SIGNED_DATA_OID);
  if (!isDerPkcs7) {
    return {
      present: true,
      valid: false,
      magic,
      version,
      blockCount,
      subBlocks,
      reason: 'Sub-block 0x20000000 is not valid ASN.1 DER PKCS#7 SignedData',
    };
  }

  const profileSub = subBlocks.find((b) => b.type === HAP_BLOCK_PROFILE) || null;
  const propertySub = subBlocks.find((b) => b.type === HAP_BLOCK_PROPERTY) || null;
  const rotationSub = subBlocks.find((b) => b.type === HAP_BLOCK_ROTATION) || null;

  return {
    present: true,
    valid: true,
    sigBlockStart,
    sigBlockSize,
    blockCount,
    magic,
    version,
    hasPkcs7Block: true,
    hasProfileBlock: Boolean(profileSub && profileSub.length > 0),
    hasPropertyCodeSignBlock: Boolean(propertySub && propertySub.length >= 12),
    hasRotationBlock: Boolean(rotationSub && rotationSub.length > 0),
    subBlocks,
  };
}

export function inspectZipBuffer(rawBuf, sourceLabel = '<zip>') {
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  if (buf.length < 22) {
    throw new ArtifactValidationError(`${sourceLabel}: Invalid or truncated ZIP (< 22 bytes)`);
  }

  let eocdOffset = -1;
  const maxComment = Math.min(buf.length - 22, 0xffff);
  for (let c = 0; c <= maxComment; c++) {
    const pos = buf.length - 22 - c;
    if (buf.readUInt32LE(pos) === EOCD_SIG && buf.readUInt16LE(pos + 20) === c) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new ArtifactValidationError(`${sourceLabel}: ZIP End of Central Directory (0x06054b50) not found`);
  }
  if (eocdOffset >= 20 && buf.readUInt32LE(eocdOffset - 20) === ZIP64_LOCATOR_SIG) {
    throw new ArtifactValidationError(`${sourceLabel}: ZIP64 format is not supported by OpenHarmony HAP/APP verifier`);
  }

  const diskNum = buf.readUInt16LE(eocdOffset + 4);
  const cdDisk = buf.readUInt16LE(eocdOffset + 6);
  const cdCountDisk = buf.readUInt16LE(eocdOffset + 8);
  const cdCount = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const zipCommentLen = buf.readUInt16LE(eocdOffset + 20);
  const zipComment = zipCommentLen > 0
    ? buf.subarray(eocdOffset + 22, eocdOffset + 22 + zipCommentLen).toString('utf8')
    : '';

  if (diskNum !== 0 || cdDisk !== 0 || cdCountDisk !== cdCount) {
    throw new ArtifactValidationError(`${sourceLabel}: Multi-disk ZIP archives are invalid`);
  }
  if (cdCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ArtifactValidationError(`${sourceLabel}: ZIP64 sentinel fields are not supported`);
  }
  if (cdOffset + cdSize !== eocdOffset) {
    throw new ArtifactValidationError(
      `${sourceLabel}: Central Directory end (${cdOffset + cdSize}) !== EOCD offset (${eocdOffset})`,
    );
  }

  const entries = [];
  const entryMap = new Map();
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (pos + 46 > eocdOffset || buf.readUInt32LE(pos) !== CDFH_SIG) {
      throw new ArtifactValidationError(`${sourceLabel}: Invalid Central Directory header at offset ${pos} (entry ${i})`);
    }
    const flags = buf.readUInt16LE(pos + 8);
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const crc32 = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lfhOffset = buf.readUInt32LE(pos + 42);
    const varEnd = pos + 46 + nameLen + extraLen + commentLen;
    if (varEnd > eocdOffset) {
      throw new ArtifactValidationError(`${sourceLabel}: Truncated Central Directory variable fields for entry ${i}`);
    }
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    if (name.includes('\0')) {
      throw new ArtifactValidationError(`${sourceLabel}: ZIP entry name contains NUL byte`);
    }
    if ((flags & 0x0001) !== 0) {
      throw new ArtifactValidationError(`${sourceLabel}: Encrypted ZIP entry '${name}' is unsupported`);
    }
    if (lfhOffset + 30 > cdOffset) {
      throw new ArtifactValidationError(
        `${sourceLabel}: Entry '${name}' local header (${lfhOffset}) overlaps Central Directory (${cdOffset})`,
      );
    }
    if (buf.readUInt32LE(lfhOffset) !== LFH_SIG) {
      throw new ArtifactValidationError(
        `${sourceLabel}: Invalid Local File Header signature for '${name}' at ${lfhOffset}`,
      );
    }
    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > cdOffset || dataEnd > cdOffset) {
      throw new ArtifactValidationError(
        `${sourceLabel}: Entry '${name}' payload [${dataStart}..${dataEnd}) overlaps Central Directory (${cdOffset})`,
      );
    }
    let entryEnd = dataEnd;
    if ((flags & 0x0008) !== 0) {
      if (dataEnd + 16 <= cdOffset && buf.readUInt32LE(dataEnd) === DD_SIG) {
        entryEnd = dataEnd + 16;
      } else if (
        dataEnd + 12 <= cdOffset &&
        buf.readUInt32LE(dataEnd) === crc32 &&
        buf.readUInt32LE(dataEnd + 4) === compressedSize &&
        buf.readUInt32LE(dataEnd + 8) === uncompressedSize
      ) {
        entryEnd = dataEnd + 12;
      }
    }
    const meta = {
      name,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      lfhOffset,
      dataStart,
      dataEnd,
      entryEnd,
    };
    entries.push(meta);
    entryMap.set(name, meta);
    pos = varEnd;
  }
  if (pos !== eocdOffset) {
    throw new ArtifactValidationError(
      `${sourceLabel}: Central Directory size mismatch (parsed up to ${pos}, expected ${eocdOffset})`,
    );
  }

  const maxEntryDataEnd = entries.reduce((maxEnd, e) => Math.max(maxEnd, e.entryEnd), 0);
  const hapSignature =
    cdOffset - maxEntryDataEnd < 32
      ? {
          present: false,
          valid: false,
          reason: 'No signing block region between ZIP entries and Central Directory',
        }
      : parseHapSignatureBlock(buf, cdOffset, maxEntryDataEnd);

  if (hapSignature.present && (!hapSignature.valid || hapSignature.sigBlockStart < maxEntryDataEnd)) {
    throw new ArtifactValidationError(
      `${sourceLabel}: Malformed OpenHarmony HAP signature block: ${hapSignature.reason || 'overlaps ZIP entry payload'}`,
    );
  }
  const dataRegionEnd = hapSignature.valid ? hapSignature.sigBlockStart : cdOffset;

  function extractEntryBuffer(entryName) {
    const meta = entryMap.get(entryName);
    if (!meta) {
      throw new ArtifactValidationError(`${sourceLabel}: Missing required ZIP entry '${entryName}'`);
    }
    const { lfhOffset, compressionMethod, compressedSize, uncompressedSize, crc32 } = meta;
    if (buf.readUInt32LE(lfhOffset) !== LFH_SIG) {
      throw new ArtifactValidationError(
        `${sourceLabel}: Invalid Local File Header signature for '${entryName}' at ${lfhOffset}`,
      );
    }
    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > dataRegionEnd) {
      throw new ArtifactValidationError(
        `${sourceLabel}: Entry '${entryName}' payload [${dataStart}..${dataEnd}) exceeds data region (${dataRegionEnd})`,
      );
    }
    const rawSlice = buf.subarray(dataStart, dataEnd);
    let out;
    if (compressionMethod === 0) {
      out = Buffer.from(rawSlice);
    } else if (compressionMethod === 8) {
      try {
        out = zlib.inflateRawSync(rawSlice);
      } catch (err) {
        throw new ArtifactValidationError(
          `${sourceLabel}: Deflate decompression failed on '${entryName}': ${err.message}`,
        );
      }
    } else {
      throw new ArtifactValidationError(
        `${sourceLabel}: Unsupported ZIP compression method ${compressionMethod} on '${entryName}'`,
      );
    }
    if (out.length !== uncompressedSize) {
      throw new ArtifactValidationError(
        `${sourceLabel}: Uncompressed size mismatch on '${entryName}': got ${out.length}, expected ${uncompressedSize}`,
      );
    }
    const actualCrc = zlib.crc32(out) >>> 0;
    if (actualCrc !== crc32) {
      throw new ArtifactValidationError(
        `${sourceLabel}: CRC-32 mismatch on '${entryName}': got 0x${actualCrc.toString(16)}, expected 0x${crc32.toString(16)}`,
      );
    }
    return out;
  }

  function hasEmbeddedSignedHap() {
    const hapEntries = entries.filter((e) => e.name.endsWith('.hap'));
    if (hapEntries.length === 0) return false;
    return hapEntries.every((e) => {
      const innerBuf = extractEntryBuffer(e.name);
      const innerZip = inspectZipBuffer(innerBuf, `${sourceLabel}!${e.name}`);
      return innerZip.hasHapSignatureBlock;
    });
  }

  return {
    path: sourceLabel,
    byteLength: buf.length,
    eocdOffset,
    cdOffset,
    cdSize,
    maxEntryDataEnd,
    zipComment,
    entries,
    entryNames: entries.map((e) => e.name),
    hasEntry: (name) => entryMap.has(name),
    getEntryMeta: (name) => entryMap.get(name) || null,
    extractEntryBuffer,
    extractEntryText: (name) => extractEntryBuffer(name).toString('utf8'),
    extractEntryJson: (name) => JSON.parse(extractEntryBuffer(name).toString('utf8')),
    hasHapSignatureBlock: hapSignature.valid,
    hasEmbeddedSignedHap,
    hapSignature,
  };
}

export const parseZipBuffer = inspectZipBuffer;

export function stripSourceComments(source) {
  if (typeof source !== 'string') return '';
  const len = source.length;
  let i = 0;
  let out = '';

  function scanQuotedString(quote) {
    out += source[i++];
    while (i < len) {
      const ch = source[i];
      out += ch;
      i++;
      if (ch === '\\' && i < len) {
        out += source[i++];
        continue;
      }
      if (ch === quote || ch === '\n' || ch === '\r') {
        break;
      }
    }
  }

  function scanTemplateExpression() {
    let depth = 1;
    while (i < len && depth > 0) {
      const ch = source[i];
      const next = i + 1 < len ? source[i + 1] : '';
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < len && source[i] !== '\n' && source[i] !== '\r') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        let hasNewline = false;
        while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n' || source[i] === '\r') hasNewline = true;
          i++;
        }
        if (i < len) i += 2;
        out += hasNewline ? '\n' : ' ';
        continue;
      }
      if (ch === "'" || ch === '"') {
        scanQuotedString(ch);
        continue;
      }
      if (ch === '`') {
        scanTemplateLiteral();
        continue;
      }
      if (ch === '{') {
        depth++;
        out += ch;
        i++;
        continue;
      }
      if (ch === '}') {
        depth--;
        out += ch;
        i++;
        continue;
      }
      out += ch;
      i++;
    }
  }

  function scanTemplateLiteral() {
    out += source[i++];
    while (i < len) {
      const ch = source[i];
      if (ch === '\\' && i + 1 < len) {
        out += ch + source[i + 1];
        i += 2;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        out += '${';
        i += 2;
        scanTemplateExpression();
        continue;
      }
      out += ch;
      i++;
      if (ch === '`') {
        break;
      }
    }
  }

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : '';
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      let hasNewline = false;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n' || source[i] === '\r') hasNewline = true;
        i++;
      }
      if (i < len) i += 2;
      out += hasNewline ? '\n' : ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      scanQuotedString(ch);
      continue;
    }
    if (ch === '`') {
      scanTemplateLiteral();
      continue;
    }
    out += ch;
    i++;
  }

  return out;
}

export function inspectModuleImports(rawSource, targetSpecifier) {
  const stripped = stripSourceComments(rawSource);
  const len = stripped.length;
  const tokens = [];
  let i = 0;

  const isIdentStart = (c) =>
    c === '$' || c === '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  const isIdentPart = (c) => isIdentStart(c) || (c >= '0' && c <= '9');

  while (i < len) {
    const ch = stripped[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = i;
      const quote = ch;
      i++;
      let val = '';
      while (i < len) {
        const c = stripped[i++];
        if (c === '\\' && i < len) {
          val += stripped[i++];
          continue;
        }
        if (c === quote || c === '\n' || c === '\r') break;
        val += c;
      }
      tokens.push({ type: 'string', value: val, raw: stripped.slice(start, i) });
      continue;
    }
    if (ch === '`') {
      const start = i;
      i++;
      let val = '';
      let hasInterp = false;
      while (i < len) {
        const c = stripped[i];
        if (c === '\\' && i + 1 < len) {
          val += stripped[i + 1];
          i += 2;
          continue;
        }
        if (c === '$' && stripped[i + 1] === '{') {
          hasInterp = true;
          i += 2;
          let depth = 1;
          while (i < len && depth > 0) {
            const tc = stripped[i];
            if (tc === "'" || tc === '"' || tc === '`') {
              const q = tc;
              i++;
              while (i < len) {
                const sc = stripped[i++];
                if (sc === '\\' && i < len) {
                  i++;
                  continue;
                }
                if (sc === q) break;
              }
              continue;
            }
            if (tc === '{') depth++;
            else if (tc === '}') depth--;
            i++;
          }
          continue;
        }
        i++;
        if (c === '`') break;
        val += c;
      }
      tokens.push({
        type: hasInterp ? 'template' : 'string',
        value: hasInterp ? '' : val,
        raw: stripped.slice(start, i),
      });
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      while (i < len && isIdentPart(stripped[i])) i++;
      const word = stripped.slice(start, i);
      tokens.push({ type: 'ident', value: word, raw: word });
      continue;
    }
    tokens.push({ type: 'punct', value: ch, raw: ch });
    i++;
  }

  const imports = [];
  const defaultImports = [];
  const typeImports = [];
  const invalidImports = [];
  const dynamicOrCommonJsLoads = [];
  const invalidReexports = [];

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    const prev = k > 0 ? tokens[k - 1] : null;

    if (
      tok.type === 'ident' &&
      (tok.value === 'import' || tok.value === 'require') &&
      prev?.value !== '.' &&
      tokens[k + 1]?.value === '('
    ) {
      if (tokens[k + 2]?.type === 'string' && tokens[k + 2].value === targetSpecifier) {
        dynamicOrCommonJsLoads.push(`${tok.value}(${tokens[k + 2].raw})`);
      }
      continue;
    }

    if (
      tok.type === 'ident' &&
      tok.value === 'import' &&
      prev?.value !== '.' &&
      tokens[k + 1]?.value !== '(' &&
      tokens[k + 1]?.value !== '.'
    ) {
      if (tokens[k + 1]?.type === 'string') {
        const spec = tokens[k + 1].value;
        if (spec === targetSpecifier) {
          const rec = { kind: 'side-effect', clause: '', raw: `import ${tokens[k + 1].raw}` };
          imports.push(rec);
          invalidImports.push(rec);
        }
        k += 1;
        continue;
      }

      let braceDepth = 0;
      let fromIdx = -1;
      for (let m = k + 1; m < tokens.length; m++) {
        const t = tokens[m];
        if (t.value === '{') {
          braceDepth++;
          continue;
        }
        if (t.value === '}') {
          braceDepth = Math.max(0, braceDepth - 1);
          continue;
        }
        if (braceDepth === 0) {
          if (t.value === ';') break;
          if (t.type === 'ident' && t.value === 'from' && tokens[m + 1]?.type === 'string') {
            fromIdx = m;
            break;
          }
        }
      }

      if (fromIdx > k) {
        const clauseTokens = tokens.slice(k + 1, fromIdx);
        const specTok = tokens[fromIdx + 1];
        if (specTok.value === targetSpecifier) {
          const clauseText = clauseTokens.map((t) => t.raw).join(' ');
          const rawStmt = `import ${clauseText} from ${specTok.raw}`;

          const isPureDefault =
            clauseTokens.length === 1 &&
            clauseTokens[0].type === 'ident';

          let isPureType = false;
          if (!isPureDefault && clauseTokens.length >= 2 && clauseTokens[0].type === 'ident' && clauseTokens[0].value === 'type') {
            const rest = clauseTokens.slice(1);
            if (rest.length === 1 && rest[0].type === 'ident') {
              isPureType = true;
            } else if (
              rest.length === 3 &&
              rest[0].value === '*' &&
              rest[1].type === 'ident' &&
              rest[1].value === 'as' &&
              rest[2].type === 'ident'
            ) {
              isPureType = true;
            } else if (
              rest.length >= 2 &&
              rest[0].value === '{' &&
              rest[rest.length - 1].value === '}' &&
              !rest.slice(1, -1).some((t) => t.value === '{' || t.value === '}')
            ) {
              isPureType = true;
            }
          }

          const rec = {
            kind: isPureDefault ? 'default' : isPureType ? 'type' : 'invalid',
            clause: clauseText,
            raw: rawStmt,
          };
          imports.push(rec);
          if (isPureDefault) defaultImports.push(rec);
          else if (isPureType) typeImports.push(rec);
          else invalidImports.push(rec);
        }
        k = fromIdx + 1;
      }
      continue;
    }

    if (tok.type === 'ident' && tok.value === 'export' && prev?.value !== '.') {
      const nextTok = tokens[k + 1];
      if (
        nextTok &&
        (nextTok.value === '*' || nextTok.value === '{' || (nextTok.type === 'ident' && nextTok.value === 'type'))
      ) {
        let braceDepth = 0;
        let fromIdx = -1;
        for (let m = k + 1; m < tokens.length; m++) {
          const t = tokens[m];
          if (t.value === '{') {
            braceDepth++;
            continue;
          }
          if (t.value === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
            continue;
          }
          if (braceDepth === 0) {
            if (t.value === ';' || t.value === '=') break;
            if (t.type === 'ident' && t.value === 'from' && tokens[m + 1]?.type === 'string') {
              fromIdx = m;
              break;
            }
          }
        }
        if (fromIdx > k && tokens[fromIdx + 1].value === targetSpecifier) {
          const isTypeReexport = nextTok.type === 'ident' && nextTok.value === 'type';
          if (!isTypeReexport) {
            const clauseText = tokens.slice(k + 1, fromIdx).map((t) => t.raw).join(' ');
            invalidReexports.push(`export ${clauseText} from ${tokens[fromIdx + 1].raw}`);
          }
          k = fromIdx + 1;
        }
      }
    }
  }

  return {
    strippedSource: stripped,
    imports,
    defaultImports,
    typeImports,
    invalidImports,
    dynamicOrCommonJsLoads,
    invalidReexports,
  };
}

export function createArtifactInspector(repoRoot) {
  function resolvePath(relOrAbsPath) {
    if (typeof relOrAbsPath !== 'string' || relOrAbsPath.trim().length === 0) {
      throw new TypeError('Artifact path must be a non-empty string');
    }
    return path.isAbsolute(relOrAbsPath) ? path.resolve(relOrAbsPath) : path.resolve(repoRoot, relOrAbsPath);
  }

  function exists(relOrAbsPath) {
    return fs.existsSync(resolvePath(relOrAbsPath));
  }

  function requireExistingFile(relOrAbsPath) {
    const abs = resolvePath(relOrAbsPath);
    if (!fs.existsSync(abs)) {
      throw new TargetNotBuiltError(`Missing target file or artifact: ${abs}`);
    }
    const st = fs.statSync(abs);
    if (!st.isFile()) {
      throw new TargetNotBuiltError(`Expected regular file at target path: ${abs}`);
    }
    return { abs, stat: st };
  }

  function stat(relOrAbsPath) {
    return requireExistingFile(relOrAbsPath).stat;
  }

  function readBuffer(relOrAbsPath) {
    const { abs } = requireExistingFile(relOrAbsPath);
    return fs.readFileSync(abs);
  }

  function readText(relOrAbsPath) {
    return readBuffer(relOrAbsPath).toString('utf8');
  }

  function readJson(relOrAbsPath) {
    const { abs } = requireExistingFile(relOrAbsPath);
    const raw = fs.readFileSync(abs, 'utf8');
    return JSON.parse(raw);
  }

  function readJson5(relOrAbsPath) {
    const { abs } = requireExistingFile(relOrAbsPath);
    const raw = fs.readFileSync(abs, 'utf8');
    return parseJson5(raw, abs);
  }

  function inspectElf(relOrAbsPathOrBuffer) {
    if (Buffer.isBuffer(relOrAbsPathOrBuffer) || relOrAbsPathOrBuffer instanceof Uint8Array) {
      return parseElfBuffer(relOrAbsPathOrBuffer, '<buffer.elf>');
    }
    const { abs } = requireExistingFile(relOrAbsPathOrBuffer);
    const buf = fs.readFileSync(abs);
    return parseElfBuffer(buf, abs);
  }

  function inspectZip(relOrAbsPathOrBuffer) {
    if (Buffer.isBuffer(relOrAbsPathOrBuffer) || relOrAbsPathOrBuffer instanceof Uint8Array) {
      return inspectZipBuffer(relOrAbsPathOrBuffer, '<buffer.zip>');
    }
    const { abs } = requireExistingFile(relOrAbsPathOrBuffer);
    const buf = fs.readFileSync(abs);
    return inspectZipBuffer(buf, abs);
  }

  function validateStageModelFoundation() {
    const appJson5 = readJson5(STAGE_MODEL_FILES.appJson5);
    const rootBuildProfile = readJson5(STAGE_MODEL_FILES.rootBuildProfile);
    const hvigorConfig = readJson5(STAGE_MODEL_FILES.hvigorConfig);
    const rootOhPackage = readJson5(STAGE_MODEL_FILES.rootOhPackage);
    const entryBuildProfile = readJson5(STAGE_MODEL_FILES.entryBuildProfile);
    const entryOhPackage = readJson5(STAGE_MODEL_FILES.entryOhPackage);
    const obfuscationRules = readText(STAGE_MODEL_FILES.obfuscationRules);
    const moduleJson5 = readJson5(STAGE_MODEL_FILES.moduleJson5);

    const issues = [];
    const app = appJson5?.app;
    if (!app || typeof app.bundleName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+){2,}$/.test(app.bundleName)) {
      issues.push('Invalid AppScope/app.json5 app.bundleName');
    }
    if (!Number.isInteger(app?.versionCode) || app.versionCode < 1 || app.versionCode > 2147483647) {
      issues.push('Invalid AppScope/app.json5 app.versionCode');
    }
    if (app?.versionName !== '1.2.0') {
      issues.push(`Expected app.versionName === '1.2.0', got '${app?.versionName}'`);
    }

    const products = rootBuildProfile?.app?.products;
    if (!Array.isArray(products)) {
      issues.push('Root build-profile.json5 missing app.products array');
    } else {
      const defProd = products.find((p) => p.name === 'default');
      const hosProd = products.find((p) => p.name === 'harmonyos');
      if (!defProd || defProd.runtimeOS !== 'OpenHarmony' || defProd.compileSdkVersion !== 20) {
        issues.push('Root build-profile.json5 missing default OpenHarmony API 20 product');
      }
      if (!hosProd || hosProd.runtimeOS !== 'HarmonyOS') {
        issues.push('Root build-profile.json5 missing harmonyos product');
      }
      const releaseMode = (rootBuildProfile?.app?.buildModeSet || []).find((m) => m.name === 'release');
      if (releaseMode?.buildOption?.debuggable === true) {
        issues.push('Root build-profile.json5 release buildMode must not set debuggable=true');
      }
    }

    if (entryBuildProfile?.apiType !== 'stageMode') {
      issues.push('entry/build-profile.json5 apiType must be stageMode');
    }
    if (!obfuscationRules.includes('-keep-dts')) {
      issues.push('entry/obfuscation-rules.txt missing -keep-dts');
    }

    const perms = moduleJson5?.module?.requestPermissions || [];
    const allowedSet = new Set(ZERO_ACL_ALLOWED_PERMISSIONS);
    const forbiddenSet = new Set(FORBIDDEN_ACL_PERMISSIONS);
    const userGrantSet = new Set(USER_GRANT_PERMISSIONS);
    for (const p of perms) {
      if (typeof p !== 'object' || p === null || Array.isArray(p)) {
        issues.push(`Permission entry in module.json5 requestPermissions must be an object, got ${JSON.stringify(p)}`);
        continue;
      }
      const name = p.name;
      if (typeof name !== 'string' || !allowedSet.has(name) || forbiddenSet.has(name)) {
        issues.push(`Disallowed or ACL-restricted permission in module.json5: ${name}`);
      }
      if (userGrantSet.has(name)) {
        if (
          typeof p.reason !== 'string' ||
          !/^\$string:[a-zA-Z0-9_]+$/.test(p.reason) ||
          p?.usedScene?.when !== 'inuse' ||
          !Array.isArray(p?.usedScene?.abilities) ||
          !p.usedScene.abilities.includes('EntryAbility')
        ) {
          issues.push(
            `User-grant permission ${name} missing $string: reason or usedScene (when='inuse', abilities=['EntryAbility'])`,
          );
        }
      }
    }

    if (issues.length > 0) {
      throw new ArtifactValidationError(`Stage Model validation failed:\n- ${issues.join('\n- ')}`);
    }

    return {
      valid: true,
      appJson5,
      rootBuildProfile,
      hvigorConfig,
      rootOhPackage,
      entryBuildProfile,
      entryOhPackage,
      obfuscationRules,
      moduleJson5,
    };
  }

  return Object.freeze({
    repoRoot,
    resolvePath,
    exists,
    stat,
    readBuffer,
    readText,
    readJson,
    readJson5,
    parseJson5,
    stripSourceComments,
    inspectModuleImports,
    inspectElf,
    parseElfBuffer,
    inspectZip,
    inspectZipBuffer,
    parseZipBuffer,
    parseHapSignatureBlock,
    validateStageModelFoundation,
  });
}
