import {
  parseSessionCampaignChildrenRequest,
  parseSessionNeighborRequest,
  parseSessionQueryRequest,
} from '@ai-usage/report-core/session-query';
import { parseWebUsageEngineCommand } from '@ai-usage/usage-engine-control';
import {
  knownSkillProjectPathsSchema,
  projectSkillInventoriesSchema,
  projectSkillMarkdownDocumentSchema,
  skillManagementSnapshotSchema,
  skillMarkdownDocumentSchema,
  skillMarkdownSaveResultSchema,
  skillReconcileResultSchema,
} from '@ai-usage/web-contract/skills';
import { parse } from 'valibot';
import type { RuntimeMode } from '../../../runtime-mode';
import type { SkillsServerAdapter, SkillsServerAdapterResult } from '../../../server/skills-contracts';
import { type E2ESkillsFixtureVariant, e2eSkillsFixtureVariantForHeaders } from './e2e-fixture-profile';
import type { WebRpcRouterDependencies } from './router';
import type { SkillsCallOptions, SkillsCapability, SkillsCapabilityResult } from './skills';

const phaseBound = async <Result>(
  signal: AbortSignal | undefined,
  operation: () => Promise<Result> | Result,
): Promise<Result> => {
  signal?.throwIfAborted();
  const result = await operation();
  signal?.throwIfAborted();
  return result;
};

const abortOptions = (signal: AbortSignal | undefined): { readonly signal?: AbortSignal } =>
  signal === undefined ? {} : { signal };

const normalizeSkillsResult = async <Output>(
  result: SkillsServerAdapterResult<unknown>,
  normalize: (value: unknown) => Output,
): Promise<SkillsCapabilityResult<Output>> => {
  const settled = await result;
  return settled.ok ? { data: normalize(settled.data), ok: true } : settled;
};

const adaptSkillsCapability = (adapter: SkillsServerAdapter): SkillsCapability => ({
  createTargetDirectory: async (input, options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.createTargetDirectory(input), (value) =>
          parse(skillManagementSnapshotSchema, value),
        ),
    ),
  previewReconcileAll: async (options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.previewReconcileAll(), (value) => parse(skillReconcileResultSchema, value)),
    ),
  readKnownProjectPaths: async (options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.readKnownProjectPaths(), (value) =>
          parse(knownSkillProjectPathsSchema, value),
        ),
    ),
  readMarkdown: async (skillName, options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.readMarkdown(skillName), (value) =>
          parse(skillMarkdownDocumentSchema, value),
        ),
    ),
  readProjectInventories: async (options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.readProjectInventories(), (value) =>
          parse(projectSkillInventoriesSchema, value),
        ),
    ),
  readProjectMarkdown: async (input, options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.readProjectMarkdown(input), (value) =>
          parse(projectSkillMarkdownDocumentSchema, value),
        ),
    ),
  readSnapshot: async (options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.readSnapshot(), (value) => parse(skillManagementSnapshotSchema, value)),
    ),
  reconcileAll: async (options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.reconcileAll(), (value) => parse(skillReconcileResultSchema, value)),
    ),
  reconcileSkill: async (skillName, options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.reconcileSkill(skillName), (value) =>
          parse(skillReconcileResultSchema, value),
        ),
    ),
  refreshSnapshot: async (options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.refreshSnapshot(), (value) => parse(skillManagementSnapshotSchema, value)),
    ),
  saveConfig: async (config, options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.saveConfig(config), (value) => parse(skillManagementSnapshotSchema, value)),
    ),
  saveMarkdown: async (input, options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.saveMarkdown(input), (value) =>
          parse(skillMarkdownSaveResultSchema, value),
        ),
    ),
  toggleSkill: async (input, options) =>
    await phaseBound(
      options.signal,
      async () =>
        await normalizeSkillsResult(adapter.toggleSkill(input), (value) => parse(skillReconcileResultSchema, value)),
    ),
});

const e2eSkillsAdapter = async (variant: E2ESkillsFixtureVariant = 'extended'): Promise<SkillsServerAdapter> => {
  const fixture = await import('../../../server/skills-e2e-fixture.server');
  const extended = variant === 'extended';
  return {
    createTargetDirectory: fixture.createE2ESkillTargetDirectory,
    previewReconcileAll: fixture.previewE2EReconcileAllSkills,
    readKnownProjectPaths: extended
      ? fixture.readExtendedE2EKnownSkillProjectPaths
      : fixture.readE2EKnownSkillProjectPaths,
    readMarkdown: fixture.readE2ESkillMarkdown,
    readProjectInventories: extended
      ? fixture.readExtendedE2ESkillProjectInventories
      : fixture.readE2ESkillProjectInventories,
    readProjectMarkdown: fixture.readE2EProjectSkillMarkdown,
    readSnapshot: fixture.readE2ESkillManagementSnapshot,
    reconcileAll: fixture.reconcileAllE2ESkills,
    reconcileSkill: fixture.reconcileE2ESkill,
    refreshSnapshot: fixture.readE2ERefreshedSkillManagementSnapshot,
    saveConfig: fixture.writeE2ESkillManagementConfig,
    saveMarkdown: fixture.writeE2ESkillMarkdown,
    toggleSkill: fixture.toggleE2ESkill,
  };
};

export const createE2ESkillsCapability = async (variant: E2ESkillsFixtureVariant): Promise<SkillsCapability> =>
  adaptSkillsCapability(await e2eSkillsAdapter(variant));

const runtimeMode = async (options: SkillsCallOptions): Promise<RuntimeMode> =>
  await phaseBound(options.signal, async () => {
    const { getServerRuntimeMode } = await import('../../../server/runtime-mode.server');
    return getServerRuntimeMode();
  });

const selectSkillsCapability = async (
  options: SkillsCallOptions,
  fixtureVariant: E2ESkillsFixtureVariant,
): Promise<SkillsCapability> => {
  const mode = await runtimeMode(options);
  if (mode === 'e2e') {
    return adaptSkillsCapability(await phaseBound(options.signal, () => e2eSkillsAdapter(fixtureVariant)));
  }
  const server = await phaseBound(options.signal, async () => await import('../../../server/skills.server'));
  return adaptSkillsCapability(server.createSkillsServerAdapter(server.createSkillsServerDependencies()));
};

const preflightSkills = async (options: SkillsCallOptions) => {
  const mode = await runtimeMode(options);
  return mode === 'demo' ? ({ allowed: false, tag: 'ForbiddenDemo' } as const) : ({ allowed: true } as const);
};

const createReportDependencies = (request: Request): WebRpcRouterDependencies['report'] => ({
  getCampaignLabelOverrides: async ({ signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/campaign-labels.server');
      return await server.getCampaignLabelOverridesForServer();
    }),
  getProviderQuotaHistory: async (input, { signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/provider-quota-resolver.server');
      return await server.resolveProviderQuotaHistoryForServer(input, undefined, undefined, abortOptions(signal));
    }),
  getReportPerfEnabled: async ({ signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/report-payload.server');
      return server.reportPerfEnabled();
    }),
  getReportRevisionBootstrap: async ({ signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/report-payload.server');
      return await server.getReportRevisionBootstrapForServer(undefined, undefined, abortOptions(signal));
    }),
  getReportRevisionManifest: async ({ signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/report-payload.server');
      return await server.getReportRevisionManifestForServer(undefined, undefined, abortOptions(signal));
    }),
  runFocusedBreakdown: async (input, { signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/revision-query-runner.server');
      return await server.runRevisionQueryForServer('breakdown', input, undefined, abortOptions(signal));
    }),
  runFocusedOverview: async (input, { signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/revision-query-runner.server');
      return await server.runRevisionQueryForServer('overview', input, undefined, abortOptions(signal));
    }),
  runFocusedSupport: async (input, { signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/revision-query-runner.server');
      return await server.runRevisionQueryForServer('support', input, undefined, abortOptions(signal));
    }),
  saveProjectGroups: async (input, { signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/report-payload.server');
      const command = parseWebUsageEngineCommand(input);
      if (command.command !== 'replace-project-groups-by-reference') {
        throw new Error('Expected a project group reference command.');
      }
      const result = await server.saveProjectGroupsFromRequestForServer(request, command);
      if (!result.accepted) {
        throw new Error('The project group command was not accepted.');
      }
      return { accepted: true };
    }),
  setCampaignLabelOverride: async (input, { signal }) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/campaign-labels.server');
      return await server.setCampaignLabelOverrideFromRequestForServer(request, input);
    }),
});

const createSessionDependencies = (): WebRpcRouterDependencies['session'] => ({
  getDetail: async (input, signal) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/session-detail.server');
      return await server.getLocalSessionDetailForServer(input, undefined, abortOptions(signal));
    }),
  resolveVcs: async (input, signal) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/session-vcs.server');
      return await server.resolveSessionVcsForServer(input, undefined, abortOptions(signal));
    }),
  runRevisionQuery: async (kind, input, signal): Promise<unknown> =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/revision-query-runner.server');
      if (kind === 'campaign-children') {
        return await server.runRevisionQueryForServer(
          kind,
          parseSessionCampaignChildrenRequest(input),
          undefined,
          abortOptions(signal),
        );
      }
      if (kind === 'neighbors') {
        return await server.runRevisionQueryForServer(
          kind,
          parseSessionNeighborRequest(input),
          undefined,
          abortOptions(signal),
        );
      }
      return await server.runRevisionQueryForServer(
        kind,
        parseSessionQueryRequest(input),
        undefined,
        abortOptions(signal),
      );
    }),
});

const createSyncDependencies = (request: Request): WebRpcRouterDependencies['sync'] => ({
  getFleet: async (signal) =>
    await phaseBound(signal, async () => {
      const [{ getSyncFleetForServer }, { resolveUsageReadModelForServer }] = await Promise.all([
        import('../../../server/sync-data.server'),
        import('../../../server/usage-read-model-resolver.server'),
      ]);
      return await getSyncFleetForServer(
        await resolveUsageReadModelForServer(),
        signal === undefined ? {} : { signal },
      );
    }),
  setMachineLabel: async (input, signal) =>
    await phaseBound(signal, async () => {
      const server = await import('../../../server/machine-label.server');
      return await server.setMachineLabelFromRequestForServer(request, input);
    }),
});

export const createWebRpcRouterDependencies = (request: Request): Promise<WebRpcRouterDependencies> => {
  const fixtureVariant = e2eSkillsFixtureVariantForHeaders(request.headers);
  return Promise.resolve({
    report: createReportDependencies(request),
    session: createSessionDependencies(),
    skills: {
      preflight: preflightSkills,
      selectCapability: async (options) => await selectSkillsCapability(options, fixtureVariant),
    },
    sync: createSyncDependencies(request),
  });
};
