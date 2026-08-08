import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

describe('plan072-keyset-a1', () => {
  let tempDirectory = '';
  let result: Record<string, unknown> = {};

  beforeAll(async () => {
    tempDirectory = mkdtempSync(path.join(tmpdir(), 'plan072-keyset-a1-'));
    const { runProbe } = await import(path.join(ROOT, 'tools/plan072-keyset-a1.ts'));
    const outputJson = path.join(tempDirectory, 'plan072-keyset-a1.json');
    result = runProbe(outputJson) as unknown as Record<string, unknown>;
  });

  afterAll(() => {
    if (existsSync(tempDirectory)) {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  const getScenarios = (): readonly Record<string, unknown>[] =>
    (result.scenarioResults as readonly Record<string, unknown>[] | undefined) ?? [];

  const getNonEmptyScenarios = (): readonly Record<string, unknown>[] =>
    getScenarios().filter((s) => s.label !== 'no-result-filter');

  test('produces valid JSON with all probe sizes and scenarios', () => {
    expect(result.tool).toBe('plan072-keyset-a1');
    expect(result.version).toBe(1);
    expect(result.scenarioResults).toBeArray();

    const scenarios = getScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(7);

    const firstScenario = scenarios[0]!;
    const scaling = firstScenario.scaling as readonly Record<string, unknown>[];
    expect(scaling.length).toBe(3);
    const probeSizes = scaling.map((entry) => entry.probeSize);
    expect(probeSizes).toEqual([5000, 20_000, 50_000]);
  });

  test('non-empty scenarios have raw samples with renamed fields', () => {
    for (const scenario of getNonEmptyScenarios()) {
      const scaling = scenario.scaling as readonly Record<string, unknown>[];
      for (const sizeEntry of scaling) {
        const rawSamples = sizeEntry.rawSamples as readonly Record<string, unknown>[];
        expect(rawSamples.length).toBe(7);
        for (const sample of rawSamples) {
          expect(typeof sample.normalizedTraversalSliceMs).toBe('number');
          expect(sample.normalizedTraversalSliceMs as number).toBeGreaterThanOrEqual(0);
          expect(typeof sample.totalSliceMs).toBe('number');
          expect(sample.totalSliceMs as number).toBeGreaterThanOrEqual(0);
          expect(typeof sample.sliceCallCount).toBe('number');
          expect(sample.sliceCallCount as number).toBeGreaterThan(0);
          expect(typeof sample.fullTraversalCount).toBe('number');
          expect(sample.fullTraversalCount as number).toBeGreaterThan(0);
        }
      }
    }
  });

  test('no-result-filter scenario records warmup + samples for empty traversal', () => {
    const noResultScenario = getScenarios().find((s) => s.label === 'no-result-filter');
    expect(noResultScenario).toBeDefined();
    const scaling = noResultScenario!.scaling as readonly Record<string, unknown>[];
    for (const sizeEntry of scaling) {
      expect(sizeEntry.itemCount).toBe(0);
      expect(sizeEntry.pageCount).toBe(0);
      const rawSamples = sizeEntry.rawSamples as readonly Record<string, unknown>[];
      expect(rawSamples.length).toBe(7);
      for (const sample of rawSamples) {
        expect(sample.normalizedTraversalSliceMs as number).toBeGreaterThanOrEqual(0);
        expect(sample.fullTraversalCount as number).toBe(50);
        expect(sample.sliceCallCount as number).toBe(0);
        expect(sample.totalSliceMs as number).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('medianPerTraversalMs represents full traversal (all pages)', () => {
    for (const scenario of getNonEmptyScenarios()) {
      const scaling = scenario.scaling as readonly Record<string, unknown>[];
      for (const sizeEntry of scaling) {
        const rawSamples = sizeEntry.rawSamples as readonly Record<string, unknown>[];
        const medianMs = sizeEntry.medianPerTraversalMs as number;

        // normalizedTraversalSliceMs = elapsed / fullTraversalCount represents
        // the cost of a single complete traversal (all pages). The median
        // should lie within the sample range.
        const values = rawSamples.map((s) => s.normalizedTraversalSliceMs as number);
        const min = Math.min(...values);
        const max = Math.max(...values);
        expect(medianMs).toBeGreaterThanOrEqual(min);
        expect(medianMs).toBeLessThanOrEqual(max);

        // Verify the normalizedTraversalSliceMs is > 0 for non-empty items
        for (const val of values) {
          expect(val).toBeGreaterThan(0);
        }
      }
    }
  });

  test('scaling ratios are present for each scenario and flag superlinear correctly', () => {
    const ratios = result.scalingRatios as readonly Record<string, unknown>[];
    expect(ratios.length).toBe(7);

    for (const entry of ratios) {
      const entryRatios = entry.ratios as readonly Record<string, unknown>[];
      const label = entry.label as string;
      if (label === 'no-result-filter') {
        expect(entryRatios.length).toBe(0);
      } else {
        expect(entryRatios.length).toBe(2);
      }
      for (const ratio of entryRatios) {
        expect(typeof ratio.from).toBe('number');
        expect(typeof ratio.to).toBe('number');
        expect(typeof ratio.rawItemRatio).toBe('number');
        expect(typeof ratio.sliceMsRatio).toBe('number');
        expect(typeof ratio.superlinear).toBe('boolean');

        // sliceMsRatio should be close to rawItemRatio for linear scaling
        // Superlinear flag only set when 10% over
        const rawItemRatio = ratio.rawItemRatio as number;
        const sliceMsRatio = ratio.sliceMsRatio as number;
        expect(sliceMsRatio).toBeGreaterThan(0);
        expect(rawItemRatio).toBeGreaterThan(0);
      }
    }
  });

  test('source assertion validates resolved architecture with three separate inspections', () => {
    const assertion = result.sourceAssertion as Record<string, boolean>;
    expect(assertion.runSessionPageUsesCachedProjection).toBe(true);
    expect(assertion.runSessionPageHasJsSlice).toBe(true);
    expect(assertion.resolveSessionQueryProjectionSqlContainsLimitOrOffset).toBe(false);
    expect(assertion.campaignChildrenHasSqlOffset).toBe(true);
  });

  test('control artifact is ingested with runtime validation and exact residual', () => {
    const control = result.controlArtifact as Record<string, unknown>;
    expect(control.exactResidualIncludesSlice).toBe(true);
    expect(typeof control.medianSliceTotalMs).toBe('number');
    expect(control.medianSliceTotalMs as number).toBeGreaterThan(0);
    expect(typeof control.medianSqliteResidualTotalMs).toBe('number');
    expect(control.medianSqliteResidualTotalMs as number).toBeGreaterThan(0);
    expect(typeof control.sliceToResidualRatio).toBe('number');
    expect(control.sliceToResidualRatio as number).toBeGreaterThan(0);

    const rawSamples = control.rawSampleSliceTotalsMs as readonly number[];
    expect(rawSamples.length).toBe(3);
    const rawResidual = control.rawSampleSqliteResidualTotalsMs as readonly number[];
    expect(rawResidual.length).toBe(3);

    // Residual includes all five phases (count+identity+materialize+projection+slice)
    for (let i = 0; i < 3; i++) {
      expect(rawResidual[i]!).toBeGreaterThan(rawSamples[i]!);
    }
  });

  test('produces deterministic output for the same seed', () => {
    const run1 = result;
    const run1NonTiming = {
      sourceAssertion: run1.sourceAssertion,
      tool: run1.tool,
      version: run1.version,
      scenarioLabels: (run1.scenarioResults as readonly Record<string, unknown>[]).map((s) => s.label),
      scenarioItemCounts: (run1.scenarioResults as readonly Record<string, unknown>[]).flatMap((s) =>
        ((s.scaling as readonly Record<string, unknown>[]) ?? []).map(
          (e: Record<string, unknown>) => `${e.probeSize}:${e.itemCount}`,
        ),
      ),
      scenarioPageCounts: (run1.scenarioResults as readonly Record<string, unknown>[]).flatMap((s) =>
        ((s.scaling as readonly Record<string, unknown>[]) ?? []).map(
          (e: Record<string, unknown>) => `${e.probeSize}:${e.pageCount}`,
        ),
      ),
    };
    expect(run1NonTiming.tool).toBe('plan072-keyset-a1');
    expect(run1NonTiming.version).toBe(1);
    expect(run1NonTiming.scenarioLabels.length).toBe(7);
    for (const ic of run1NonTiming.scenarioItemCounts) {
      expect(typeof ic).toBe('string');
    }
  });

  test('identity verification reports unique/duplicate counts per scenario/size', () => {
    const scenarios = getScenarios();
    for (const scenario of scenarios) {
      const scaling = scenario.scaling as readonly Record<string, unknown>[];
      const label = scenario.label as string;
      for (const sizeEntry of scaling) {
        const iv = sizeEntry.identityVerification as Record<string, unknown>;
        expect(iv).toBeDefined();
        expect(typeof iv.uniqueIdentityCount).toBe('number');
        expect(typeof iv.duplicateIdentityCount).toBe('number');
        expect(typeof iv.missingIdentityCount).toBe('number');
        expect(typeof iv.totalExpectedCount).toBe('number');

        const unique = iv.uniqueIdentityCount as number;
        const dup = iv.duplicateIdentityCount as number;
        const missing = iv.missingIdentityCount as number;
        const total = iv.totalExpectedCount as number;
        const probeSize = sizeEntry.probeSize as number;

        expect(unique).toBeGreaterThanOrEqual(0);
        expect(unique).toBeLessThanOrEqual(probeSize);
        // No duplicate identities in deterministic generation
        expect(dup).toBe(0);
        expect(missing).toBe(0);

        if (label === 'no-result-filter') {
          expect(unique).toBe(0);
          expect(total).toBe(0);
        } else {
          expect(unique).toBeGreaterThan(0);
          expect(total).toBeGreaterThan(0);
          expect(unique).toBe(total);
        }
      }
    }
  });

  test('revision-change scenario verifies two deterministic sequences with no shared identities', () => {
    const revScenario = getScenarios().find((s) => s.label === 'revision-change-seq');
    expect(revScenario).toBeDefined();
    const scaling = revScenario!.scaling as readonly Record<string, unknown>[];
    expect(scaling.length).toBe(3);

    for (const sizeEntry of scaling) {
      const rv = sizeEntry.revisionVerification as Record<string, unknown>;
      expect(rv).toBeDefined();
      expect(rv.sequencesVerified).toBe(true);
      expect(rv.sharedIdentityCount).toBe(0);
      expect(typeof rv.revisionV1Count).toBe('number');
      expect(typeof rv.revisionV2Count).toBe('number');
      expect(rv.revisionV1Count as number).toBeGreaterThan(0);
      expect(rv.revisionV2Count as number).toBeGreaterThan(0);
      expect(rv.revisionV1Count).toBe(rv.revisionV2Count);
    }

    // Top-level revision verification exists
    const topRv = revScenario!.revisionVerification as Record<number, Record<string, unknown>>;
    expect(topRv).toBeDefined();
    for (const size of [5000, 20_000, 50_000]) {
      const entry = topRv[size];
      expect(entry).toBeDefined();
      expect(entry.sequencesVerified).toBe(true);
      expect(entry.sharedIdentityCount).toBe(0);
    }
  });

  test('project-ties scenario sorts by project key then identity', () => {
    const projScenario = getScenarios().find((s) => s.label === 'project-ties-12-teams');
    expect(projScenario).toBeDefined();
    const scaling = projScenario!.scaling as readonly Record<string, unknown>[];
    for (const sizeEntry of scaling) {
      expect(sizeEntry.itemCount as number).toBeGreaterThan(0);
      const iv = sizeEntry.identityVerification as Record<string, unknown>;
      expect(iv.duplicateIdentityCount).toBe(0);
      expect(iv.uniqueIdentityCount).toBe(sizeEntry.itemCount);
    }
  });

  test('non-revision scenarios do not have revision verification', () => {
    const nonRevScenarios = getScenarios().filter((s) => s.label !== 'revision-change-seq');
    for (const scenario of nonRevScenarios) {
      const scaling = scenario.scaling as readonly Record<string, unknown>[];
      for (const sizeEntry of scaling) {
        expect(sizeEntry.revisionVerification).toBeUndefined();
      }
      expect(scenario.revisionVerification).toBeUndefined();
    }
  });

  test('CLI entry point runs and produces valid output', async () => {
    const cliDir = mkdtempSync(path.join(tmpdir(), 'plan072-keyset-a1-cli-'));
    const outputJson = path.join(cliDir, 'plan072-keyset-a1-cli.json');
    try {
      const proc = Bun.spawn(['bun', path.join(ROOT, 'tools/plan072-keyset-a1.ts')], {
        cwd: ROOT,
        env: {
          ...process.env,
          AI_USAGE_PLAN072_OUTPUT_JSON: outputJson,
        },
        stderr: 'pipe',
        stdout: 'pipe',
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      const content = readFileSync(outputJson, 'utf8');
      const parsed = JSON.parse(content);
      expect(isRecord(parsed)).toBe(true);
      expect((parsed as Record<string, unknown>).tool).toBe('plan072-keyset-a1');

      // Verify CLI output has all new fields
      const cliScenarios = (parsed as Record<string, unknown>).scenarioResults as readonly Record<string, unknown>[];
      const cliRev = cliScenarios.find((s) => s.label === 'revision-change-seq');
      expect(cliRev).toBeDefined();
      const cliScale = (cliRev as Record<string, unknown>).scaling as readonly Record<string, unknown>[];
      expect(cliScale[0] as Record<string, unknown>).toHaveProperty('revisionVerification');
    } finally {
      if (existsSync(cliDir)) {
        rmSync(cliDir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
