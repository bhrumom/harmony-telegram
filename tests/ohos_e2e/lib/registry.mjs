import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALL_FEATURES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  SUITE_ROOT,
  TIER_DIRECTORIES,
  TIERS_ROOT,
  VALID_TIERS,
} from './constants.mjs';

const VALID_FEATURES_SET = new Set(ALL_FEATURES);
const VALID_TIERS_SET = new Set(VALID_TIERS);

export function defineTest(def) {
  if (typeof def !== 'object' || def === null) {
    throw new TypeError('defineTest(def) requires a test definition object');
  }
  const id = typeof def.id === 'string' ? def.id.trim() : '';
  if (!id) {
    throw new TypeError('defineTest: id must be a non-empty string');
  }
  const name = typeof def.name === 'string' ? def.name.trim() : '';
  if (!name) {
    throw new TypeError(`defineTest (${id}): name must be a non-empty string`);
  }
  const tier = def.tier;
  if (!Number.isInteger(tier) || !VALID_TIERS_SET.has(tier)) {
    throw new TypeError(`defineTest (${id}): tier must be 1, 2, 3, or 4; got ${tier}`);
  }
  if (!Array.isArray(def.features) || def.features.length === 0) {
    throw new TypeError(`defineTest (${id}): features must be a non-empty array of F1..F16`);
  }
  const uniqueFeatures = [];
  for (const rawFeat of def.features) {
    const feat = String(rawFeat).trim().toUpperCase();
    if (!VALID_FEATURES_SET.has(feat)) {
      throw new TypeError(`defineTest (${id}): invalid feature ID '${rawFeat}' (expected F1..F16)`);
    }
    if (!uniqueFeatures.includes(feat)) {
      uniqueFeatures.push(feat);
    }
  }
  if (tier === 3 && uniqueFeatures.length < 2) {
    throw new TypeError(`defineTest (${id}): Tier 3 cross-feature tests MUST list >= 2 features`);
  }
  if (tier === 4 && uniqueFeatures.length < 4) {
    throw new TypeError(`defineTest (${id}): Tier 4 scenario tests MUST list >= 4 features`);
  }

  const timeoutMs = def.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : def.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `defineTest (${id}): timeoutMs must be an integer in ${MIN_TIMEOUT_MS}..=${MAX_TIMEOUT_MS}, got ${def.timeoutMs}`,
    );
  }
  if (typeof def.run !== 'function') {
    throw new TypeError(`defineTest (${id}): run(ctx) must be a function`);
  }

  return Object.freeze({
    id,
    name,
    tier,
    features: Object.freeze(uniqueFeatures),
    timeoutMs,
    run: def.run,
  });
}

export function discoverTierModuleFiles(tiers = VALID_TIERS) {
  const results = [];
  for (const tier of tiers) {
    const subDirName = TIER_DIRECTORIES[tier];
    if (!subDirName) continue;
    const dirPath = path.join(TIERS_ROOT, subDirName);
    if (!fs.existsSync(dirPath)) {
      // Gracefully skip tier directories not yet created by parallel E2E milestones
      continue;
    }
    const entries = fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.mjs'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of entries) {
      const absPath = path.join(dirPath, fileName);
      results.push({
        tier,
        fileName,
        filePath: absPath,
        relFilePath: path.relative(SUITE_ROOT, absPath),
      });
    }
  }
  return results;
}

export function matchesTestFilter(test, rawFilter) {
  if (!rawFilter || !String(rawFilter).trim()) return true;
  const trimmed = String(rawFilter).trim();

  // Exact feature token match (e.g. --filter F1 should NOT match F10..F16!)
  const exactFeatMatch = /^F([1-9]|1[0-6])$/i.exec(trimmed);
  if (exactFeatMatch) {
    const targetFeat = `F${exactFeatMatch[1]}`;
    const padded = `F${String(exactFeatMatch[1]).padStart(2, '0')}`;
    if (test.features.includes(targetFeat)) return true;
    if (new RegExp(`\\b${padded}\\b`, 'i').test(test.id)) return true;
    return false;
  }

  const needle = trimmed.toLowerCase();
  if (test.id.toLowerCase().includes(needle)) return true;
  if (test.name.toLowerCase().includes(needle)) return true;
  if (test.relFilePath && test.relFilePath.toLowerCase().includes(needle)) return true;
  if (test.features.some((f) => f.toLowerCase() === needle)) return true;
  return false;
}

export async function loadAllTests({ tiers = VALID_TIERS, features = null, filter = null } = {}) {
  const discoveredFiles = discoverTierModuleFiles(tiers);
  const allLoaded = [];

  for (const modMeta of discoveredFiles) {
    const fileUrl = pathToFileURL(modMeta.filePath).href;
    const imported = await import(fileUrl);
    const exportedTests = imported.default ?? imported.tests;
    if (!Array.isArray(exportedTests)) {
      throw new TypeError(
        `Test module ${modMeta.relFilePath} must default-export or named-export an Array of tests`,
      );
    }
    for (const def of exportedTests) {
      const validated = defineTest(def);
      if (validated.tier !== modMeta.tier) {
        throw new Error(
          `Test '${validated.id}' in ${modMeta.relFilePath} declares tier=${validated.tier}, expected tier=${modMeta.tier}`,
        );
      }
      allLoaded.push(
        Object.freeze({
          ...validated,
          filePath: modMeta.filePath,
          relFilePath: modMeta.relFilePath,
        }),
      );
    }
  }

  let filtered = allLoaded;
  if (Array.isArray(features) && features.length > 0) {
    const wantSet = new Set(features.map((f) => String(f).trim().toUpperCase()));
    filtered = filtered.filter((t) => t.features.some((f) => wantSet.has(f)));
  }
  if (filter) {
    filtered = filtered.filter((t) => matchesTestFilter(t, filter));
  }

  return {
    moduleFiles: discoveredFiles,
    allLoaded,
    tests: filtered,
  };
}
