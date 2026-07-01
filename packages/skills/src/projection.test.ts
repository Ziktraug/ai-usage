import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyProjectionAction,
  buildDefaultSkillTargets,
  isProjectionHealthy,
  planProjection,
  type SkillTarget,
  type SourceSkill,
  scanTargetProjections,
} from '.';

const makeSkill = (overrides: Partial<SourceSkill> = {}): SourceSkill => ({
  description: 'Helps with examples',
  diagnostics: [],
  enabled: true,
  manifest: {
    description: 'Helps with examples',
    fields: [],
    markdown: '# Example\n',
    name: 'example-skill',
  },
  name: 'example-skill',
  path: '/source/skills/example-skill',
  skillMdPath: '/source/skills/example-skill/SKILL.md',
  validationStatus: 'valid',
  ...overrides,
});

const makeTarget = (targetPath: string, overrides: Partial<SkillTarget> = {}): SkillTarget => ({
  enabled: true,
  id: 'codex',
  kind: 'standard-interop',
  label: 'Codex',
  missing: false,
  observed: true,
  path: targetPath,
  scope: 'system',
  ...overrides,
});

describe('target observation and projections', () => {
  test('builds conservative default runtime targets', () => {
    const targets = buildDefaultSkillTargets('/home/user');

    expect(targets.map((target) => [target.id, target.enabled, target.path])).toEqual([
      ['standard-agents', true, '/home/user/.agents/skills'],
      ['claude-code', true, '/home/user/.claude/skills'],
      ['codex', true, '/home/user/.codex/skills'],
      ['opencode', true, '/home/user/.config/opencode/skills'],
      ['github-copilot', false, '/home/user/.config/github-copilot/skills'],
      ['cursor', false, '/home/user/.cursor/skills'],
    ]);
  });

  test('classifies enabled missing projections as needing attention', async () => {
    const targetPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-target-'));
    try {
      const scan = await scanTargetProjections({
        skills: [makeSkill()],
        targets: [makeTarget(targetPath)],
      });

      expect(scan.projections[0]?.state).toBe('missing');
      expect(isProjectionHealthy(scan.projections[0])).toBe(false);
      expect(planProjection(makeSkill(), makeTarget(targetPath), scan.projections[0])).toMatchObject({
        type: 'create-symlink',
      });
    } finally {
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  test('creates managed symlinks for valid enabled skills', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-project-'));
    try {
      const sourcePath = path.join(root, 'source', 'skills', 'example-skill');
      const targetPath = path.join(root, 'target');
      await mkdir(sourcePath, { recursive: true });
      await mkdir(targetPath, { recursive: true });
      await writeFile(path.join(sourcePath, 'SKILL.md'), '# Example\n', 'utf8');

      const skill = makeSkill({ path: sourcePath, skillMdPath: path.join(sourcePath, 'SKILL.md') });
      const target = makeTarget(targetPath);
      const scan = await scanTargetProjections({ skills: [skill], targets: [target] });
      const action = planProjection(skill, target, scan.projections[0]);
      await applyProjectionAction(action);

      expect(await readlink(path.join(targetPath, 'example-skill'))).toBe(sourcePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses to mutate copied skill directories', async () => {
    const targetPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-target-'));
    try {
      await mkdir(path.join(targetPath, 'example-skill'));
      const skill = makeSkill();
      const target = makeTarget(targetPath);
      const scan = await scanTargetProjections({ skills: [skill], targets: [target] });

      expect(scan.projections[0]?.state).toBe('unmanaged-copy');
      expect(planProjection(skill, target, scan.projections[0])).toMatchObject({
        type: 'refuse-unmanaged-mutation',
      });
    } finally {
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  test('unlinks only managed symlinks for disabled skills', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-project-'));
    try {
      const sourcePath = path.join(root, 'source', 'skills', 'example-skill');
      const targetPath = path.join(root, 'target');
      const projectedPath = path.join(targetPath, 'example-skill');
      await mkdir(sourcePath, { recursive: true });
      await mkdir(targetPath, { recursive: true });
      await symlink(sourcePath, projectedPath);

      const skill = makeSkill({ enabled: false, path: sourcePath, validationStatus: 'invalid' });
      const target = makeTarget(targetPath);
      const scan = await scanTargetProjections({ skills: [skill], targets: [target] });
      const action = planProjection(skill, target, scan.projections[0]);
      await applyProjectionAction(action);

      await expect(lstat(projectedPath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
