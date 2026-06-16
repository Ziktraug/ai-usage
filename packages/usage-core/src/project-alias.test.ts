import { describe, expect, test } from 'bun:test';
import { applyProjectAliases } from './project-alias';
import type { Row } from './types';

const row = (project: string, sourcePath?: string): Row =>
  ({
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
    source: { harnessKey: 'codex', sourceSessionId: 'session-1', sourcePath },
  }) as Row;

describe('project aliases', () => {
  test('applies first matching alias against source paths', () => {
    const rows = applyProjectAliases(
      [row('exalibur-spike', '/Users/nathan/tmp/exalibur-spike')],
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
});
