import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { createMemo, createSignal } from 'solid-js';
import type { SkillSnapshotResult } from './skills-client-contracts';
import type { SkillsMutationRequest, SkillsMutationResult } from './skills-query-operations';
import { snapshotRemovesDirtySkill } from './skills-route-model';
import type { SkillMarkdownDraftGuard } from './skills-workspace';

export interface OperationNotice {
  message: string;
  tone: 'error' | 'ok';
}

export interface PendingSnapshotReplacement {
  afterCommit?: () => void;
  message: string;
  refreshDependents: boolean;
  snapshot: SkillManagementSnapshot;
}

interface SkillsSnapshotOwnerOptions {
  commitCache: (next: SkillSnapshotResult) => void;
  initialResult: SkillSnapshotResult;
  refetchInventories: () => Promise<void>;
}

export interface SkillsSnapshotCoordinatorPorts {
  commitCache: (next: SkillSnapshotResult) => void;
  dirtyDraft: () => SkillMarkdownDraftGuard | undefined;
  incrementMarkdownRefreshVersion: () => void;
  pendingReplacement: () => PendingSnapshotReplacement | undefined;
  refetchInventories: () => Promise<void>;
  setDirtyDraft: (draft?: SkillMarkdownDraftGuard) => void;
  setNotice: (notice: OperationNotice | null) => void;
  setPendingReplacement: (pending?: PendingSnapshotReplacement) => void;
  setResult: (result: SkillSnapshotResult) => void;
}

export const createSkillsSnapshotCoordinator = (ports: SkillsSnapshotCoordinatorPorts) => {
  const commitSnapshotResult = async (
    next: SkillSnapshotResult,
    message: string,
    refreshDependents: boolean,
  ): Promise<void> => {
    ports.setResult(next);
    ports.commitCache(next);
    ports.setNotice(next.ok ? { message, tone: 'ok' } : { message: next.error.message, tone: 'error' });
    if (!(next.ok && refreshDependents)) {
      return;
    }
    if (next.data.configured) {
      await ports.refetchInventories();
    }
    ports.incrementMarkdownRefreshVersion();
  };

  const requestSnapshotReplacement = async (
    next: SkillSnapshotResult,
    message: string,
    refreshDependents = false,
    afterCommit?: () => void,
  ): Promise<boolean> => {
    if (next.ok && snapshotRemovesDirtySkill(next.data, ports.dirtyDraft())) {
      ports.setPendingReplacement({
        ...(afterCommit === undefined ? {} : { afterCommit }),
        message,
        refreshDependents,
        snapshot: next.data,
      });
      return false;
    }
    await commitSnapshotResult(next, message, refreshDependents);
    if (next.ok) {
      afterCommit?.();
    }
    return true;
  };

  const discardDirtySnapshot = async (): Promise<void> => {
    const pending = ports.pendingReplacement();
    if (pending === undefined) {
      return;
    }
    ports.dirtyDraft()?.discard();
    ports.setPendingReplacement();
    ports.setDirtyDraft();
    await commitSnapshotResult({ data: pending.snapshot, ok: true }, pending.message, pending.refreshDependents);
    pending.afterCommit?.();
  };

  return { discardDirtySnapshot, requestSnapshotReplacement };
};

export const createSkillsSnapshotOwner = (options: SkillsSnapshotOwnerOptions) => {
  const [result, setResult] = createSignal(options.initialResult);
  const [operationNotice, setOperationNotice] = createSignal<OperationNotice | null>(null);
  const [markdownRefreshVersion, setMarkdownRefreshVersion] = createSignal(0);
  const [dirtyMarkdownDraft, setDirtyMarkdownDraft] = createSignal<SkillMarkdownDraftGuard>();
  const [pendingSnapshotReplacement, setPendingSnapshotReplacement] = createSignal<PendingSnapshotReplacement>();
  const snapshot = createMemo(() => {
    const current = result();
    return current.ok ? current.data : undefined;
  });
  const errorMessage = createMemo(() => {
    const current = result();
    return current.ok ? '' : current.error.message;
  });
  const coordinator = createSkillsSnapshotCoordinator({
    commitCache: options.commitCache,
    dirtyDraft: dirtyMarkdownDraft,
    incrementMarkdownRefreshVersion: () => setMarkdownRefreshVersion((version) => version + 1),
    pendingReplacement: pendingSnapshotReplacement,
    refetchInventories: options.refetchInventories,
    setDirtyDraft: setDirtyMarkdownDraft,
    setNotice: setOperationNotice,
    setPendingReplacement: setPendingSnapshotReplacement,
    setResult,
  });

  return {
    discardDirtySnapshot: coordinator.discardDirtySnapshot,
    errorMessage,
    keepDirtySnapshot: () => setPendingSnapshotReplacement(),
    markdownRefreshVersion,
    operationNotice,
    pendingSnapshotReplacement,
    requestSnapshotReplacement: coordinator.requestSnapshotReplacement,
    result,
    setDirtyMarkdownDraft,
    setOperationNotice,
    snapshot,
  };
};

interface RunSkillsControllerOperationInput {
  clearReconcilePlan: () => void;
  error?: () => unknown;
  isPending: () => boolean;
  mutate: (request: SkillsMutationRequest) => Promise<SkillsMutationResult>;
  request: SkillsMutationRequest;
  setNotice: (notice: OperationNotice | null) => void;
}

const errorMessageFrom = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const runSkillsControllerOperation = async (
  input: RunSkillsControllerOperationInput,
): Promise<SkillsMutationResult | undefined> => {
  if (input.isPending()) {
    return;
  }
  input.setNotice(null);
  input.clearReconcilePlan();
  try {
    return await input.mutate(input.request);
  } catch (error) {
    input.setNotice({ message: errorMessageFrom(input.error?.() ?? error), tone: 'error' });
  }
};
