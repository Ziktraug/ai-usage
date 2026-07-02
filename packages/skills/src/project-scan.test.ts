import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanProjectSkills } from '.';

const writeSkill = async (directory: string, name: string, description = 'Helps with examples') => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---
name: ${name}
description: ${description}
---
# ${name}
`,
    'utf8',
  );
};

describe('project skill scans', () => {
  test('observes owned directories and symlink placements without mutating projects', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-skills-'));
    try {
      const projectPath = path.join(root, 'project');
      const sourceRepoPath = path.join(root, 'source');
      const claudeSkills = path.join(projectPath, '.claude', 'skills');
      const agentsSkills = path.join(projectPath, '.agents', 'skills');
      const globalSkill = path.join(sourceRepoPath, 'skills', 'global-skill');
      const foreignSkill = path.join(root, 'foreign', 'foreign-skill');
      const projectLocalSkill = path.join(projectPath, 'tools', 'local-skill');

      await writeSkill(path.join(claudeSkills, 'owned-skill'), 'owned-skill');
      await writeSkill(globalSkill, 'global-skill');
      await writeSkill(foreignSkill, 'foreign-skill');
      await writeSkill(projectLocalSkill, 'local-skill');
      await mkdir(agentsSkills, { recursive: true });
      await symlink(globalSkill, path.join(agentsSkills, 'global-skill'));
      await symlink(foreignSkill, path.join(agentsSkills, 'foreign-skill'));
      await symlink(projectLocalSkill, path.join(claudeSkills, 'local-skill'));

      const inventories = await scanProjectSkills({ projectPaths: [projectPath], sourceRepoPath });

      expect(inventories).toHaveLength(1);
      expect(inventories[0]?.diagnostics).toEqual([]);
      expect(inventories[0]?.observations.map((observation) => [observation.name, observation.placement])).toEqual([
        ['local-skill', 'project-symlink'],
        ['owned-skill', 'owned-directory'],
        ['foreign-skill', 'external-symlink'],
        ['global-skill', 'symlink-to-source'],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('missing project skill directories are empty without diagnostics', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-empty-'));
    try {
      const inventories = await scanProjectSkills({ projectPaths: [projectPath] });

      expect(inventories[0]?.observations).toEqual([]);
      expect(inventories[0]?.diagnostics).toEqual([]);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  test('invalid project skill markdown is reported on the observation', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-invalid-'));
    try {
      const skillPath = path.join(projectPath, '.claude', 'skills', 'invalid-skill');
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        path.join(skillPath, 'SKILL.md'),
        `---
name: other-skill
---
# Invalid
`,
        'utf8',
      );

      const inventories = await scanProjectSkills({ projectPaths: [projectPath] });

      expect(inventories[0]?.observations[0]?.validationStatus).toBe('invalid');
      expect(inventories[0]?.observations[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'MissingSkillDescription',
        'SkillNameMismatch',
      ]);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});
