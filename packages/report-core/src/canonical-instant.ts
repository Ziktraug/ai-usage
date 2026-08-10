declare const canonicalInstantBrand: unique symbol;

export type CanonicalInstant = string & {
  readonly [canonicalInstantBrand]: 'CanonicalInstant';
};

export const isCanonicalInstant = (value: unknown): value is CanonicalInstant => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

export const parseCanonicalInstant = (value: unknown, label = 'timestamp'): CanonicalInstant => {
  if (!isCanonicalInstant(value)) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
};

export const canonicalInstantFromDate = (value: Date): CanonicalInstant => parseCanonicalInstant(value.toISOString());

export const canonicalInstantEpochMs = (value: CanonicalInstant): number => Date.parse(value);

export const compareCanonicalInstants = (left: CanonicalInstant, right: CanonicalInstant): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};
