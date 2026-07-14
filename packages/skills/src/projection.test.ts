import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SkillTarget, SourceSkill } from './contracts';
import {
  applyProjectionAction,
  buildDefaultSkillTargets,
  isProjectionHealthy,
  planProjection,
  scanTargetProjections,
} from './projections';

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
      await applyProjectionAction(action, { privateStatePath: path.join(root, 'state') });

      expect(await readlink(path.join(targetPath, 'example-skill'))).toBe(sourcePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a target directory identity swap without touching the replacement tree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-target-swap-'));
    try {
      const sourcePath = path.join(root, 'source');
      const targetPath = path.join(root, 'target');
      const originalPath = path.join(root, 'target-original');
      await mkdir(sourcePath);
      await mkdir(targetPath);
      const skill = makeSkill({ path: sourcePath, skillMdPath: path.join(sourcePath, 'SKILL.md') });
      const target = makeTarget(targetPath);
      const scan = await scanTargetProjections({ skills: [skill], targets: [target] });
      const action = planProjection(skill, target, scan.projections[0]);

      await Bun.write(path.join(sourcePath, 'SKILL.md'), '# safe\n');
      await rename(targetPath, originalPath);
      await mkdir(targetPath);

      await expect(applyProjectionAction(action, { privateStatePath: path.join(root, 'state') })).rejects.toThrow(
        'identity changed',
      );
      expect(await readdir(targetPath)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
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
      await applyProjectionAction(action, { privateStatePath: path.join(root, 'state') });

      await expect(lstat(projectedPath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses to repair a symlink that changed after it was observed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-project-'));
    try {
      const sourcePath = path.join(root, 'source', 'skills', 'example-skill');
      const firstForeignPath = path.join(root, 'first-foreign');
      const secondForeignPath = path.join(root, 'second-foreign');
      const targetPath = path.join(root, 'target');
      const projectedPath = path.join(targetPath, 'example-skill');
      await mkdir(sourcePath, { recursive: true });
      await mkdir(firstForeignPath);
      await mkdir(secondForeignPath);
      await mkdir(targetPath);
      await symlink(firstForeignPath, projectedPath);

      const skill = makeSkill({ path: sourcePath, skillMdPath: path.join(sourcePath, 'SKILL.md') });
      const target = makeTarget(targetPath);
      const scan = await scanTargetProjections({ skills: [skill], targets: [target] });
      const action = planProjection(skill, target, scan.projections[0]);
      await rm(projectedPath);
      await symlink(secondForeignPath, projectedPath);

      await expect(applyProjectionAction(action, { privateStatePath: path.join(root, 'state') })).rejects.toThrow(
        'changed',
      );
      await expect(readlink(projectedPath)).resolves.toBe(secondForeignPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('preserves the observed symlink when creating its replacement fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-project-'));
    try {
      const sourcePath = path.join(root, 'source', 'skills', 'example-skill');
      const foreignPath = path.join(root, 'foreign');
      const targetPath = path.join(root, 'target');
      const projectedPath = path.join(targetPath, 'example-skill');
      await mkdir(sourcePath, { recursive: true });
      await mkdir(foreignPath);
      await mkdir(targetPath);
      await symlink(foreignPath, projectedPath);

      const skill = makeSkill({ path: sourcePath, skillMdPath: path.join(sourcePath, 'SKILL.md') });
      const target = makeTarget(targetPath);
      const scan = await scanTargetProjections({ skills: [skill], targets: [target] });
      const action = planProjection(skill, target, scan.projections[0]);
      if (action.type !== 'repair-symlink') {
        throw new Error('expected a repair action');
      }

      await expect(
        applyProjectionAction({ ...action, sourcePath: '\0invalid' }, { privateStatePath: path.join(root, 'state') }),
      ).rejects.toThrow();
      await expect(readlink(projectedPath)).resolves.toBe(foreignPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('never overwrites an interloper created during the claim-install gap', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-interloper-'));
    try {
      const sourcePath = path.join(root, 'source', 'skills', 'example-skill');
      const foreignPath = path.join(root, 'foreign');
      const interloperPath = path.join(root, 'interloper');
      const targetPath = path.join(root, 'target');
      const projectedPath = path.join(targetPath, 'example-skill');
      await mkdir(sourcePath, { recursive: true });
      await mkdir(foreignPath);
      await mkdir(interloperPath);
      await mkdir(targetPath);
      await symlink(foreignPath, projectedPath);
      const skill = makeSkill({ path: sourcePath, skillMdPath: path.join(sourcePath, 'SKILL.md') });
      const target = makeTarget(targetPath);
      const scan = await scanTargetProjections({ skills: [skill], targets: [target] });
      const action = planProjection(skill, target, scan.projections[0]);
      const readyPath = path.join(root, 'interloper-ready');
      const subprocess = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, 'test-fixtures', 'projection-interloper-subprocess.ts'),
          projectedPath,
          interloperPath,
          readyPath,
        ],
        { stderr: 'pipe', stdout: 'pipe' },
      );
      while (true) {
        try {
          await lstat(readyPath);
          break;
        } catch {
          await Bun.sleep(1);
        }
      }

      await expect(applyProjectionAction(action, { privateStatePath: path.join(root, 'state') })).rejects.toThrow();
      expect(await subprocess.exited).toBe(0);
      await expect(readlink(projectedPath)).resolves.toBe(interloperPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const actionKind of ['repair', 'unlink'] as const) {
    for (const replacementKind of ['directory', 'file'] as const) {
      test(`leaves a stale ${replacementKind} visible when a planned ${actionKind} target changed`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-stale-entry-'));
        try {
          const sourcePath = path.join(root, 'source', 'skills', 'example-skill');
          const foreignPath = path.join(root, 'foreign');
          const targetPath = path.join(root, 'target');
          const projectedPath = path.join(targetPath, 'example-skill');
          await mkdir(sourcePath, { recursive: true });
          await mkdir(foreignPath);
          await mkdir(targetPath);
          await symlink(actionKind === 'repair' ? foreignPath : sourcePath, projectedPath);
          const skill = makeSkill({
            enabled: actionKind !== 'unlink',
            path: sourcePath,
            skillMdPath: path.join(sourcePath, 'SKILL.md'),
          });
          const target = makeTarget(targetPath);
          const scan = await scanTargetProjections({ skills: [skill], targets: [target] });
          const action = planProjection(skill, target, scan.projections[0]);
          await rm(projectedPath);
          if (replacementKind === 'directory') {
            await mkdir(projectedPath);
          } else {
            await writeFile(projectedPath, 'stale external file', 'utf8');
          }

          await expect(applyProjectionAction(action, { privateStatePath: path.join(root, 'state') })).rejects.toThrow(
            'changed',
          );
          const replacementStat = await lstat(projectedPath);
          expect(replacementKind === 'directory' ? replacementStat.isDirectory() : replacementStat.isFile()).toBe(true);
          expect((await readdir(targetPath)).some((entry) => entry.endsWith('.old'))).toBe(false);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});
