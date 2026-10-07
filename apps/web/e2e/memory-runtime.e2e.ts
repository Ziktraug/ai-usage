import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import {
  parseDistillationBrowsePage,
  parseDistillationDiscoveryPreview,
} from '@ai-usage/platform-core/distillation-discovery';
import {
  type DistillationLease,
  distillationObject,
  parseSessionAnalysis,
  type SessionAnalysisContent,
} from '@ai-usage/platform-core/session-distillation';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Response, test } from '@playwright/test';
import { decodeRpcResponseBody } from './rpc-test-transport';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../../..');
const finalValidation = '12 pass, 0 fail';
const finalDecision = 'Replace the cache with direct reads; the initial cache decision is superseded.';
interface RuntimeMetadata {
  databasePath: string;
  homeDirectory: string;
  projectId: string;
  selection: { revision: string; rowId: string };
  sourceFile: string;
  stateDirectory: string;
}
let runtime: ChildProcessWithoutNullStreams;
let web: ChildProcessWithoutNullStreams;
let metadata: RuntimeMetadata;
let fixtureEnvironment: NodeJS.ProcessEnv;
const logs: string[] = [];
const waitLine = (process: ChildProcessWithoutNullStreams, match: (line: string) => boolean): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = createInterface({ input: process.stdout });
    const timer = setTimeout(() => {
      reader.close();
      reject(new Error('Isolated runtime did not announce readiness within 20 seconds.'));
    }, 20_000);
    reader.on('line', (line) => {
      logs.push(line);
      if (match(line)) {
        clearTimeout(timer);
        reader.close();
        resolve(line);
      }
    });
    process.once('error', (error) => {
      clearTimeout(timer);
      reader.close();
      reject(error);
    });
  });
const cli = async (...args: string[]): Promise<unknown> => {
  const { stdout } = await execute('bun', ['--no-env-file', 'apps/cli/src/main.ts', 'analyses', ...args], {
    cwd: root,
    env: fixtureEnvironment,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};
const restart = async () => {
  const restarted = waitLine(runtime, (line) => line === 'synthetic-distillation-restarted');
  runtime.kill('SIGHUP');
  await restarted;
};
const stop = async (child: ChildProcessWithoutNullStreams | undefined) => {
  if (!child?.pid) {
    return;
  }
  const done =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, value);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw error;
      }
    }
  };
  const deadline = setTimeout(() => signal('SIGKILL'), 5000);
  signal('SIGTERM');
  await done;
  clearTimeout(deadline);
};

test.beforeAll(async () => {
  runtime = spawn('bun', ['--no-env-file', 'apps/usage-engine/src/fixtures/distillation-browser.ts'], {
    cwd: root,
    env: { ...process.env, VITE_AI_USAGE_E2E: '0', VITE_AI_USAGE_DEMO: '0' },
    stdio: 'pipe',
    detached: true,
  });
  runtime.stderr.on('data', (chunk) => logs.push(String(chunk)));
  metadata = JSON.parse(
    await waitLine(runtime, (line) => line.startsWith('{') && line.includes('synthetic-distillation-ready')),
  ) as RuntimeMetadata;
  fixtureEnvironment = {
    ...process.env,
    AI_USAGE_HOME: metadata.homeDirectory,
    AI_USAGE_ENGINE_STATE_DIR: metadata.stateDirectory,
    AI_USAGE_DATABASE_PATH: metadata.databasePath,
    VITE_AI_USAGE_E2E: '0',
    VITE_AI_USAGE_DEMO: '0',
    AI_USAGE_SVELTEKIT_PRIVATE_E2E_OVERRIDES: '0',
    AI_USAGE_SVELTEKIT_PHASE: 'dev',
    BROWSER: 'none',
    PORT: '4179',
  };
  const command =
    process.env.AI_USAGE_MEMORY_BROWSER_PRODUCTION === '1'
      ? ['--no-env-file', 'start.mjs']
      : ['--no-env-file', '--bun', 'vite', '--host', '127.0.0.1', '--port', '4179', '--strictPort'];
  web = spawn('bun', command, {
    cwd: path.join(root, 'apps/web'),
    env: fixtureEnvironment,
    stdio: 'pipe',
    detached: true,
  });
  web.stderr.on('data', (chunk) => logs.push(String(chunk)));
  await waitLine(web, (line) => line.includes('127.0.0.1:4179'));
});
test.afterAll(async () => {
  await stop(web);
  await stop(runtime);
});
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring even when the hook only uses testInfo.
test.afterEach(async ({}, testInfo) => {
  await testInfo.attach('runtime-log.txt', { body: logs.join('\n'), contentType: 'text/plain' });
});

test('new local store to durable account, verified evidence, edited proposal and accepted knowledge', async ({
  page,
  context,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/memory');
  await expect(page.getByRole('heading', { name: 'Your session library starts here' })).toBeVisible();
  await page.getByLabel('Project to analyse').selectOption({ label: 'Synthetic ai-usage' });
  const discovered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/rpc/sessionDistillation/discover',
  );
  await page.getByRole('button', { name: 'Preview sessions' }).click();
  const preview = parseDistillationDiscoveryPreview(decodeRpcResponseBody(await (await discovered).text()));
  expect(preview.selections).toHaveLength(1);
  await page.getByRole('button', { name: 'Copy skill instruction for 1 session' }).click();
  await expect(page.getByRole('button', { name: 'Instruction copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(preview.prepareCommand);
  await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No accepted knowledge in this scope' })).toBeVisible();

  const prepared = distillationObject(
    await cli(
      'prepare',
      '--selection',
      preview.selectionToken,
      '--row',
      preview.selections[0]!.rowId,
      '--authorize-provider-processing',
    ),
  );
  const jobId = String((prepared.jobs as { id: string }[])[0]!.id);
  const claim = async () => (await cli('claim', '--project', preview.projectId, '--job', jobId)) as DistillationLease;
  let lease = await claim();
  const checkpoint: SessionAnalysisContent = {
    schemaVersion: 1,
    summary: {
      text: 'The investigation remains in progress; initial claims are unverified.',
      basis: 'unknown',
      evidence: [],
    },
    episodes: [],
    abstention: null,
  };
  let finalContent = checkpoint;
  let saved: ReturnType<typeof parseSessionAnalysis> | undefined;
  let segments = 0;
  const submit = async (kind: 'advance' | 'submit', current: DistillationLease, content: SessionAnalysisContent) => {
    const file = path.join(metadata.stateDirectory, 'browser-submission.json');
    const value = {
      kind,
      projectId: preview.projectId,
      jobId,
      leaseId: current.leaseId,
      packetDigest: current.packet.packetDigest,
      extractorVersion: current.extractorVersion,
      snapshotDigest: current.packet.source.version.digest,
      segmentIndex: current.packet.window!.index,
      content,
    };
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    return await cli('submit', '--file', file);
  };
  for (let step = 0; step < 8; step += 1) {
    await testInfo.attach(`packet-${step}.json`, {
      body: JSON.stringify(lease.packet),
      contentType: 'application/json',
    });
    if (lease.job.progress?.stage === 'consolidation') {
      saved = parseSessionAnalysis(await submit('submit', lease, finalContent));
      expect(parseSessionAnalysis(await submit('submit', lease, finalContent)).id).toBe(saved.id);
      break;
    }
    segments += 1;
    expect(Buffer.byteLength(JSON.stringify(lease.packet))).toBeLessThanOrEqual(256 * 1024);
    const evidence = lease.packet.events.find((event) => event.text === finalValidation);
    const decision = lease.packet.events.find((event) => event.text === finalDecision);
    if (evidence && decision) {
      finalContent = {
        schemaVersion: 1,
        summary: {
          text: 'Direct reads replace the stale cache after recorded validation.',
          basis: 'observed',
          evidence: [{ eventId: evidence.id, quote: finalValidation }],
        },
        episodes: [
          {
            id: 'direct-reads',
            objective: { text: 'Repair stale reads.', basis: 'unknown', evidence: [] },
            attempts: [
              {
                text: 'An initial claim of success was superseded by recorded verification.',
                basis: 'inferred',
                evidence: [],
              },
            ],
            decisions: [
              { text: finalDecision, basis: 'reported', evidence: [{ eventId: decision.id, quote: finalDecision }] },
            ],
            difficulties: [],
            entryPoints: [],
            openQuestions: [],
            result: {
              status: 'observed-success',
              assertion: {
                text: finalValidation,
                basis: 'observed',
                evidence: [{ eventId: evidence.id, quote: finalValidation }],
              },
            },
          },
        ],
        abstention: null,
      };
    }
    await submit('advance', lease, finalContent);
    lease = await claim();
    if (segments === 1) {
      const oldDigest = lease.packet.packetDigest;
      await restart();
      await cli('retry', '--project', preview.projectId, '--job', jobId);
      lease = await claim();
      expect(lease.packet.packetDigest).toBe(oldDigest);
    }
  }
  expect(segments).toBeGreaterThan(1);
  expect(saved).toBeDefined();
  if (!saved) {
    throw new Error('Consolidation did not publish within the fixed test step budget.');
  }
  expect(saved.coverage.includedEvents).toBeGreaterThan(256);
  expect(saved.source.version.bytes).toBeGreaterThan(4 * 1024 * 1024);
  await restart();
  await page.goto('/memory');
  const account = page.locator(`[data-memory-analysis="${saved.id}"]`);
  await expect(account).toBeVisible();
  await account.click();
  await expect(page.locator('[data-memory-analysis-detail]')).toBeVisible();
  await expect(page.getByText(finalDecision, { exact: true })).toBeVisible();
  const durableUrl = page.url();
  await page.reload();
  await expect(page.getByText(finalDecision, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Evidence 1', exact: true }).first().click();
  await expect(page.locator('[data-session-analysis-evidence] pre')).toContainText(finalValidation);
  const proof = distillationObject(
    await cli(
      'evidence',
      '--project',
      preview.projectId,
      '--id',
      saved.id,
      '--event',
      saved.content.summary.evidence[0]!.eventId,
    ),
  );
  expect(proof.status).toBe('available');
  await testInfo.attach('memory-desktop.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await testInfo.attach('memory-mobile.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).include('[data-route-shell="memory"]').analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByText('Source session and provenance', { exact: true }).click();
  await page.getByRole('link', { name: 'Open source session', exact: true }).click();
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  await expect(page.getByText(finalDecision, { exact: true })).toBeVisible();
  await page.goto(durableUrl);
  await expect(page.getByText(finalDecision, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Propose as knowledge', exact: true }).first().click();
  await page.getByLabel('Knowledge title', { exact: true }).fill('Prefer direct reads for stale cache repair');
  await page
    .getByLabel('Reusable formulation')
    .fill('When stale cache behavior persists, prefer direct reads and verify the recorded test output.');
  await page.getByRole('checkbox', { name: 'Keep this knowledge on this device', exact: false }).check();
  await page.getByRole('button', { name: 'Submit for human review' }).click();
  await expect(page.getByText('Proposal saved for review.')).toBeVisible();
  await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No accepted knowledge in this scope' })).toBeVisible();
  await page.getByRole('link', { name: 'Pending review', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Read source analysis and evidence' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit before accepting' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Verify direct reads before reusing the lesson');
  await page.getByRole('button', { name: 'Accept proposal' }).click();
  await expect(page.getByText('No Memory proposals need review.')).toBeVisible();
  await restart();
  await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify direct reads before reusing the lesson' })).toBeVisible();
  await page.getByLabel('Memory query').fill('direct reads');
  await page.getByRole('button', { name: 'Search Memory' }).click();
  await expect(page.getByRole('heading', { name: 'Verify direct reads before reusing the lesson' })).toBeVisible();
  await page.goto(durableUrl);
  await expect(page.getByText(finalDecision, { exact: true })).toBeVisible();
  await rm(metadata.sourceFile);
  await page.reload();
  await page.getByRole('button', { name: 'Evidence 1', exact: true }).first().click();
  await expect(
    page.getByText('Source unavailable. The original passage cannot be read on this machine.'),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
  await testInfo.attach('runtime-log.txt', { body: logs.join('\n'), contentType: 'text/plain' });
});

test('160 real saved accounts stay bounded through eviction, selection, filters and history navigation', async ({
  page,
}, testInfo) => {
  const ready = waitLine(runtime, (line) => line.includes('synthetic-volume-ready'));
  runtime.kill('SIGUSR1');
  const library = JSON.parse(await ready) as {
    analyses: { id: string; projectId: string; summary: string }[];
    otherProjectId: string;
  };
  expect(library.analyses).toHaveLength(160);
  const responses: { bytes: number; count: number; ids: string[] }[] = [];
  const collectResponse = async (response: Response) => {
    if (new URL(response.url()).pathname === '/rpc/sessionDistillation/browse' && response.ok()) {
      const body = await response.text();
      const result = parseDistillationBrowsePage(decodeRpcResponseBody(body));
      responses.push({
        bytes: Buffer.byteLength(body),
        count: result.items.length,
        ids: result.items.map((item) => item.id),
      });
    }
  };
  page.on('response', collectResponse);
  await page.goto('/memory?q=Library%20account');
  const list = page.locator('[data-memory-analysis-list]');
  const rows = list.locator('[data-memory-analysis]');
  await expect(rows.first()).toBeVisible();
  const originalId = await rows.first().getAttribute('data-memory-analysis');
  await rows.first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get('analysis')).toBe(originalId);
  const detail = page.locator('[data-memory-analysis-detail]');
  await expect(detail).toBeVisible();
  let largestDom = 0;
  for (let step = 0; step < 12; step += 1) {
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(async () => Number(await rows.last().getAttribute('data-analysis-index')))
      .toBeGreaterThanOrEqual(Math.min(15 + step * 20, 159));
    if (step < 7) {
      await expect.poll(() => responses.length).toBeGreaterThanOrEqual(step + 2);
    }
    largestDom = Math.max(largestDom, await rows.count());
    expect(await rows.count()).toBeLessThanOrEqual(14);
    if (Number(await rows.last().getAttribute('data-analysis-index')) === 159) {
      break;
    }
  }
  await expect(rows.last()).toHaveAttribute('data-analysis-index', '159');
  expect(responses.length).toBeGreaterThan(5);
  expect(responses.every((response) => response.bytes <= 132 * 1024 && response.count <= 20)).toBe(true);
  page.off('response', collectResponse);
  const browsedIds = responses.flatMap((response) => response.ids);
  expect(browsedIds).toHaveLength(160);
  expect(new Set(browsedIds).size).toBe(160);
  await expect(detail).toBeVisible();
  expect(new URL(page.url()).searchParams.get('analysis')).toBe(originalId);
  const selectedId = await rows.last().getAttribute('data-memory-analysis');
  await rows.last().click();
  await expect.poll(() => new URL(page.url()).searchParams.get('analysis')).toBe(selectedId);
  const lateUrl = page.url();
  const selected = library.analyses.find((analysis) => analysis.id === new URL(lateUrl).searchParams.get('analysis'))!;
  await expect(detail.getByText(selected.summary, { exact: true })).toBeVisible();
  for (let step = 0; step < 8; step += 1) {
    await list.evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollTop - 20 * 148);
    });
    await expect.poll(async () => await rows.count()).toBeGreaterThan(0);
    await expect(page.getByText('Loading more saved accounts…')).toBeHidden();
  }
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(list.locator('[data-analysis-index="0"]')).toBeVisible();
  await expect(detail.getByText(selected.summary, { exact: true })).toBeVisible();
  const first = list.locator('[data-analysis-index="0"]');
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(list.locator('[data-analysis-index="1"]')).toBeFocused();
  await first.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('analysis')).toBe(originalId);
  await page.goBack();
  await expect(detail.getByText(selected.summary, { exact: true })).toBeVisible();
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('analysis')).toBe(originalId);
  await page.goto(lateUrl);
  await page.reload();
  await expect(detail.getByText(selected.summary, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Evidence 1', exact: true }).click();
  await expect(
    page.getByText('Access to this source is denied. The retained historical quotation remains readable.'),
  ).toBeVisible();
  await page.getByLabel('Project filter').selectOption(library.otherProjectId);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(library.otherProjectId);
  await expect(rows.first()).toContainText('Synthetic second project');
  await page.getByLabel('Search session accounts').fill('Library account 007');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Library account 007');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Partial source coverage');
  await page.goto('/memory?since=not-a-date');
  await expect(page.getByRole('alert')).toContainText('invalid date');
  const volumePath = testInfo.outputPath('library-volume.json');
  await writeFile(
    volumePath,
    JSON.stringify(
      { seeded: 160, projects: 2, largestDom, uniqueResults: new Set(browsedIds).size, responses },
      null,
      2,
    ),
  );
  await testInfo.attach('library-volume.json', { path: volumePath, contentType: 'application/json' });
});
