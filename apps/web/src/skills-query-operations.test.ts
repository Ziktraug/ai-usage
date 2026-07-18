import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { createSkillsMutationRunner, type SkillsMutationPorts } from './skills-query-operations';

const snapshot = (sourceRepoPath = '/skills'): SkillManagementSnapshot => ({
  config: { sourceRepoPath },
  configured: true,
  diagnostics: [],
  nativeRuleFindings: [],
  projections: [],
  skills: [],
  sourceState: { skillEnabledByName: {}, version: 1 },
  summary: {
    activeSkillCount: 0,
    diagnosticCount: 0,
    healthyProjectionCount: 0,
    skillCount: 0,
    targetCount: 0,
    unhealthyProjectionCount: 0,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
});

const ports = (requests: unknown[]): SkillsMutationPorts => ({
  createTarget: (input) => {
    requests.push(input);
    return Promise.resolve({ data: snapshot(), ok: true });
  },
  knownProjectPaths: () => Promise.resolve({ data: [], ok: true }),
  previewReconcile: () => Promise.resolve({ data: { actions: [], snapshot: snapshot() }, ok: true }),
  reconcileAll: () => Promise.resolve({ data: { actions: [], snapshot: snapshot() }, ok: true }),
  reconcileOne: (input) => {
    requests.push(input);
    return Promise.resolve({ data: { actions: [], snapshot: snapshot() }, ok: true });
  },
  refresh: () => Promise.resolve({ data: snapshot('/refreshed'), ok: true }),
  saveConfig: (input) => {
    requests.push(input);
    return Promise.resolve({ data: snapshot(input.data.sourceRepoPath), ok: true });
  },
  toggle: (input) => {
    requests.push(input);
    return Promise.resolve({ data: { actions: [], snapshot: snapshot() }, ok: true });
  },
});

describe('typed skills query operations', () => {
  test('passes domain variables and returns validated typed results', async () => {
    const requests: unknown[] = [];
    const run = createSkillsMutationRunner(ports(requests));
    const saved = await run({ config: { sourceRepoPath: '/next' }, type: 'save-config' });
    const toggled = await run({ enabled: false, skillName: 'example-skill', type: 'toggle' });

    expect(requests).toEqual([
      { data: { sourceRepoPath: '/next' } },
      { data: { enabled: false, skillName: 'example-skill' } },
    ]);
    expect(saved.type === 'save-config' && saved.result.ok && saved.result.data.config.sourceRepoPath).toBe('/next');
    expect(toggled.type === 'toggle' && toggled.result.ok).toBe(true);
  });

  test('validates refresh dependents and rejects malformed server success data', async () => {
    const run = createSkillsMutationRunner(ports([]));
    const refreshed = await run({ type: 'refresh' });
    expect(refreshed.type === 'refresh' && refreshed.knownProjectPaths.ok && refreshed.result.ok).toBe(true);

    const invalidPorts = ports([]);
    invalidPorts.saveConfig = () => Promise.resolve({ data: { private: true }, ok: true });
    await expect(createSkillsMutationRunner(invalidPorts)({ config: {}, type: 'save-config' })).rejects.toThrow(
      'Invalid skills snapshot response',
    );
  });
});
