export interface PlatformReadiness {
  readonly schemaVersion: number;
  readonly status: 'ready';
}

export interface PlatformStoreReader {
  readonly checkReadiness: () => Promise<PlatformReadiness>;
}

export const checkPlatformReadiness = (reader: PlatformStoreReader): Promise<PlatformReadiness> =>
  reader.checkReadiness();

export type { PlatformStoreErrorCode } from './errors';
export { isPlatformStoreError, PlatformStoreError } from './errors';
