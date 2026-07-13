import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseUsageSnapshot } from '@ai-usage/report-core/snapshot';
import { withCliSandbox } from './test-support/run-cli';

const codexHistory =
  JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'session_meta',
    payload: { cwd: '/work/fixture-project', id: 'fixture-thread' },
  }) +
  `\n${JSON.stringify({
    timestamp: '2026-01-01T00:04:00.000Z',
    payload: {
      info: { total_token_usage: { cached_input_tokens: 2, input_tokens: 12, output_tokens: 18, total_tokens: 30 } },
      type: 'token_count',
    },
  })}\n`;

test('runs stateful machine and snapshot commands in an isolated profile', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const first = await runCli(['machine']);
    const second = await runCli(['machine']);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);

    const labelled = await runCli(['machine', 'set-label', 'Fixture Machine']);
    expect(labelled.exitCode).toBe(0);
    expect(labelled.stdout).toContain('Fixture Machine');

    const home = path.join(root, 'profile');
    await mkdir(path.join(home, '.codex', 'sessions', '2026', '01', '01'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'sessions', '2026', '01', '01', 'fixture.jsonl'), codexHistory);
    const snapshotPath = path.join(root, 'snapshot.json');
    const snapshot = await runCli(['snapshot', '--no-cursor', '--out', snapshotPath]);
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stdout).toContain(snapshotPath);
    expect(parseUsageSnapshot(await readFile(snapshotPath, 'utf8')).rows).toHaveLength(1);
  });
});

test('renders a snapshot merge and rejects retired HTML arguments as real processes', async () => {
  await withCliSandbox(async ({ root, runCli }) => {
    const home = path.join(root, 'profile');
    await mkdir(path.join(home, '.codex', 'sessions', '2026', '01', '01'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'sessions', '2026', '01', '01', 'fixture.jsonl'), codexHistory);
    const snapshotPath = path.join(root, 'snapshot.json');
    const snapshot = await runCli(['snapshot', '--no-cursor', '--out', snapshotPath]);
    expect(snapshot.exitCode).toBe(0);

    const json = await runCli(['merge', snapshotPath, '--json']);
    const csv = await runCli(['merge', snapshotPath, '--csv']);
    expect(json.exitCode).toBe(0);
    expect(csv.exitCode).toBe(0);
    expect(csv.stdout).toContain('fixture-project');

    const reportHtml = await runCli(['--html']);
    const mergeHtml = await runCli(['merge', snapshotPath, '--html']);
    expect(reportHtml.exitCode).toBe(1);
    expect(reportHtml.stderr).toContain('Unknown option: --html');
    expect(mergeHtml.exitCode).toBe(1);
    expect(mergeHtml.stderr).toContain('Unknown option for merge: --html');
  });
});
