import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLocalSourcePolicyOverrides } from './source-policy-config';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('reads only persisted current-machine source policy overrides', async () => {
  const homePath = await mkdtemp(path.join(tmpdir(), 'ai-usage-source-policy-read-'));
  roots.push(homePath);
  const configPath = path.join(homePath, '.config', 'ai-usage', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({
      skills: { sourceRepoPath: '/unrelated/skills' },
      sourcePolicies: {
        'codex.sessions': { enabled: false },
        'rtk.savings': { enabled: false },
      },
    })}\n`,
    'utf8',
  );

  await expect(readLocalSourcePolicyOverrides(homePath)).resolves.toEqual({
    'codex.sessions': { enabled: false },
    'rtk.savings': { enabled: false },
  });
});

test('uses the catalogue defaults when no home override exists', async () => {
  const homePath = await mkdtemp(path.join(tmpdir(), 'ai-usage-source-policy-default-'));
  roots.push(homePath);

  await expect(readLocalSourcePolicyOverrides(homePath)).resolves.toEqual({});
});
