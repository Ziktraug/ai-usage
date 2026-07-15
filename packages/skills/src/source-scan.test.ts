import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { maxSkillMarkdownBytes } from './contracts';
import { readSkillMarkdown, writeSkillMarkdown } from './skill-markdown-io';
import { scanSkillSourceRepository } from './source-scan';

const markdownSha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

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
      await writeFile(path.join(skillPath, 'notes.md'), 'one\n', 'utf8');
      await writeFile(path.join(skillPath, 'too-large.md'), 'one two three\n', 'utf8');
      await writeFile(path.join(skillPath, '.git', 'ignored.md'), 'ignored\n', 'utf8');

      const scan = await scanSkillSourceRepository({
        sourceRepoPath,
        options: { maxFilesPerSkill: 2, maxTextFileBytes: 200 },
      });

      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['SkillFileLimitExceeded']);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('bounds traversal with a shared entry budget that includes directories', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-'));
    try {
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
      for (let index = 0; index < 100; index += 1) {
        await mkdir(path.join(skillPath, `directory-${index.toString().padStart(3, '0')}`));
      }

      const scan = await scanSkillSourceRepository({
        sourceRepoPath,
        options: { maxFilesPerSkill: 4 },
      });

      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['SkillFileLimitExceeded']);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('streams and truncates top-level source skill entries at the configured budget', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-top-level-budget-'));
    try {
      for (let index = 0; index < 40; index += 1) {
        const skillName = `skill-${index.toString().padStart(2, '0')}`;
        const skillPath = path.join(sourceRepoPath, 'skills', skillName);
        await mkdir(skillPath, { recursive: true });
        await writeFile(
          path.join(skillPath, 'SKILL.md'),
          `---\nname: ${skillName}\ndescription: Budget fixture\n---\n# Fixture\n`,
          'utf8',
        );
      }

      const scan = await scanSkillSourceRepository({ sourceRepoPath, options: { maxSkills: 3 } });

      expect(scan.skills).toHaveLength(3);
      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('SourceSkillLimitExceeded');
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('recovers a crash-claimed SKILL.md while loading the source snapshot', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-recovery-'));
    try {
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        markdownPath,
        '---\nname: example-skill\ndescription: Recovered by scan\n---\n# Example\n',
        'utf8',
      );
      const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      await rename(markdownPath, claimPath);
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: document.sha256,
          newSha256: '1'.repeat(64),
          operationId: 'scan-crash',
          phase: 'claimed',
          tempName: '.SKILL.md.ai-usage.scan-crash.tmp',
          version: 1,
        }),
        { mode: 0o600 },
      );

      const scan = await scanSkillSourceRepository({ sourceRepoPath });

      expect(scan.skills.map((skill) => skill.name)).toEqual(['example-skill']);
      expect(scan.skills[0]?.description).toBe('Recovered by scan');
      await expect(stat(claimPath)).rejects.toThrow();
      await expect(stat(journalPath)).rejects.toThrow();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('blocks source scan recovery without deleting a forged journal temp artifact', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-forged-journal-'));
    try {
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      const tempName = '.SKILL.md.ai-usage.forged.tmp';
      const tempPath = path.join(skillPath, tempName);
      const originalContent = '---\nname: example-skill\ndescription: Original\n---\n# Example\n';
      const forgedContent = 'preserve this unrelated file';
      await mkdir(skillPath, { recursive: true });
      await writeFile(markdownPath, originalContent, 'utf8');
      const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      await writeFile(tempPath, forgedContent, { mode: 0o640 });
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: document.sha256,
          newSha256: '1'.repeat(64),
          operationId: 'forged',
          phase: 'prepared',
          tempName,
          version: 1,
        }),
        { mode: 0o600 },
      );

      const scan = await scanSkillSourceRepository({ sourceRepoPath });

      expect(scan.skills).toEqual([]);
      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('SkillMarkdownRecoveryConflict');
      await expect(readFile(tempPath, 'utf8')).resolves.toBe(forgedContent);
      await expect(stat(journalPath)).resolves.toBeDefined();
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe(originalContent);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  for (const phase of ['claimed', 'published'] as const) {
    test(`blocks ${phase} source scan rollback when claim is absent`, async () => {
      const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-unsafe-rollback-'));
      try {
        const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
        const markdownPath = path.join(skillPath, 'SKILL.md');
        const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
        const baseContent = '---\nname: example-skill\ndescription: Original\n---\n# Example\n';
        const interruptedContent = '# Interrupted edit\n';
        const operationId = `scan-${phase}-rollback`;
        const tempName = `.SKILL.md.ai-usage.${operationId}.tmp`;
        const tempPath = path.join(skillPath, tempName);
        await mkdir(skillPath, { recursive: true });
        await writeFile(markdownPath, baseContent, 'utf8');
        await writeFile(tempPath, interruptedContent, { mode: 0o640 });
        await writeFile(
          journalPath,
          JSON.stringify({
            baseSha256: markdownSha256(baseContent),
            newSha256: markdownSha256(interruptedContent),
            operationId,
            phase,
            tempName,
            version: 1,
          }),
          { mode: 0o600 },
        );

        const scan = await scanSkillSourceRepository({ sourceRepoPath });

        expect(scan.skills).toEqual([]);
        expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('SkillMarkdownRecoveryConflict');
        await expect(readFile(tempPath, 'utf8')).resolves.toBe(interruptedContent);
        await expect(stat(journalPath)).resolves.toBeDefined();
        await expect(readFile(markdownPath, 'utf8')).resolves.toBe(baseContent);
      } finally {
        await rm(sourceRepoPath, { recursive: true, force: true });
      }
    });
  }

  test('blocks prepared source recovery when claim and temp coexist', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-prepared-claim-temp-'));
    try {
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      const baseContent = '---\nname: example-skill\ndescription: Original\n---\n# Example\n';
      const interruptedContent = '# Interrupted edit\n';
      const tempName = '.SKILL.md.ai-usage.scan-prepared-claim.tmp';
      const tempPath = path.join(skillPath, tempName);
      await mkdir(skillPath, { recursive: true });
      await writeFile(markdownPath, baseContent, 'utf8');
      await rename(markdownPath, claimPath);
      await writeFile(tempPath, interruptedContent, { mode: 0o640 });
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(baseContent),
          newSha256: markdownSha256(interruptedContent),
          operationId: 'scan-prepared-claim',
          phase: 'prepared',
          tempName,
          version: 1,
        }),
        { mode: 0o600 },
      );

      const scan = await scanSkillSourceRepository({ sourceRepoPath });

      expect(scan.skills).toEqual([]);
      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('SkillMarkdownRecoveryConflict');
      await expect(readFile(claimPath, 'utf8')).resolves.toBe(baseContent);
      await expect(readFile(tempPath, 'utf8')).resolves.toBe(interruptedContent);
      await expect(stat(journalPath)).resolves.toBeDefined();
      await expect(stat(markdownPath)).rejects.toThrow();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('rejects special reference files without following them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-special-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const externalPath = path.join(root, 'external.md');
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
      await writeFile(externalPath, 'secret words that must not be counted\n', 'utf8');
      await symlink(externalPath, path.join(skillPath, 'linked-reference.md'));

      const scan = await scanSkillSourceRepository({ sourceRepoPath });

      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['UnsupportedSkillFile']);
      expect(scan.skills[0]?.tokenCount?.references).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses the markdown save limit for SKILL.md and keeps maxTextFileBytes for references', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-'));
    try {
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      await mkdir(skillPath, { recursive: true });
      const prefix = '---\nname: example-skill\ndescription: Boundary markdown\n---\n';
      await writeFile(path.join(skillPath, 'SKILL.md'), `${prefix}# Initial\n`, 'utf8');
      await writeFile(path.join(skillPath, 'reference.md'), 'reference content', 'utf8');
      const current = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      const content = `${prefix}${'x'.repeat(maxSkillMarkdownBytes - Buffer.byteLength(prefix))}`;
      expect(Buffer.byteLength(content)).toBe(maxSkillMarkdownBytes);
      await expect(
        writeSkillMarkdown({
          baseSha256: current.sha256,
          content,
          skillName: 'example-skill',
          sourceRepoPath,
        }),
      ).resolves.toEqual({ ok: true });

      const scan = await scanSkillSourceRepository({
        sourceRepoPath,
        options: { maxTextFileBytes: 16 },
      });

      expect(scan.skills).toHaveLength(1);
      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('SkillFileTooLarge');
      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('SkillMarkdownTooLarge');
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('emits stable configured token diagnostics without structurally invalidating the skill', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-'));
    try {
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
      await writeFile(path.join(skillPath, 'reference.md'), 'one two three four\n', 'utf8');

      const scan = await scanSkillSourceRepository({
        sourceRepoPath,
        options: {
          tokenThresholds: {
            referenceFile: { warn: 1, high: 5 },
            skillMd: { warn: 1, high: 1000 },
            totalSkill: { warn: 1, high: 1000 },
          },
        },
      });

      expect(scan.diagnostics.map(({ code, severity }) => [code, severity])).toEqual([
        ['SkillMarkdownTokenWarning', 'warning'],
        ['SkillReferenceTokenHigh', 'error'],
        ['SkillTotalTokenWarning', 'warning'],
      ]);
      expect(scan.skills[0]?.validationStatus).toBe('warning');
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('uses default token thresholds when scan options omit them', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-'));
    try {
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        path.join(skillPath, 'SKILL.md'),
        `---
name: example-skill
description: Helps with examples
---
${'word '.repeat(1500)}`,
        'utf8',
      );

      const scan = await scanSkillSourceRepository({ sourceRepoPath });

      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['SkillMarkdownTokenWarning']);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('reports unreadable reference files as diagnostics', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skills-scan-'));
    try {
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
      const referencePath = path.join(skillPath, 'notes.md');
      await writeFile(referencePath, 'one two three\n', 'utf8');
      await chmod(referencePath, 0);

      const scan = await scanSkillSourceRepository({ sourceRepoPath });

      expect(scan.skills).toHaveLength(1);
      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('UnreadableSkillReferenceFile');
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });
});
