#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FIXTURE_SEED = 0x8_a1_1d_17;
const MEASURED_REPETITIONS = 5;
const WARMUP_REPETITIONS = 1;
const IMPORT_LOOKUP_BUDGET_BATCH_SIZE = 400;
const MAX_SESSION_PAGE_ROWS = 200;
const MIN_REPORT_ARTIFACT_BUDGET_BYTES = 128 * 1024 * 1024;
const SERVED_BOOTSTRAP_BUDGET_BYTES = 512 * 1024;
const OVERVIEW_REFRESH_BUDGET_BYTES = 2 * 1024 * 1024;
const SESSION_PAGE_REFRESH_BUDGET_BYTES = 2 * 1024 * 1024;
const FIXTURE_ROW_COUNTS = [1000, 50_000] as const;

const harnesses = [
  { key: 'codex', label: 'Codex', provider: 'OpenAI', model: 'gpt-5.3-codex' },
  { key: 'claude', label: 'Claude Code', provider: 'Anthropic', model: 'claude-sonnet-4-6' },
  { key: 'opencode', label: 'OpenCode', provider: 'OpenRouter', model: 'qwen3-coder' },
  { key: 'cursor', label: 'Cursor', provider: 'Cursor', model: 'cursor-agent' },
] as const;

const projectNames = ['ai-usage', 'billing-console', 'agent-runtime', 'docs-site', 'mobile-shell'] as const;

interface Measurement {
  medianMs: number;
  repetitions: number;
  samplesMs: number[];
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const measure = async (operation: () => Promise<void> | void): Promise<Measurement> => {
  for (let index = 0; index < WARMUP_REPETITIONS; index++) {
    await operation();
  }
  const samplesMs: number[] = [];
  for (let index = 0; index < MEASURED_REPETITIONS; index++) {
    const startedAt = performance.now();
    await operation();
    samplesMs.push(Number((performance.now() - startedAt).toFixed(3)));
  }
  return {
    medianMs: median(samplesMs),
    repetitions: MEASURED_REPETITIONS,
    samplesMs,
  };
};

const nextPowerOfTwo = (value: number): number => 2 ** Math.ceil(Math.log2(value));

const run = async () => {
  const temporaryHome = mkdtempSync(path.join(tmpdir(), 'ai-usage-audit-baseline-'));
  const previousHome = process.env.HOME;
  process.env.HOME = temporaryHome;

  try {
    const [{ Effect }, localHistory, machineConfig, reportData, usageStore, usageRow] = await Promise.all([
      import('effect'),
      import('@ai-usage/local-collectors/local-history'),
      import('@ai-usage/local-collectors/machine-config'),
      import('@ai-usage/report-core/report-data'),
      import('@ai-usage/usage-store'),
      import('@ai-usage/report-core/usage-row'),
    ]);
    const machine = { id: 'audit-fixture-machine', label: 'Audit Fixture Machine' };
    const storage = localHistory.createLocalHistoryStorage(temporaryHome);
    await Effect.runPromise(
      machineConfig.writeMachineConfig(machine).pipe(Effect.provideService(localHistory.LocalHistoryStorage, storage)),
    );

    let randomState = FIXTURE_SEED;
    const random = (): number => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) % 4_294_967_296;
      if (randomState < 0) {
        randomState += 4_294_967_296;
      }
      return randomState / 4_294_967_296;
    };

    const rows = Array.from({ length: FIXTURE_ROW_COUNTS[1] }, (_, index) => {
      const harness = harnesses[Math.floor(random() * harnesses.length)] ?? harnesses[0];
      const projectIndex = Math.floor(random() * projectNames.length);
      const project = projectNames[projectIndex] ?? projectNames[0];
      const campaignIndex = Math.floor(index / 5);
      const campaignRootId = `campaign-${campaignIndex * 5}`;
      const sourceSessionId = `session-${index}`;
      const date = new Date(Date.UTC(2025, 0, 1) + index * 60_000);
      const durationMs = 30_000 + Math.floor(random() * 7_200_000);
      const normalized = usageRow.normalizeUsageRow({
        calls: 1 + Math.floor(random() * 30),
        cost: usageRow.approximateApiCost,
        date,
        durationMs,
        endDate: new Date(date.getTime() + durationMs),
        harness: harness.label,
        linesAdded: Math.floor(random() * 500),
        linesDeleted: Math.floor(random() * 200),
        model: harness.model,
        name: `Synthetic ${harness.label} session ${index}`,
        project,
        provider: harness.provider,
        subagent: index % 5 !== 0,
        tokens: {
          in: 100 + Math.floor(random() * 50_000),
          out: 50 + Math.floor(random() * 10_000),
          cr: Math.floor(random() * 100_000),
          cw: Math.floor(random() * 5000),
        },
        tools: Math.floor(random() * 100),
        turns: 1 + Math.floor(random() * 50),
      });
      return {
        ...normalized,
        source: {
          harnessKey: harness.key,
          ...(index % 5 === 0 ? {} : { parentSourceSessionId: campaignRootId }),
          rootSourceSessionId: campaignRootId,
          sourcePath: path.join(temporaryHome, 'projects', project),
          sourceSessionId,
        },
      };
    });

    for (const project of projectNames) {
      mkdirSync(path.join(temporaryHome, 'projects', project, '.git'), { recursive: true });
    }

    const importMeasurements: Record<string, Measurement> = {};
    for (const rowCount of FIXTURE_ROW_COUNTS) {
      let repetition = 0;
      importMeasurements[String(rowCount)] = await measure(async () => {
        const dbPath = path.join(temporaryHome, 'measurements', `${rowCount}-${repetition}.sqlite`);
        repetition += 1;
        await Effect.runPromise(
          usageStore.importLocalRows({
            dbPath,
            machine,
            rows: rows.slice(0, rowCount),
          }),
        );
      });
    }

    const reportOptions = {
      limit: null,
      minTokens: 1,
      project: null,
      since: null,
      sort: 'date' as const,
    };
    let payloadBytes = 0;
    const reportPayload = await measure(() => {
      const prepared = reportData.prepareUsageReport(rows, reportOptions);
      const payload = reportData.createUsageReportPayload(
        prepared,
        reportOptions,
        new Date('2026-07-13T00:00:00.000Z'),
      );
      payloadBytes = Buffer.byteLength(JSON.stringify(payload));
    });

    await Effect.runPromise(
      usageStore.importLocalRows({
        dbPath: usageStore.usageStorePath(temporaryHome),
        machine,
        rows,
      }),
    );
    const skillsStartedAt = performance.now();
    const skillsServerPath = path.join(process.cwd(), 'apps/web/src/server/skills.server.ts');
    const skillsServer = await import(pathToFileURL(skillsServerPath).href);
    const skillsResult = await skillsServer.readKnownSkillProjectPathsForServer();
    const skillsFirstLoadMs = Number((performance.now() - skillsStartedAt).toFixed(3));

    const artifactHeadroomBytes = Math.ceil(payloadBytes * 1.5);
    const reportArtifactBudgetBytes = Math.max(MIN_REPORT_ARTIFACT_BUDGET_BYTES, nextPowerOfTwo(artifactHeadroomBytes));
    const output = {
      fixture: {
        campaignSize: 5,
        harnesses: harnesses.map((harness) => harness.key),
        measuredRepetitions: MEASURED_REPETITIONS,
        projects: projectNames,
        rowCounts: FIXTURE_ROW_COUNTS,
        seed: FIXTURE_SEED,
        warmupRepetitions: WARMUP_REPETITIONS,
      },
      frozenBudgets: {
        importExistingRowLookupQueries: Object.fromEntries(
          FIXTURE_ROW_COUNTS.map((rowCount) => [
            String(rowCount),
            Math.ceil(rowCount / IMPORT_LOOKUP_BUDGET_BATCH_SIZE),
          ]),
        ),
        maxReportRunnerArtifactBytes: reportArtifactBudgetBytes,
        maxSessionPageRows: MAX_SESSION_PAGE_ROWS,
        overviewRefreshBytes: OVERVIEW_REFRESH_BUDGET_BYTES,
        servedBootstrapBytes: SERVED_BOOTSTRAP_BUDGET_BYTES,
        sessionPageRefreshBytes: SESSION_PAGE_REFRESH_BUDGET_BYTES,
      },
      measurements: {
        importRows: importMeasurements,
        reportPayload: { bytes: payloadBytes, ...reportPayload },
        skillsFirstLoad: {
          datasetCollectionRuns: true,
          durationMs: skillsFirstLoadMs,
          fullPayloadSerializationRuns: true,
          ok: skillsResult.ok,
          projectPaths: skillsResult.ok ? skillsResult.data.length : 0,
        },
      },
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(temporaryHome, { force: true, recursive: true });
  }
};

await run();
