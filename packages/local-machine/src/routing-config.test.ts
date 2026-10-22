import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLocalRoutingDeclarations } from './routing-config';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeHome = async (
  files: Readonly<Record<string, unknown>>,
): Promise<{ readonly configPath: string; readonly homePath: string }> => {
  const homePath = await mkdtemp(path.join(tmpdir(), 'ai-usage-routing-config-read-'));
  roots.push(homePath);
  const directory = path.join(homePath, '.config', 'ai-usage');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(directory, name), `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  return { configPath: path.join(directory, 'config.json'), homePath };
};

const declaration = {
  accountScope: 'personal' as const,
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T20:00:00.000Z',
  harness: 'claude-code',
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
} as const;

test('reads declarations from the home config and defaults their machine to machine.json', async () => {
  const { configPath, homePath } = await writeHome({
    'config.json': {
      routing: {
        executors: [declaration, { ...declaration, harness: 'codex', authorization: 'maybe' }],
        reviewTargets: [{ checkoutPath: '/home/operator/src/ai-usage/', label: 'main' }, { checkoutPath: 'relative' }],
      },
      sourcePolicies: { 'rtk.savings': { enabled: false } },
    },
    'machine.json': { id: 'machine-from-file', label: 'Workstation' },
  });

  const result = await readLocalRoutingDeclarations(homePath);
  expect(result.configPath).toBe(configPath);
  expect(result.machineId).toBe('machine-from-file');
  expect(result.declarations).toEqual([{ ...declaration, effort: null, machineId: 'machine-from-file', model: null }]);
  expect(result.issues).toEqual([
    { path: 'routing.executors[1].authorization', reason: "must be 'allowed' or 'forbidden'" },
  ]);
  expect(result.reviewTargets).toEqual([{ checkoutPath: '/home/operator/src/ai-usage', label: 'main' }]);
  expect(result.reviewTargetIssues.map((issue) => issue.path)).toEqual(['routing.reviewTargets[1].checkoutPath']);
});

test('reports a missing machine identity instead of inventing one and never creates machine.json', async () => {
  const { homePath } = await writeHome({ 'config.json': { routing: { executors: [declaration] } } });

  const result = await readLocalRoutingDeclarations(homePath);
  expect(result.machineId).toBeNull();
  expect(result.declarations).toEqual([]);
  expect(result.issues).toEqual([
    { path: 'routing.executors[0].machineId', reason: 'is required because no local machine identity is known' },
  ]);
  expect(await Bun.file(path.join(homePath, '.config', 'ai-usage', 'machine.json')).exists()).toBe(false);
});

test('is empty when no home config exists', async () => {
  const homePath = await mkdtemp(path.join(tmpdir(), 'ai-usage-routing-config-empty-'));
  roots.push(homePath);
  await expect(readLocalRoutingDeclarations(homePath)).resolves.toEqual({
    configPath: path.join(homePath, '.config', 'ai-usage', 'config.json'),
    declarations: [],
    issues: [],
    machineId: null,
    reviewTargetIssues: [],
    reviewTargets: [],
  });
});

test('rejects a routing section that is not an executors array as an invalid config', async () => {
  const { homePath } = await writeHome({ 'config.json': { routing: { executors: 'all' } } });
  await expect(readLocalRoutingDeclarations(homePath)).rejects.toThrow('Invalid ai-usage config');
});

test('reads a pinned account and alternate models from a disposable home, and writes nothing back (ADR 0057)', async () => {
  const pinned = { ...declaration, accountFingerprint: '0123456789abcdef', alternateModels: ['Opus'], model: 'Fable' };
  const { configPath, homePath } = await writeHome({
    'config.json': { routing: { executors: [pinned, { ...pinned, accountFingerprint: 'Not-Hex', harness: 'codex' }] } },
    'machine.json': { id: 'machine-from-file', label: 'Workstation' },
  });
  const written = await Bun.file(configPath).text();

  const result = await readLocalRoutingDeclarations(homePath);
  expect(result.declarations).toEqual([{ ...pinned, effort: null, machineId: 'machine-from-file' }]);
  expect(result.issues).toEqual([
    {
      path: 'routing.executors[1].accountFingerprint',
      reason: 'must be the 16-character lowercase hexadecimal fingerprint the Work view shows',
    },
  ]);
  expect(await Bun.file(configPath).text()).toBe(written);
});
