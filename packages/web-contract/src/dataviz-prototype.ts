/** Development-only snapshot contract for the dataviz prototype. No session content. */
import { oc } from '@orpc/contract';
import {
  array,
  boolean,
  type InferOutput,
  literal,
  maxLength,
  minValue,
  nullable,
  number,
  picklist,
  pipe,
  strictObject,
  string,
} from 'valibot';
import { publicErrorMap } from './errors';
import { emptyInputSchema } from './schema-conventions';

const label = pipe(string(), maxLength(500));
const count = pipe(number(), minValue(0));
const segment = strictObject({ model: label, tokens: count });
export const prototypeRowSchema = strictObject({
  id: label,
  sourceId: nullable(label),
  parentId: nullable(label),
  campaign: label,
  campaignLabel: label,
  root: boolean(),
  label,
  harness: label,
  project: label,
  projectLabel: label,
  day: nullable(label),
  tokens: count,
  partial: boolean(),
  segments: pipe(array(segment), maxLength(100)),
});
const detailSchema = strictObject({
  rowId: label,
  status: picklist(['available', 'unavailable']),
  note: label,
  rounds: pipe(array(strictObject({ index: count, start: label, tokens: count })), maxLength(2000)),
  interactions: pipe(
    array(strictObject({ to: nullable(label), round: nullable(count), kind: picklist(['spawn', 'message']) })),
    maxLength(2000),
  ),
});
export const datavizPrototypeSnapshotSchema = strictObject({
  version: literal(1),
  revision: label,
  capturedAt: label,
  generatedAt: label,
  rows: pipe(array(prototypeRowSchema), maxLength(20_000)),
  details: pipe(array(detailSchema), maxLength(12)),
});
export type DatavizPrototypeSnapshot = InferOutput<typeof datavizPrototypeSnapshotSchema>;
export type PrototypeRow = InferOutput<typeof prototypeRowSchema>;
export const datavizPrototypeContract = {
  snapshot: oc
    .route({ method: 'GET', path: '/datavizPrototype/snapshot' })
    .input(emptyInputSchema)
    .output(datavizPrototypeSnapshotSchema)
    .errors({ Unavailable: publicErrorMap.Unavailable }),
};
