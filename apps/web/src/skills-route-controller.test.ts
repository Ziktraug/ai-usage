import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import type { SkillSnapshotResult } from './skills-client-contracts';
import type { SkillsMutationResult } from './skills-query-operations';
import {
  createSkillsSnapshotCoordinator,
  type OperationNotice,
  type PendingSnapshotReplacement,
  runSkillsControllerOperation,
} from './skills-route-controller-state';
import type { SkillMarkdownDraftGuard } from './skills-workspace';

const snapshot = (sourceRepoPath: string): SkillManagementSnapshot => ({
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

describe('Skills route controller state', () => {
  test('commits successful snapshots to visible state and the Query cache', async () => {
    const committed: unknown[] = [];
    let result: SkillSnapshotResult = { data: snapshot('/initial'), ok: true };
    const notices: (OperationNotice | null)[] = [];
    let refreshVersion = 0;
    const coordinator = createSkillsSnapshotCoordinator({
      commitCache: (next) => committed.push(next),
      dirtyDraft: () => undefined,
      incrementMarkdownRefreshVersion: () => {
        refreshVersion++;
      },
      pendingReplacement: () => undefined,
      refetchInventories: () => Promise.resolve(),
      setDirtyDraft: () => undefined,
      setNotice: (next) => {
        notices.push(next);
      },
      setPendingReplacement: () => undefined,
      setResult: (next) => {
        result = next;
      },
    });

    await coordinator.requestSnapshotReplacement({ data: snapshot('/next'), ok: true }, 'Skills refreshed.', true);

    expect(result.ok && result.data.config.sourceRepoPath).toBe('/next');
    expect(notices).toEqual([{ message: 'Skills refreshed.', tone: 'ok' }]);
    expect(refreshVersion).toBe(1);
    expect(committed).toEqual([{ data: snapshot('/next'), ok: true }]);
  });

  test('protects a dirty draft until the pending snapshot is explicitly discarded', async () => {
    let discarded = false;
    let result: SkillSnapshotResult = { data: snapshot('/initial'), ok: true };
    let pending: PendingSnapshotReplacement | undefined;
    let dirtyDraft: SkillMarkdownDraftGuard | undefined = {
      dirty: true,
      discard: () => {
        discarded = true;
      },
      focus: () => undefined,
      skillName: 'removed-skill',
    };
    const coordinator = createSkillsSnapshotCoordinator({
      commitCache: () => undefined,
      dirtyDraft: () => dirtyDraft,
      incrementMarkdownRefreshVersion: () => undefined,
      pendingReplacement: () => pending,
      refetchInventories: () => Promise.resolve(),
      setDirtyDraft: (next) => {
        dirtyDraft = next;
      },
      setNotice: () => undefined,
      setPendingReplacement: (next) => {
        pending = next;
      },
      setResult: (next) => {
        result = next;
      },
    });

    const replaced = await coordinator.requestSnapshotReplacement(
      { data: snapshot('/pending'), ok: true },
      'Skills reloaded.',
    );
    expect(replaced).toBe(false);
    expect(result.ok && result.data.config.sourceRepoPath).toBe('/initial');

    await coordinator.discardDirtySnapshot();
    expect(discarded).toBe(true);
    expect(result.ok && result.data.config.sourceRepoPath).toBe('/pending');
  });

  test('rejects concurrent operations and exposes mutation failures', async () => {
    let mutationCalls = 0;
    const concurrent = await runSkillsControllerOperation({
      clearReconcilePlan: () => undefined,
      isPending: () => true,
      mutate: (): Promise<SkillsMutationResult> => {
        mutationCalls++;
        return Promise.resolve({ result: { data: snapshot('/unused'), ok: true }, type: 'save-config' });
      },
      request: { type: 'refresh' },
      setNotice: () => undefined,
    });
    expect(concurrent).toBeUndefined();
    expect(mutationCalls).toBe(0);

    let errorNotice: unknown = null;
    await runSkillsControllerOperation({
      clearReconcilePlan: () => undefined,
      isPending: () => false,
      mutate: () => Promise.reject(new Error('refresh failed')),
      request: { type: 'refresh' },
      setNotice: (notice) => {
        errorNotice = notice;
      },
    });
    expect(errorNotice).toEqual({ message: 'refresh failed', tone: 'error' });
  });
});
