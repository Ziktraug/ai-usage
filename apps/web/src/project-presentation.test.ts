import { describe, expect, test } from 'bun:test';
import { projectDataQualityLabel } from './project-presentation';

describe('project data-quality presentation', () => {
  test('classifies exact filename, worktree, and missing-project shapes case-insensitively', () => {
    expect(projectDataQualityLabel('usage.csv')).toBe('Filename-like');
    expect(projectDataQualityLabel('REPORT.CSV')).toBe('Filename-like');
    expect(projectDataQualityLabel('/tmp/imports/Usage.CsV')).toBe('Filename-like');
    expect(projectDataQualityLabel('agent-a15e8356ff54ade2a')).toBe('Worktree-like');
    expect(projectDataQualityLabel('WORKTREE-Feature-12')).toBe('Worktree-like');
    expect(projectDataQualityLabel('/repo/.claude/worktrees/agent-a1')).toBe('Worktree-like');
    expect(projectDataQualityLabel('(unknown)')).toBe('No detected project');
  });

  test('leaves ambiguous labels unbadged', () => {
    for (const label of [
      '',
      'report.csv.json',
      'agent-',
      'agent-a_b',
      'agent a',
      'worktree--',
      'my-agent-a1',
      'agent-a1 — Build Host',
      '(Unknown)',
    ]) {
      expect(projectDataQualityLabel(label)).toBeNull();
    }
  });
});
