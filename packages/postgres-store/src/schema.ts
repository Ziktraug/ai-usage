export const PLATFORM_SCHEMA_METADATA_KEY = 'foundation_schema_version';
export const PLATFORM_SCHEMA_VERSION = 8;

export interface PlatformSchemaIdentity {
  readonly metadataKey: typeof PLATFORM_SCHEMA_METADATA_KEY;
  readonly version: typeof PLATFORM_SCHEMA_VERSION;
}

export const PLATFORM_SCHEMA_IDENTITY: PlatformSchemaIdentity = Object.freeze({
  metadataKey: PLATFORM_SCHEMA_METADATA_KEY,
  version: PLATFORM_SCHEMA_VERSION,
});
