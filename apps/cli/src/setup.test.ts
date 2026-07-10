import { describe, expect, test } from 'bun:test';
import type { ProjectSource } from '@ai-usage/report-data';
import { setupHTML } from './setup';

const maliciousSource: ProjectSource = {
  gitRemote: '<img src=x onerror=alert(1)>',
  harness: 'Codex',
  harnesses: ['Codex'],
  harnessKey: 'codex',
  harnessKeys: ['codex'],
  id: 'source-1',
  machine: '<script>alert(1)</script>',
  machineId: 'machine-a',
  project: '<svg onload=alert(1)>',
  sessions: 1,
  sourcePath: '/tmp/<iframe src=javascript:alert(1)>',
  tokens: 10,
};

describe('setup HTML', () => {
  test('renders snapshot and config values through DOM text sinks', () => {
    const html = setupHTML(
      [maliciousSource],
      [{ name: '<img src=x onerror=alert(1)>', match: ['<script>alert(1)</script>'] }],
      [{ harness: '<svg onload=alert(1)>', message: '<iframe src=javascript:alert(1)>' }],
    );

    expect(html).not.toContain('.innerHTML');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('textContent = alias.name');
    expect(html).toContain('textContent = s.gitRemote');
  });
});
