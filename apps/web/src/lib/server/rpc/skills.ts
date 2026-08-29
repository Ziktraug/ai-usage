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
} from '@ai-usage/web-contract/skills';
import { skillsContract } from '@ai-usage/web-contract/skills';
import { implement, ORPCError, ValidationError } from '@orpc/server';

export interface SkillsCallOptions {
  signal?: AbortSignal;
}

export type SkillsCapabilityResult<T> =
  | { data: T; ok: true }
  | {
      error: {
        message: string;
        tag: string;
      };
      ok: false;
    };

type SkillsCapabilityCall<T> = Promise<SkillsCapabilityResult<T>> | SkillsCapabilityResult<T>;

export interface SkillsCapability {
  createTargetDirectory: (
    input: SkillTargetInput,
    options: SkillsCallOptions,
  ) => SkillsCapabilityCall<SkillManagementSnapshot>;
  previewReconcileAll: (options: SkillsCallOptions) => SkillsCapabilityCall<SkillReconcileResult>;
  readKnownProjectPaths: (options: SkillsCallOptions) => SkillsCapabilityCall<KnownSkillProjectPath[]>;
  readMarkdown: (skillName: string, options: SkillsCallOptions) => SkillsCapabilityCall<SkillMarkdownDocument>;
  readObservations: (options: SkillsCallOptions) => SkillsCapabilityCall<SkillObservations>;
  readProjectInventories: (options: SkillsCallOptions) => SkillsCapabilityCall<ProjectSkillInventory[]>;
  readProjectMarkdown: (
    input: ProjectSkillMarkdownInput,
    options: SkillsCallOptions,
  ) => SkillsCapabilityCall<ProjectSkillMarkdownDocument>;
  readSnapshot: (options: SkillsCallOptions) => SkillsCapabilityCall<SkillManagementSnapshot>;
  reconcileAll: (options: SkillsCallOptions) => SkillsCapabilityCall<SkillReconcileResult>;
  reconcileSkill: (skillName: string, options: SkillsCallOptions) => SkillsCapabilityCall<SkillReconcileResult>;
  refreshSnapshot: (options: SkillsCallOptions) => SkillsCapabilityCall<SkillManagementSnapshot>;
  saveConfig: (
    config: SkillManagementConfig,
    options: SkillsCallOptions,
  ) => SkillsCapabilityCall<SkillManagementSnapshot>;
  saveMarkdown: (
    input: SaveSkillMarkdownInput,
    options: SkillsCallOptions,
  ) => SkillsCapabilityCall<SkillMarkdownSaveResult>;
  toggleSkill: (input: SkillToggleInput, options: SkillsCallOptions) => SkillsCapabilityCall<SkillReconcileResult>;
}

export type SelectSkillsCapability = (options: SkillsCallOptions) => Promise<SkillsCapability> | SkillsCapability;

export type SkillsRequestPreflightResult = { allowed: true } | { allowed: false; tag: 'ForbiddenDemo' };

export type SkillsRequestPreflight = (
  options: SkillsCallOptions,
) => Promise<SkillsRequestPreflightResult> | SkillsRequestPreflightResult;

const allowSkillsRequest: SkillsRequestPreflight = () => ({ allowed: true });

const publicError = (tag: string): ORPCError<string, { reason: string }> => {
  switch (tag) {
    case 'ForbiddenDemo':
      return new ORPCError('ForbiddenDemo', {
        data: { reason: 'forbidden-demo' },
        defined: true,
        message: 'Skills are unavailable in demo mode.',
        status: 403,
      });
    case 'InvalidInput':
      return new ORPCError('InvalidInput', {
        data: { reason: 'invalid-input' },
        defined: true,
        message: 'The Skills request is invalid.',
        status: 400,
      });
    case 'SkillsConflict':
      return new ORPCError('SkillsConflict', {
        data: { reason: 'skills-conflict' },
        defined: true,
        message: 'Skills state changed. Refresh and try again.',
        status: 409,
      });
    default:
      return new ORPCError('Unavailable', {
        data: { reason: 'skills-unavailable' },
        defined: true,
        message: 'Skills are unavailable.',
        status: 503,
      });
  }
};

const unwrap = <T>(result: SkillsCapabilityResult<T>): T => {
  if (result.ok) {
    return result.data;
  }
  throw publicError(result.error.tag);
};

export const skillsValidationErrorFor = (error: unknown): ORPCError<string, { reason: string }> | undefined => {
  const isInputValidationError =
    error instanceof ValidationError ||
    (error instanceof ORPCError && error.code === 'BAD_REQUEST' && error.cause instanceof ValidationError);
  return isInputValidationError ? publicError('InvalidInput') : undefined;
};

const callCapability = async <T>(
  selectCapability: SelectSkillsCapability,
  preflight: SkillsRequestPreflight,
  signal: AbortSignal | undefined,
  call: (capability: SkillsCapability, options: SkillsCallOptions) => SkillsCapabilityCall<T>,
): Promise<T> => {
  const options = signal === undefined ? {} : { signal };
  try {
    signal?.throwIfAborted();
    const preflightResult = await preflight(options);
    signal?.throwIfAborted();
    if (!preflightResult.allowed) {
      throw publicError(preflightResult.tag);
    }
    const capability = await selectCapability(options);
    signal?.throwIfAborted();
    const result = await call(capability, options);
    signal?.throwIfAborted();
    return unwrap(result);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ORPCError) {
      throw error;
    }
    throw publicError('Unavailable');
  }
};

export const createSkillsRouter = (
  selectCapability: SelectSkillsCapability,
  preflight: SkillsRequestPreflight = allowSkillsRequest,
) => {
  const skills = implement(skillsContract);

  return {
    createTargetDirectory: skills.createTargetDirectory.handler(({ input, signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.createTargetDirectory(input, options),
      ),
    ),
    projectInventories: skills.projectInventories.handler(({ signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.readProjectInventories(options),
      ),
    ),
    knownProjectPaths: skills.knownProjectPaths.handler(({ signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.readKnownProjectPaths(options),
      ),
    ),
    observations: skills.observations.handler(({ signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.readObservations(options),
      ),
    ),
    managedMarkdown: skills.managedMarkdown.handler(({ input, signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.readMarkdown(input.skillName, options),
      ),
    ),
    previewReconcileAll: skills.previewReconcileAll.handler(({ signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.previewReconcileAll(options),
      ),
    ),
    projectMarkdown: skills.projectMarkdown.handler(({ input, signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.readProjectMarkdown(input, options),
      ),
    ),
    reconcileAll: skills.reconcileAll.handler(({ signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) => capability.reconcileAll(options)),
    ),
    reconcileOne: skills.reconcileOne.handler(({ input, signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.reconcileSkill(input.skillName, options),
      ),
    ),
    refreshSnapshot: skills.refreshSnapshot.handler(({ signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) => capability.refreshSnapshot(options)),
    ),
    saveConfig: skills.saveConfig.handler(({ input, signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.saveConfig(input, options),
      ),
    ),
    saveManagedMarkdown: skills.saveManagedMarkdown.handler(({ input, signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.saveMarkdown(input, options),
      ),
    ),
    snapshot: skills.snapshot.handler(({ signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) => capability.readSnapshot(options)),
    ),
    toggleProjection: skills.toggleProjection.handler(({ input, signal }) =>
      callCapability(selectCapability, preflight, signal, (capability, options) =>
        capability.toggleSkill(input, options),
      ),
    ),
  };
};

export type SkillsRouter = ReturnType<typeof createSkillsRouter>;
