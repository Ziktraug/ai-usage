#!/usr/bin/env bun
/**
 * Plan 072 A1 — session-page slice scaling probe.
 *
 * Determines whether the current top-level Sessions page `Array.slice` cursor
 * offset has material/superlinear cost at 5k, 20k, and 50k synthetic items.
 *
 * The current architecture builds and caches the full ordered projection in
 * SQLite (no LIMIT/OFFSET) and pages via `Array.slice(offset, offset+N+1)`.
 * This tool isolates that slice cost to confirm it remains negligible
 * even at scale.
 *
 * Additionally calculates the 5k median slice-total ratio against the SQLite
 * residual total from the plan072-control artifact.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Runtime-validated env/path inputs
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_OUTPUT_JSON = path.join(ROOT, 'docs/performance/artifacts/plan072-keyset-a1.json');
const SOURCE_FILE = path.join(ROOT, 'packages/usage-store/src/session-query-sqlite.ts');
const CONTROL_ARTIFACT = path.join(ROOT, 'docs/performance/artifacts/plan072-control.json');

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// biome-ignore lint/suspicious/noUndeclaredEnvVars: tooling override for isolated test runs
const OUTPUT_PATH_OVERRIDE: string | undefined = process.env.AI_USAGE_PLAN072_OUTPUT_JSON;

const resolveOutputPath = (): string =>
  isNonEmptyString(OUTPUT_PATH_OVERRIDE) ? OUTPUT_PATH_OVERRIDE : DEFAULT_OUTPUT_JSON;

// ---------------------------------------------------------------------------
// Probe sizes and configuration
// ---------------------------------------------------------------------------

const PROBE_SIZES = [5000, 20_000, 50_000] as const;
const PAGE_SIZE = 200;
const SAMPLES_PER_SCENARIO = 7;
const TARGET_SLICE_CALLS_PER_SAMPLE = 250_000;
const WARM_UP_COUNT = 1;

// ---------------------------------------------------------------------------
// Structural assertion — three independent inspections:
//   1. resolveSessionQueryProjection — SQL must lack LIMIT/OFFSET
//   2. runSessionPage — must use cached projection + JS slice
//   3. runCampaignChildren — must still have SQL LIMIT/OFFSET
// ---------------------------------------------------------------------------

export interface SourceAssertionResult {
  readonly campaignChildrenHasSqlOffset: boolean;
  readonly resolveSessionQueryProjectionSqlContainsLimitOrOffset: boolean;
  readonly runSessionPageHasJsSlice: boolean;
  readonly runSessionPageUsesCachedProjection: boolean;
}

const TOP_LEVEL_DECLARATION = /^(?:const|export|function|interface|type|enum|class|(?:async\s+)?function)\s/gm;

const extractTopLevelFunctionBody = (source: string, funcName: string): string => {
  // Build a regex that matches the start of a top-level const arrow function
  // declaration. The paren after ' = ' is part of the arrow function syntax
  // but we avoid including '(' in the pattern because it would need escaping
  // within a RegExp built from a string.
  const declRegex = new RegExp(`^const ${funcName} = `, 'm');
  const match = declRegex.exec(source);
  if (!match) {
    throw new Error(`Could not locate ${funcName} in source`);
  }

  const startIndex = match.index;
  let nextDeclIndex = source.length;

  // Reset and scan forward for the next top-level declaration
  TOP_LEVEL_DECLARATION.lastIndex = 0;
  let declMatch = TOP_LEVEL_DECLARATION.exec(source);
  while (declMatch !== null) {
    if (declMatch.index > startIndex) {
      nextDeclIndex = declMatch.index;
      break;
    }
    declMatch = TOP_LEVEL_DECLARATION.exec(source);
  }

  return source.slice(startIndex, nextDeclIndex);
};

const PAGE_SQL_PATTERN = /pageSql\s*[=:][\s\S]*?\b(LIMIT|OFFSET)\b/im;
const PROJECTION_REF_PATTERN = /resolveSessionQueryProjection/;
const CACHE_REF_PATTERN = /sessionQueryExactRevisionCache/;
const JS_SLICE_PATTERN = /\.slice\(offset/;
const CAMPAIGN_CHILDREN_OFFSET_PATTERN = /LIMIT\s+\?\s+OFFSET\s+\?/;

const assertSourceArchitecture = (source: string): SourceAssertionResult => {
  // 1. Inspect resolveSessionQueryProjection for LIMIT/OFFSET in its SQL
  const projectionBody = extractTopLevelFunctionBody(source, 'resolveSessionQueryProjection');
  const resolveSessionQueryProjectionSqlContainsLimitOrOffset = PAGE_SQL_PATTERN.test(projectionBody);

  // 2. Inspect runSessionPage for cached projection + JS slice
  const runSessionPageBody = extractTopLevelFunctionBody(source, 'runSessionPage');
  const runSessionPageUsesCachedProjection =
    PROJECTION_REF_PATTERN.test(runSessionPageBody) || CACHE_REF_PATTERN.test(runSessionPageBody);
  const runSessionPageHasJsSlice = JS_SLICE_PATTERN.test(runSessionPageBody);

  // 3. Inspect runCampaignChildren for SQL LIMIT/OFFSET (line ~837)
  const campaignChildrenBody = extractTopLevelFunctionBody(source, 'runCampaignChildren');
  const campaignChildrenHasSqlOffset = CAMPAIGN_CHILDREN_OFFSET_PATTERN.test(campaignChildrenBody);

  return {
    campaignChildrenHasSqlOffset,
    resolveSessionQueryProjectionSqlContainsLimitOrOffset,
    runSessionPageHasJsSlice,
    runSessionPageUsesCachedProjection,
  };
};

// ---------------------------------------------------------------------------
// Deterministic identity generation
//
// Reproduces the same identities that the current projection SQL would
// produce for a given scenario. Uses FNV-1a hashing (matching the codebase)
// to create stable, deterministic identity arrays with zero duplicates and
// the correct total order.
// ---------------------------------------------------------------------------

const fnv1a64 = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a is defined in terms of XOR.
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

interface IdentityItem {
  identity: string;
  sortDate: number;
  sortProject: string;
}

interface ScenarioIdentityConfig {
  /** Range filter: if non-null, items only within this date range */
  readonly dateRange?: { readonly end: string; readonly start: string };
  /** Sort direction — ascending or descending */
  readonly direction: 'asc' | 'desc';
  /** If non-null, only include items whose project key matches this filter */
  readonly projectFilter?: string;
  /** Revision v2 seed for revision-change scenario */
  readonly revisionV2Seed?: string;
  /** Seed prefix for deterministic generation */
  readonly seed: string;
  /** Primary sort field — 'project' sorts by project key then identity, default sorts by date then identity */
  readonly sortField?: 'date' | 'project';
  /** How many project-level "ties" to introduce (groups of same-prefix items) */
  readonly teamCount: number;
}

interface ScenarioDefinition {
  readonly config: ScenarioIdentityConfig;
  readonly label: string;
}

const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    config: { direction: 'asc', seed: 'p072a1-date-asc', sortField: 'date', teamCount: 1 },
    label: 'date-ascending',
  },
  {
    config: { direction: 'desc', seed: 'p072a1-date-desc', sortField: 'date', teamCount: 1 },
    label: 'date-descending',
  },
  {
    config: { direction: 'asc', seed: 'p072a1-project-ties', sortField: 'project', teamCount: 12 },
    label: 'project-ties-12-teams',
  },
  {
    config: {
      dateRange: { end: '2020-01-01Z', start: '2019-01-01Z' },
      direction: 'desc',
      seed: 'p072a1-no-result',
      sortField: 'date',
      teamCount: 1,
    },
    label: 'no-result-filter',
  },
  {
    config: {
      direction: 'asc',
      projectFilter: 'team-0',
      seed: 'p072a1-high-selectivity',
      sortField: 'date',
      teamCount: 20,
    },
    label: 'highly-selective-filter',
  },
  {
    config: {
      direction: 'asc',
      projectFilter: 'team-',
      seed: 'p072a1-low-selectivity',
      sortField: 'date',
      teamCount: 40,
    },
    label: 'low-selectivity-filter',
  },
  {
    config: {
      direction: 'asc',
      revisionV2Seed: 'p072a1-revision-v2',
      seed: 'p072a1-revision-v1',
      sortField: 'date',
      teamCount: 1,
    },
    label: 'revision-change-seq',
  },
] as const;

const buildDeterministicIdentities = (size: number, config: ScenarioIdentityConfig): readonly IdentityItem[] => {
  const items: IdentityItem[] = [];

  for (let i = 0; i < size; i++) {
    const teamIndex = i % config.teamCount;

    const baseTimestamp = new Date('2025-01-01T00:00:00Z').getTime();
    const timestamp = baseTimestamp + (config.direction === 'desc' ? size - i : i) * 60_000;

    const projectKey = `${config.seed}-team-${teamIndex}`;

    if (config.projectFilter && !projectKey.includes(config.projectFilter)) {
      continue;
    }

    if (config.dateRange) {
      const startMs = Date.parse(config.dateRange.start);
      const endMs = Date.parse(config.dateRange.end);
      if (timestamp < startMs || timestamp > endMs) {
        continue;
      }
    }

    const identitySeed = `${config.seed}\0${timestamp}\0${projectKey}\0${i}`;
    const identity = `campaign:${fnv1a64(identitySeed)}`;

    items.push({
      identity,
      sortDate: Math.floor(timestamp / 1000),
      sortProject: projectKey,
    });
  }

  // Sort by configured sortField, then stable identity tie-breaker
  items.sort((a, b) => {
    if (config.sortField === 'project') {
      const projDiff = a.sortProject.localeCompare(b.sortProject);
      if (projDiff !== 0) {
        return projDiff;
      }
      return a.identity.localeCompare(b.identity);
    }
    const dateDiff = config.direction === 'desc' ? b.sortDate - a.sortDate : a.sortDate - b.sortDate;
    if (dateDiff !== 0) {
      return dateDiff;
    }
    return a.identity.localeCompare(b.identity);
  });

  return items;
};

// ---------------------------------------------------------------------------
// Identity verification
// ---------------------------------------------------------------------------

export interface IdentityVerification {
  duplicateIdentityCount: number;
  missingIdentityCount: number;
  totalExpectedCount: number;
  uniqueIdentityCount: number;
}

const verifyIdentities = (identities: readonly IdentityItem[]): IdentityVerification => {
  const identitySet = new Set<string>();
  const duplicates = new Set<string>();

  for (const item of identities) {
    if (identitySet.has(item.identity)) {
      duplicates.add(item.identity);
    } else {
      identitySet.add(item.identity);
    }
  }

  return {
    duplicateIdentityCount: duplicates.size,
    missingIdentityCount: 0,
    totalExpectedCount: identities.length,
    uniqueIdentityCount: identitySet.size - duplicates.size,
  };
};

// ---------------------------------------------------------------------------
// Revision sequence verification
// ---------------------------------------------------------------------------

export interface RevisionSequenceVerification {
  revisionV1Count: number;
  revisionV2Count: number;
  sequencesVerified: boolean;
  sharedIdentityCount: number;
}

const verifyRevisionSequences = (
  v1Identities: readonly IdentityItem[],
  v2Identities: readonly IdentityItem[],
): RevisionSequenceVerification => {
  const v1Set = new Set(v1Identities.map((i) => i.identity));
  const v2Set = new Set(v2Identities.map((i) => i.identity));
  let sharedCount = 0;
  for (const id of v1Set) {
    if (v2Set.has(id)) {
      sharedCount++;
    }
  }

  return {
    revisionV1Count: v1Identities.length,
    revisionV2Count: v2Identities.length,
    sequencesVerified: sharedCount === 0,
    sharedIdentityCount: sharedCount,
  };
};

// ---------------------------------------------------------------------------
// Slice traversal measurement
//
// Mimics the current runSessionPage flow:
//   1. Build full ordered projection (the cached array)
//   2. Page through all items using Array.slice(offset, offset+pageSize+1)
//
// Normalizing to a complete traversal (elapsed / fullTraversalCount) so that
// medianPerTraversalMs truly means all pages. sliceCallCount records the
// total number of slice calls across all repetitions.
// ---------------------------------------------------------------------------

export interface SamplePoint {
  fullTraversalCount: number;
  normalizedTraversalSliceMs: number;
  sliceCallCount: number;
  totalSliceMs: number;
}

const determineRepetitions = (size: number): number => {
  const pages = Math.max(1, Math.ceil(size / PAGE_SIZE));
  return Math.max(1, Math.ceil(TARGET_SLICE_CALLS_PER_SAMPLE / pages));
};

const measureSliceTraversal = (
  projection: readonly IdentityItem[],
  repetitions: number,
): Pick<SamplePoint, 'fullTraversalCount' | 'normalizedTraversalSliceMs' | 'sliceCallCount' | 'totalSliceMs'> => {
  const pages = Math.ceil(projection.length / PAGE_SIZE);
  const started = performance.now();

  for (let rep = 0; rep < repetitions; rep++) {
    for (let page = 0; page < pages; page++) {
      const offset = page * PAGE_SIZE;
      projection.slice(offset, offset + PAGE_SIZE + 1);
    }
  }

  const elapsed = performance.now() - started;
  const normalizedTraversalSliceMs = repetitions > 0 ? elapsed / repetitions : 0;

  return {
    fullTraversalCount: repetitions,
    normalizedTraversalSliceMs,
    sliceCallCount: pages * repetitions,
    totalSliceMs: elapsed,
  };
};

// ---------------------------------------------------------------------------
// Scaling summary
// ---------------------------------------------------------------------------

export interface ScalingSummary {
  itemCount: number;
  medianPerTraversalMs: number;
  pageCount: number;
  rawSamples: readonly SamplePoint[];
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

// ---------------------------------------------------------------------------
// Control artifact ingestion — compute the 5k median slice total and its
// ratio to the exact residual SQLite total (count+identity+materialize+
// projection+slice). Validates the artifact shape deeply at runtime.
// ---------------------------------------------------------------------------

export interface ControlArtifactSummary {
  exactResidualIncludesSlice: true;
  medianSliceTotalMs: number;
  medianSqliteResidualTotalMs: number;
  rawSampleSliceTotalsMs: readonly number[];
  rawSampleSqliteResidualTotalsMs: readonly number[];
  sliceToResidualRatio: number;
}

interface ValidatedControlSample {
  sqlitePhases: {
    count: { totalMs: number };
    identity: { totalMs: number };
    materialize: { totalMs: number };
    projection: { totalMs: number };
    slice: { totalMs: number };
  };
}

const validateNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} is not a finite number (got ${String(value)})`);
  }
  return value;
};

const ingestControlArtifact = (artifactPath: string): ControlArtifactSummary => {
  const raw = readFileSync(artifactPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    throw new Error('Control artifact is not a JSON object');
  }

  const bench = parsed.sessionScrollBenchmark;
  if (!isRecord(bench)) {
    throw new Error('Control artifact missing sessionScrollBenchmark');
  }

  const samples = bench.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('Control artifact has no samples');
  }

  const validated: ValidatedControlSample[] = samples.map((sample, index) => {
    if (!isRecord(sample)) {
      throw new Error(`Control artifact sample[${index}] is not an object`);
    }
    const sqlitePhases = sample.sqlitePhases;
    if (!isRecord(sqlitePhases)) {
      throw new Error(`Control artifact sample[${index}].sqlitePhases is not an object`);
    }

    const phaseNames = ['count', 'identity', 'materialize', 'projection', 'slice'] as const;
    for (const phase of phaseNames) {
      const phaseVal = sqlitePhases[phase];
      if (!isRecord(phaseVal)) {
        throw new Error(`Control artifact sample[${index}].sqlitePhases.${phase} is not an object`);
      }
      validateNumber(phaseVal.totalMs, `sample[${index}].sqlitePhases.${phase}.totalMs`);
    }

    return {
      sqlitePhases: {
        count: { totalMs: sqlitePhases.count.totalMs as number },
        identity: { totalMs: sqlitePhases.identity.totalMs as number },
        materialize: { totalMs: sqlitePhases.materialize.totalMs as number },
        projection: { totalMs: sqlitePhases.projection.totalMs as number },
        slice: { totalMs: sqlitePhases.slice.totalMs as number },
      },
    };
  });

  const sliceTotals: number[] = [];
  const residualTotals: number[] = [];

  for (const sample of validated) {
    const phases = sample.sqlitePhases;
    sliceTotals.push(phases.slice.totalMs);
    residualTotals.push(
      phases.count.totalMs +
        phases.identity.totalMs +
        phases.materialize.totalMs +
        phases.projection.totalMs +
        phases.slice.totalMs,
    );
  }

  const medianSlice = median(sliceTotals);
  const medianResidual = median(residualTotals);

  return {
    exactResidualIncludesSlice: true,
    medianSliceTotalMs: medianSlice,
    medianSqliteResidualTotalMs: medianResidual,
    rawSampleSliceTotalsMs: sliceTotals,
    rawSampleSqliteResidualTotalsMs: residualTotals,
    sliceToResidualRatio: medianResidual > 0 ? medianSlice / medianResidual : 0,
  };
};

// ---------------------------------------------------------------------------
// Scaling ratios
//
// Linear growth in complete traversal is expected. Flag superlinear only when
// traversal time grows > item/page ratio by a documented 10% margin.
// ---------------------------------------------------------------------------

interface ScalingRatio {
  from: number;
  rawItemRatio: number;
  sliceMsRatio: number;
  superlinear: boolean;
  to: number;
}

const computeScalingRatios = (probeScaling: Record<number, ScalingSummary>): readonly ScalingRatio[] => {
  const sizes = Object.keys(probeScaling)
    .map(Number)
    .sort((a, b) => a - b);
  const ratios: ScalingRatio[] = [];

  for (let i = 1; i < sizes.length; i++) {
    const fromSize = sizes[i - 1]!;
    const toSize = sizes[i]!;
    const fromEntry = probeScaling[fromSize]!;
    const toEntry = probeScaling[toSize]!;

    if (fromEntry.medianPerTraversalMs <= 0 || toEntry.medianPerTraversalMs <= 0) {
      continue;
    }

    const rawItemRatio = toEntry.itemCount / fromEntry.itemCount;
    const sliceMsRatio = toEntry.medianPerTraversalMs / fromEntry.medianPerTraversalMs;
    const superlinear = sliceMsRatio > rawItemRatio * 1.1;

    ratios.push({
      from: fromSize,
      rawItemRatio: Number(rawItemRatio.toFixed(2)),
      sliceMsRatio: Number(sliceMsRatio.toFixed(4)),
      superlinear,
      to: toSize,
    });
  }

  return ratios;
};

// ---------------------------------------------------------------------------
// Scenario result types
// ---------------------------------------------------------------------------

interface ScenarioResult {
  identityVerification: Record<number, IdentityVerification>;
  label: string;
  probeScaling: Record<number, ScalingSummary>;
  rawProjectionItemCount: number;
  revisionVerification?: Record<number, RevisionSequenceVerification>;
}

// ---------------------------------------------------------------------------
// Probe output type
// ---------------------------------------------------------------------------

export interface ProbeOutput {
  controlArtifact: ControlArtifactSummary & { ingestPath: string };
  probeConfiguration: {
    pageSize: number;
    probeSizes: readonly number[];
    samplesPerScenario: number;
    warmUpCount: number;
  };
  scalingRatios: readonly { label: string; ratios: readonly ScalingRatio[] }[];
  scenarioResults: readonly {
    identityVerification: Record<number, IdentityVerification>;
    label: string;
    rawProjectionItemCount: number;
    revisionVerification?: Record<number, RevisionSequenceVerification>;
    scaling: readonly {
      identityVerification: IdentityVerification;
      itemCount: number;
      medianPerTraversalMs: number;
      pageCount: number;
      probeSize: number;
      rawSamples: readonly SamplePoint[];
      revisionVerification?: RevisionSequenceVerification;
    }[];
  }[];
  sourceAssertion: SourceAssertionResult;
  tool: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Main — also exported for in-process test usage
// ---------------------------------------------------------------------------

const EMPTY_TRAVERSAL_REPETITIONS = 50;

export const runProbe = (outputPath: string): ProbeOutput => {
  // 1. Structural assertion
  const source = readFileSync(SOURCE_FILE, 'utf8');
  const assertion = assertSourceArchitecture(source);

  if (!assertion.runSessionPageUsesCachedProjection) {
    throw new Error(
      'Structural assertion failed: runSessionPage does not use cached projection (resolveSessionQueryProjection)',
    );
  }
  if (!assertion.runSessionPageHasJsSlice) {
    throw new Error('Structural assertion failed: runSessionPage does not use JS slice for paging');
  }
  if (assertion.resolveSessionQueryProjectionSqlContainsLimitOrOffset) {
    throw new Error(
      'Structural assertion failed: resolveSessionQueryProjection SQL unexpectedly contains LIMIT/OFFSET',
    );
  }
  if (!assertion.campaignChildrenHasSqlOffset) {
    throw new Error('Structural assertion failed: campaign-children should have SQL OFFSET but does not');
  }

  // 2. Control artifact ingestion
  const control = ingestControlArtifact(CONTROL_ARTIFACT);

  // 3. Run scenarios
  const scenarioResults: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    const probeScaling: Record<number, ScalingSummary> = {};
    const identityVerification: Record<number, IdentityVerification> = {};
    const revisionVerification: Record<number, RevisionSequenceVerification> = {};
    let maxRawItemCount = 0;

    for (const size of PROBE_SIZES) {
      const identities = buildDeterministicIdentities(size, scenario.config);
      if (identities.length > maxRawItemCount) {
        maxRawItemCount = identities.length;
      }

      const effectiveSize = identities.length;
      identityVerification[size] = verifyIdentities(identities);

      // Revision sequence verification
      if (scenario.config.revisionV2Seed) {
        const v2Config = { ...scenario.config, seed: scenario.config.revisionV2Seed };
        const v2Identities = buildDeterministicIdentities(size, v2Config);
        revisionVerification[size] = verifyRevisionSequences(identities, v2Identities);
      }

      if (effectiveSize === 0) {
        // No-result scenario: still run warmup + samples with empty projection
        const repetitions = EMPTY_TRAVERSAL_REPETITIONS;

        for (let w = 0; w < WARM_UP_COUNT; w++) {
          measureSliceTraversal([], repetitions);
        }

        const rawSamples: SamplePoint[] = [];
        for (let s = 0; s < SAMPLES_PER_SCENARIO; s++) {
          const { fullTraversalCount, normalizedTraversalSliceMs, sliceCallCount, totalSliceMs } =
            measureSliceTraversal([], repetitions);
          rawSamples.push({
            fullTraversalCount,
            normalizedTraversalSliceMs,
            sliceCallCount,
            totalSliceMs,
          });
        }

        probeScaling[size] = {
          itemCount: 0,
          medianPerTraversalMs: 0,
          pageCount: 0,
          rawSamples,
        };
        continue;
      }

      const pageCount = Math.ceil(effectiveSize / PAGE_SIZE);
      const repetitions = determineRepetitions(effectiveSize);

      // Warm-up (unrecorded)
      for (let w = 0; w < WARM_UP_COUNT; w++) {
        const warmupData = buildDeterministicIdentities(size, scenario.config);
        measureSliceTraversal(warmupData, repetitions);
      }

      // Recorded samples
      const rawSamples: SamplePoint[] = [];
      for (let s = 0; s < SAMPLES_PER_SCENARIO; s++) {
        const data = buildDeterministicIdentities(size, scenario.config);
        const { fullTraversalCount, normalizedTraversalSliceMs, sliceCallCount, totalSliceMs } = measureSliceTraversal(
          data,
          repetitions,
        );
        rawSamples.push({
          fullTraversalCount,
          normalizedTraversalSliceMs,
          sliceCallCount,
          totalSliceMs,
        });
      }

      const perTraversalValues = rawSamples.map((s) => Math.max(0, s.normalizedTraversalSliceMs));
      probeScaling[size] = {
        itemCount: effectiveSize,
        medianPerTraversalMs: median(perTraversalValues),
        pageCount,
        rawSamples,
      };
    }

    scenarioResults.push({
      identityVerification,
      label: scenario.label,
      probeScaling,
      rawProjectionItemCount: maxRawItemCount,
      revisionVerification: scenario.config.revisionV2Seed ? revisionVerification : undefined,
    });
  }

  // 4. Compute scaling ratios
  const allRatios = scenarioResults.map((scenario) => ({
    label: scenario.label,
    ratios: computeScalingRatios(scenario.probeScaling),
  }));

  // 5. Assemble output
  const summary: ProbeOutput = {
    controlArtifact: {
      ingestPath: path.relative(ROOT, CONTROL_ARTIFACT),
      ...control,
    },
    probeConfiguration: {
      pageSize: PAGE_SIZE,
      probeSizes: PROBE_SIZES,
      samplesPerScenario: SAMPLES_PER_SCENARIO,
      warmUpCount: WARM_UP_COUNT,
    },
    scalingRatios: allRatios,
    scenarioResults: scenarioResults.map((sr) => ({
      identityVerification: sr.identityVerification,
      label: sr.label,
      rawProjectionItemCount: sr.rawProjectionItemCount,
      revisionVerification: sr.revisionVerification,
      scaling: Object.entries(sr.probeScaling).map(([size, s]) => ({
        identityVerification: sr.identityVerification[Number(size)]!,
        itemCount: s.itemCount,
        medianPerTraversalMs: s.medianPerTraversalMs,
        pageCount: s.pageCount,
        probeSize: Number(size),
        rawSamples: s.rawSamples,
        revisionVerification: sr.revisionVerification?.[Number(size)],
      })),
    })),
    sourceAssertion: assertion,
    tool: 'plan072-keyset-a1',
    version: 1,
  };

  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  return summary;
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const outputPath = resolveOutputPath();
  const summary = runProbe(outputPath);
  process.stdout.write(
    `plan072-keyset-a1: ${summary.scenarioResults.length} scenarios, sizes=[${PROBE_SIZES.join(',')}]\n`,
  );
  process.stdout.write(
    `  Source assertion: projection cached=${summary.sourceAssertion.runSessionPageUsesCachedProjection}, JS slice=${summary.sourceAssertion.runSessionPageHasJsSlice}, resolveSessionQueryProjection SQL LIMIT/OFFSET=${summary.sourceAssertion.resolveSessionQueryProjectionSqlContainsLimitOrOffset}, campaign-children SQL OFFSET=${summary.sourceAssertion.campaignChildrenHasSqlOffset}\n`,
  );
  process.stdout.write(
    `  Control artifact slice/residual ratio (exact): ${summary.controlArtifact.sliceToResidualRatio.toExponential(3)}\n`,
  );
}
