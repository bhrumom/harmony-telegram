import nodeAssert, { AssertionError } from 'node:assert/strict';

export { AssertionError };

function formatValue(val, maxLen = 280) {
  if (typeof val === 'string') {
    const s = JSON.stringify(val);
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}`;
  }
  if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    const hex = Buffer.from(val.subarray(0, 32)).toString('hex');
    return `<Bytes len=${val.length} hex=${hex}${val.length > 32 ? '...' : ''}>`;
  }
  try {
    const s = JSON.stringify(val);
    if (s === undefined) return String(val);
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
  } catch {
    return String(val);
  }
}

function withMsg(defaultMsg, customMsg) {
  return customMsg ? `${customMsg} — ${defaultMsg}` : defaultMsg;
}

export function fail(message = 'Explicit assertion failure') {
  throw new AssertionError({ message: String(message), operator: 'fail' });
}

export function ok(value, message) {
  if (!value) {
    throw new AssertionError({
      message: withMsg(`Expected truthy value, got ${formatValue(value)}`, message),
      actual: value,
      expected: true,
      operator: 'ok',
    });
  }
}

export function isTrue(value, message) {
  equal(value, true, message);
}

export function isFalse(value, message) {
  equal(value, false, message);
}

export function equal(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new AssertionError({
      message: withMsg(`Expected ${formatValue(actual)} === ${formatValue(expected)}`, message),
      actual,
      expected,
      operator: 'strictEqual',
    });
  }
}

export function notEqual(actual, unexpected, message) {
  if (Object.is(actual, unexpected)) {
    throw new AssertionError({
      message: withMsg(`Expected value not to equal ${formatValue(unexpected)}`, message),
      actual,
      expected: unexpected,
      operator: 'notStrictEqual',
    });
  }
}

export function deepEqual(actual, expected, message) {
  try {
    nodeAssert.deepStrictEqual(actual, expected);
  } catch (err) {
    throw new AssertionError({
      message: withMsg(
        `Deep equality failed: actual=${formatValue(actual, 400)} vs expected=${formatValue(expected, 400)}`,
        message,
      ),
      actual,
      expected,
      operator: 'deepStrictEqual',
      cause: err,
    });
  }
}

export function notDeepEqual(actual, unexpected, message) {
  try {
    nodeAssert.notDeepStrictEqual(actual, unexpected);
  } catch {
    throw new AssertionError({
      message: withMsg(`Expected deep inequality from ${formatValue(unexpected, 400)}`, message),
      actual,
      expected: unexpected,
      operator: 'notDeepStrictEqual',
    });
  }
}

export function match(actual, regex, message) {
  if (typeof actual !== 'string' || !(regex instanceof RegExp) || !regex.test(actual)) {
    throw new AssertionError({
      message: withMsg(`Expected string ${formatValue(actual)} to match ${regex}`, message),
      actual,
      expected: regex,
      operator: 'match',
    });
  }
}

export function doesNotMatch(actual, regex, message) {
  if (typeof actual !== 'string' || !(regex instanceof RegExp)) {
    throw new AssertionError({
      message: withMsg(`Expected string input and RegExp for doesNotMatch, got ${formatValue(actual)}`, message),
      actual,
      expected: regex,
      operator: 'doesNotMatch',
    });
  }
  if (regex.test(actual)) {
    throw new AssertionError({
      message: withMsg(`Expected string ${formatValue(actual)} NOT to match ${regex}`, message),
      actual,
      expected: regex,
      operator: 'doesNotMatch',
    });
  }
}

function checkContains(haystack, needle) {
  if (typeof haystack === 'string') {
    return haystack.includes(String(needle));
  }
  if (Array.isArray(haystack)) {
    return haystack.includes(needle);
  }
  if (haystack instanceof Set) {
    return haystack.has(needle);
  }
  if (Buffer.isBuffer(haystack) || haystack instanceof Uint8Array) {
    const buf = Buffer.isBuffer(haystack) ? haystack : Buffer.from(haystack);
    const sub = Buffer.isBuffer(needle) || needle instanceof Uint8Array ? Buffer.from(needle) : Buffer.from(String(needle));
    return buf.includes(sub);
  }
  return false;
}

export function includes(haystack, needle, message) {
  if (!checkContains(haystack, needle)) {
    throw new AssertionError({
      message: withMsg(`Expected ${formatValue(haystack)} to include ${formatValue(needle)}`, message),
      actual: haystack,
      expected: needle,
      operator: 'includes',
    });
  }
}

export function notIncludes(haystack, needle, message) {
  if (checkContains(haystack, needle)) {
    throw new AssertionError({
      message: withMsg(`Expected ${formatValue(haystack)} NOT to include ${formatValue(needle)}`, message),
      actual: haystack,
      expected: needle,
      operator: 'notIncludes',
    });
  }
}

export const excludes = notIncludes;

export function oneOf(actual, allowedValues, message) {
  const list = Array.isArray(allowedValues) ? allowedValues : Array.from(allowedValues || []);
  if (!list.includes(actual)) {
    throw new AssertionError({
      message: withMsg(`Expected ${formatValue(actual)} to be one of ${formatValue(list)}`, message),
      actual,
      expected: list,
      operator: 'oneOf',
    });
  }
}

export function greaterThan(actual, minExclusive, message) {
  if (typeof actual !== 'number' || Number.isNaN(actual) || !(actual > minExclusive)) {
    throw new AssertionError({
      message: withMsg(`Expected ${formatValue(actual)} > ${formatValue(minExclusive)}`, message),
      actual,
      expected: minExclusive,
      operator: '>',
    });
  }
}

export const gt = greaterThan;

export function greaterThanOrEqual(actual, minInclusive, message) {
  if (typeof actual !== 'number' || Number.isNaN(actual) || !(actual >= minInclusive)) {
    throw new AssertionError({
      message: withMsg(`Expected ${formatValue(actual)} >= ${formatValue(minInclusive)}`, message),
      actual,
      expected: minInclusive,
      operator: '>=',
    });
  }
}

export const gte = greaterThanOrEqual;

export function lessThan(actual, maxExclusive, message) {
  if (typeof actual !== 'number' || Number.isNaN(actual) || !(actual < maxExclusive)) {
    throw new AssertionError({
      message: withMsg(`Expected ${formatValue(actual)} < ${formatValue(maxExclusive)}`, message),
      actual,
      expected: maxExclusive,
      operator: '<',
    });
  }
}

export const lt = lessThan;

export function lessThanOrEqual(actual, maxInclusive, message) {
  if (typeof actual !== 'number' || Number.isNaN(actual) || !(actual <= maxInclusive)) {
    throw new AssertionError({
      message: withMsg(`Expected ${formatValue(actual)} <= ${formatValue(maxInclusive)}`, message),
      actual,
      expected: maxInclusive,
      operator: '<=',
    });
  }
}

export const lte = lessThanOrEqual;

export function between(actual, minInclusive, maxInclusive, message) {
  if (typeof actual !== 'number' || Number.isNaN(actual) || actual < minInclusive || actual > maxInclusive) {
    throw new AssertionError({
      message: withMsg(`Expected ${formatValue(actual)} in [${minInclusive}, ${maxInclusive}]`, message),
      actual,
      expected: [minInclusive, maxInclusive],
      operator: 'between',
    });
  }
}

export function isNonEmptyString(actual, message) {
  if (typeof actual !== 'string' || actual.trim().length === 0) {
    throw new AssertionError({
      message: withMsg(`Expected non-empty string, got ${formatValue(actual)}`, message),
      actual,
      expected: '<non-empty string>',
      operator: 'isNonEmptyString',
    });
  }
}

export function isArray(actual, message) {
  if (!Array.isArray(actual)) {
    throw new AssertionError({
      message: withMsg(`Expected Array, got ${formatValue(actual)}`, message),
      actual,
      expected: 'Array',
      operator: 'isArray',
    });
  }
}

export function isObject(actual, message) {
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    throw new AssertionError({
      message: withMsg(`Expected plain object, got ${formatValue(actual)}`, message),
      actual,
      expected: 'Object',
      operator: 'isObject',
    });
  }
}

export function hasOwn(obj, key, message) {
  if (typeof obj !== 'object' || obj === null || !Object.prototype.hasOwnProperty.call(obj, key)) {
    throw new AssertionError({
      message: withMsg(`Expected object to have own property ${formatValue(key)}`, message),
      actual: obj ? Object.keys(obj) : obj,
      expected: key,
      operator: 'hasOwn',
    });
  }
}

function verifyErrorMatcher(err, matcher, message) {
  if (!matcher) return;
  if (matcher instanceof RegExp) {
    const combined = `${err?.name ?? ''}: ${err?.message ?? String(err)}`;
    if (!matcher.test(combined)) {
      throw new AssertionError({
        message: withMsg(`Thrown error ${formatValue(combined)} did not match ${matcher}`, message),
        actual: combined,
        expected: matcher,
        operator: 'throws',
      });
    }
    return;
  }
  if (typeof matcher === 'function') {
    if (matcher.prototype instanceof Error || matcher === Error) {
      if (!(err instanceof matcher)) {
        throw new AssertionError({
          message: withMsg(`Expected error instance of ${matcher.name}, got ${formatValue(err)}`, message),
          actual: err,
          expected: matcher.name,
          operator: 'throws',
        });
      }
      return;
    }
    const okPred = matcher(err);
    if (!okPred) {
      throw new AssertionError({
        message: withMsg(`Thrown error ${formatValue(err)} rejected by predicate`, message),
        actual: err,
        operator: 'throws',
      });
    }
    return;
  }
  if (typeof matcher === 'string') {
    // Allow string message as optional custom description when 2-arg throws(fn, 'desc') is used
    return;
  }
}

export function throws(fn, matcherOrMessage, maybeMessage) {
  const customMsg = typeof matcherOrMessage === 'string' && !maybeMessage ? matcherOrMessage : maybeMessage;
  let caught;
  let didThrow = false;
  try {
    fn();
  } catch (err) {
    didThrow = true;
    caught = err;
  }
  if (!didThrow) {
    throw new AssertionError({
      message: withMsg('Expected synchronous function to throw an error, but it returned normally', customMsg),
      operator: 'throws',
    });
  }
  if (typeof matcherOrMessage !== 'string') {
    verifyErrorMatcher(caught, matcherOrMessage, customMsg);
  }
  return caught;
}

export async function rejects(asyncFnOrPromise, matcherOrMessage, maybeMessage) {
  const customMsg = typeof matcherOrMessage === 'string' && !maybeMessage ? matcherOrMessage : maybeMessage;
  let caught;
  let didReject = false;
  try {
    if (typeof asyncFnOrPromise === 'function') {
      await asyncFnOrPromise();
    } else {
      await asyncFnOrPromise;
    }
  } catch (err) {
    didReject = true;
    caught = err;
  }
  if (!didReject) {
    throw new AssertionError({
      message: withMsg('Expected promise/async function to reject, but it resolved normally', customMsg),
      operator: 'rejects',
    });
  }
  if (typeof matcherOrMessage !== 'string') {
    verifyErrorMatcher(caught, matcherOrMessage, customMsg);
  }
  return caught;
}

export function httpStatus(res, expectedStatusOrArray, context = '') {
  if (!res || typeof res.status !== 'number') {
    throw new AssertionError({
      message: withMsg(`Expected HTTP response object with numeric status, got ${formatValue(res)}`, context),
      actual: res,
      expected: expectedStatusOrArray,
      operator: 'httpStatus',
    });
  }
  const allowed = Array.isArray(expectedStatusOrArray) ? expectedStatusOrArray : [expectedStatusOrArray];
  if (!allowed.includes(res.status)) {
    const bodySnippet = typeof res.text === 'string' ? res.text.slice(0, 400) : formatValue(res.json);
    throw new AssertionError({
      message: withMsg(
        `Expected HTTP status ${allowed.join('|')}, got ${res.status} (body: ${bodySnippet})`,
        context,
      ),
      actual: res.status,
      expected: expectedStatusOrArray,
      operator: 'httpStatus',
    });
  }
}

const defaultExport = Object.freeze({
  AssertionError,
  fail,
  ok,
  isTrue,
  isFalse,
  equal,
  notEqual,
  deepEqual,
  notDeepEqual,
  match,
  doesNotMatch,
  includes,
  notIncludes,
  excludes,
  oneOf,
  greaterThan,
  gt,
  greaterThanOrEqual,
  gte,
  lessThan,
  lt,
  lessThanOrEqual,
  lte,
  between,
  isNonEmptyString,
  isArray,
  isObject,
  hasOwn,
  throws,
  rejects,
  httpStatus,
});

export default defaultExport;
