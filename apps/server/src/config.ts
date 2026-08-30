import {
  createDeploymentTokenKey,
  createDeploymentTokenKeyRing,
  type DeploymentTokenKeyRing,
} from '@ai-usage/identity/device-tokens';
import type { PlatformDatabaseTlsMode, PlatformMigrationMode } from '@ai-usage/postgres-store/writer';

const integerPattern = /^\d+$/u;
const whitespacePattern = /\s/u;
const redactedValue = '[REDACTED]' as const;

export type PlatformRuntimeEnvironment = 'development' | 'production' | 'test';

export type ServerConfigErrorCode =
  | 'authentication-invalid'
  | 'base-url-invalid'
  | 'database-url-invalid'
  | 'database-url-missing'
  | 'secret-invalid'
  | 'setting-invalid'
  | 'tls-required';

export class ServerConfigError extends Error {
  readonly code: ServerConfigErrorCode;

  constructor(code: ServerConfigErrorCode) {
    super('The platform server configuration is invalid.');
    this.name = 'ServerConfigError';
    this.code = code;
  }
}

export interface RedactedDatabaseUrl {
  readonly redacted: typeof redactedValue;
  readonly toJSON: () => typeof redactedValue;
  readonly toString: () => typeof redactedValue;
}

const databaseUrlValues = new WeakMap<RedactedDatabaseUrl, string>();
const serverSecretValues = new WeakMap<RedactedServerSecret, string>();

export interface RedactedServerSecret {
  readonly redacted: typeof redactedValue;
  readonly toJSON: () => typeof redactedValue;
  readonly toString: () => typeof redactedValue;
}

const createRedactedServerSecret = (value: string): RedactedServerSecret => {
  const secret: RedactedServerSecret = Object.freeze({
    redacted: redactedValue,
    toJSON: () => redactedValue,
    toString: () => redactedValue,
  });
  serverSecretValues.set(secret, value);
  return secret;
};

export const revealServerSecret = (secret: RedactedServerSecret): string => {
  const value = serverSecretValues.get(secret);
  if (value === undefined) {
    throw new ServerConfigError('secret-invalid');
  }
  return value;
};

export interface VersionedAuthenticationSecret {
  readonly secret: RedactedServerSecret;
  readonly version: number;
}

const createRedactedDatabaseUrl = (value: string): RedactedDatabaseUrl => {
  const secret: RedactedDatabaseUrl = Object.freeze({
    redacted: redactedValue,
    toJSON: () => redactedValue,
    toString: () => redactedValue,
  });
  databaseUrlValues.set(secret, value);
  return secret;
};

export const revealDatabaseUrl = (secret: RedactedDatabaseUrl): string => {
  const value = databaseUrlValues.get(secret);
  if (value === undefined) {
    throw new ServerConfigError('database-url-invalid');
  }
  return value;
};

export interface PlatformServerConfig {
  readonly authenticationSecrets: readonly VersionedAuthenticationSecret[];
  readonly baseUrl: string;
  readonly bootstrapFirstOwner: boolean;
  readonly connectTimeoutMs: number;
  readonly databaseUrl: RedactedDatabaseUrl;
  readonly deviceTokenKeyRing: DeploymentTokenKeyRing;
  readonly githubClientId: string;
  readonly githubClientSecret: RedactedServerSecret;
  readonly host: string;
  readonly migrationMode: PlatformMigrationMode;
  readonly poolSize: number;
  readonly port: number;
  readonly queryTimeoutMs: number;
  readonly runtimeEnvironment: PlatformRuntimeEnvironment;
  readonly shutdownTimeoutMs: number;
  readonly tlsMode: PlatformDatabaseTlsMode;
}

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

const parseRuntimeEnvironment = (value: string | undefined): PlatformRuntimeEnvironment => {
  const candidate = value ?? 'development';
  if (candidate === 'development' || candidate === 'production' || candidate === 'test') {
    return candidate;
  }
  throw new ServerConfigError('setting-invalid');
};

const parseInteger = (value: string | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined) {
    return fallback;
  }
  if (!integerPattern.test(value)) {
    throw new ServerConfigError('setting-invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ServerConfigError('setting-invalid');
  }
  return parsed;
};

const parseDatabaseUrl = (value: string | undefined): RedactedDatabaseUrl => {
  if (!value) {
    throw new ServerConfigError('database-url-missing');
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new ServerConfigError('database-url-invalid');
    }
  } catch {
    throw new ServerConfigError('database-url-invalid');
  }
  return createRedactedDatabaseUrl(value);
};

const parseMigrationMode = (
  value: string | undefined,
  runtimeEnvironment: PlatformRuntimeEnvironment,
): PlatformMigrationMode => {
  const candidate = value ?? (runtimeEnvironment === 'production' ? 'verify' : 'apply');
  if (candidate === 'apply' || candidate === 'verify') {
    return candidate;
  }
  throw new ServerConfigError('setting-invalid');
};

const parseTlsMode = (
  value: string | undefined,
  runtimeEnvironment: PlatformRuntimeEnvironment,
): PlatformDatabaseTlsMode => {
  const candidate = value ?? (runtimeEnvironment === 'production' ? 'require' : 'disable');
  if (candidate !== 'disable' && candidate !== 'require') {
    throw new ServerConfigError('setting-invalid');
  }
  if (runtimeEnvironment === 'production' && candidate !== 'require') {
    throw new ServerConfigError('tls-required');
  }
  return candidate;
};

const parseHost = (value: string | undefined): string => {
  const candidate = value ?? '127.0.0.1';
  if (candidate.length === 0 || candidate.length > 255 || whitespacePattern.test(candidate)) {
    throw new ServerConfigError('setting-invalid');
  }
  return candidate;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new ServerConfigError('setting-invalid');
};

const parseBaseUrl = (value: string | undefined, runtimeEnvironment: PlatformRuntimeEnvironment): string => {
  if (!value) {
    throw new ServerConfigError('base-url-invalid');
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      (runtimeEnvironment === 'production' && parsed.protocol !== 'https:')
    ) {
      throw new ServerConfigError('base-url-invalid');
    }
    return parsed.origin;
  } catch {
    throw new ServerConfigError('base-url-invalid');
  }
};

const parseAuthenticationSecrets = (value: string | undefined): readonly VersionedAuthenticationSecret[] => {
  if (!value) {
    throw new ServerConfigError('secret-invalid');
  }
  const seen = new Set<number>();
  const secrets = value.split(',').map((entry) => {
    const separator = entry.indexOf(':');
    const rawVersion = entry.slice(0, separator);
    const rawSecret = entry.slice(separator + 1);
    if (
      separator <= 0 ||
      !integerPattern.test(rawVersion) ||
      !base64UrlPattern.test(rawSecret) ||
      Buffer.from(rawSecret, 'base64url').byteLength < 32 ||
      Buffer.from(rawSecret, 'base64url').byteLength > 128
    ) {
      throw new ServerConfigError('secret-invalid');
    }
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version <= 0 || seen.has(version)) {
      throw new ServerConfigError('secret-invalid');
    }
    seen.add(version);
    return Object.freeze({ secret: createRedactedServerSecret(rawSecret), version });
  });
  if (secrets.length === 0) {
    throw new ServerConfigError('secret-invalid');
  }
  return Object.freeze(secrets);
};

const parseDeviceTokenKeyRing = (value: string | undefined): DeploymentTokenKeyRing => {
  if (!value) {
    throw new ServerConfigError('secret-invalid');
  }
  try {
    const keys = value.split(',').map((entry) => {
      const separator = entry.indexOf(':');
      if (separator <= 0) {
        throw new ServerConfigError('secret-invalid');
      }
      return createDeploymentTokenKey(entry.slice(separator + 1), Number(entry.slice(0, separator)));
    });
    const current = keys[0];
    if (!current) {
      throw new ServerConfigError('secret-invalid');
    }
    return createDeploymentTokenKeyRing(keys, current.keyVersion);
  } catch {
    throw new ServerConfigError('secret-invalid');
  }
};

const parseGithubClientId = (value: string | undefined): string => {
  if (!value || value.length > 256 || whitespacePattern.test(value)) {
    throw new ServerConfigError('authentication-invalid');
  }
  return value;
};

const parseGithubClientSecret = (value: string | undefined): RedactedServerSecret => {
  if (!value || value.length < 20 || value.length > 512 || whitespacePattern.test(value)) {
    throw new ServerConfigError('authentication-invalid');
  }
  return createRedactedServerSecret(value);
};

export const parsePlatformServerConfig = (environment: EnvironmentSource): PlatformServerConfig => {
  const runtimeEnvironment = parseRuntimeEnvironment(environment.NODE_ENV);
  const minimumPort = runtimeEnvironment === 'test' ? 0 : 1;

  return Object.freeze({
    authenticationSecrets: parseAuthenticationSecrets(environment.AI_USAGE_AUTH_SECRETS),
    baseUrl: parseBaseUrl(environment.AI_USAGE_PLATFORM_BASE_URL, runtimeEnvironment),
    bootstrapFirstOwner: parseBoolean(environment.AI_USAGE_FIRST_OWNER_BOOTSTRAP, false),
    connectTimeoutMs: parseInteger(environment.AI_USAGE_PLATFORM_CONNECT_TIMEOUT_MS, 5000, 100, 120_000),
    databaseUrl: parseDatabaseUrl(environment.AI_USAGE_PLATFORM_DATABASE_URL),
    deviceTokenKeyRing: parseDeviceTokenKeyRing(environment.AI_USAGE_DEVICE_TOKEN_KEYS),
    githubClientId: parseGithubClientId(environment.AI_USAGE_GITHUB_CLIENT_ID),
    githubClientSecret: parseGithubClientSecret(environment.AI_USAGE_GITHUB_CLIENT_SECRET),
    host: parseHost(environment.AI_USAGE_PLATFORM_HOST),
    migrationMode: parseMigrationMode(environment.AI_USAGE_PLATFORM_MIGRATION_MODE, runtimeEnvironment),
    poolSize: parseInteger(environment.AI_USAGE_PLATFORM_POOL_SIZE, 10, 1, 100),
    port: parseInteger(environment.AI_USAGE_PLATFORM_PORT, 4318, minimumPort, 65_535),
    queryTimeoutMs: parseInteger(environment.AI_USAGE_PLATFORM_QUERY_TIMEOUT_MS, 5000, 100, 120_000),
    runtimeEnvironment,
    shutdownTimeoutMs: parseInteger(environment.AI_USAGE_PLATFORM_SHUTDOWN_TIMEOUT_MS, 10_000, 100, 120_000),
    tlsMode: parseTlsMode(environment.AI_USAGE_PLATFORM_DATABASE_TLS, runtimeEnvironment),
  });
};
