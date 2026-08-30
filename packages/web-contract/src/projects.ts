import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  array,
  type InferOutput,
  literal,
  maxLength,
  minLength,
  nullable,
  parse,
  picklist,
  pipe,
  regex,
  strictObject,
  string,
  union,
} from 'valibot';
import { publicErrorMap } from './errors';
import { emptyInputSchema, jsonWireValueSchema } from './schema-conventions';

const uuidSchema = pipe(string(), regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u));
const boundedLabelSchema = pipe(string(), minLength(1), maxLength(256));
const remoteSchema = pipe(string(), minLength(1), maxLength(2048));
const localLabelSchema = pipe(string(), regex(/^checkout:[0-9a-f]{8}$/u));

const resolutionCandidateSchema = strictObject({
  canonicalLabel: remoteSchema,
  repositoryId: uuidSchema,
});

const resolutionReviewSchema = strictObject({
  candidateMatches: pipe(array(resolutionCandidateSchema), maxLength(32)),
  checkoutId: uuidSchema,
  destinationSpaceId: uuidSchema,
  deviceId: uuidSchema,
  deviceLabel: boundedLabelSchema,
  localLabel: localLabelSchema,
  normalizedRemote: nullable(remoteSchema),
  status: picklist(['ambiguous', 'candidate', 'unassigned']),
});

export const projectResolutionReviewSnapshotSchema = pipe(
  jsonWireValueSchema,
  strictObject({
    reviews: pipe(array(resolutionReviewSchema), maxLength(100)),
    spaceId: uuidSchema,
  }),
);
export type ProjectResolutionReviewSnapshot = InferOutput<typeof projectResolutionReviewSnapshotSchema>;
export const parseProjectResolutionReviewSnapshot = (value: unknown): ProjectResolutionReviewSnapshot =>
  parse(projectResolutionReviewSnapshotSchema, value);

export const projectResolutionActionSchema = pipe(
  jsonWireValueSchema,
  union([
    strictObject({
      checkoutId: uuidSchema,
      displayName: boundedLabelSchema,
      kind: literal('create-project'),
      spaceId: uuidSchema,
    }),
    strictObject({
      checkoutId: uuidSchema,
      kind: literal('link'),
      projectId: nullable(uuidSchema),
      repositoryId: uuidSchema,
      spaceId: uuidSchema,
    }),
    strictObject({
      checkoutId: uuidSchema,
      kind: literal('leave-unassigned'),
      spaceId: uuidSchema,
    }),
  ]),
);
export type ProjectResolutionAction = InferOutput<typeof projectResolutionActionSchema>;

export const projectResolutionActionResultSchema = pipe(
  jsonWireValueSchema,
  union([
    strictObject({ kind: literal('project-created'), projectId: uuidSchema }),
    strictObject({
      kind: literal('linked'),
      projectId: nullable(uuidSchema),
      repositoryId: uuidSchema,
    }),
    strictObject({ kind: literal('left-unassigned') }),
  ]),
);
export type ProjectResolutionActionResult = InferOutput<typeof projectResolutionActionResultSchema>;
export const parseProjectResolutionActionResult = (value: unknown): ProjectResolutionActionResult =>
  parse(projectResolutionActionResultSchema, value);

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

export const projectsContract = {
  applyResolutionAction: oc
    .route({ method: 'POST', path: '/projects/applyResolutionAction' })
    .input(projectResolutionActionSchema)
    .output(projectResolutionActionResultSchema)
    .errors(mutationErrors),
  resolutionReviews: oc
    .route({ method: 'GET', path: '/projects/resolutionReviews' })
    .input(emptyInputSchema)
    .output(projectResolutionReviewSnapshotSchema)
    .errors(queryErrors),
} as const;

export type ProjectsContractClient = ContractRouterClient<typeof projectsContract>;
