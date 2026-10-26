import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import type { DelegationQualification } from '@ai-usage/report-core/delegation-contracts';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import type { DelegationExecutorHarness } from '@ai-usage/report-core/delegation-vocabulary';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { ExecutorObservation } from '@ai-usage/report-core/work-executors';
import type { UsageEngineDelegationQualificationOutput } from '@ai-usage/usage-engine-control';
import {
  importExecutorObservations,
  importProviderQuotaBatch,
  initializeUsageStore,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createDelegationService } from './delegation';
import type { RoutingQualificationExecutorRun } from './runtime';

/**
 * The remotes of a real temporary checkout, read by the engine, matched by a `forbid githubOwner`
 * rule, and applied to route admission: equivalent URL spellings must block the same route; a
 * remote the engine cannot identify must keep the rule as an assumption, never lift it; a known
 * absence of GitHub remotes must leave the route admissible. No harness is launched.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const NOW = '2026-10-25T10:00:00.000Z';
const PERSONAL_ROUTE = `declared:${JSON.stringify([machine.id, 'claude-code', 'personal'])}`;
const WORK_ROUTE = `declared:${JSON.stringify([machine.id, 'codex', 'work'])}`;
const RUN: RoutingQualificationExecutorRun = { source: null, startedAt: NOW };
/** The source of a partly identified remote fact carries counts only, never a URL. */
const PARTIAL_SOURCE = /^git remote -v \(\d+ of \d+ remote URLs not identified\)$/u;
const FORBID_ACME_ON_PERSONAL = {
  effect: 'forbid',
  id: 'no-acme-on-personal',
  match: { githubOwner: 'acme' },
  routes: { contexts: ['personal'] },
};

const declarationFor = (harness: DelegationExecutorHarness, accountScope: string): Record<string, unknown> => ({
  accountScope,
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T08:00:00.000Z',
  harness,
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
});

const observationFor = (harness: DelegationExecutorHarness): ExecutorObservation => ({
  authEvidence: `${harness} status exit 0`,
  authMethod: harness === 'claude-code' ? 'claude.ai' : null,
  authState: 'logged-in',
  binaryPath: `/usr/local/bin/${harness}`,
  harness,
  machineId: machine.id,
  observedAt: '2026-10-25T09:58:00.000Z',
  outcome: 'observed',
  version: harness === 'claude-code' ? '2.1.306 (Claude Code)' : 'codex-cli 0.164.0',
});

const quotaFor = (providerKey: 'claude' | 'codex'): ProviderQuotaObservation => ({
  accountScope: null,
  machineId: machine.id,
  machineLabel: machine.label,
  observedAt: '2026-10-25T09:57:00.000Z',
  plan: providerKey === 'claude' ? 'max' : 'plus',
  providerGeneratedAt: null,
  providerKey,
  providerLabel: providerKey === 'claude' ? 'Claude' : 'Codex',
  source: { confidence: 'authoritative', key: `fixture-${providerKey}`, mode: 'poll' },
  state: 'ok',
  windows: [
    {
      blocked: false,
      group: '5h',
      id: 'five_hour',
      label: '5h',
      limitSeconds: 18_000,
      remainingPercent: 70,
      resetsAt: '2026-10-25T13:00:00.000Z',
      scope: 'global',
      usedPercent: 30,
    },
  ],
});

interface Fixture {
  readonly checkout: string;
  readonly commit: string;
  readonly service: ReturnType<typeof createDelegationService>;
}

/** A checkout with the given remotes, a home config with both routes and the forbid rule, a store with both routes live. */
const createFixture = async (remotes: readonly (readonly [name: string, url: string])[]): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-delegation-remotes-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'work', 'checkout');
  await mkdir(checkout, { recursive: true });
  const git = async (...args: string[]): Promise<string> => {
    const run = Bun.spawn(['git', ...args], {
      cwd: checkout,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
      },
      stderr: 'ignore',
      stdout: 'pipe',
    });
    const stdout = await new Response(run.stdout).text();
    if ((await run.exited) !== 0) {
      throw new Error(`git ${args.join(' ')} failed in the fixture`);
    }
    return stdout.trim();
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  for (const [name, url] of remotes) {
    await git('remote', 'add', name, url);
  }
  await writeFile(path.join(checkout, 'a.txt'), 'one\n');
  await git('add', 'a.txt');
  await git('commit', '-q', '-m', 'first');
  await writeFile(path.join(checkout, 'a.txt'), 'one\ntwo\n');
  await git('commit', '-q', '-am', 'second');
  const commit = await git('rev-parse', 'HEAD');
  const storage = createLocalHistoryStorage(home);
  await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  await mkdir(path.join(home, '.config', 'ai-usage'), { mode: 0o700, recursive: true });
  await writeFile(
    path.join(home, '.config', 'ai-usage', 'config.json'),
    `${JSON.stringify(
      {
        delegation: {
          routes: [
            { accountScope: 'personal', context: 'personal', harness: 'claude-code' },
            { accountScope: 'work', context: 'professional', harness: 'codex' },
          ],
          rules: [FORBID_ACME_ON_PERSONAL],
        },
        github: { accounts: [{ ghUser: 'octocat', host: 'github.com', owner: 'acme' }] },
        routing: {
          executors: [declarationFor('claude-code', 'personal'), declarationFor('codex', 'work')],
          reviewTargets: [{ checkoutPath: path.join(root, 'work'), label: 'fixture' }],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const dbPath = path.join(root, 'state', 'usage.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine, updatedAt: new Date(NOW) }));
  await Effect.runPromise(
    importExecutorObservations({ dbPath, observations: [observationFor('claude-code'), observationFor('codex')] }),
  );
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      items: [
        { observation: quotaFor('claude'), sourceEventKey: 'fixture-claude-1' },
        { observation: quotaFor('codex'), sourceEventKey: 'fixture-codex-1' },
      ],
    }),
  );
  const service = createDelegationService({
    adapterOptions: { env: { HOME: home, PATH: process.env.PATH } },
    dbPath,
    findProcesses: async () => ({ kind: 'absent' }),
    machine: () => machine,
    now: () => new Date(NOW),
    privateRoot: path.join(root, 'state', 'delegation'),
    probeClaudeAccount: () => Promise.resolve({ accountFingerprint: '0123456789abcdef', evidence: 'fixture' }),
    probeCodexAuth: () =>
      Promise.resolve({ authMethod: 'chatgpt', authState: 'logged-in', evidence: 'fixture', outcome: 'observed' }),
    report: () => undefined,
    runLimits: { heartbeatMs: 25 },
    storage,
  });
  return { checkout, commit, service };
};

const qualificationOf = (output: UsageEngineDelegationQualificationOutput): DelegationQualification => {
  const parsed = parseDelegationQualification(output.qualification);
  if (parsed === null) {
    throw new Error('the engine produced a qualification that does not parse');
  }
  return parsed;
};

/** Simulate a review of the fixture checkout and return the qualification with its two routes. */
const simulate = async (remotes: readonly (readonly [string, string])[]) => {
  const fixture = await createFixture(remotes);
  const qualification = qualificationOf(
    await fixture.service.qualify(
      {
        command: 'qualify-delegation',
        purpose: 'simulation',
        request: {
          action: 'read-only-review',
          checkout: { path: fixture.checkout },
          constraints: [],
          criteria: ['The change is explained'],
          objective: 'Review the second commit of the fixture for correctness',
          schemaVersion: 1,
          scope: { commit: fixture.commit, kind: 'commit' },
          taskCategory: 'correctness',
        },
      },
      RUN,
    ),
  );
  const routeOf = (routeId: string) => {
    const route = qualification.routes.find((entry) => entry.routeId === routeId);
    if (route === undefined) {
      throw new Error(`route ${routeId} is missing from the qualification`);
    }
    return route;
  };
  return { personal: routeOf(PERSONAL_ROUTE), qualification, work: routeOf(WORK_ROUTE) };
};

describe('delegation remotes → facts → rules → route admission', () => {
  test.each([
    ['SCP form', 'git@github.com:acme/widgets.git'],
    ['SSH URL without a port', 'ssh://git@github.com/acme/widgets.git'],
    ['SSH URL with the explicit port 22', 'ssh://git@github.com:22/acme/widgets.git'],
    ['HTTPS without a port', 'https://github.com/acme/widgets'],
    ['HTTPS with the explicit port 443', 'https://github.com:443/acme/widgets.git'],
    ['SSH over 443 through ssh.github.com', 'ssh://git@ssh.github.com:443/acme/widgets.git'],
  ])('an identified GitHub remote in %s blocks the personal route by the owner rule', async (_, url) => {
    const { personal, qualification, work } = await simulate([['origin', url]]);
    expect(qualification.checkoutFacts).toMatchObject({
      githubAccount: { provenance: 'declared', value: 'octocat' },
      githubOwners: { provenance: 'observed', source: 'git remote -v', value: ['acme'] },
      repositories: { provenance: 'observed', source: 'git remote -v', value: ['acme/widgets'] },
    });
    expect(qualification.appliedRules).toEqual([
      { applies: 'yes', effect: 'forbid', id: 'no-acme-on-personal', reason: 'matches githubOwner acme' },
    ]);
    expect(personal.admissible).toBe(false);
    expect(personal.blockers).toEqual(['forbidden-by-rule']);
    expect(work.admissible).toBe(true);
    expect(qualification.admissibleRouteIds).toEqual([WORK_ROUTE]);
  });

  test('several remotes: a known non-GitHub remote beside an identified one does not weaken the rule', async () => {
    const { personal, qualification, work } = await simulate([
      ['origin', 'https://gitlab.example.com/acme/widgets.git'],
      ['upstream', 'git@github.com:acme/widgets.git'],
    ]);
    expect(qualification.checkoutFacts?.githubOwners).toEqual({
      provenance: 'observed',
      source: 'git remote -v',
      value: ['acme'],
    });
    expect(qualification.appliedRules).toEqual([
      { applies: 'yes', effect: 'forbid', id: 'no-acme-on-personal', reason: 'matches githubOwner acme' },
    ]);
    expect(personal.blockers).toEqual(['forbidden-by-rule']);
    expect(work.admissible).toBe(true);
  });

  test.each([
    ['an ssh host alias', [['origin', 'git@github-pro:acme/widgets.git']]],
    ['an ssh URL to a non-GitHub host', [['origin', 'ssh://git@git.example.com/acme/widgets.git']]],
    ['a GitHub URL with a malformed port', [['origin', 'ssh://git@github.com:2x2/acme/widgets.git']]],
    ['a GitHub URL whose path is not owner/repo', [['origin', 'https://github.com/acme/widgets/extra']]],
    [
      'a mix of identified, known non-GitHub and unidentified remotes',
      [
        ['fork', 'https://github.com/someone/widgets.git'],
        ['lab', 'https://gitlab.example.com/acme/widgets.git'],
        ['origin', 'git@github.com-work:acme/widgets.git'],
      ],
    ],
  ] as const)('%s keeps the owner rule as an assumption: the personal route stays blocked', async (_, remotes) => {
    const { personal, qualification, work } = await simulate(remotes);
    const owners = qualification.checkoutFacts?.githubOwners;
    expect(owners?.provenance).toBe('partial');
    expect(owners?.source).toMatch(PARTIAL_SOURCE);
    expect(qualification.checkoutFacts?.githubAccount).toMatchObject({ provenance: 'unknown', value: null });
    expect(qualification.appliedRules).toHaveLength(1);
    expect(qualification.appliedRules[0]).toMatchObject({
      applies: 'assumed',
      effect: 'forbid',
      id: 'no-acme-on-personal',
    });
    const assumption = qualification.assumptions.find((entry) => entry.startsWith('Rule no-acme-on-personal'));
    expect(assumption).toContain('is assumed to apply because githubOwner (git remote -v (');
    expect(assumption).toContain('remote URLs not identified)) is only partly identified');
    expect(personal.admissible).toBe(false);
    expect(personal.blockers).toEqual(['forbidden-by-rule']);
    expect(work.admissible).toBe(true);
  });

  test('a mixed listing identifies what it can: a matching identified owner applies the rule outright', async () => {
    const { personal, qualification } = await simulate([
      ['alias', 'git@github-pro:someone/other.git'],
      ['origin', 'https://github.com:443/acme/widgets.git'],
    ]);
    // Each remote lists a fetch and a push URL: the alias accounts for 2 of the 4 lines.
    expect(qualification.checkoutFacts?.githubOwners).toEqual({
      provenance: 'partial',
      source: 'git remote -v (2 of 4 remote URLs not identified)',
      value: ['acme'],
    });
    expect(qualification.appliedRules).toEqual([
      { applies: 'yes', effect: 'forbid', id: 'no-acme-on-personal', reason: 'matches githubOwner acme' },
    ]);
    expect(personal.blockers).toEqual(['forbidden-by-rule']);
  });

  test.each([
    ['no remote at all', []],
    ['only an HTTPS GitLab remote', [['origin', 'https://gitlab.example.com/acme/widgets.git']]],
    [
      'only lookalike HTTPS hosts',
      [
        ['a', 'https://github.com.evil.example/acme/widgets.git'],
        ['b', 'https://evilgithub.com/acme/widgets.git'],
        ['c', 'https://gist.github.com/acme/widgets.git'],
        ['d', 'https://github.company.com/acme/widgets.git'],
      ],
    ],
  ] as const)('%s is a known absence of GitHub remotes: the owner rule does not apply', async (_, remotes) => {
    const { personal, qualification, work } = await simulate(remotes);
    expect(qualification.checkoutFacts?.githubOwners).toEqual({
      provenance: 'observed',
      source: 'git remote -v',
      value: [],
    });
    expect(qualification.checkoutFacts?.githubAccount).toMatchObject({
      provenance: 'unknown',
      source: 'github.accounts (no github.com remote)',
    });
    expect(qualification.appliedRules).toEqual([]);
    expect(qualification.assumptions.some((entry) => entry.startsWith('Rule '))).toBe(false);
    expect(personal.admissible).toBe(true);
    expect(work.admissible).toBe(true);
  });
});
