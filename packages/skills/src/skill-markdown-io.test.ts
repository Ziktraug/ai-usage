import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { maxSkillMarkdownBytes, parseSkillMarkdownWriteInput, readSkillMarkdown, writeSkillMarkdown } from '.';

const writeSourceSkill = async (sourceRepoPath: string, skillName: string, content = '# Skill\n') => {
  const skillPath = path.join(sourceRepoPath, 'skills', skillName);
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, 'SKILL.md'), content, 'utf8');
};

describe('skill markdown IO', () => {
  test('reads and writes only source SKILL.md with sha conflict protection', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-'));
    try {
      await writeSourceSkill(sourceRepoPath, 'example-skill', '# Original\n');
      const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });

      expect(document.content).toBe('# Original\n');
      expect(document.sha256).toHaveLength(64);
      expect(
        await writeSkillMarkdown({
          baseSha256: '0'.repeat(64),
          content: '# Edited\n',
          skillName: 'example-skill',
          sourceRepoPath,
        }),
      ).toEqual({ ok: false, reason: 'conflict' });
      expect(
        await writeSkillMarkdown({
          baseSha256: document.sha256,
          content: '# Edited\n',
          skillName: 'example-skill',
          sourceRepoPath,
        }),
      ).toEqual({ ok: true });
      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).resolves.toMatchObject({
        content: '# Edited\n',
      });
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('refuses symlinked markdown outside the source skills directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-link-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const externalPath = path.join(root, 'external.md');
      await mkdir(path.join(sourceRepoPath, 'skills', 'example-skill'), { recursive: true });
      await writeFile(externalPath, '# External\n', 'utf8');
      await symlink(externalPath, path.join(sourceRepoPath, 'skills', 'example-skill', 'SKILL.md'));

      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow('not found');
      expect(
        await writeSkillMarkdown({
          baseSha256: '0'.repeat(64),
          content: '# Edited\n',
          skillName: 'example-skill',
          sourceRepoPath,
        }),
      ).toEqual({ ok: false, reason: 'not-found' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('validates write input and rejects oversized content', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-large-'));
    try {
      await writeSourceSkill(sourceRepoPath, 'example-skill');
      const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      const oversized = 'x'.repeat(maxSkillMarkdownBytes + 1);

      expect(() =>
        parseSkillMarkdownWriteInput({ baseSha256: document.sha256, content: oversized, skillName: 'example-skill' }),
      ).toThrow('262144 bytes');
      expect(
        await writeSkillMarkdown({
          baseSha256: document.sha256,
          content: oversized,
          skillName: 'example-skill',
          sourceRepoPath,
        }),
      ).toEqual({ ok: false, reason: 'too-large' });
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });
});
