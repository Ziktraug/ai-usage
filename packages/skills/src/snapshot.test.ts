import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createSkillTargetDirectory,
  loadSkillManagementSnapshot,
  previewReconcileAllActiveSkills,
  reconcileAllActiveSkills,
  reconcileSkill,
  toggleSkillEnabled,
  writeSkillManagementConfig,
} from '.';

describe('skill management workflows', () => {
  test('returns a UI-safe unconfigured snapshot', async () => {
    const snapshot = await loadSkillManagementSnapshot({
      config: {},
      homePath: '/home/user',
    });

    expect(snapshot.configured).toBe(false);
    expect(snapshot.summary).toEqual({
      activeSkillCount: 0,
      diagnosticCount: 0,
      healthyProjectionCount: 0,
      skillCount: 0,
      targetCount: 0,
      unhealthyProjectionCount: 0,
      unmanagedEntryCount: 0,
    });
  });

  test('loads configured source, targets, and unhealthy missing projections', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-snapshot-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const targetPath = path.join(root, 'target');
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      await mkdir(skillPath, { recursive: true });
      await mkdir(targetPath, { recursive: true });
      await writeFile(
        path.join(skillPath, 'SKILL.md'),
        `---
name: example-skill
description: Helps with examples
---
# Example
`,
        'utf8',
      );

      const snapshot = await loadSkillManagementSnapshot({
        config: {
          skills: {
            sourceRepoPath,
            targets: {
              codex: {
                enabled: true,
                kind: 'standard-interop',
                path: targetPath,
                scope: 'system',
              },
            },
          },
        },
        homePath: root,
      });

      expect(snapshot.configured).toBe(true);
      expect(snapshot.skills).toHaveLength(1);
      expect(snapshot.projections[0]?.state).toBe('missing');
      expect(snapshot.summary.unhealthyProjectionCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('writes parsed skills config through an injected config writer', async () => {
    const writes: unknown[] = [];

    await writeSkillManagementConfig({
      config: { projectAliases: [] },
      skills: { sourceRepoPath: '/repo/source' },
      writeConfig: (nextConfig) => {
        writes.push(nextConfig);
        return Promise.resolve();
      },
    });

    expect(writes).toEqual([{ projectAliases: [], skills: { sourceRepoPath: '/repo/source' } }]);
  });

  test('toggle, target directory creation, and reconcile all operate on configured paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-workflow-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const targetPath = path.join(root, 'target');
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        path.join(skillPath, 'SKILL.md'),
        `---
name: example-skill
description: Helps with examples
---
# Example
`,
        'utf8',
      );

      await toggleSkillEnabled({ enabled: true, skillName: 'example-skill', sourceRepoPath });
      await createSkillTargetDirectory({ path: targetPath });
      const result = await reconcileAllActiveSkills({
        config: {
          skills: {
            sourceRepoPath,
            targets: {
              codex: {
                enabled: true,
                kind: 'standard-interop',
                path: targetPath,
                scope: 'system',
              },
            },
          },
        },
        homePath: root,
      });

      expect(result.actions.map((action) => action.type)).toEqual(['create-symlink']);
      await expect(Bun.file(path.join(targetPath, 'example-skill', 'SKILL.md')).text()).resolves.toContain('# Example');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reconcile all links warning skills and refuses invalid skills', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-warning-reconcile-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const targetPath = path.join(root, 'target');
      const warnedSkillPath = path.join(sourceRepoPath, 'skills', 'warned-skill');
      const invalidSkillPath = path.join(sourceRepoPath, 'skills', 'invalid-skill');
      await mkdir(warnedSkillPath, { recursive: true });
      await mkdir(invalidSkillPath, { recursive: true });
      await mkdir(targetPath, { recursive: true });
      // Unknown frontmatter field → warning status; still projectable.
      await writeFile(
        path.join(warnedSkillPath, 'SKILL.md'),
        `---
name: warned-skill
description: Warns but works
unknown-field: value
---
# Warned
`,
        'utf8',
      );
      // Frontmatter name mismatching the directory → invalid status.
      await writeFile(
        path.join(invalidSkillPath, 'SKILL.md'),
        `---
name: other-name
description: Broken manifest
---
# Invalid
`,
        'utf8',
      );

      const result = await reconcileAllActiveSkills({
        config: {
          skills: {
            sourceRepoPath,
            targets: {
              codex: {
                enabled: true,
                kind: 'standard-interop',
                path: targetPath,
                scope: 'system',
              },
            },
          },
        },
        homePath: root,
      });

      const warnedAction = result.actions.find((action) => action.skillName === 'warned-skill');
      expect(warnedAction?.type).toBe('create-symlink');
      await expect(Bun.file(path.join(targetPath, 'warned-skill', 'SKILL.md')).text()).resolves.toContain('# Warned');
      await expect(lstat(path.join(targetPath, 'invalid-skill'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('preview reconcile all plans actions without mutating the filesystem', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-preview-reconcile-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const targetAPath = path.join(root, 'target-a');
      const targetBPath = path.join(root, 'target-b');
      const safeSkillPath = path.join(sourceRepoPath, 'skills', 'safe-skill');
      await mkdir(safeSkillPath, { recursive: true });
      await mkdir(targetAPath, { recursive: true });
      await mkdir(path.join(targetBPath, 'safe-skill'), { recursive: true });
      await writeFile(
        path.join(safeSkillPath, 'SKILL.md'),
        `---
name: safe-skill
description: Creates a safe link
---
# Safe
`,
        'utf8',
      );

      const result = await previewReconcileAllActiveSkills({
        config: {
          skills: {
            sourceRepoPath,
            targets: {
              'target-a': {
                enabled: true,
                kind: 'standard-interop',
                path: targetAPath,
                scope: 'system',
              },
              'target-b': {
                enabled: true,
                kind: 'standard-interop',
                path: targetBPath,
                scope: 'system',
              },
            },
          },
        },
        homePath: root,
      });

      expect(result.actions.map((action) => action.type).sort()).toEqual([
        'create-symlink',
        'refuse-unmanaged-mutation',
      ]);
      // Nothing was applied: the planned symlink does not exist and the
      // unmanaged copy is untouched.
      await expect(lstat(path.join(targetAPath, 'safe-skill'))).rejects.toThrow();
      expect((await lstat(path.join(targetBPath, 'safe-skill'))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reconcile all applies safe actions while reporting refused unmanaged mutations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-mixed-reconcile-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const targetAPath = path.join(root, 'target-a');
      const targetBPath = path.join(root, 'target-b');
      const safeSkillPath = path.join(sourceRepoPath, 'skills', 'safe-skill');
      const blockedSkillPath = path.join(sourceRepoPath, 'skills', 'blocked-skill');
      await mkdir(safeSkillPath, { recursive: true });
      await mkdir(blockedSkillPath, { recursive: true });
      await mkdir(targetAPath, { recursive: true });
      await mkdir(path.join(targetBPath, 'blocked-skill'), { recursive: true });
      await writeFile(
        path.join(safeSkillPath, 'SKILL.md'),
        `---
name: safe-skill
description: Creates a safe link
---
# Safe
`,
        'utf8',
      );
      await writeFile(
        path.join(blockedSkillPath, 'SKILL.md'),
        `---
name: blocked-skill
description: Has unmanaged content
---
# Blocked
`,
        'utf8',
      );

      const result = await reconcileAllActiveSkills({
        config: {
          skills: {
            sourceRepoPath,
            targets: {
              'target-a': {
                enabled: true,
                kind: 'standard-interop',
                path: targetAPath,
                scope: 'system',
              },
              'target-b': {
                enabled: true,
                kind: 'standard-interop',
                path: targetBPath,
                scope: 'system',
              },
            },
          },
        },
        homePath: root,
      });

      expect(result.actions.map((action) => action.type)).toContain('refuse-unmanaged-mutation');
      expect(result.actions.map((action) => action.type)).toContain('create-symlink');
      expect(await Bun.file(path.join(targetAPath, 'safe-skill', 'SKILL.md')).text()).toContain('# Safe');
      expect((await lstat(path.join(targetBPath, 'blocked-skill'))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reconcile skill applies safe targets even when another target is refused', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-partial-skill-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const targetAPath = path.join(root, 'target-a');
      const targetBPath = path.join(root, 'target-b');
      const skillPath = path.join(sourceRepoPath, 'skills', 'mixed-skill');
      await mkdir(skillPath, { recursive: true });
      await mkdir(targetAPath, { recursive: true });
      await mkdir(path.join(targetBPath, 'mixed-skill'), { recursive: true });
      await writeFile(
        path.join(skillPath, 'SKILL.md'),
        `---
name: mixed-skill
description: Mixes safe and refused targets
---
# Mixed
`,
        'utf8',
      );

      const result = await reconcileSkill({
        config: {
          skills: {
            sourceRepoPath,
            targets: {
              'target-a': {
                enabled: true,
                kind: 'standard-interop',
                path: targetAPath,
                scope: 'system',
              },
              'target-b': {
                enabled: true,
                kind: 'standard-interop',
                path: targetBPath,
                scope: 'system',
              },
            },
          },
        },
        homePath: root,
        skillName: 'mixed-skill',
      });

      expect(result.actions.map((action) => action.type)).toEqual(['create-symlink', 'refuse-unmanaged-mutation']);
      expect(await Bun.file(path.join(targetAPath, 'mixed-skill', 'SKILL.md')).text()).toContain('# Mixed');
      expect((await lstat(path.join(targetBPath, 'mixed-skill'))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
