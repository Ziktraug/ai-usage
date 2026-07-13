import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runKnownProjectSourcesRunner } from './known-project-sources-runner.server';

const request = { configCwd: '/tmp/config', harness: null, includeCursor: true } as const;

describe('known project-source runner', () => {
  test('parses a bounded streamed result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-known-project-runner-'));
    const runnerPath = path.join(root, 'runner.ts');
    try {
      await writeFile(
        runnerPath,
        'process.stdout.write(JSON.stringify({ projectGroups: [], sources: [], warnings: [] }));\n',
      );
      await expect(
        runKnownProjectSourcesRunner(request, { executable: process.execPath, runnerPath }),
      ).resolves.toEqual({ projectGroups: [], sources: [], warnings: [] });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('exposes observed child diagnostics to injected measurement traces', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-known-project-runner-'));
    const runnerPath = path.join(root, 'runner.ts');
    const diagnostics: string[] = [];
    try {
      await writeFile(
        runnerPath,
        `process.stderr.write('[perf] aiUsage.report.knownLocalProjectSources ok\\n');\nprocess.stdout.write(JSON.stringify({ projectGroups: [], sources: [], warnings: [] }));\n`,
      );
      await runKnownProjectSourcesRunner(request, {
        executable: process.execPath,
        onStderr: (chunk) => diagnostics.push(chunk),
        runnerPath,
      });

      expect(diagnostics.join('')).toContain('aiUsage.report.knownLocalProjectSources ok');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('terminates a runner whose stdout exceeds the configured budget', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-known-project-runner-'));
    const runnerPath = path.join(root, 'runner.ts');
    try {
      await writeFile(runnerPath, `process.stdout.write('x'.repeat(65));\n`);
      await expect(
        runKnownProjectSourcesRunner(request, {
          executable: process.execPath,
          maxStdoutBytes: 64,
          runnerPath,
        }),
      ).rejects.toThrow('exceeded 64 stdout bytes');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('rejects structurally invalid runner output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-known-project-runner-'));
    const runnerPath = path.join(root, 'runner.ts');
    try {
      await writeFile(runnerPath, `process.stdout.write('{}');\n`);
      await expect(runKnownProjectSourcesRunner(request, { executable: process.execPath, runnerPath })).rejects.toThrow(
        'invalid result',
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
