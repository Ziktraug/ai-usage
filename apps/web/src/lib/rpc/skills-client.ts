import type {
  KnownSkillProjectPath,
  ProjectSkillInventory,
  ProjectSkillMarkdownDocument,
  ProjectSkillMarkdownInput,
  SaveSkillMarkdownInput,
  SkillManagementConfig,
  SkillManagementSnapshot,
  SkillMarkdownDocument,
  SkillMarkdownSaveResult,
  SkillObservations,
  SkillReconcileResult,
  SkillTargetInput,
  SkillToggleInput,
  skillsContract,
} from '@ai-usage/web-contract/skills';
import { ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';

export interface SkillsClientCallOptions {
  signal?: AbortSignal;
}

export type SkillsClientResult<T> =
  | { data: T; ok: true }
  | {
      error: {
        message: string;
        tag: string;
      };
      ok: false;
    };

type SkillsRpcClient = ContractRouterClient<typeof skillsContract>;

const fallbackError = {
  message: 'Skills are unavailable.',
  tag: 'Unavailable',
} as const;

const call = async <T>(
  request: (options: SkillsClientCallOptions) => Promise<T>,
  options: SkillsClientCallOptions,
): Promise<SkillsClientResult<T>> => {
  try {
    options.signal?.throwIfAborted();
    const data = await request(options);
    options.signal?.throwIfAborted();
    return { data, ok: true };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof ORPCError && error.defined) {
      return {
        error: {
          message: error.message,
          tag: error.code,
        },
        ok: false,
      };
    }
    return { error: fallbackError, ok: false };
  }
};

export const createSkillsClient = (rpc: SkillsRpcClient) => ({
  createManagedSkillTargetDirectory: (
    input: SkillTargetInput,
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillManagementSnapshot>> =>
    call((callOptions) => rpc.createTargetDirectory(input, callOptions), options),
  getKnownSkillProjectPaths: (
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<readonly KnownSkillProjectPath[]>> =>
    call((callOptions) => rpc.knownProjectPaths({}, callOptions), options),
  getManagedSkillMarkdown: (
    skillName: string,
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillMarkdownDocument>> =>
    call((callOptions) => rpc.managedMarkdown({ skillName }, callOptions), options),
  getProjectSkillMarkdown: (
    input: ProjectSkillMarkdownInput,
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<ProjectSkillMarkdownDocument>> =>
    call((callOptions) => rpc.projectMarkdown(input, callOptions), options),
  getSkillManagementSnapshot: (
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillManagementSnapshot>> =>
    call((callOptions) => rpc.snapshot({}, callOptions), options),
  getSkillObservations: (options: SkillsClientCallOptions = {}): Promise<SkillsClientResult<SkillObservations>> =>
    call((callOptions) => rpc.observations({}, callOptions), options),
  getSkillProjectInventories: (
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<readonly ProjectSkillInventory[]>> =>
    call((callOptions) => rpc.projectInventories({}, callOptions), options),
  previewReconcileAllManagedSkills: (
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillReconcileResult>> =>
    call((callOptions) => rpc.previewReconcileAll({}, callOptions), options),
  reconcileAllManagedSkills: (
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillReconcileResult>> =>
    call((callOptions) => rpc.reconcileAll({}, callOptions), options),
  reconcileManagedSkill: (
    skillName: string,
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillReconcileResult>> =>
    call((callOptions) => rpc.reconcileOne({ skillName }, callOptions), options),
  refreshSkillManagementSnapshot: (
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillManagementSnapshot>> =>
    call((callOptions) => rpc.refreshSnapshot({}, callOptions), options),
  saveManagedSkillMarkdown: (
    input: SaveSkillMarkdownInput,
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillMarkdownSaveResult>> =>
    call((callOptions) => rpc.saveManagedMarkdown(input, callOptions), options),
  saveSkillManagementConfig: (
    input: SkillManagementConfig,
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillManagementSnapshot>> =>
    call((callOptions) => rpc.saveConfig(input, callOptions), options),
  toggleManagedSkill: (
    input: SkillToggleInput,
    options: SkillsClientCallOptions = {},
  ): Promise<SkillsClientResult<SkillReconcileResult>> =>
    call((callOptions) => rpc.toggleProjection(input, callOptions), options),
});

export type SkillsClient = ReturnType<typeof createSkillsClient>;
