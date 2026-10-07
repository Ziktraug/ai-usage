import type { AuthorizationPrincipal, AuthorizationRequestContext, Authorizer } from '@ai-usage/authorization-contract';
import { parseMemoryProposalId, parseProjectId } from '@ai-usage/platform-core/identity';
import {
  DistillationError,
  distillationObject,
  distillationText,
  type SessionAnalysis,
  type SourcedAssertion,
} from '@ai-usage/platform-core/session-distillation';
import { createMemoryApplicationService } from './application';
import {
  type MemoryKind,
  type MemorySensitivity,
  memoryFingerprint,
  memoryKinds,
  parseMemoryJsonValue,
} from './domain';
import { redactMemoryValue } from './redaction';
import type { MemoryRepository } from './repository';

export interface AnalysisPromotionRequest {
  readonly analysisId: string;
  readonly elementKey: string;
  readonly formulation: string;
  readonly kind: MemoryKind;
  readonly localOnly: true;
  readonly projectId: string;
  readonly sensitivity: MemorySensitivity;
  readonly title: string;
}
export interface AnalysisPromotionResult {
  readonly localOnly: true;
  readonly proposalId: ReturnType<typeof parseMemoryProposalId>;
  readonly sourceLocator: string;
}
export const parseAnalysisPromotionRequest = (value: unknown): AnalysisPromotionRequest => {
  const input = distillationObject(value);
  const keys = ['analysisId', 'projectId', 'elementKey', 'title', 'kind', 'formulation', 'sensitivity', 'localOnly'];
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !(key in input)) ||
    !memoryKinds.includes(input.kind as MemoryKind) ||
    !['normal', 'sensitive'].includes(String(input.sensitivity)) ||
    input.localOnly !== true
  ) {
    throw new DistillationError('invalid-promotion');
  }
  return {
    analysisId: distillationText(input.analysisId, 128),
    projectId: parseProjectId(input.projectId),
    elementKey: distillationText(input.elementKey, 160),
    title: distillationText(input.title, 512),
    formulation: distillationText(input.formulation, 4096),
    kind: input.kind as MemoryKind,
    sensitivity: input.sensitivity as MemorySensitivity,
    localOnly: true,
  };
};
export const parseAnalysisPromotionResult = (value: unknown): AnalysisPromotionResult => {
  const input = distillationObject(value);
  if (input.localOnly !== true) {
    throw new DistillationError('invalid-promotion-result');
  }
  return {
    proposalId: parseMemoryProposalId(input.proposalId),
    sourceLocator: distillationText(input.sourceLocator, 1024),
    localOnly: true,
  };
};

export const analysisPromotionAssertion = (analysis: SessionAnalysis, key: string): SourcedAssertion => {
  if (key === 'summary') {
    return analysis.content.summary;
  }
  for (const episode of analysis.content.episodes) {
    if (key === `${episode.id}:result`) {
      return episode.result.assertion;
    }
    const index = episode.decisions.findIndex((_, i) => key === `${episode.id}:decision:${i}`);
    if (index >= 0 && episode.decisions[index]) {
      return episode.decisions[index];
    }
  }
  throw new DistillationError('element-not-found');
};

/** Reads the immutable source itself. Clients choose a passage, never supply its evidence or authority. */
export const createAnalysisPromotionService = (options: {
  readonly authorizer: Authorizer;
  readonly repository: MemoryRepository;
  readonly readAnalysis: (projectId: string, analysisId: string) => Promise<SessionAnalysis>;
}) => {
  const application = createMemoryApplicationService(options.authorizer, options.repository);
  return async (
    input: AnalysisPromotionRequest,
    context: {
      readonly principal: AuthorizationPrincipal;
      readonly authorization: AuthorizationRequestContext;
    },
  ): Promise<AnalysisPromotionResult> => {
    const request = parseAnalysisPromotionRequest(input);
    const projectId = parseProjectId(request.projectId);
    const access = await options.authorizer.check({
      ...context,
      context: context.authorization,
      permission: 'propose_memory',
      resource: { id: projectId, kind: 'project', spaceId: context.authorization.activeSpaceId },
    });
    if (access.kind !== 'allow') {
      throw new DistillationError(access.kind === 'deny' ? 'forbidden' : 'authorization-unavailable');
    }
    const analysis = await options.readAnalysis(projectId, request.analysisId);
    if (analysis.projectId !== projectId || analysis.id !== request.analysisId) {
      throw new DistillationError('analysis-scope-mismatch');
    }
    const assertion = analysisPromotionAssertion(analysis, request.elementKey);
    const sourceLocator = `/memory?view=analyses&project=${encodeURIComponent(projectId)}&analysis=${encodeURIComponent(analysis.id)}&element=${encodeURIComponent(request.elementKey)}`;
    const content = parseMemoryJsonValue({
      analysisId: analysis.id,
      analysisRevision: analysis.revision,
      snapshotDigest: analysis.source.version.digest,
      elementKey: request.elementKey,
      assertion,
      coverage: analysis.coverage,
      sourceLocator,
      publicationPolicy: 'local-only',
    });
    const draft = redactMemoryValue(
      { title: request.title, formulation: request.formulation, kind: request.kind },
      request.sensitivity,
    );
    const fingerprint = memoryFingerprint({
      source: content,
      draft: draft.value,
      sensitivity: draft.sensitivity,
      projectId,
    });
    const proposal = await application.createProposal({
      ...context,
      projectId,
      observationIds: [],
      localAnalysisObservation: { content, fingerprint: memoryFingerprint(content), sourceLocator },
      title: request.title,
      summary: request.formulation,
      guidance: [request.formulation],
      proposedKind: request.kind,
      structuredContent: content,
      sensitivity: request.sensitivity,
      trustCandidate: 'harvest-accepted',
      localAnalysisSource: {
        analysisId: analysis.id,
        analysisRevision: analysis.revision,
        elementKey: request.elementKey,
        fingerprint,
        projectId,
        snapshotDigest: analysis.source.version.digest,
      },
    });
    if (proposal.kind !== 'success') {
      throw new DistillationError(proposal.error.code);
    }
    return { proposalId: proposal.value, sourceLocator, localOnly: true };
  };
};
