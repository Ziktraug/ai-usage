import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

const writeCodexFixture = async (home: string): Promise<void> => {
  const sessionsDirectory = path.join(home, '.codex/sessions/2026');
  await mkdir(sessionsDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(home, '.codex/session_index.jsonl'),
      `${[
        { id: 'static-session', thread_name: 'Static report session' },
        { id: 'other-session', thread_name: 'Other report session' },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    ),
    writeFile(
      path.join(sessionsDirectory, 'static-session.jsonl'),
      [
        {
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { cwd: '/work/static-fixture', id: 'static-session' },
        },
        {
          timestamp: '2026-07-01T10:01:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex' },
        },
        {
          timestamp: '2026-07-01T10:02:00.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ input_text: 'Verify the static report' }],
          },
        },
        {
          timestamp: '2026-07-01T10:03:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 5,
                input_tokens: 25,
                output_tokens: 10,
                total_tokens: 35,
              },
            },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    ),
    writeFile(
      path.join(sessionsDirectory, 'other-session.jsonl'),
      [
        {
          timestamp: '2026-07-02T10:00:00.000Z',
          type: 'session_meta',
          payload: { cwd: '/work/other-fixture', id: 'other-session' },
        },
        {
          timestamp: '2026-07-02T10:01:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.3-codex' },
        },
        {
          timestamp: '2026-07-02T10:02:00.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ input_text: 'Keep this row out of the static filter result' }],
          },
        },
        {
          timestamp: '2026-07-02T10:03:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                cached_input_tokens: 2,
                input_tokens: 20,
                output_tokens: 8,
                total_tokens: 30,
              },
            },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    ),
  ]);
};

test('opens a self-contained report from file without network or dynamic assets', async ({ page }) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ai-usage-static-html-'));
  const home = path.join(fixtureRoot, 'home');
  const reportPath = path.join(fixtureRoot, 'report.html');
  await mkdir(home);

  try {
    await writeCodexFixture(home);
    const { stdout } = await execFileAsync(
      'bun',
      ['apps/cli/src/main.ts', '--html', '--harness', 'codex', '--no-cursor'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    await writeFile(reportPath, stdout, { mode: 0o600 });

    const requests: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const reportUrl = pathToFileURL(reportPath).href;
    await page.goto(reportUrl);
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
    await expect(page.getByText('2 / 2 sessions', { exact: true })).toBeVisible();

    const filter = page.getByRole('textbox', {
      name: 'Filter sessions by title, project, model, provider, or harness',
    });
    await filter.fill('static-fixture');
    await expect(filter).toHaveValue('static-fixture');
    await expect(page.getByText('1 / 2 sessions', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Sessions' }).click();
    await page.locator('tbody tr').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();

    expect(requests).toEqual([reportUrl]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
