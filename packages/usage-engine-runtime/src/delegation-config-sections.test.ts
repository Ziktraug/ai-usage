import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { initializeUsageStore } from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createDelegationService } from './delegation';

/**
 * The persistence half of "a form must restate what it does not edit": the Delegation page's
 * Models and Rules forms write the whole `delegation` section composed from the configuration as
 * read plus their own drafts. This proves, through the real `update-delegation-config` path on a
 * temporary home configuration, that such a composition keeps a route annotation no executor
 * declaration resolves (its context, reserve and concurrency limit) across unrelated saves, and
 * that only an explicit removal drops it.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const NOW = '2026-10-25T10:00:00.000Z';

const PERSONAL_ANNOTATION = { accountScope: 'personal', context: 'personal', harness: 'claude-code' };
/** No declaration resolves to this route; the forms never show it as a route. */
const TEAM_ANNOTATION = {
  accountScope: 'team',
  context: 'professional',
  harness: 'codex',
  label: 'Codex · team',
  maxConcurrent: 2,
  reservePercent: 35,
};
const MODEL = {
  alias: 'opus',
  declaredAt: '2026-10-20T08:00:00.000Z',
  discouragedFor: [],
  harnesses: ['claude-code'],
  id: 'claude-opus',
  nativeId: 'claude-opus-4-1',
  provider: 'anthropic',
  recommendedFor: ['correctness'],
};

const createFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-delegation-sections-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const dbPath = path.join(root, 'state', 'usage.sqlite');
  const storage = createLocalHistoryStorage(home);
  await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  await mkdir(path.join(home, '.config', 'ai-usage'), { mode: 0o700, recursive: true });
  const configPath = path.join(home, '.config', 'ai-usage', 'config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        delegation: { models: [MODEL], routes: [PERSONAL_ANNOTATION, TEAM_ANNOTATION] },
        github: { accounts: [{ ghUser: 'octocat', host: 'github.com', owner: 'acme' }] },
        routing: {
          executors: [
            {
              accountScope: 'personal',
              authorization: 'allowed',
              capabilities: ['read-only-review'],
              declaredAt: '2026-10-21T08:00:00.000Z',
              harness: 'claude-code',
              quality: 'review-capable',
              subscription: 'verified',
              targets: [{ kind: 'any-local-session' }],
            },
          ],
          reviewTargets: [{ checkoutPath: path.join(root, 'work'), label: 'fixture' }],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  const engine = createDelegationService({
    adapters: [],
    dbPath,
    findProcesses: async () => ({ kind: 'absent' }),
    machine: () => machine,
    now: () => new Date(NOW),
    privateRoot: path.join(root, 'state', 'delegation'),
    probeClaudeAccount: () => Promise.resolve({ accountFingerprint: '0123456789abcdef', evidence: 'fixture' }),
    probeCodexAuth: () =>
      Promise.resolve({ authMethod: 'chatgpt', authState: 'logged-in', evidence: 'fixture', outcome: 'observed' }),
    report: () => undefined,
    storage,
  });
  return { configPath, engine, home };
};

/** The typed section as the browser sends it: a plain JSON record. */
const asJsonRecord = (value: object): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const routesInFile = async (configPath: string): Promise<unknown[]> => {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { delegation: { routes: unknown[] } };
  return config.delegation.routes;
};

describe('update-delegation-config with a section composed from the configuration as read', () => {
  test('a models save and a rules save keep an annotation no declaration resolves; only a removal drops it', async () => {
    const fixture = await createFixture();
    const first = await readLocalRoutingDeclarations(fixture.home);
    expect(first.declarations.map((declaration) => declaration.accountScope)).toEqual(['personal']);
    expect(first.delegation.config.routes.map((route) => route.accountScope)).toEqual(['personal', 'team']);

    // The Models form: its model drafts plus every other sub-section as read.
    const modelsSave = await fixture.engine.updateConfig({
      command: 'update-delegation-config',
      delegation: asJsonRecord({
        ...first.delegation.config,
        models: [{ ...MODEL, declaredAt: NOW, note: 'Re-declared with a note' }],
      }),
      expectedRevision: first.revisions.policyRevision,
    });
    expect(modelsSave).toMatchObject({ issues: [], result: 'written' });

    const afterModels = await readLocalRoutingDeclarations(fixture.home);
    expect(afterModels.revisions.policyRevision).toBe(modelsSave.revision);
    expect(afterModels.delegation.config.models[0]?.note).toBe('Re-declared with a note');
    expect(afterModels.delegation.config.routes).toEqual([
      { ...PERSONAL_ANNOTATION, machineId: machine.id },
      { ...TEAM_ANNOTATION, machineId: machine.id },
    ]);
    expect(await routesInFile(fixture.configPath)).toEqual([
      { ...PERSONAL_ANNOTATION, machineId: machine.id },
      { ...TEAM_ANNOTATION, machineId: machine.id },
    ]);

    // The Rules form: its rule drafts plus every other sub-section as read.
    const rule = {
      effect: 'forbid',
      id: 'acme-no-codex',
      match: { githubOwner: 'acme' },
      routes: { harnesses: ['codex'] },
    };
    const rulesSave = await fixture.engine.updateConfig({
      command: 'update-delegation-config',
      delegation: asJsonRecord({ ...afterModels.delegation.config, rules: [rule] }),
      expectedRevision: afterModels.revisions.policyRevision,
    });
    expect(rulesSave).toMatchObject({ issues: [], result: 'written' });

    const afterRules = await readLocalRoutingDeclarations(fixture.home);
    expect(afterRules.delegation.config.rules.map((entry) => entry.id)).toEqual(['acme-no-codex']);
    expect(afterRules.delegation.config.models[0]?.note).toBe('Re-declared with a note');
    expect(afterRules.delegation.config.routes.find((route) => route.accountScope === 'team')).toEqual({
      ...TEAM_ANNOTATION,
      machineId: machine.id,
    });

    // A stale revision never writes, whatever it carries.
    const stale = await fixture.engine.updateConfig({
      command: 'update-delegation-config',
      delegation: asJsonRecord({ ...afterRules.delegation.config, routes: [] }),
      expectedRevision: first.revisions.policyRevision,
    });
    expect(stale).toMatchObject({ result: 'revision-conflict', revision: afterRules.revisions.policyRevision });
    expect((await routesInFile(fixture.configPath)).length).toBe(2);

    // The Routes form, after the operator removed the annotation explicitly.
    const removal = await fixture.engine.updateConfig({
      command: 'update-delegation-config',
      delegation: asJsonRecord({
        ...afterRules.delegation.config,
        routes: afterRules.delegation.config.routes.filter((route) => route.accountScope !== 'team'),
      }),
      expectedRevision: afterRules.revisions.policyRevision,
    });
    expect(removal).toMatchObject({ issues: [], result: 'written' });
    const afterRemoval = await readLocalRoutingDeclarations(fixture.home);
    expect(afterRemoval.delegation.config.routes.map((route) => route.accountScope)).toEqual(['personal']);
    expect(afterRemoval.delegation.config.rules.map((entry) => entry.id)).toEqual(['acme-no-codex']);
    expect(await routesInFile(fixture.configPath)).toEqual([{ ...PERSONAL_ANNOTATION, machineId: machine.id }]);
  });
});
