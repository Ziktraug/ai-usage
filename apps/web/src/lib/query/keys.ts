export type QueryFamily = string;
export type QueryIdentityPart = boolean | number | string;

export type CurrentAliasQueryKey = readonly ['web', 'current-alias', QueryFamily];
export type ImmutableRevisionQueryKey = readonly [
  'web',
  'immutable-revision',
  QueryFamily,
  revision: string,
  fingerprint: string,
  destination: string,
];
export type FiniteSwrQueryKey = readonly ['web', 'finite-swr', QueryFamily, ...identity: readonly QueryIdentityPart[]];
export type ControlPlaneQueryKey = readonly [
  'web',
  'control-plane',
  QueryFamily,
  ...identity: readonly QueryIdentityPart[],
];

export type WebQueryKey = ControlPlaneQueryKey | CurrentAliasQueryKey | FiniteSwrQueryKey | ImmutableRevisionQueryKey;

export const currentAliasKey = (family: QueryFamily): CurrentAliasQueryKey => ['web', 'current-alias', family];

export const immutableRevisionKey = (
  family: QueryFamily,
  revision: string,
  fingerprint: string,
  destination: string,
): ImmutableRevisionQueryKey => ['web', 'immutable-revision', family, revision, fingerprint, destination];

export const finiteSwrKey = (family: QueryFamily, ...identity: readonly QueryIdentityPart[]): FiniteSwrQueryKey => [
  'web',
  'finite-swr',
  family,
  ...identity,
];

export const controlPlaneKey = (
  family: QueryFamily,
  ...identity: readonly QueryIdentityPart[]
): ControlPlaneQueryKey => ['web', 'control-plane', family, ...identity];
