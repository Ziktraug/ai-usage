import type { SkillManagementConfig, SkillManagementSnapshot } from '@ai-usage/skills';
import { createMutation, type QueryClient, useQueryClient } from '@tanstack/svelte-query';
import { parseSkillReconcileResult, parseSkillSnapshotResult } from '../../../../skills-client-contracts';
import { describeReconcileActions, type ReconcilePlanSummary } from '../../../../skills-page-model';
import {
  applySkillsConfigurationSnapshotToCache,
  applySkillsSnapshotToCache,
  type SkillsInventoryQueryClient,
  skillsMutationOptions,
} from '../../../query/options/skills';
import {
  type SkillsConfigurationOperation,
  type SkillsManagementOperation,
  skillsConfigurationRefreshesDependents,
  skillsManagementSuccessMessage,
} from './model';

export type SkillsHealthOperationOwner = 'health-detail' | 'health-inspector' | 'health-summary';
export type SkillsManagementOperationOwner = 'configuration' | SkillsHealthOperationOwner | 'matrix';

export type SkillsManagementOperationCommand =
  | {
      readonly kind: 'configuration';
      readonly operation: SkillsConfigurationOperation;
      readonly owner: 'configuration';
      readonly pendingLabel: string;
      readonly successMessage: string;
    }
  | {
      readonly kind: 'management';
      readonly operation: SkillsManagementOperation;
      readonly owner: SkillsHealthOperationOwner | 'matrix';
      readonly pendingLabel: string;
    }
  | {
      readonly kind: 'refresh';
      readonly owner: SkillsHealthOperationOwner;
      readonly pendingLabel: 'refresh-skills';
    };

export interface SkillsManagementOperationOutcome {
  readonly kind: SkillsManagementOperationCommand['kind'];
  readonly message: string | undefined;
  readonly owner: SkillsManagementOperationOwner;
  readonly plan: ReconcilePlanSummary | null;
  readonly snapshot: SkillManagementSnapshot;
}

export interface SkillsManagementOperationNotice {
  readonly message: string;
  readonly owner: SkillsManagementOperationOwner;
  readonly tone: 'error' | 'success';
}

export interface SkillsManagementOperationClient extends SkillsInventoryQueryClient {
  createManagedSkillTargetDirectory(input: { readonly targetId: string }): Promise<unknown>;
  previewReconcileAllManagedSkills(): Promise<unknown>;
  reconcileAllManagedSkills(): Promise<unknown>;
  reconcileManagedSkill(skillName: string): Promise<unknown>;
  refreshSkillManagementSnapshot(): Promise<unknown>;
  saveSkillManagementConfig(input: SkillManagementConfig): Promise<unknown>;
  toggleManagedSkill(input: { readonly enabled: boolean; readonly skillName: string }): Promise<unknown>;
}

const requireSnapshot = (wireResult: unknown): SkillManagementSnapshot => {
  const result = parseSkillSnapshotResult(wireResult);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
};

/**
 * The complete command episode: dispatch through the browser contract adapter, publish the returned
 * snapshot through Query, and derive the presentation outcome from that same authoritative reply.
 */
export const executeSkillsManagementOperationEpisode = async (
  queryClient: QueryClient,
  client: SkillsManagementOperationClient,
  command: SkillsManagementOperationCommand,
): Promise<SkillsManagementOperationOutcome> => {
  if (command.kind === 'refresh') {
    const snapshot = requireSnapshot(await client.refreshSkillManagementSnapshot());
    await applySkillsConfigurationSnapshotToCache(queryClient, client, snapshot, true);
    return { kind: command.kind, message: undefined, owner: command.owner, plan: null, snapshot };
  }

  if (command.kind === 'configuration') {
    const wireResult =
      command.operation.type === 'save-config'
        ? await client.saveSkillManagementConfig(command.operation.config)
        : await client.createManagedSkillTargetDirectory({ targetId: command.operation.targetId });
    const snapshot = requireSnapshot(wireResult);
    await applySkillsConfigurationSnapshotToCache(
      queryClient,
      client,
      snapshot,
      skillsConfigurationRefreshesDependents(command.operation),
    );
    return {
      kind: command.kind,
      message: command.successMessage,
      owner: command.owner,
      plan: null,
      snapshot,
    };
  }

  const wireResult = (() => {
    if (command.operation.type === 'preview-reconcile') {
      return client.previewReconcileAllManagedSkills();
    }
    if (command.operation.type === 'reconcile-all') {
      return client.reconcileAllManagedSkills();
    }
    if (command.operation.type === 'reconcile-skill') {
      return client.reconcileManagedSkill(command.operation.skillName);
    }
    return client.toggleManagedSkill({
      enabled: command.operation.enabled,
      skillName: command.operation.skillName,
    });
  })();
  const result = parseSkillReconcileResult(await wireResult);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const plan =
    command.operation.type === 'preview-reconcile'
      ? describeReconcileActions(result.data.actions, result.data.snapshot.targets)
      : null;
  const success = { actions: result.data.actions, plan, snapshot: result.data.snapshot };
  await applySkillsSnapshotToCache(queryClient, result.data.snapshot);
  return {
    kind: command.kind,
    message: skillsManagementSuccessMessage(command.operation, success),
    owner: command.owner,
    plan,
    snapshot: result.data.snapshot,
  };
};

export interface SkillsManagementOperationEpisodePort {
  readonly clearPlan: () => void;
  readonly execute: (
    command: SkillsManagementOperationCommand,
  ) => Promise<SkillsManagementOperationOutcome | undefined>;
  readonly notice: SkillsManagementOperationNotice | null;
  readonly pendingOperation: string | null;
  readonly plan: ReconcilePlanSummary | null;
}

interface SkillsManagementMutationObserver {
  readonly data: SkillsManagementOperationOutcome | undefined;
  readonly error: Error | null;
  readonly isPending: boolean;
  readonly mutateAsync: (command: SkillsManagementOperationCommand) => Promise<SkillsManagementOperationOutcome>;
  readonly reset: () => void;
  readonly variables: SkillsManagementOperationCommand | undefined;
}

export const createSkillsManagementOperationEpisodePort = (
  mutation: SkillsManagementMutationObserver,
): SkillsManagementOperationEpisodePort => {
  const clearPlan = (): void => mutation.reset();
  const execute = async (
    command: SkillsManagementOperationCommand,
  ): Promise<SkillsManagementOperationOutcome | undefined> => {
    if (mutation.isPending) {
      return;
    }
    mutation.reset();
    try {
      return await mutation.mutateAsync(command);
    } catch {
      return;
    }
  };
  return {
    clearPlan,
    execute,
    get notice(): SkillsManagementOperationNotice | null {
      if (mutation.error instanceof Error && mutation.variables !== undefined) {
        return { message: mutation.error.message, owner: mutation.variables.owner, tone: 'error' };
      }
      const outcome = mutation.data;
      return outcome?.message === undefined
        ? null
        : { message: outcome.message, owner: outcome.owner, tone: 'success' };
    },
    get pendingOperation(): string | null {
      return mutation.isPending ? (mutation.variables?.pendingLabel ?? null) : null;
    },
    get plan(): ReconcilePlanSummary | null {
      return mutation.data?.plan ?? null;
    },
  };
};

/**
 * One observer at the Skills shell lifetime. `createMutation` binds its subscription cleanup to the
 * owning Svelte component; the port adds no cache or parallel controller beside Query.
 */
export const createSkillsManagementOperationEpisode = (
  resolveClient: () => SkillsManagementOperationClient,
): SkillsManagementOperationEpisodePort => {
  const queryClient = useQueryClient();
  const mutation = createMutation(() =>
    skillsMutationOptions('operation-episode', (command: SkillsManagementOperationCommand) =>
      executeSkillsManagementOperationEpisode(queryClient, resolveClient(), command),
    ),
  );
  return createSkillsManagementOperationEpisodePort(mutation);
};
