import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  array,
  boolean,
  finite,
  type InferOutput,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
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
import { emptyInputSchema, jsonWireValueSchema } from './schema-conventions';

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
  applyProposalReviewAction: oc
    .route({ method: 'POST', path: '/memory/applyProposalReviewAction' })
    .input(memoryProposalReviewActionSchema)
    .output(memoryProposalReviewActionResultSchema)
    .errors(mutationErrors),
  proposalReviews: oc
    .route({ method: 'GET', path: '/memory/proposalReviews' })
    .input(emptyInputSchema)
    .output(memoryProposalReviewSnapshotSchema)
    .errors(queryErrors),
  search: oc
    .route({ method: 'POST', path: '/memory/search' })
    .input(memorySearchInputSchema)
    .output(memorySearchPageSchema)
    .errors(searchErrors),
} as const;

export type MemoryContractClient = ContractRouterClient<typeof memoryContract>;
