import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  array,
  boolean,
  exactOptional,
  finite,
  type InferOutput,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  optional,
  parse,
  picklist,
  pipe,
  regex,
  safeInteger,
  strictObject,
  string,
  union,
} from 'valibot';
import { publicErrorMap } from './errors';
import { jsonWireValueSchema } from './schema-conventions';

const uuidSchema = pipe(string(), regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u));
const instantSchema = pipe(string(), minLength(20), maxLength(64));
const titleSchema = pipe(string(), minLength(1), maxLength(512));
const summarySchema = pipe(string(), maxLength(16_384));
const guidanceSchema = pipe(array(pipe(string(), minLength(1), maxLength(4096))), maxLength(64));
const sourceLocatorSchema = pipe(string(), minLength(1), maxLength(4096));
const cursorSchema = pipe(string(), minLength(1), maxLength(4096));
const sensitivitySchema = picklist(['normal', 'sensitive']);
const contentHashSchema = pipe(string(), regex(/^[0-9a-f]{64}$/u));
const boundedPositiveIntegerSchema = pipe(number(), safeInteger(), minValue(1));
const boundedResultLimitSchema = pipe(boundedPositiveIntegerSchema, maxValue(25));
const nonNegativeFiniteNumberSchema = pipe(number(), finite(), minValue(0));
const nonNegativeIntegerSchema = pipe(number(), safeInteger(), minValue(0));

export const memorySearchInputSchema = pipe(
  jsonWireValueSchema,
  strictObject({
    cursor: nullable(cursorSchema),
    includeSpaceWide: boolean(),
    limit: boundedResultLimitSchema,
    matchingMode: picklist(['hybrid', 'literal']),
    projectId: nullable(uuidSchema),
    kinds: exactOptional(
      pipe(
        array(picklist(['decision', 'pattern', 'pitfall', 'command', 'constraint', 'handoff', 'lesson', 'preference'])),
        maxLength(8),
      ),
    ),
    query: pipe(string(), minLength(1), maxLength(512)),
  }),
);
export type MemorySearchInput = InferOutput<typeof memorySearchInputSchema>;
export const parseMemorySearchInput = (value: unknown): MemorySearchInput => parse(memorySearchInputSchema, value);

const memorySearchMatchExplanationSchema = strictObject({
  excerpt: pipe(string(), maxLength(384)),
  field: picklist(['guidance', 'structured-content', 'summary', 'title']),
  kind: picklist(['exact', 'fuzzy', 'lexical', 'prefix']),
});

const memorySearchProvenanceSchema = strictObject({
  observationId: uuidSchema,
  observedAt: instantSchema,
  sensitivity: sensitivitySchema,
  sourceKind: picklist(['agent', 'commit', 'file', 'import', 'pull-request', 'session', 'user']),
  verification: literal('accepted-proposal-evidence'),
});

const memorySearchResultSchema = strictObject({
  chunkerVersion: literal('memory-search-chunker-v1'),
  contentHash: contentHashSchema,
  guidance: pipe(array(pipe(string(), maxLength(2048))), maxLength(16)),
  id: uuidSchema,
  kind: picklist(['decision', 'pattern', 'pitfall', 'command', 'constraint', 'handoff', 'lesson', 'preference']),
  matchedBecause: pipe(array(memorySearchMatchExplanationSchema), maxLength(8)),
  projectId: nullable(uuidSchema),
  provenance: pipe(array(memorySearchProvenanceSchema), maxLength(8)),
  rank: strictObject({
    exact: nonNegativeFiniteNumberSchema,
    lexical: nonNegativeFiniteNumberSchema,
    total: nonNegativeFiniteNumberSchema,
    trigram: nonNegativeFiniteNumberSchema,
  }),
  resourceKind: literal('memory'),
  revisionId: uuidSchema,
  revisionNumber: boundedPositiveIntegerSchema,
  sensitivity: sensitivitySchema,
  status: picklist(['active', 'archived', 'rejected', 'superseded']),
  summary: pipe(string(), maxLength(4096)),
  title: pipe(string(), maxLength(512)),
  trust: picklist(['explicit', 'harvest-accepted']),
});

export const memorySearchPageSchema = pipe(
  jsonWireValueSchema,
  strictObject({
    items: pipe(array(memorySearchResultSchema), maxLength(25)),
    nextCursor: nullable(cursorSchema),
    queryFingerprint: contentHashSchema,
    rankingVersion: pipe(string(), minLength(1), maxLength(128)),
    total: nonNegativeIntegerSchema,
  }),
);
export type MemorySearchPage = InferOutput<typeof memorySearchPageSchema>;
export const parseMemorySearchPage = (value: unknown): MemorySearchPage => parse(memorySearchPageSchema, value);

const proposalObservationSourceSchema = strictObject({
  id: uuidSchema,
  observedAt: instantSchema,
  sensitivity: sensitivitySchema,
  sourceKind: picklist(['agent', 'commit', 'file', 'import', 'pull-request', 'session', 'user']),
  sourceLocator: nullable(sourceLocatorSchema),
});

const memoryKindSchema = picklist([
  'decision',
  'pattern',
  'pitfall',
  'command',
  'constraint',
  'handoff',
  'lesson',
  'preference',
]);
export const memoryKnowledgeInputSchema = strictObject({
  cursor: nullable(cursorSchema),
  projectId: nullable(uuidSchema),
  kind: nullable(memoryKindSchema),
  pageSize: pipe(boundedPositiveIntegerSchema, maxValue(20)),
});
export type MemoryKnowledgeInput = InferOutput<typeof memoryKnowledgeInputSchema>;
export const memoryKnowledgePageSchema = pipe(
  jsonWireValueSchema,
  strictObject({
    nextCursor: nullable(cursorSchema),
    items: pipe(
      array(
        strictObject({
          id: uuidSchema,
          revisionId: uuidSchema,
          revisionNumber: boundedPositiveIntegerSchema,
          title: titleSchema,
          summary: summarySchema,
          guidance: guidanceSchema,
          projectId: nullable(uuidSchema),
          kind: memoryKindSchema,
          sensitivity: sensitivitySchema,
          trust: picklist(['explicit', 'harvest-accepted']),
          createdAt: instantSchema,
          contentOmitted: boolean(),
          provenance: strictObject({
            sourceLocator: nullable(sourceLocatorSchema),
            sourceKind: nullable(literal('session')),
            analysisRevision: nullable(boundedPositiveIntegerSchema),
          }),
        }),
      ),
      maxLength(20),
    ),
  }),
);
export type MemoryKnowledgePage = InferOutput<typeof memoryKnowledgePageSchema>;
export const parseMemoryKnowledgePage = (input: unknown): MemoryKnowledgePage =>
  parse(memoryKnowledgePageSchema, input);
export const memoryKnowledgeGetInputSchema = strictObject({ itemId: uuidSchema, revisionId: uuidSchema });
export type MemoryKnowledgeGetInput = InferOutput<typeof memoryKnowledgeGetInputSchema>;
export const memoryKnowledgeDetailSchema = pipe(
  jsonWireValueSchema,
  strictObject({
    id: uuidSchema,
    revisionId: uuidSchema,
    title: titleSchema,
    summary: summarySchema,
    guidance: guidanceSchema,
    structuredContent: jsonWireValueSchema,
  }),
);
export type MemoryKnowledgeDetail = InferOutput<typeof memoryKnowledgeDetailSchema>;

export const memoryPromotionInputSchema = pipe(
  jsonWireValueSchema,
  strictObject({
    analysisId: pipe(string(), minLength(1), maxLength(128)),
    projectId: uuidSchema,
    elementKey: pipe(string(), minLength(1), maxLength(160)),
    title: titleSchema,
    kind: memoryKindSchema,
    formulation: pipe(string(), minLength(1), maxLength(4096)),
    sensitivity: sensitivitySchema,
    localOnly: literal(true),
  }),
);
export type MemoryPromotionInput = InferOutput<typeof memoryPromotionInputSchema>;
export const memoryPromotionResultSchema = strictObject({
  proposalId: uuidSchema,
  sourceLocator: sourceLocatorSchema,
  localOnly: literal(true),
});
export type MemoryPromotionResult = InferOutput<typeof memoryPromotionResultSchema>;
export const memoryProposalReviewInputSchema = strictObject({ cursor: optional(nullable(cursorSchema)) });
export type MemoryProposalReviewInput = InferOutput<typeof memoryProposalReviewInputSchema>;

const proposalReviewSchema = strictObject({
  guidance: guidanceSchema,
  observationSources: pipe(array(proposalObservationSourceSchema), maxLength(100)),
  projectId: nullable(uuidSchema),
  proposalId: uuidSchema,
  proposedByKind: picklist(['person', 'service']),
  proposedKind: picklist([
    'decision',
    'pattern',
    'pitfall',
    'command',
    'constraint',
    'handoff',
    'lesson',
    'preference',
  ]),
  sensitivity: sensitivitySchema,
  structuredContent: jsonWireValueSchema,
  summary: summarySchema,
  title: titleSchema,
  trustCandidate: picklist(['explicit', 'harvest-accepted']),
});

export const memoryProposalReviewSnapshotSchema = pipe(
  jsonWireValueSchema,
  strictObject({
    nextCursor: nullable(cursorSchema),
    proposals: pipe(array(proposalReviewSchema), maxLength(100)),
    spaceId: uuidSchema,
  }),
);
export type MemoryProposalReviewSnapshot = InferOutput<typeof memoryProposalReviewSnapshotSchema>;
export const parseMemoryProposalReviewSnapshot = (value: unknown): MemoryProposalReviewSnapshot =>
  parse(memoryProposalReviewSnapshotSchema, value);

const proposalEditsSchema = strictObject({
  guidance: guidanceSchema,
  sensitivity: sensitivitySchema,
  structuredContent: jsonWireValueSchema,
  summary: summarySchema,
  title: titleSchema,
});

export const memoryProposalReviewActionSchema = pipe(
  jsonWireValueSchema,
  union([
    strictObject({
      kind: literal('accept'),
      proposalId: uuidSchema,
      scope: picklist(['person', 'project', 'space']),
      spaceId: uuidSchema,
    }),
    strictObject({
      edits: proposalEditsSchema,
      kind: literal('accept'),
      proposalId: uuidSchema,
      scope: picklist(['person', 'project', 'space']),
      spaceId: uuidSchema,
    }),
    strictObject({
      kind: literal('reject'),
      proposalId: uuidSchema,
      reason: pipe(string(), minLength(1), maxLength(4096)),
      spaceId: uuidSchema,
    }),
  ]),
);
export type MemoryProposalReviewAction = InferOutput<typeof memoryProposalReviewActionSchema>;
export const parseMemoryProposalReviewAction = (value: unknown): MemoryProposalReviewAction =>
  parse(memoryProposalReviewActionSchema, value);

export const memoryProposalReviewActionResultSchema = pipe(
  jsonWireValueSchema,
  union([
    strictObject({ itemId: uuidSchema, kind: literal('accepted'), revisionId: uuidSchema }),
    strictObject({ kind: literal('rejected'), proposalId: uuidSchema }),
  ]),
);
export type MemoryProposalReviewActionResult = InferOutput<typeof memoryProposalReviewActionResultSchema>;
export const parseMemoryProposalReviewActionResult = (value: unknown): MemoryProposalReviewActionResult =>
  parse(memoryProposalReviewActionResultSchema, value);

const queryErrors = {
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  Unavailable: publicErrorMap.Unavailable,
} as const;

const mutationErrors = {
  Forbidden: publicErrorMap.Forbidden,
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  InvalidInput: publicErrorMap.InvalidInput,
  Unavailable: publicErrorMap.Unavailable,
} as const;

const searchErrors = {
  Forbidden: publicErrorMap.Forbidden,
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  InvalidInput: publicErrorMap.InvalidInput,
  Unavailable: publicErrorMap.Unavailable,
} as const;

export const memoryContract = {
  getKnowledge: oc
    .route({ method: 'POST', path: '/memory/getKnowledge' })
    .input(memoryKnowledgeGetInputSchema)
    .output(memoryKnowledgeDetailSchema)
    .errors(searchErrors),
  knowledge: oc
    .route({ method: 'POST', path: '/memory/knowledge' })
    .input(memoryKnowledgeInputSchema)
    .output(memoryKnowledgePageSchema)
    .errors(searchErrors),
  promote: oc
    .route({ method: 'POST', path: '/memory/promote' })
    .input(memoryPromotionInputSchema)
    .output(memoryPromotionResultSchema)
    .errors(mutationErrors),
  applyProposalReviewAction: oc
    .route({ method: 'POST', path: '/memory/applyProposalReviewAction' })
    .input(memoryProposalReviewActionSchema)
    .output(memoryProposalReviewActionResultSchema)
    .errors(mutationErrors),
  proposalReviews: oc
    .route({ method: 'GET', path: '/memory/proposalReviews' })
    .input(memoryProposalReviewInputSchema)
    .output(memoryProposalReviewSnapshotSchema)
    .errors(queryErrors),
  search: oc
    .route({ method: 'POST', path: '/memory/search' })
    .input(memorySearchInputSchema)
    .output(memorySearchPageSchema)
    .errors(searchErrors),
} as const;

export type MemoryContractClient = ContractRouterClient<typeof memoryContract>;
