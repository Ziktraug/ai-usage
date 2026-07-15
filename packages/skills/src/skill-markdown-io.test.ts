import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { maxSkillMarkdownBytes } from './contracts';
import {
  parseSkillMarkdownWriteInput,
  readSkillMarkdown,
  writeSkillMarkdown,
  writeSkillMarkdownWithHooks,
} from './skill-markdown-io';

const writeSourceSkill = async (sourceRepoPath: string, skillName: string, content = '# Skill\n') => {
  const skillPath = path.join(sourceRepoPath, 'skills', skillName);
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, 'SKILL.md'), content, 'utf8');
};

const markdownSha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

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

  test('allows only one concurrent save from the same base revision', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-'));
    try {
      await writeSourceSkill(sourceRepoPath, 'example-skill', '# Original\n');
      const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      const firstEdit = `# First complete edit\n${'a'.repeat(200_000)}\n`;
      const secondEdit = `# Second complete edit\n${'b'.repeat(200_000)}\n`;

      const results = await Promise.all([
        writeSkillMarkdown({
          baseSha256: document.sha256,
          content: firstEdit,
          skillName: 'example-skill',
          sourceRepoPath,
        }),
        writeSkillMarkdown({
          baseSha256: document.sha256,
          content: secondEdit,
          skillName: 'example-skill',
          sourceRepoPath,
        }),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.reason === 'conflict')).toHaveLength(1);
      expect([firstEdit, secondEdit]).toContain(
        (await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).content,
      );
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('allows only one save across processes and canonical source path aliases', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-process-'));
    try {
      const sourceRepoPath = path.join(root, 'source');
      const sourceAliasPath = path.join(root, 'source-alias');
      const readyPath = path.join(root, 'ready');
      const barrierPath = path.join(root, 'go');
      await writeSourceSkill(sourceRepoPath, 'example-skill', '# Original\n');
      await symlink(sourceRepoPath, sourceAliasPath);
      await mkdir(readyPath);
      const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      const subprocessPath = path.join(import.meta.dir, 'test-fixtures', 'skills-subprocess.ts');
      const edits = ['alpha', 'bravo', 'charlie', 'delta'];
      const processes = edits.map((edit, index) =>
        Bun.spawn(
          [
            process.execPath,
            subprocessPath,
            'markdown',
            index % 2 === 0 ? sourceRepoPath : sourceAliasPath,
            edit,
            readyPath,
            barrierPath,
            document.sha256,
          ],
          { stderr: 'pipe', stdout: 'pipe' },
        ),
      );
      while ((await Array.fromAsync(new Bun.Glob('*').scan({ cwd: readyPath }))).length < edits.length) {
        await Bun.sleep(5);
      }
      await writeFile(barrierPath, 'go', 'utf8');

      const exitCodes = await Promise.all(processes.map((subprocess) => subprocess.exited));
      expect(exitCodes).toEqual(edits.map(() => 0));
      const results = await Promise.all(
        processes.map(
          async (subprocess) =>
            JSON.parse(await new Response(subprocess.stdout).text()) as {
              ok: boolean;
              reason?: string;
            },
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => result.reason === 'conflict')).toHaveLength(edits.length - 1);
      const finalDocument = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      expect(edits.some((edit) => finalDocument.content === `# ${edit}\n${edit.repeat(20_000)}\n`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('preserves a non-cooperative writer that publishes during the filesystem CAS window', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-interloper-'));
    try {
      await writeSourceSkill(sourceRepoPath, 'example-skill', '# Original\n');
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      const result = await writeSkillMarkdownWithHooks(
        {
          baseSha256: document.sha256,
          content: '# Our edit\n',
          skillName: 'example-skill',
          sourceRepoPath,
        },
        {
          afterClaim: async () => {
            await writeFile(markdownPath, '# External edit\n', { flag: 'wx', mode: 0o640 });
          },
        },
      );

      expect(result).toEqual({ ok: false, reason: 'conflict' });
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe('# External edit\n');
      const claimName = '.SKILL.md.ai-usage.claim';
      expect(await readdir(skillPath)).toContain(claimName);
      await expect(readFile(path.join(skillPath, claimName), 'utf8')).resolves.toBe('# Original\n');
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  }, 20_000);

  test('does not steal a fresh lease owned by an active local process', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-live-lock-'));
    try {
      await writeSourceSkill(sourceRepoPath, 'example-skill', '# Original\n');
      const markdownPath = path.join(sourceRepoPath, 'skills', 'example-skill', 'SKILL.md');
      const lockPath = `${markdownPath}.ai-usage.lock`;
      const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      await writeFile(
        lockPath,
        JSON.stringify({
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          heartbeatAt: new Date().toISOString(),
          hostname: hostname(),
          ownerId: 'active-owner',
          pid: process.pid,
          version: 1,
        }),
        { mode: 0o600 },
      );

      const mutation = writeSkillMarkdown({
        baseSha256: document.sha256,
        content: '# Edited after lock\n',
        skillName: 'example-skill',
        sourceRepoPath,
      });
      const earlyOutcome = await Promise.race([
        mutation.then(() => 'completed' as const),
        Bun.sleep(100).then(() => 'waiting' as const),
      ]);
      expect(earlyOutcome).toBe('waiting');
      await unlink(lockPath);
      await expect(mutation).resolves.toEqual({ ok: true });
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  }, 20_000);

  for (const expiredOwner of ['foreign-host', 'reused-local-pid'] as const) {
    test(`recovers an expired ${expiredOwner} lease`, async () => {
      const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-expired-lock-'));
      try {
        await writeSourceSkill(sourceRepoPath, 'example-skill', '# Original\n');
        const markdownPath = path.join(sourceRepoPath, 'skills', 'example-skill', 'SKILL.md');
        const lockPath = `${markdownPath}.ai-usage.lock`;
        const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
        const expiredDate = new Date(Date.now() - 120_000);
        await writeFile(
          lockPath,
          JSON.stringify({
            createdAt: expiredDate.toISOString(),
            heartbeatAt: expiredDate.toISOString(),
            hostname: expiredOwner === 'foreign-host' ? 'remote-build-host' : hostname(),
            ownerId: 'expired-owner',
            pid: process.pid,
            version: 1,
          }),
          { mode: 0o600 },
        );
        await utimes(lockPath, expiredDate, expiredDate);

        await expect(
          writeSkillMarkdown({
            baseSha256: document.sha256,
            content: '# Recovered lease\n',
            skillName: 'example-skill',
            sourceRepoPath,
          }),
        ).resolves.toEqual({ ok: true });
      } finally {
        await rm(sourceRepoPath, { recursive: true, force: true });
      }
    }, 20_000);
  }

  test('recovers a deterministic claim left by a crash before publication', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-crash-claim-'));
    try {
      const originalContent = '# Original\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', originalContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      await rename(markdownPath, claimPath);
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(originalContent),
          newSha256: markdownSha256('# Interrupted edit\n'),
          operationId: 'crashed-operation',
          phase: 'prepared',
          tempName: '.SKILL.md.ai-usage.crashed-operation.tmp',
          version: 1,
        }),
        { mode: 0o600 },
      );

      const recoveredDocument = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      expect(recoveredDocument.content).toBe(originalContent);
      await expect(stat(claimPath)).rejects.toThrow();
      await expect(stat(journalPath)).rejects.toThrow();

      await expect(
        writeSkillMarkdown({
          baseSha256: recoveredDocument.sha256,
          content: '# Recovered edit\n',
          skillName: 'example-skill',
          sourceRepoPath,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe('# Recovered edit\n');
      await expect(stat(claimPath)).rejects.toThrow();
      await expect(stat(journalPath)).rejects.toThrow();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('recovers after a writer subprocess is killed between claim and publication', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-killed-writer-'));
    try {
      const originalContent = '# Original\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', originalContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const readyPath = path.join(sourceRepoPath, 'writer-ready');
      const barrierPath = path.join(sourceRepoPath, 'writer-go');
      const killerReadyPath = path.join(sourceRepoPath, 'killer-ready');
      const killedPath = path.join(sourceRepoPath, 'writer-killed');
      const writer = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, 'test-fixtures', 'skill-markdown-crash-writer.ts'),
          sourceRepoPath,
          markdownSha256(originalContent),
          readyPath,
          barrierPath,
        ],
        { stderr: 'pipe', stdout: 'pipe' },
      );
      while (
        !(await stat(readyPath)
          .then(() => true)
          .catch(() => false))
      ) {
        await Bun.sleep(1);
      }
      const killer = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, 'test-fixtures', 'skill-markdown-crash-killer.ts'),
          `${writer.pid}`,
          claimPath,
          killerReadyPath,
          killedPath,
        ],
        { stderr: 'pipe', stdout: 'pipe' },
      );
      while (
        !(await stat(killerReadyPath)
          .then(() => true)
          .catch(() => false))
      ) {
        await Bun.sleep(1);
      }
      await writeFile(barrierPath, 'go', 'utf8');
      expect(await killer.exited).toBe(0);
      expect(await writer.exited).not.toBe(0);
      await expect(stat(killedPath)).resolves.toBeDefined();

      const recoveredDocument = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      expect(recoveredDocument.content).toBe(originalContent);
      await expect(stat(claimPath)).rejects.toThrow();

      await expect(
        writeSkillMarkdown({
          baseSha256: recoveredDocument.sha256,
          content: '# Recovered after kill\n',
          skillName: 'example-skill',
          sourceRepoPath,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(readFile(path.join(skillPath, 'SKILL.md'), 'utf8')).resolves.toBe('# Recovered after kill\n');
      await expect(stat(claimPath)).rejects.toThrow();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  }, 20_000);

  test('cleans a journaled claim after recovering a crash following publication', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-crash-published-'));
    try {
      const originalContent = '# Original\n';
      const publishedContent = '# Published before crash\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', publishedContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      const tempName = '.SKILL.md.ai-usage.published-operation.tmp';
      await writeFile(claimPath, originalContent, { mode: 0o640 });
      await link(markdownPath, path.join(skillPath, tempName));
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(originalContent),
          newSha256: markdownSha256(publishedContent),
          operationId: 'published-operation',
          phase: 'claimed',
          tempName,
          version: 1,
        }),
        { mode: 0o600 },
      );

      const recoveredDocument = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });
      expect(recoveredDocument.content).toBe(publishedContent);
      await expect(stat(claimPath)).rejects.toThrow();
      await expect(stat(journalPath)).rejects.toThrow();
      await expect(stat(path.join(skillPath, tempName))).rejects.toThrow();

      await expect(
        writeSkillMarkdown({
          baseSha256: recoveredDocument.sha256,
          content: '# Next edit\n',
          skillName: 'example-skill',
          sourceRepoPath,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe('# Next edit\n');
      await expect(stat(claimPath)).rejects.toThrow();
      await expect(stat(journalPath)).rejects.toThrow();
      await expect(stat(path.join(skillPath, tempName))).rejects.toThrow();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('blocks read recovery without deleting a forged journal temp artifact', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-forged-journal-'));
    try {
      const originalContent = '# Original\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', originalContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      const tempName = '.SKILL.md.ai-usage.forged.tmp';
      const tempPath = path.join(skillPath, tempName);
      const forgedContent = 'must not be deleted';
      await writeFile(tempPath, forgedContent, { mode: 0o640 });
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(originalContent),
          newSha256: markdownSha256('# Expected edit\n'),
          operationId: 'forged',
          phase: 'prepared',
          tempName,
          version: 1,
        }),
        { mode: 0o600 },
      );

      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow(
        'recovery conflict',
      );
      await expect(readFile(tempPath, 'utf8')).resolves.toBe(forgedContent);
      await expect(stat(journalPath)).resolves.toBeDefined();
      await expect(readFile(path.join(skillPath, 'SKILL.md'), 'utf8')).resolves.toBe(originalContent);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('preserves a matching temp when a prepared journal has no claim', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-prepared-temp-'));
    try {
      const originalContent = '# Original\n';
      const expectedContent = '# Expected edit\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', originalContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      const tempName = '.SKILL.md.ai-usage.prepared.tmp';
      const tempPath = path.join(skillPath, tempName);
      await writeFile(tempPath, expectedContent, { mode: 0o640 });
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(originalContent),
          newSha256: markdownSha256(expectedContent),
          operationId: 'prepared',
          phase: 'prepared',
          tempName,
          version: 1,
        }),
        { mode: 0o600 },
      );

      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow(
        'recovery conflict',
      );
      await expect(readFile(tempPath, 'utf8')).resolves.toBe(expectedContent);
      await expect(stat(journalPath)).resolves.toBeDefined();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('preserves prepared claim and temp when markdown is absent', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-prepared-claim-temp-'));
    try {
      const baseContent = '# Original\n';
      const interruptedContent = '# Interrupted edit\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', baseContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      const tempName = '.SKILL.md.ai-usage.prepared-claim.tmp';
      const tempPath = path.join(skillPath, tempName);
      await rename(markdownPath, claimPath);
      await writeFile(tempPath, interruptedContent, { mode: 0o640 });
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(baseContent),
          newSha256: markdownSha256(interruptedContent),
          operationId: 'prepared-claim',
          phase: 'prepared',
          tempName,
          version: 1,
        }),
        { mode: 0o600 },
      );

      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow(
        'recovery conflict',
      );
      await expect(readFile(claimPath, 'utf8')).resolves.toBe(baseContent);
      await expect(readFile(tempPath, 'utf8')).resolves.toBe(interruptedContent);
      await expect(stat(journalPath)).resolves.toBeDefined();
      await expect(stat(markdownPath)).rejects.toThrow();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('preserves prepared rollback hard-links and temp as an impossible state', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-prepared-rollback-temp-'));
    try {
      const baseContent = '# Original\n';
      const interruptedContent = '# Interrupted edit\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', baseContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      const tempName = '.SKILL.md.ai-usage.prepared-rollback.tmp';
      const tempPath = path.join(skillPath, tempName);
      await link(markdownPath, claimPath);
      await writeFile(tempPath, interruptedContent, { mode: 0o640 });
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(baseContent),
          newSha256: markdownSha256(interruptedContent),
          operationId: 'prepared-rollback',
          phase: 'prepared',
          tempName,
          version: 1,
        }),
        { mode: 0o600 },
      );

      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow(
        'recovery conflict',
      );
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe(baseContent);
      await expect(readFile(claimPath, 'utf8')).resolves.toBe(baseContent);
      await expect(readFile(tempPath, 'utf8')).resolves.toBe(interruptedContent);
      await expect(stat(journalPath)).resolves.toBeDefined();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('preserves a non-regular recovery journal and blocks recovery', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-journal-directory-'));
    try {
      await writeSourceSkill(sourceRepoPath, 'example-skill', '# Original\n');
      const journalPath = path.join(sourceRepoPath, 'skills', 'example-skill', '.SKILL.md.ai-usage.journal.json');
      await mkdir(journalPath);

      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow(
        'recovery conflict',
      );
      expect((await stat(journalPath)).isDirectory()).toBe(true);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('preserves a claim whose hash does not match the recovery journal base', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-forged-claim-'));
    try {
      const originalContent = '# Original\n';
      const forgedClaimContent = '# Forged claim\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', originalContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      await rename(markdownPath, claimPath);
      await writeFile(claimPath, forgedClaimContent, 'utf8');
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(originalContent),
          newSha256: markdownSha256('# Expected edit\n'),
          operationId: 'forged-claim',
          phase: 'claimed',
          tempName: '.SKILL.md.ai-usage.forged-claim.tmp',
          version: 1,
        }),
        { mode: 0o600 },
      );

      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow(
        'recovery conflict',
      );
      await expect(readFile(claimPath, 'utf8')).resolves.toBe(forgedClaimContent);
      await expect(stat(markdownPath)).rejects.toThrow();
      await expect(stat(journalPath)).resolves.toBeDefined();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('preserves claim and markdown unless their hashes prove a completed publication', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-unproven-publish-'));
    try {
      const baseContent = '# Original\n';
      const externalContent = '# External\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', externalContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      await writeFile(claimPath, baseContent, { mode: 0o640 });
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(baseContent),
          newSha256: markdownSha256('# Expected edit\n'),
          operationId: 'unproven',
          phase: 'prepared',
          tempName: '.SKILL.md.ai-usage.unproven.tmp',
          version: 1,
        }),
        { mode: 0o600 },
      );

      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow(
        'recovery conflict',
      );
      await expect(readFile(claimPath, 'utf8')).resolves.toBe(baseContent);
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe(externalContent);
      await expect(stat(journalPath)).resolves.toBeDefined();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('blocks cleanup when matching temp and markdown content come from different inodes', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-temp-identity-'));
    try {
      const baseContent = '# Original\n';
      const publishedContent = '# Published\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', publishedContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      const tempName = '.SKILL.md.ai-usage.different-inode.tmp';
      const tempPath = path.join(skillPath, tempName);
      await writeFile(claimPath, baseContent, { mode: 0o640 });
      await writeFile(tempPath, publishedContent, { mode: 0o640 });
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(baseContent),
          newSha256: markdownSha256(publishedContent),
          operationId: 'different-inode',
          phase: 'published',
          tempName,
          version: 1,
        }),
        { mode: 0o600 },
      );

      await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow(
        'recovery conflict',
      );
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe(publishedContent);
      await expect(readFile(tempPath, 'utf8')).resolves.toBe(publishedContent);
      await expect(readFile(claimPath, 'utf8')).resolves.toBe(baseContent);
      await expect(stat(journalPath)).resolves.toBeDefined();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('idempotently cleans a rollback hard-link without deleting markdown', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-rollback-identity-'));
    try {
      const baseContent = '# Original\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', baseContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      await link(markdownPath, claimPath);
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(baseContent),
          newSha256: markdownSha256('# Interrupted edit\n'),
          operationId: 'rollback',
          phase: 'claimed',
          tempName: '.SKILL.md.ai-usage.rollback.tmp',
          version: 1,
        }),
        { mode: 0o600 },
      );

      const recovered = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });

      expect(recovered.content).toBe(baseContent);
      await expect(stat(claimPath)).rejects.toThrow();
      await expect(stat(journalPath)).rejects.toThrow();
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe(baseContent);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('removes only a redundant no-journal claim hard-link after rollback cleanup', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-no-journal-rollback-'));
    try {
      const baseContent = '# Original\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', baseContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const claimPath = path.join(skillPath, '.SKILL.md.ai-usage.claim');
      await link(markdownPath, claimPath);

      const recovered = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });

      expect(recovered.content).toBe(baseContent);
      await expect(stat(claimPath)).rejects.toThrow();
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe(baseContent);
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('idempotently finishes cleanup after claim removal from a claimed publication', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-partial-publish-cleanup-'));
    try {
      const baseContent = '# Original\n';
      const publishedContent = '# Published\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', publishedContent);
      const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
      const markdownPath = path.join(skillPath, 'SKILL.md');
      const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
      const tempName = '.SKILL.md.ai-usage.partial-publish.tmp';
      const tempPath = path.join(skillPath, tempName);
      await link(markdownPath, tempPath);
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(baseContent),
          newSha256: markdownSha256(publishedContent),
          operationId: 'partial-publish',
          phase: 'claimed',
          tempName,
          version: 1,
        }),
        { mode: 0o600 },
      );

      const recovered = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });

      expect(recovered.content).toBe(publishedContent);
      await expect(stat(tempPath)).rejects.toThrow();
      await expect(stat(journalPath)).rejects.toThrow();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  test('idempotently finishes cleanup after temp removal from a claimed publication', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-partial-temp-cleanup-'));
    try {
      const baseContent = '# Original\n';
      const publishedContent = '# Published\n';
      await writeSourceSkill(sourceRepoPath, 'example-skill', publishedContent);
      const journalPath = path.join(sourceRepoPath, 'skills', 'example-skill', '.SKILL.md.ai-usage.journal.json');
      await writeFile(
        journalPath,
        JSON.stringify({
          baseSha256: markdownSha256(baseContent),
          newSha256: markdownSha256(publishedContent),
          operationId: 'partial-temp-cleanup',
          phase: 'claimed',
          tempName: '.SKILL.md.ai-usage.partial-temp-cleanup.tmp',
          version: 1,
        }),
        { mode: 0o600 },
      );

      const recovered = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });

      expect(recovered.content).toBe(publishedContent);
      await expect(stat(journalPath)).rejects.toThrow();
    } finally {
      await rm(sourceRepoPath, { recursive: true, force: true });
    }
  });

  for (const phase of ['claimed', 'published'] as const) {
    test(`blocks ${phase} rollback cleanup after claim disappearance`, async () => {
      const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-unsafe-rollback-cleanup-'));
      try {
        const baseContent = '# Original\n';
        const interruptedContent = '# Interrupted edit\n';
        await writeSourceSkill(sourceRepoPath, 'example-skill', baseContent);
        const skillPath = path.join(sourceRepoPath, 'skills', 'example-skill');
        const journalPath = path.join(skillPath, '.SKILL.md.ai-usage.journal.json');
        const operationId = `unsafe-${phase}-rollback`;
        const tempName = `.SKILL.md.ai-usage.${operationId}.tmp`;
        const tempPath = path.join(skillPath, tempName);
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

        await expect(readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath })).rejects.toThrow(
          'recovery conflict',
        );
        await expect(readFile(tempPath, 'utf8')).resolves.toBe(interruptedContent);
        await expect(stat(journalPath)).resolves.toBeDefined();
        await expect(readFile(path.join(skillPath, 'SKILL.md'), 'utf8')).resolves.toBe(baseContent);
      } finally {
        await rm(sourceRepoPath, { recursive: true, force: true });
      }
    });
  }

  test('preserves existing markdown permissions through an atomic save', async () => {
    const sourceRepoPath = await mkdtemp(path.join(tmpdir(), 'ai-usage-skill-md-mode-'));
    try {
      await writeSourceSkill(sourceRepoPath, 'example-skill', '# Original\n');
      const markdownPath = path.join(sourceRepoPath, 'skills', 'example-skill', 'SKILL.md');
      await chmod(markdownPath, 0o640);
      const document = await readSkillMarkdown({ skillName: 'example-skill', sourceRepoPath });

      await writeSkillMarkdown({
        baseSha256: document.sha256,
        content: '# Edited\n',
        skillName: 'example-skill',
        sourceRepoPath,
      });

      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX modes are bitmasks.
      expect((await stat(markdownPath)).mode & 0o777).toBe(0o640);
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
