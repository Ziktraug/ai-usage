import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createSkillTargetDirectory,
  loadSkillManagementSnapshot,
  reconcileAllActiveSkills,
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
});
