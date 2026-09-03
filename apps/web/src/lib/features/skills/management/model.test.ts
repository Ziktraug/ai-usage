import { describe, expect, test } from 'bun:test';
import type { ProjectionAction } from '@ai-usage/skills';
import {
  buildSkillsMatrixView,
  editSourceRepositoryDraft,
  matrixDotTone,
  observeInspectorDisclosure,
  reconcileSkillOperation,
  resolveSkillsRefreshAcceptance,
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

  test('preserves action-specific reconciliation copy and snapshot acceptance signatures', () => {
    const snapshot = syntheticManagementSnapshot();
    const action: ProjectionAction = {
      path: '/synthetic/runtime/skills/alpha-skill',
      skillName: 'alpha-skill',
      sourcePath: '/synthetic/source/skills/alpha-skill',
      targetId: 'codex',
      type: 'create-symlink',
    };
    expect(
      skillsManagementSuccessMessage(reconcileSkillOperation('alpha-skill'), {
        actions: [action],
        plan: null,
        snapshot,
      }),
    ).toBe('alpha-skill linked to Codex.');
    expect(
      skillsManagementSuccessMessage(reconcileSkillOperation('alpha-skill'), {
        actions: [],
        plan: null,
        snapshot,
      }),
    ).toBe('Nothing to change.');
    // A toggle that moved no files still flipped the state, and the message must say the flip
    // happened rather than reading as a no-op.
    expect(
      skillsManagementSuccessMessage(toggleOperation('alpha-skill', false), {
        actions: [],
        plan: null,
        snapshot,
      }),
    ).toBe('Disabled alpha-skill — no file changes were needed.');

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
    const config = skillsConfigInput(snapshot, { sourceRepoPath: '/synthetic/replacement' });
    expect(skillsConfigurationRefreshesDependents({ config, type: 'save-config' })).toBe(true);
    expect(skillsConfigurationRefreshesDependents({ targetId: 'codex', type: 'create-target' })).toBe(false);
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
