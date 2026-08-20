declare const servedRevisionBrand: unique symbol;

export type ServedRevision = string & {
  readonly [servedRevisionBrand]: 'ServedRevision';
};

export const SERVED_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export const isServedRevision = (value: unknown): value is ServedRevision =>
  typeof value === 'string' && SERVED_REVISION_PATTERN.test(value);

export const parseServedRevision = (value: unknown, label = 'served revision'): ServedRevision => {
  if (!isServedRevision(value)) {
    throw new Error(`${label} must be a canonical opaque identifier`);
  }
  return value;
};
