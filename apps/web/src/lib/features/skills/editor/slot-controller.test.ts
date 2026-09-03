import { describe, expect, test } from 'bun:test';
import type { SkillMarkdownDocument, SkillMarkdownSaveResult } from '@ai-usage/web-contract/skills';
import { QueryObserver } from '@tanstack/svelte-query';
import { createWebQueryClient } from '../../../query/client';
import {
  managedSkillMarkdownKey,
  skillObservationsKey,
  skillsKnownProjectPathsKey,
  skillsSnapshotKey,
} from '../../../query/options/skills';
import { webQueryPolicies } from '../../../query/policies';
import type { SkillsClientResult } from '../../../rpc/skills-client';
import { createDirtyGuardRegistry } from '../../shell/dirty-navigation-context';
import { normalizeSkillsQuerySnapshot } from '../shell/model';
import type { SkillsSnapshotUpdatePort } from '../shell/slot-context';
import { createSkillsSnapshotController } from '../shell/snapshot-controller';
import { syntheticManagedDocument, syntheticSnapshot } from '../shell/synthetic-fixture.test-helper';
import { createSkillsEditorSlotController } from './slot-controller';

const savedDocument: SkillMarkdownDocument = {
  ...syntheticManagedDocument,
  content: '# Saved editor draft\n',
  sha256: 'b'.repeat(64),
};

describe('P9 Skills editor slot integration', () => {
  test('registers one identity, defers destructive Query replacement, and awaits discard', async () => {
    const queryClient = createWebQueryClient();
    const initialWire = syntheticSnapshot();
    const initial = normalizeSkillsQuerySnapshot(initialWire);
    queryClient.setQueryData(skillsSnapshotKey(), initialWire);
    let accepted = initial;
    const snapshots = createSkillsSnapshotController({
      initial,
      onCommit: (snapshot) => {
        accepted = snapshot;
      },
    });
    const registered: unknown[] = [];
    const unregistered: unknown[] = [];
    const snapshotUpdates: SkillsSnapshotUpdatePort = {
      get pendingDecision() {
        const pending = snapshots.pending();
        return pending
          ? {
              discard: snapshots.discardPending,
              focus: snapshots.focusDraft,
              keep: snapshots.retainCurrent,
              snapshot: pending,
            }
          : undefined;
      },
      registerDraft: (guard) => {
        registered.push(guard);
        snapshots.registerDraft(guard);
      },
      unregisterDraft: (guard) => {
        unregistered.push(guard);
        snapshots.unregisterDraft(guard);
      },
    };
    let focused = 0;
    const dirtyRegistry = createDirtyGuardRegistry();
    const slot = createSkillsEditorSlotController({
      client: {
        getManagedSkillMarkdown: () => Promise.resolve({ data: syntheticManagedDocument, ok: true }),
        saveManagedSkillMarkdown: (): Promise<SkillsClientResult<SkillMarkdownSaveResult>> =>
          Promise.resolve({ data: { document: savedDocument, snapshot: initialWire }, ok: true }),
      },
      dirtyRegistry,
      document: syntheticManagedDocument,
      queryClient,
      snapshotUpdates,
    });
    slot.setFocus(() => {
      focused += 1;
    });
    const dispose = slot.mount();
    expect(() => slot.mount()).toThrow('already mounted');
    slot.editor.setDraft('# Exact retained draft\n');
    expect(registered).toHaveLength(1);
    expect(dirtyRegistry.dirty.getState()).toBe(true);

    const observer = new QueryObserver(queryClient, {
      ...webQueryPolicies.finiteSwr,
      enabled: false,
      queryFn: () => Promise.resolve(initialWire),
      queryKey: skillsSnapshotKey(),
    });
    const unsubscribe = observer.subscribe(({ data }) => {
      if (data) {
        snapshots.apply(normalizeSkillsQuerySnapshot(data));
      }
    });
    const removalWire = syntheticSnapshot([]);
    const removal = normalizeSkillsQuerySnapshot(removalWire);
    const secondRemovalWire = {
      ...removalWire,
      config: { ...removalWire.config, sourceRepoPath: '/synthetic/refreshed-source' },
    };
    const secondRemoval = normalizeSkillsQuerySnapshot(secondRemovalWire);
    queryClient.setQueryData(skillsSnapshotKey(), removalWire);
    await Promise.resolve();

    expect(snapshotUpdates.pendingDecision?.snapshot).toEqual(removal);
    const retainedDecision = snapshotUpdates.pendingDecision;
    retainedDecision?.keep();
    retainedDecision?.focus();
    expect(focused).toBe(1);
    expect(slot.editor.getState()).toMatchObject({ dirty: true, draft: '# Exact retained draft\n' });
    expect(accepted).toBe(initial);

    queryClient.setQueryData(skillsSnapshotKey(), secondRemovalWire);
    await Promise.resolve();
    expect(await snapshotUpdates.pendingDecision?.discard()).toBe(true);
    expect(accepted).toEqual(secondRemoval);
    expect(slot.editor.getState().dirty).toBe(false);
    expect(dirtyRegistry.dirty.getState()).toBe(false);

    dispose();
    dispose();
    expect(unregistered).toEqual(registered);
    expect(dirtyRegistry.dirty.getState()).toBe(false);
    unsubscribe();
    queryClient.clear();
  });

  test('publishes a confirmed save and invalidates the inventory-joined observations', async () => {
    const queryClient = createWebQueryClient();
    const initialWire = syntheticSnapshot();
    const nextSnapshot = {
      ...initialWire,
      config: { ...initialWire.config, sourceRepoPath: '/synthetic/after-save' },
    };
    const unrelatedKey = skillsKnownProjectPathsKey();
    const unrelated = [{ label: 'untouched' }];
    queryClient.setQueryData(managedSkillMarkdownKey('alpha-skill'), syntheticManagedDocument);
    queryClient.setQueryData(skillObservationsKey(), { marker: 'old inventory join' });
    queryClient.setQueryData(skillsSnapshotKey(), initialWire);
    queryClient.setQueryData(unrelatedKey, unrelated);
    const slot = createSkillsEditorSlotController({
      client: {
        getManagedSkillMarkdown: () => Promise.resolve({ data: syntheticManagedDocument, ok: true }),
        saveManagedSkillMarkdown: (): Promise<SkillsClientResult<SkillMarkdownSaveResult>> =>
          Promise.resolve({ data: { document: savedDocument, snapshot: nextSnapshot }, ok: true }),
      },
      dirtyRegistry: createDirtyGuardRegistry(),
      document: syntheticManagedDocument,
      queryClient,
      snapshotUpdates: {
        pendingDecision: undefined,
        registerDraft: () => undefined,
        unregisterDraft: () => undefined,
      },
    });
    slot.editor.setDraft(savedDocument.content);
    await slot.editor.save();

    expect(queryClient.getQueryData<SkillMarkdownDocument>(managedSkillMarkdownKey('alpha-skill'))).toEqual(
      savedDocument,
    );
    expect(queryClient.getQueryData<typeof nextSnapshot>(skillsSnapshotKey())).toEqual(nextSnapshot);
    expect(queryClient.getQueryState(skillObservationsKey())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData<typeof unrelated>(unrelatedKey)).toBe(unrelated);
    queryClient.clear();
  });
});
