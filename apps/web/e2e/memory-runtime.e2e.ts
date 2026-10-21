import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '../../..');
interface RuntimeMetadata {
  databasePath: string;
  homeDirectory: string;
  legacyLocator: string;
  projectId: string;
  proposalId: string;
  rejectedProposalId: string;
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
const restart = async () => {
  const restarted = waitLine(runtime, (line) => line === 'synthetic-memory-restarted');
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
  runtime = spawn('bun', ['--no-env-file', 'apps/usage-engine/src/fixtures/memory.ts'], {
    cwd: root,
    env: { ...process.env, VITE_AI_USAGE_E2E: '0', VITE_AI_USAGE_DEMO: '0' },
    stdio: 'pipe',
    detached: true,
  });
  runtime.stderr.on('data', (chunk) => logs.push(String(chunk)));
  metadata = JSON.parse(
    await waitLine(runtime, (line) => line.startsWith('{') && line.includes('synthetic-memory-ready')),
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

test('accepted Memory survives edited acceptance, rejection, restart and scoped search without source links', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/memory');
  await expect(page.getByRole('link', { name: 'Knowledge', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Analysed sessions', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No accepted knowledge in this scope' })).toBeVisible();
  await page.getByRole('link', { name: 'Pending review', exact: true }).click();
  const proposal = page.locator(`[data-memory-proposal="${metadata.proposalId}"]`);
  await expect(proposal.getByText(metadata.legacyLocator, { exact: true })).toBeVisible();
  await expect(proposal.locator('a')).toHaveCount(0);
  await proposal.getByRole('button', { name: 'Edit before accepting' }).click();
  await proposal.getByLabel('Title', { exact: true }).fill('Verify direct reads before reusing the lesson');
  await proposal.getByRole('button', { name: 'Accept proposal' }).click();
  await expect(proposal).toHaveCount(0);
  const rejected = page.locator(`[data-memory-proposal="${metadata.rejectedProposalId}"]`);
  await rejected.getByRole('button', { name: 'Reject proposal' }).click();
  await expect(rejected.getByText('Give a reason so this rejection remains reviewable.')).toBeVisible();
  await rejected.getByLabel('Rejection reason').fill('The recommendation has no supporting evidence.');
  await rejected.getByRole('button', { name: 'Reject proposal' }).click();
  await expect(page.getByText('No Memory proposals need review.')).toBeVisible();
  await restart();
  const knowledge = page.getByRole('link', { name: 'Knowledge', exact: true });
  await knowledge.click();
  // Reloading before client navigation settles would reload the review view instead.
  await expect(knowledge).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Verify direct reads before reusing the lesson' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reject an unsupported recommendation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Read complete accepted revision' }).click();
  const detail = page.getByRole('region', { name: 'Complete accepted revision' });
  await detail.getByText('Retained structured evidence', { exact: true }).click();
  await expect(detail.locator('pre')).toContainText(metadata.legacyLocator);
  await expect(page.locator('a[href*="analysis="]')).toHaveCount(0);
  await page.getByLabel('Project ID (optional)').fill('invalid');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a valid Project ID');
  await page.getByLabel('Project ID (optional)').fill(metadata.projectId);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(metadata.projectId);
  await expect(page.getByRole('heading', { name: 'Verify direct reads before reusing the lesson' })).toBeVisible();
  await page.getByLabel('Memory query').fill('direct reads');
  await page.getByRole('button', { name: 'Search Memory' }).click();
  await expect(page.getByRole('heading', { name: 'Verify direct reads before reusing the lesson' })).toBeVisible();
  await testInfo.attach('memory-desktop.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Read complete accepted revision' }).click();
  await detail.getByText('Retained structured evidence', { exact: true }).click();
  await page.getByText('Retained provenance', { exact: true }).click();
  await expect(detail.locator('pre')).toContainText('retained-source-'.repeat(40));
  await testInfo.attach('memory-mobile.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include('[data-route-shell="memory"]').analyze()).violations).toEqual([]);
  await page.getByLabel('Project ID (optional)').fill('');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBeNull();
  await page.goBack();
  await expect(page.getByLabel('Project ID (optional)')).toHaveValue(metadata.projectId);
  const beforeRetiredVisit = page.url();
  await page.goto('/memory?view=analyses&analysis=historical-account&cursor=retired-cursor');
  await expect(page).toHaveURL('/memory?view=knowledge');
  await expect(page.getByRole('heading', { name: 'Verify direct reads before reusing the lesson' })).toBeVisible();
  await expect(page.locator('a[href*="analysis="]')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(beforeRetiredVisit);
  await expect(page.getByLabel('Project ID (optional)')).toHaveValue(metadata.projectId);
  await page.goForward();
  await expect(page).toHaveURL('/memory?view=knowledge');
  await expect(page.locator('a[href*="analysis="]')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('a proposal past the first review page opens exactly through reload and history, and unknown links are refused', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const ready = waitLine(runtime, (line) => line.includes('synthetic-review-queue-ready'));
  runtime.kill('SIGUSR2');
  const queue = JSON.parse(await ready) as { proposalIds: string[]; targetProposalId: string };
  expect(queue.proposalIds).toHaveLength(105);
  const proposalId = queue.targetProposalId;
  const reviewReads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/rpc/memory/proposalReviews') {
      reviewReads.push(decodeURIComponent(request.url()));
    }
  });
  const addressedUrl = `/memory?view=review&proposal=${proposalId}`;
  await page.goto(addressedUrl);
  const cards = page.locator('[data-memory-proposal]');
  const target = page.locator('[data-memory-proposal-target]');
  await expect(target).toHaveAttribute('data-memory-proposal', proposalId);
  await expect(target).toContainText('Run the focused regression first');
  await expect(target).toBeFocused();
  await expect(cards.first()).toHaveAttribute('data-memory-proposal', proposalId);
  expect(reviewReads).toHaveLength(1);
  expect(reviewReads[0]).toContain(proposalId);
  expect(reviewReads[0]).not.toContain('cursor');
  await page.getByRole('link', { name: 'Newest proposals', exact: true }).click();
  await expect(cards).toHaveCount(100);
  await expect(target).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'More proposals', exact: true })).toBeVisible();
  await page.goBack();
  await expect(target).toHaveAttribute('data-memory-proposal', proposalId);
  await page.goForward();
  await expect(cards).toHaveCount(100);
  await page.goBack();
  await page.reload();
  await expect(target).toHaveAttribute('data-memory-proposal', proposalId);
  await expect(target).toBeFocused();
  expect((await new AxeBuilder({ page }).include('[data-route-shell="memory"]').analyze()).violations).toEqual([]);
  await target.getByRole('button', { name: 'Accept proposal' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('proposal')).toBeNull();
  await expect(cards).toHaveCount(100);
  const refusal = page.getByText('This Memory proposal is not pending review or is not accessible.');
  await page.goto(addressedUrl);
  await expect(refusal).toBeVisible();
  await page.goto(`/memory?view=review&proposal=${crypto.randomUUID()}`);
  await expect(refusal).toBeVisible();
  reviewReads.length = 0;
  await page.goto('/memory?view=review&proposal=not-a-proposal');
  await expect(refusal).toBeVisible();
  expect(reviewReads).toEqual([]);
  await page.getByRole('link', { name: 'Open the review queue', exact: true }).click();
  await expect(cards).toHaveCount(100);
  expect(pageErrors).toEqual([]);
});
