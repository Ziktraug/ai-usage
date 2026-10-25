import type { Device, DeviceCredentialId, DeviceId, Instant } from '@ai-usage/platform-core/identity';

export interface DeviceCredentialMetadata {
  readonly createdAt: Instant;
  readonly deviceId: DeviceId;
  readonly id: DeviceCredentialId;
  readonly keyVersion: number;
  readonly lastUsedAt: Instant | null;
  readonly revokedAt: Instant | null;
  readonly rotatedAt: Instant | null;
}

/** The server's answer to an authenticated Device credential: its metadata and the shared Device it names. */
export interface DeviceCredentialResolution {
  readonly credential: DeviceCredentialMetadata;
  readonly device: Device;
}
