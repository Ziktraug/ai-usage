import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanSkillSourceRepository } from '.';

describe('source skill scanning', () => {
  test('scans skills and defaults absent source-state entries to enabled', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-'));
    try {
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      await mkdir(path.join(skillPath, 'references'), { recursive: true });
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
      await writeFile(path.join(skillPath, 'references', 'guide.md'), 'Use clear examples.\n', 'utf8');

      const scan = await scanSkillSourceRepository({ sourceRepoPath });

      expect(scan.skills).toHaveLength(1);
      expect(scan.skills[0]?.enabled).toBe(true);
      expect(scan.skills[0]?.tokenCount?.approximate).toBe(true);
      expect(scan.diagnostics).toEqual([]);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('honors JSON source state toggles', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-'));
    try {
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      await mkdir(path.join(sourceRepoPath, '.skill-tracker'), { recursive: true });
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        path.join(sourceRepoPath, '.skill-tracker', 'state.json'),
        JSON.stringify({ version: 1, skillEnabledByName: { 'example-skill': false } }),
        'utf8',
      );
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

      const scan = await scanSkillSourceRepository({ sourceRepoPath });

      expect(scan.skills[0]?.enabled).toBe(false);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('applies scan limits and ignores generated directories', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-'));
    try {
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      await mkdir(path.join(skillPath, '.git'), { recursive: true });
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
      await writeFile(path.join(skillPath, 'notes.md'), 'one two three\n', 'utf8');
      await writeFile(path.join(skillPath, '.git', 'ignored.md'), 'ignored\n', 'utf8');

      const scan = await scanSkillSourceRepository({
        sourceRepoPath,
        options: { maxFilesPerSkill: 1, maxTextFileBytes: 4 },
      });

      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'SkillFileLimitExceeded',
        'SkillFileTooLarge',
      ]);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });
});
