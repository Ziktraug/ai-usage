import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
      expect(inventories[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'ExternalProjectSkillNotScanned',
      ]);
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

  test('scans project skills read-only without creating lock or recovery artifacts', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-read-only-'));
    const skillPath = path.join(projectPath, '.claude', 'skills', 'read-only-skill');
    try {
      await writeSkill(skillPath, 'read-only-skill');
      await chmod(skillPath, 0o555);

      const inventories = await scanProjectSkills({ projectPaths: [projectPath] });

      expect(inventories[0]?.observations.map((observation) => observation.name)).toEqual(['read-only-skill']);
      expect(await readdir(skillPath)).toEqual(['SKILL.md']);
    } finally {
      await chmod(skillPath, 0o755).catch(() => undefined);
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  test('classifies external symlinks without reading their markdown', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-skills-'));
    try {
      const projectPath = path.join(root, 'project');
      const runtimePath = path.join(projectPath, '.agents', 'skills');
      const foreignSkill = path.join(root, 'foreign', 'foreign-skill');
      await writeSkill(foreignSkill, 'foreign-skill', 'TOP SECRET EXTERNAL DESCRIPTION');
      await mkdir(runtimePath, { recursive: true });
      await symlink(foreignSkill, path.join(runtimePath, 'foreign-skill'));

      const inventories = await scanProjectSkills({ projectPaths: [projectPath] });
      const observation = inventories[0]?.observations[0];

      expect(observation?.placement).toBe('external-symlink');
      expect(observation?.description).toBe('');
      expect(observation?.tokenCount).toBeUndefined();
      expect(observation?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['ExternalProjectSkillNotScanned']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses an external symlink used as the project runtime skills directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-runtime-link-'));
    try {
      const projectPath = path.join(root, 'project');
      const externalRuntimePath = path.join(root, 'external-runtime');
      await mkdir(path.join(projectPath, '.agents'), { recursive: true });
      await writeSkill(path.join(externalRuntimePath, 'secret-skill'), 'secret-skill', 'TOP SECRET');
      await symlink(externalRuntimePath, path.join(projectPath, '.agents', 'skills'));

      const inventories = await scanProjectSkills({ projectPaths: [projectPath] });

      expect(inventories[0]?.observations).toEqual([]);
      expect(inventories[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'ExternalProjectSkillDirectoryNotScanned',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('streams and truncates project runtime entries at the configured budget', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-runtime-budget-'));
    try {
      for (let index = 0; index < 40; index += 1) {
        const skillName = `runtime-skill-${index.toString().padStart(2, '0')}`;
        await writeSkill(path.join(projectPath, '.claude', 'skills', skillName), skillName);
      }

      const inventories = await scanProjectSkills({
        projectPaths: [projectPath],
        options: { maxRuntimeEntries: 3 },
      });

      expect(inventories[0]?.observations).toHaveLength(3);
      expect(inventories[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'ProjectSkillEntryLimitExceeded',
      );
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  test('inherits configured scanner token thresholds', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-project-thresholds-'));
    try {
      await writeSkill(path.join(projectPath, '.claude', 'skills', 'local-skill'), 'local-skill');

      const inventories = await scanProjectSkills({
        projectPaths: [projectPath],
        options: {
          tokenThresholds: {
            referenceFile: { warn: 1000, high: 2000 },
            skillMd: { warn: 1, high: 1000 },
            totalSkill: { warn: 1, high: 1000 },
          },
        },
      });

      expect(inventories[0]?.observations[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'SkillMarkdownTokenWarning',
        'SkillTotalTokenWarning',
      ]);
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
