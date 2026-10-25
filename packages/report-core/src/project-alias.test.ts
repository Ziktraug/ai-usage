import { describe, expect, test } from 'bun:test';
import { applyProjectAliases } from './project-alias';
import type { UsageRowWithOptionalSource } from './types';

const row = (project: string, sourcePath?: string): UsageRowWithOptionalSource => ({
  date: null,
  endDate: null,
  harness: 'Codex',
  provider: 'Codex API',
  name: 'session',
  model: 'codex',
  project,
  tokIn: 1,
  tokOut: 0,
  tokCr: 0,
  tokCw: 0,
  costActual: 0,
  costApprox: 0,
  costKnown: true,
  calls: 1,
  durationMs: null,
  turns: 1,
  tools: 0,
  linesAdded: null,
  linesDeleted: null,
  source: {
    harnessKey: 'codex',
    sourceSessionId: 'session-1',
    ...(sourcePath === undefined ? {} : { sourcePath }),
  },
});

describe('project aliases', () => {
  test('applies first matching alias against source paths', () => {
    const rows = applyProjectAliases(
      [row('exalibur-spike', '/Users/alex/tmp/exalibur-spike')],
      [
        { name: 'exalibur', match: ['*/exalibur-*'] },
        { name: 'other', match: ['*/exalibur-spike'] },
      ],
    );

    expect(rows[0]?.project).toBe('exalibur');
  });

  test('falls back to project basename when source path is missing', () => {
    const rows = applyProjectAliases([row('exalibur')], [{ name: 'exalibur-main', match: ['exalibur'] }]);

    expect(rows[0]?.project).toBe('exalibur-main');
  });

  test('matches every character but the * wildcard literally', () => {
    const aliased = (sourcePath: string, pattern: string) =>
      applyProjectAliases([row('raw', sourcePath)], [{ name: 'aliased', match: [pattern] }])[0]?.project;

    // `?`, `.`, `(`, `+` and `[` are path characters, not regular-expression syntax.
    expect(aliased('/work/proj?', '*/proj?')).toBe('aliased');
    expect(aliased('/work/pro', '*/proj?')).toBe('raw');
    expect(aliased('/work/a.b', '*/a.b')).toBe('aliased');
    expect(aliased('/work/aXb', '*/a.b')).toBe('raw');
    expect(aliased('/work/c++ (v2) [x]', '*/c++ (v2) [x]')).toBe('aliased');
    expect(aliased('/work/cc (v2) x', '*/c+ (v2) [x]')).toBe('raw');
    // `*` still spans any run of characters.
    expect(aliased('/work/deep/tree/name', '/work/*/name')).toBe('aliased');
  });
});
