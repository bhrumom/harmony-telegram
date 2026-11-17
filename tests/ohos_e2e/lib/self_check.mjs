import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_FEATURES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  SELF_CHECK_THRESHOLDS,
  SUITE_ROOT,
  VALID_TIERS,
} from './constants.mjs';
import { discoverTierModuleFiles, loadAllTests } from './registry.mjs';

// Construct forbidden path tokens dynamically so this validator file itself contains zero literal matches
const FORBIDDEN_SYS_TEMP_TOKEN = '/' + 'tmp';
const FORBIDDEN_TEAMWORK_TOKEN = '.agents/' + 'teamwork';
const FORBIDDEN_SYS_TEMP_REGEX = new RegExp(`(?:^|[^a-zA-Z0-9_-])\\${FORBIDDEN_SYS_TEMP_TOKEN}(?:\\/|\\b|$)`, 'm');
const FORBIDDEN_TEAMWORK_REGEX = new RegExp(FORBIDDEN_TEAMWORK_TOKEN.replace('.', '\\.').replace('/', '\\/'), 'm');
const FORBIDDEN_HVIGOR_TEST_REGEX = /\bhvigorw?\s+test\b|\bLocalTest\b/;
const FORBIDDEN_OS_TMPDIR_REGEX = /\btmpdir\s*\(/;
const FORBIDDEN_INTERNAL_IMPORT_REGEX = /(?:from|import|require\s*\()\s*['"][^'"]*harmony-telegram[^'"]*['"]/;
const TAUTOLOGICAL_BOOL_REGEX = /\bassert\s*\.\s*(?:ok|isTrue)\s*\(\s*true\b|\bassert\s*\.\s*isFalse\s*\(\s*false\b/;
const EQUALITY_CALL_REGEX = /\bassert\s*\.\s*(?:equal|deepEqual)\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*(?:,|\))/g;
const SILENT_EMPTY_CATCH_REGEX = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\n\s*)*(?:return\s*;?\s*)?\}/m;
const OPAQUE_CHANNEL_REGEX =
  /\b(?:ctx|[a-zA-Z0-9_$]+)\s*\.\s*(?:cli|ensureServer|http|connectWs|ws|artifacts)\b/;

function collectMjsFilesRecursively(dirPath, out = []) {
  if (!fs.existsSync(dirPath)) return out;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === 'work' || entry.name === 'node_modules') continue;
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectMjsFilesRecursively(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(abs);
    }
  }
  return out;
}

function validatePackageJson(errors) {
  const pkgPath = path.join(SUITE_ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    errors.push('Missing package.json in SUITE_ROOT');
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    errors.push(`Invalid JSON in package.json: ${err.message}`);
    return;
  }
  if (pkg.type !== 'module') {
    errors.push(`package.json must have "type": "module", got ${JSON.stringify(pkg.type)}`);
  }
  if (pkg.private !== true) {
    errors.push('package.json must have "private": true');
  }
  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[depField] && Object.keys(pkg[depField]).length > 0) {
      errors.push(`package.json must have zero external ${depField}, found: ${Object.keys(pkg[depField]).join(', ')}`);
    }
  }
}

function scanSourceFilesStatic(errors) {
  const allMjs = collectMjsFilesRecursively(SUITE_ROOT);
  const selfFileAbs = path.join(SUITE_ROOT, 'lib', 'self_check.mjs');

  for (const absPath of allMjs) {
    const relPath = path.relative(SUITE_ROOT, absPath);
    const isTierTestModule = relPath.startsWith(`tiers${path.sep}`);
    const content = fs.readFileSync(absPath, 'utf8');

    if (absPath !== selfFileAbs) {
      if (FORBIDDEN_SYS_TEMP_REGEX.test(content)) {
        errors.push(`[ANTI-CHEAT] ${relPath}: contains forbidden '${FORBIDDEN_SYS_TEMP_TOKEN}' path literal`);
      }
      if (FORBIDDEN_TEAMWORK_REGEX.test(content)) {
        errors.push(`[ANTI-CHEAT] ${relPath}: contains forbidden '${FORBIDDEN_TEAMWORK_TOKEN}' path literal`);
      }
      if (FORBIDDEN_INTERNAL_IMPORT_REGEX.test(content)) {
        errors.push(`[ANTI-CHEAT] ${relPath}: imports internal harmony-telegram module directly`);
      }
      if (FORBIDDEN_HVIGOR_TEST_REGEX.test(content)) {
        errors.push(`[ANTI-CHEAT] ${relPath}: references banned Linux 'hvigor test' / 'LocalTest' command`);
      }
    }

    if (isTierTestModule) {
      if (FORBIDDEN_OS_TMPDIR_REGEX.test(content)) {
        errors.push(`[ANTI-CHEAT] ${relPath}: calls forbidden tmpdir() instead of ctx.tmpDir / ctx.workDir`);
      }
      if (TAUTOLOGICAL_BOOL_REGEX.test(content)) {
        errors.push(`[ANTI-CHEAT] ${relPath}: contains tautological boolean assertion (e.g. assert.ok(true))`);
      }
      EQUALITY_CALL_REGEX.lastIndex = 0;
      let eqMatch;
      while ((eqMatch = EQUALITY_CALL_REGEX.exec(content)) !== null) {
        const lhs = eqMatch[1].trim();
        const rhs = eqMatch[2].trim();
        if (lhs.length > 0 && lhs === rhs) {
          errors.push(`[ANTI-CHEAT] ${relPath}: contains tautological equality assertion (${lhs} === ${rhs})`);
        }
      }
      if (SILENT_EMPTY_CATCH_REGEX.test(content)) {
        errors.push(`[ANTI-CHEAT] ${relPath}: contains silent empty/early-return catch block`);
      }
      if (!OPAQUE_CHANNEL_REGEX.test(content)) {
        errors.push(
          `[ANTI-CHEAT] ${relPath}: test module never touches ctx.{cli,ensureServer,http,connectWs,ws,artifacts}`,
        );
      }
    }
  }
}

function extractModuleHelperBodies(fileContent) {
  const helpers = new Map();
  const fnRegex = /(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = fnRegex.exec(fileContent)) !== null) {
    const name = m[1];
    if (name === 'run') continue;
    let depth = 1;
    let idx = m.index + m[0].length;
    while (idx < fileContent.length && depth > 0) {
      const ch = fileContent[idx++];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    helpers.set(name, fileContent.slice(m.index, idx));
  }
  return helpers;
}

function testUsesOpaqueBoxChannel(test, moduleContentCache) {
  const runSrc = test.run.toString();
  if (OPAQUE_CHANNEL_REGEX.test(runSrc)) {
    return true;
  }
  let cached = moduleContentCache.get(test.filePath);
  if (!cached) {
    const raw = fs.readFileSync(test.filePath, 'utf8');
    cached = { raw, helpers: extractModuleHelperBodies(raw) };
    moduleContentCache.set(test.filePath, cached);
  }
  for (const [helperName, helperBody] of cached.helpers.entries()) {
    if (new RegExp(`\\b${helperName}\\s*\\(`).test(runSrc) && OPAQUE_CHANNEL_REGEX.test(helperBody)) {
      return true;
    }
  }
  return false;
}

export async function runSelfCheck({ features = null, tiers = null } = {}) {
  const errors = [];
  validatePackageJson(errors);
  scanSourceFilesStatic(errors);

  let allLoaded = [];
  let moduleFiles = [];
  try {
    const loaded = await loadAllTests({ tiers: VALID_TIERS });
    allLoaded = loaded.allLoaded;
    moduleFiles = loaded.moduleFiles;
  } catch (err) {
    errors.push(`Failed to load test modules: ${err.stack || err.message}`);
  }

  // Global uniqueness & per-test invariants across ALL discovered tests
  const seenIds = new Map();
  const seenNames = new Map();
  const seenBodies = new Map();
  const moduleContentCache = new Map();

  for (const t of allLoaded) {
    if (seenIds.has(t.id)) {
      errors.push(`Duplicate test id '${t.id}' in ${t.relFilePath} and ${seenIds.get(t.id)}`);
    } else {
      seenIds.set(t.id, t.relFilePath);
    }

    if (seenNames.has(t.name)) {
      errors.push(`Duplicate test name '${t.name}' in ${t.relFilePath} and ${seenNames.get(t.name)}`);
    } else {
      seenNames.set(t.name, t.relFilePath);
    }

    const normalizedBody = t.run.toString().replace(/\s+/g, ' ').trim();
    if (seenBodies.has(normalizedBody)) {
      errors.push(
        `Duplicate identical test run() body in '${t.id}' (${t.relFilePath}) and '${seenBodies.get(normalizedBody)}'`,
      );
    } else {
      seenBodies.set(normalizedBody, t.id);
    }

    if (t.timeoutMs < MIN_TIMEOUT_MS || t.timeoutMs > MAX_TIMEOUT_MS) {
      errors.push(`Test '${t.id}' timeoutMs=${t.timeoutMs} out of range ${MIN_TIMEOUT_MS}..=${MAX_TIMEOUT_MS}`);
    }

    if (!testUsesOpaqueBoxChannel(t, moduleContentCache)) {
      errors.push(
        `[ANTI-CHEAT] Test '${t.id}' (${t.relFilePath}) does not invoke ctx.{cli,ensureServer,http,connectWs,ws,artifacts}`,
      );
    }
  }

  // Compute feature & tier coverage matrix
  const perFeatureCounts = {};
  for (const f of ALL_FEATURES) {
    perFeatureCounts[f] = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
  }
  const tierTotals = { 1: 0, 2: 0, 3: 0, 4: 0 };

  for (const t of allLoaded) {
    tierTotals[t.tier] = (tierTotals[t.tier] || 0) + 1;
    for (const f of t.features) {
      if (perFeatureCounts[f]) {
        perFeatureCounts[f][`tier${t.tier}`] += 1;
      }
    }
  }

  const grandTotal = allLoaded.length;
  const hasFeatureScope = Array.isArray(features) && features.length > 0;
  const hasTierScope = Array.isArray(tiers) && tiers.length > 0;

  if (hasFeatureScope) {
    for (const rawF of features) {
      const f = String(rawF).trim().toUpperCase();
      if (!perFeatureCounts[f]) {
        errors.push(`Unknown feature '${rawF}' in --features`);
        continue;
      }
      const checkT1 = !hasTierScope || tiers.includes(1);
      const checkT2 = !hasTierScope || tiers.includes(2);
      if (checkT1 && perFeatureCounts[f].tier1 < SELF_CHECK_THRESHOLDS.minTier1PerFeature) {
        errors.push(
          `Feature ${f} Tier 1 count is ${perFeatureCounts[f].tier1} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier1PerFeature})`,
        );
      }
      if (checkT2 && perFeatureCounts[f].tier2 < SELF_CHECK_THRESHOLDS.minTier2PerFeature) {
        errors.push(
          `Feature ${f} Tier 2 count is ${perFeatureCounts[f].tier2} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier2PerFeature})`,
        );
      }
      if (hasTierScope && tiers.includes(3) && perFeatureCounts[f].tier3 < 1) {
        errors.push(`Feature ${f} has 0 Tier 3 cross-feature tests`);
      }
      if (hasTierScope && tiers.includes(4) && perFeatureCounts[f].tier4 < 1) {
        errors.push(`Feature ${f} has 0 Tier 4 scenario tests`);
      }
    }
  } else if (hasTierScope) {
    if (tiers.includes(1)) {
      for (const f of ALL_FEATURES) {
        if (perFeatureCounts[f].tier1 < SELF_CHECK_THRESHOLDS.minTier1PerFeature) {
          errors.push(
            `Feature ${f} Tier 1 count is ${perFeatureCounts[f].tier1} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier1PerFeature})`,
          );
        }
      }
      if (tierTotals[1] < SELF_CHECK_THRESHOLDS.minTier1Total) {
        errors.push(`Tier 1 total is ${tierTotals[1]} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier1Total})`);
      }
    }
    if (tiers.includes(2)) {
      for (const f of ALL_FEATURES) {
        if (perFeatureCounts[f].tier2 < SELF_CHECK_THRESHOLDS.minTier2PerFeature) {
          errors.push(
            `Feature ${f} Tier 2 count is ${perFeatureCounts[f].tier2} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier2PerFeature})`,
          );
        }
      }
      if (tierTotals[2] < SELF_CHECK_THRESHOLDS.minTier2Total) {
        errors.push(`Tier 2 total is ${tierTotals[2]} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier2Total})`);
      }
    }
    if (tiers.includes(3)) {
      if (tierTotals[3] < SELF_CHECK_THRESHOLDS.minTier3Total) {
        errors.push(`Tier 3 total is ${tierTotals[3]} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier3Total})`);
      }
      const missingT3 = ALL_FEATURES.filter((f) => perFeatureCounts[f].tier3 < 1);
      if (missingT3.length > 0) {
        errors.push(`Tier 3 cross-feature coverage missing features: ${missingT3.join(', ')}`);
      }
    }
    if (tiers.includes(4)) {
      if (tierTotals[4] < SELF_CHECK_THRESHOLDS.minTier4Total) {
        errors.push(`Tier 4 total is ${tierTotals[4]} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier4Total})`);
      }
      const missingT4 = ALL_FEATURES.filter((f) => perFeatureCounts[f].tier4 < 1);
      if (missingT4.length > 0) {
        errors.push(`Tier 4 scenario coverage missing features: ${missingT4.join(', ')}`);
      }
    }
  } else {
    // Full unfiltered --self-check gate: enforces ALL F1..F16 and ALL Tiers 1..4 (>= 190 total)
    const missingT1Features = [];
    const missingT2Features = [];
    for (const f of ALL_FEATURES) {
      if (perFeatureCounts[f].tier1 < SELF_CHECK_THRESHOLDS.minTier1PerFeature) {
        missingT1Features.push(`${f}(${perFeatureCounts[f].tier1}/${SELF_CHECK_THRESHOLDS.minTier1PerFeature})`);
      }
      if (perFeatureCounts[f].tier2 < SELF_CHECK_THRESHOLDS.minTier2PerFeature) {
        missingT2Features.push(`${f}(${perFeatureCounts[f].tier2}/${SELF_CHECK_THRESHOLDS.minTier2PerFeature})`);
      }
    }
    if (missingT1Features.length > 0) {
      errors.push(`Missing/under-threshold Tier 1 feature tests: ${missingT1Features.join(', ')}`);
    }
    if (missingT2Features.length > 0) {
      errors.push(`Missing/under-threshold Tier 2 boundary tests: ${missingT2Features.join(', ')}`);
    }
    if (tierTotals[1] < SELF_CHECK_THRESHOLDS.minTier1Total) {
      errors.push(`Tier 1 total is ${tierTotals[1]} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier1Total})`);
    }
    if (tierTotals[2] < SELF_CHECK_THRESHOLDS.minTier2Total) {
      errors.push(`Tier 2 total is ${tierTotals[2]} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier2Total})`);
    }
    if (tierTotals[3] < SELF_CHECK_THRESHOLDS.minTier3Total) {
      errors.push(`Tier 3 total is ${tierTotals[3]} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier3Total})`);
    }
    if (tierTotals[4] < SELF_CHECK_THRESHOLDS.minTier4Total) {
      errors.push(`Tier 4 total is ${tierTotals[4]} (minimum required: ${SELF_CHECK_THRESHOLDS.minTier4Total})`);
    }
    if (grandTotal < SELF_CHECK_THRESHOLDS.minGrandTotal) {
      errors.push(`Grand total tests is ${grandTotal} (minimum required: ${SELF_CHECK_THRESHOLDS.minGrandTotal})`);
    }
  }

  const scopeLabel = hasFeatureScope
    ? `features=${features.join(',')}${hasTierScope ? ` tiers=${tiers.join(',')}` : ''}`
    : hasTierScope
      ? `tiers=${tiers.join(',')}`
      : 'full-suite (F1..F16, Tiers 1..4)';

  const ok = errors.length === 0;
  console.log(`[SELF-CHECK] Scope: ${scopeLabel}`);
  console.log(
    `[SELF-CHECK] Loaded ${grandTotal} tests across ${moduleFiles.length} modules (T1=${tierTotals[1]}, T2=${tierTotals[2]}, T3=${tierTotals[3]}, T4=${tierTotals[4]})`,
  );
  if (!ok) {
    console.error(`[SELF-CHECK] FAILED with ${errors.length} issue(s):`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
  } else {
    console.log('[SELF-CHECK] PASSED (0 anti-cheat/schema/threshold issues)');
  }

  return {
    ok,
    scope: scopeLabel,
    moduleCount: moduleFiles.length,
    tierTotals,
    grandTotal,
    perFeatureCounts,
    errors,
  };
}
