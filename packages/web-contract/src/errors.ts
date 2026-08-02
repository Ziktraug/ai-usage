import { type InferOutput, optional, picklist, strictObject } from 'valibot';
import { publicMessageSchema, publicReasonSchema } from './schema-conventions';

export const publicErrorFamilies = [
  'Conflict',
  'EngineUnavailable',
  'Forbidden',
  'ForbiddenDemo',
  'IncompatibleStore',
  'InvalidInput',
  'RevisionExpired',
  'SkillsConflict',
  'Unavailable',
] as const;

export type PublicErrorFamily = (typeof publicErrorFamilies)[number];

export const publicErrorSchema = strictObject({
  message: publicMessageSchema,
  reason: optional(publicReasonSchema),
  tag: picklist(publicErrorFamilies),
});

export type PublicError = InferOutput<typeof publicErrorSchema>;
export const publicErrorDataSchema = strictObject({
  reason: optional(publicReasonSchema),
});

export const publicErrorMap = {
  Conflict: { data: publicErrorDataSchema },
  EngineUnavailable: { data: publicErrorDataSchema },
  Forbidden: { data: publicErrorDataSchema },
  ForbiddenDemo: { data: publicErrorDataSchema },
  IncompatibleStore: { data: publicErrorDataSchema },
  InvalidInput: { data: publicErrorDataSchema },
  RevisionExpired: { data: publicErrorDataSchema },
  SkillsConflict: { data: publicErrorDataSchema },
  Unavailable: { data: publicErrorDataSchema },
} as const satisfies Readonly<Record<PublicErrorFamily, { readonly data: typeof publicErrorDataSchema }>>;

export const isPublicErrorFamily = (value: unknown): value is PublicErrorFamily =>
  typeof value === 'string' && (publicErrorFamilies as readonly string[]).includes(value);
