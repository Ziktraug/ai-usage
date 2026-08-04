import { describe, expect, test } from 'bun:test';
import type { ProjectionAction } from '@ai-usage/skills';
import {
  buildSkillsMatrixView,
  editSourceRepositoryDraft,
  matrixDotTone,
  observeInspectorDisclosure,
  resolveSkillsRefreshAcceptance,
  runSkillsConfigurationOperation,
  runSkillsManagementOperation,
  runSkillsRefreshOperation,
  skillsConfigInput,
  skillsConfigurationRefreshesDependents,
  skillsManagementSuccessMessage,
  skillsSnapshotAcceptanceSignature,
  sourceRepositoryDraftFrom,
  syncSourceRepositoryDraft,
  toggleOperation,
} from './model';
import { syntheticManagementSnapshot } from './synthetic-fixture.test-helper';

describe('Skills management presentation and mutation seam', () => {
  test('preserves matrix sorting, filtering, origin, invocation, and projection tones', () => {
    const snapshot = syntheticManagementSnapshot();
    const all = buildSkillsMatrixView(snapshot, { query: '' });
    expect(all.rows.map((row) => row.name)).toEqual(['alpha-skill', 'beta-skill']);
    expect(all.autoCount).toBe(1);
    expect(all.manualCount).toBe(1);
    expect(all.origins).toEqual(['github', 'skills.sh']);
    expect(buildSkillsMatrixView(snapshot, { invocation: 'manual', query: '' }).rows.map((row) => row.name)).toEqual([
      'beta-skill',
    ]);
    expect(buildSkillsMatrixView(snapshot, { cellState: 'not-linked', query: '' }).rows.map((row) => row.name)).toEqual(
      ['alpha-skill'],
    );
    expect(matrixDotTone('linked')).toBe('linked');
    expect(matrixDotTone('unmanaged-copy')).toBe('copy');
    expect(matrixDotTone('wrong-target')).toBe('broken');
    expect(matrixDotTone('not-applicable')).toBe('none');
  });

  test('previews without applying unmanaged content and returns the server snapshot unchanged', async () => {
    const snapshot = syntheticManagementSnapshot();
    const actions: readonly ProjectionAction[] = [
      {
        path: '/synthetic/runtime/skills/alpha-skill',
        skillName: 'alpha-skill',
        sourcePath: '/synthetic/source/skills/alpha-skill',
        targetId: 'codex',
        type: 'create-symlink',
      },
      {
        path: '/synthetic/runtime/skills/legacy-local-copy',
        reason: 'unmanaged copy',
        skillName: 'legacy-local-copy',
        targetId: 'codex',
        type: 'refuse-unmanaged-mutation',
      },
    ];
    const result = await runSkillsManagementOperation(
      {
        createManagedSkillTargetDirectory: () => Promise.resolve({ data: snapshot, ok: true }),
        previewReconcileAllManagedSkills: () => Promise.resolve({ data: { actions, snapshot }, ok: true }),
        reconcileAllManagedSkills: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true }),
        reconcileManagedSkill: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true }),
        saveSkillManagementConfig: () => Promise.resolve({ data: snapshot, ok: true }),
        toggleManagedSkill: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true }),
      },
      'preview-reconcile',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.snapshot).toEqual(snapshot);
    expect(result.plan?.apply).toEqual(['link alpha-skill @ Codex → /synthetic/runtime/skills/alpha-skill']);
    expect(result.plan?.skipped).toEqual(['legacy-local-copy @ Codex — unmanaged copy']);
  });

  test('preserves action-specific reconciliation copy and parses refresh snapshots', async () => {
    const snapshot = syntheticManagementSnapshot();
    const action: ProjectionAction = {
      path: '/synthetic/runtime/skills/alpha-skill',
      skillName: 'alpha-skill',
      sourcePath: '/synthetic/source/skills/alpha-skill',
      targetId: 'codex',
      type: 'create-symlink',
    };
    expect(
      skillsManagementSuccessMessage('reconcile:alpha-skill', {
        actions: [action],
        plan: null,
        snapshot,
      }),
    ).toBe('alpha-skill linked to Codex.');
    expect(
      skillsManagementSuccessMessage('reconcile:alpha-skill', {
        actions: [],
        plan: null,
        snapshot,
      }),
    ).toBe('Nothing to change.');

    expect(
      await runSkillsRefreshOperation({
        refreshSkillManagementSnapshot: () => Promise.resolve({ data: snapshot, ok: true }),
      }),
    ).toEqual({ ok: true, snapshot });
    expect(
      await runSkillsRefreshOperation({
        refreshSkillManagementSnapshot: () =>
          Promise.resolve({ error: { message: 'Synthetic refresh failure', tag: 'Unavailable' }, ok: false }),
      }),
    ).toEqual({ error: 'Synthetic refresh failure', ok: false });

    expect(skillsSnapshotAcceptanceSignature(structuredClone(snapshot))).toBe(
      skillsSnapshotAcceptanceSignature(snapshot),
    );
    expect(
      skillsSnapshotAcceptanceSignature({ ...snapshot, config: { ...snapshot.config, sourceRepoPath: '/changed' } }),
    ).not.toBe(skillsSnapshotAcceptanceSignature(snapshot));
  });

  test('disarms a kept refresh before a later matching cache publication', () => {
    const refreshed = syntheticManagementSnapshot();
    const current = {
      ...refreshed,
      config: { ...refreshed.config, sourceRepoPath: '/kept-current-snapshot' },
    };
    const target = {
      publicationReady: true,
      signature: skillsSnapshotAcceptanceSignature(refreshed),
    } as const;
    const pendingTarget = { ...target, publicationReady: false } as const;

    const cases = [
      { decision: 'none', expected: 'retain', snapshot: refreshed, target: undefined },
      { decision: 'none', expected: 'retain', snapshot: current, target: pendingTarget },
      { decision: 'pending', expected: 'retain', snapshot: current, target: pendingTarget },
      { decision: 'closed', expected: 'clear', snapshot: current, target: pendingTarget },
      { decision: 'none', expected: 'retain', snapshot: refreshed, target: pendingTarget },
      { decision: 'closed', expected: 'retain', snapshot: refreshed, target: pendingTarget },
      { decision: 'pending', expected: 'retain', snapshot: current, target },
      { decision: 'none', expected: 'clear', snapshot: current, target },
      { decision: 'closed', expected: 'clear', snapshot: current, target },
      { decision: 'none', expected: 'announce', snapshot: refreshed, target },
      { decision: 'pending', expected: 'announce', snapshot: refreshed, target },
      { decision: 'closed', expected: 'announce', snapshot: refreshed, target },
    ] as const;

    expect(
      cases.map(({ decision, snapshot: candidate, target: candidateTarget }) =>
        resolveSkillsRefreshAcceptance(candidateTarget, candidate, decision),
      ),
    ).toEqual(cases.map(({ expected }) => expected));
  });

  test('maps enable and disable requests without changing skill identity', async () => {
    const snapshot = syntheticManagementSnapshot();
    const requests: unknown[] = [];
    const client = {
      createManagedSkillTargetDirectory: () => Promise.resolve({ data: snapshot, ok: true } as const),
      previewReconcileAllManagedSkills: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true } as const),
      reconcileAllManagedSkills: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true } as const),
      reconcileManagedSkill: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true } as const),
      saveSkillManagementConfig: () => Promise.resolve({ data: snapshot, ok: true } as const),
      toggleManagedSkill: (input: unknown) => {
        requests.push(input);
        return Promise.resolve({ data: { actions: [], snapshot }, ok: true } as const);
      },
    };
    await runSkillsManagementOperation(client, toggleOperation('alpha-skill', false));
    await runSkillsManagementOperation(client, toggleOperation('alpha-skill', true));
    expect(requests).toEqual([
      { enabled: false, skillName: 'alpha-skill' },
      { enabled: true, skillName: 'alpha-skill' },
    ]);
  });
  test('preserves a dirty source repository draft across unrelated snapshot refreshes', () => {
    const snapshot = syntheticManagementSnapshot();
    const draft = editSourceRepositoryDraft('/synthetic/unsaved-source', snapshot);
    const refreshedSnapshot = {
      ...snapshot,
      summary: { ...snapshot.summary, diagnosticCount: snapshot.summary.diagnosticCount + 1 },
    };

    expect(syncSourceRepositoryDraft(draft, refreshedSnapshot)).toBe(draft);
    expect(syncSourceRepositoryDraft(sourceRepositoryDraftFrom(snapshot), refreshedSnapshot)).toEqual({
      dirty: false,
      value: '/synthetic/source',
    });
    expect(skillsConfigInput(snapshot, { sourceRepoPath: ' /synthetic/replacement ' })).toEqual({
      ...snapshot.config,
      sourceRepoPath: '/synthetic/replacement',
    });
  });

  test('routes source saves and target creation through typed snapshot operations', async () => {
    const snapshot = syntheticManagementSnapshot();
    const requests: unknown[] = [];
    const client = {
      createManagedSkillTargetDirectory: (input: unknown) => {
        requests.push({ input, type: 'create-target' });
        return Promise.resolve({ data: snapshot, ok: true } as const);
      },
      previewReconcileAllManagedSkills: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true } as const),
      reconcileAllManagedSkills: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true } as const),
      reconcileManagedSkill: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true } as const),
      saveSkillManagementConfig: (input: unknown) => {
        requests.push({ input, type: 'save-config' });
        return Promise.resolve({ data: snapshot, ok: true } as const);
      },
      toggleManagedSkill: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true } as const),
    };

    const config = skillsConfigInput(snapshot, { sourceRepoPath: '/synthetic/replacement' });
    expect(skillsConfigurationRefreshesDependents({ config, type: 'save-config' })).toBe(true);
    expect(skillsConfigurationRefreshesDependents({ targetId: 'codex', type: 'create-target' })).toBe(false);

    expect(await runSkillsConfigurationOperation(client, { config, type: 'save-config' })).toEqual({
      ok: true,
      snapshot,
    });
    expect(await runSkillsConfigurationOperation(client, { targetId: 'codex', type: 'create-target' })).toEqual({
      ok: true,
      snapshot,
    });
    expect(requests).toEqual([
      { input: config, type: 'save-config' },
      { input: { targetId: 'codex' }, type: 'create-target' },
    ]);
  });

  test('synchronizes responsive Inspector disclosures and removes the media listener', () => {
    let matches = true;
    let listener: (() => void) | undefined;
    let removedListener: (() => void) | undefined;
    const mediaQuery = {
      addEventListener: (_type: 'change', nextListener: () => void) => {
        listener = nextListener;
      },
      get matches() {
        return matches;
      },
      removeEventListener: (_type: 'change', nextListener: () => void) => {
        removedListener = nextListener;
      },
    };
    const observed: boolean[] = [];
    const cleanup = observeInspectorDisclosure(mediaQuery, (open) => observed.push(open));

    matches = false;
    listener?.();
    cleanup();

    expect(observed).toEqual([true, false]);
    expect(removedListener).toBe(listener);
  });
});
