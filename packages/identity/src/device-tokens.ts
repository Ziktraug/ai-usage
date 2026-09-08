import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const redactedValue = '[REDACTED]' as const;
const publicTokenIdPattern = /^[A-Za-z0-9_-]{22}$/u;
const randomSecretPattern = /^[A-Za-z0-9_-]{43}$/u;
const digestPattern = /^[A-Za-z0-9_-]{43}$/u;
const deploymentKeyPattern = /^[A-Za-z0-9_-]+$/u;
const minimumDeploymentKeyBytes = 32;
const maximumDeploymentKeyBytes = 128;
const publicTokenIdBytes = 16;
const randomSecretBytes = 32;

declare const deploymentTokenKeyBrand: unique symbol;
declare const deviceCredentialTokenBrand: unique symbol;
declare const enrollmentGrantTokenBrand: unique symbol;

export type DeviceTokenKind = 'device-credential' | 'enrollment-grant';

export interface DeploymentTokenKey {
  readonly keyVersion: number;
  readonly redacted: typeof redactedValue;
  readonly toJSON: () => typeof redactedValue;
  readonly toString: () => typeof redactedValue;
  readonly [deploymentTokenKeyBrand]: true;
}

interface RedactedBearerToken {
  readonly publicTokenId: string;
  readonly redacted: typeof redactedValue;
  readonly toJSON: () => typeof redactedValue;
  readonly toString: () => typeof redactedValue;
}

export interface DeviceCredentialToken extends RedactedBearerToken {
  readonly [deviceCredentialTokenBrand]: true;
}

export interface EnrollmentGrantToken extends RedactedBearerToken {
  readonly [enrollmentGrantTokenBrand]: true;
}

export interface DeviceTokenVerifier {
  readonly keyedDigest: string;
  readonly keyVersion: number;
  readonly publicTokenId: string;
}

export interface DeploymentTokenKeyRing {
  readonly current: DeploymentTokenKey;
  readonly versions: readonly number[];
}

export type RandomByteSource = (byteLength: number) => Uint8Array;

const keyValues = new WeakMap<DeploymentTokenKey, Uint8Array>();
const keyRingValues = new WeakMap<DeploymentTokenKeyRing, ReadonlyMap<number, DeploymentTokenKey>>();
const bearerTokenValues = new WeakMap<RedactedBearerToken, string>();

class RedactedDeploymentTokenKey implements DeploymentTokenKey {
  declare readonly [deploymentTokenKeyBrand]: true;
  readonly keyVersion: number;
  readonly redacted = redactedValue;

  constructor(keyVersion: number, value: Uint8Array) {
    this.keyVersion = keyVersion;
    keyValues.set(this, value.slice());
    Object.freeze(this);
  }

  toJSON(): typeof redactedValue {
    return redactedValue;
  }

  toString(): typeof redactedValue {
    return redactedValue;
  }
}

class RedactedDeviceCredentialToken implements DeviceCredentialToken {
  declare readonly [deviceCredentialTokenBrand]: true;
  readonly publicTokenId: string;
  readonly redacted = redactedValue;

  constructor(publicTokenId: string, value: string) {
    this.publicTokenId = publicTokenId;
    bearerTokenValues.set(this, value);
    Object.freeze(this);
  }

  toJSON(): typeof redactedValue {
    return redactedValue;
  }

  toString(): typeof redactedValue {
    return redactedValue;
  }
}

class RedactedEnrollmentGrantToken implements EnrollmentGrantToken {
  declare readonly [enrollmentGrantTokenBrand]: true;
  readonly publicTokenId: string;
  readonly redacted = redactedValue;

  constructor(publicTokenId: string, value: string) {
    this.publicTokenId = publicTokenId;
    bearerTokenValues.set(this, value);
    Object.freeze(this);
  }

  toJSON(): typeof redactedValue {
    return redactedValue;
  }

  toString(): typeof redactedValue {
    return redactedValue;
  }
}

const parsePositiveKeyVersion = (value: unknown): number => {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)) {
    throw new Error('The deployment token key version is invalid.');
  }
  return value;
};

const decodeBase64Url = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'base64url'));
const encodeBase64Url = (value: Uint8Array): string => Buffer.from(value).toString('base64url');

export const createDeploymentTokenKey = (value: unknown, keyVersion: unknown): DeploymentTokenKey => {
  if (typeof value !== 'string' || !deploymentKeyPattern.test(value)) {
    throw new Error('The deployment token key is invalid.');
  }
  const decoded = decodeBase64Url(value);
  if (decoded.byteLength < minimumDeploymentKeyBytes || decoded.byteLength > maximumDeploymentKeyBytes) {
    throw new Error('The deployment token key is invalid.');
  }
  return new RedactedDeploymentTokenKey(parsePositiveKeyVersion(keyVersion), decoded);
};

export const createDeploymentTokenKeyRing = (
  keys: readonly DeploymentTokenKey[],
  currentVersion: unknown,
): DeploymentTokenKeyRing => {
  const parsedCurrentVersion = parsePositiveKeyVersion(currentVersion);
  const byVersion = new Map<number, DeploymentTokenKey>();
  for (const key of keys) {
    if (!keyValues.has(key) || byVersion.has(key.keyVersion)) {
      throw new Error('The deployment token key ring is invalid.');
    }
    byVersion.set(key.keyVersion, key);
  }
  const current = byVersion.get(parsedCurrentVersion);
  if (!current) {
    throw new Error('The deployment token key ring is invalid.');
  }
  const keyRing: DeploymentTokenKeyRing = Object.freeze({
    current,
    versions: Object.freeze([...byVersion.keys()].sort((left, right) => left - right)),
  });
  keyRingValues.set(keyRing, byVersion);
  return keyRing;
};

const parseRawToken = (value: unknown): { publicTokenId: string; randomSecret: string; raw: string } => {
  if (typeof value !== 'string') {
    throw new Error('The Device bearer token is invalid.');
  }
  const separator = value.indexOf('.');
  if (separator === -1 || value.indexOf('.', separator + 1) !== -1) {
    throw new Error('The Device bearer token is invalid.');
  }
  const publicTokenId = value.slice(0, separator);
  const randomSecret = value.slice(separator + 1);
  if (!(publicTokenIdPattern.test(publicTokenId) && randomSecretPattern.test(randomSecret))) {
    throw new Error('The Device bearer token is invalid.');
  }
  return { publicTokenId, randomSecret, raw: value };
};

const keyedDigest = (key: DeploymentTokenKey, randomSecret: string): string => {
  const value = keyValues.get(key);
  if (!value) {
    throw new Error('The deployment token key is invalid.');
  }
  return createHmac('sha256', value).update(decodeBase64Url(randomSecret)).digest('base64url');
};

const createToken = <Token extends DeviceCredentialToken | EnrollmentGrantToken>(
  key: DeploymentTokenKey,
  construct: (publicTokenId: string, raw: string) => Token,
  randomByteSource: RandomByteSource,
): { readonly token: Token; readonly verifier: DeviceTokenVerifier } => {
  if (!keyValues.has(key)) {
    throw new Error('The deployment token key is invalid.');
  }
  const publicTokenId = encodeBase64Url(randomByteSource(publicTokenIdBytes));
  const randomSecret = encodeBase64Url(randomByteSource(randomSecretBytes));
  if (!(publicTokenIdPattern.test(publicTokenId) && randomSecretPattern.test(randomSecret))) {
    throw new Error('The Device token entropy source is invalid.');
  }
  const raw = `${publicTokenId}.${randomSecret}`;
  return Object.freeze({
    token: construct(publicTokenId, raw),
    verifier: Object.freeze({
      keyVersion: key.keyVersion,
      keyedDigest: keyedDigest(key, randomSecret),
      publicTokenId,
    }),
  });
};

const defaultRandomByteSource: RandomByteSource = (byteLength) => randomBytes(byteLength);

export const createDeviceCredentialToken = (
  key: DeploymentTokenKey,
  randomByteSource: RandomByteSource = defaultRandomByteSource,
): { readonly token: DeviceCredentialToken; readonly verifier: DeviceTokenVerifier } =>
  createToken(key, (publicTokenId, raw) => new RedactedDeviceCredentialToken(publicTokenId, raw), randomByteSource);

export const createEnrollmentGrantToken = (
  key: DeploymentTokenKey,
  randomByteSource: RandomByteSource = defaultRandomByteSource,
): { readonly token: EnrollmentGrantToken; readonly verifier: DeviceTokenVerifier } =>
  createToken(key, (publicTokenId, raw) => new RedactedEnrollmentGrantToken(publicTokenId, raw), randomByteSource);

export const parseDeviceCredentialToken = (value: unknown): DeviceCredentialToken => {
  const parsed = parseRawToken(value);
  return new RedactedDeviceCredentialToken(parsed.publicTokenId, parsed.raw);
};

export const parseEnrollmentGrantToken = (value: unknown): EnrollmentGrantToken => {
  const parsed = parseRawToken(value);
  return new RedactedEnrollmentGrantToken(parsed.publicTokenId, parsed.raw);
};

const revealBearerToken = (token: RedactedBearerToken): string => {
  const value = bearerTokenValues.get(token);
  if (!value) {
    throw new Error('The Device bearer token is invalid.');
  }
  return value;
};

export const revealDeviceCredentialTokenForTransport = (token: DeviceCredentialToken): string =>
  revealBearerToken(token);
export const revealEnrollmentGrantTokenForTransport = (token: EnrollmentGrantToken): string => revealBearerToken(token);

const validateVerifier = (verifier: DeviceTokenVerifier): boolean =>
  publicTokenIdPattern.test(verifier.publicTokenId) &&
  digestPattern.test(verifier.keyedDigest) &&
  Number.isSafeInteger(verifier.keyVersion) &&
  verifier.keyVersion > 0;

const verifyToken = (
  token: RedactedBearerToken,
  verifier: DeviceTokenVerifier,
  keyRing: DeploymentTokenKeyRing,
): boolean => {
  if (!validateVerifier(verifier) || token.publicTokenId !== verifier.publicTokenId) {
    return false;
  }
  const keys = keyRingValues.get(keyRing);
  const key = keys?.get(verifier.keyVersion);
  if (!key) {
    return false;
  }
  const raw = bearerTokenValues.get(token);
  if (!raw) {
    return false;
  }
  const { randomSecret } = parseRawToken(raw);
  const actual = decodeBase64Url(keyedDigest(key, randomSecret));
  const expected = decodeBase64Url(verifier.keyedDigest);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
};

export const verifyDeviceCredentialToken = (
  token: DeviceCredentialToken,
  verifier: DeviceTokenVerifier,
  keyRing: DeploymentTokenKeyRing,
): boolean => verifyToken(token, verifier, keyRing);

export const verifyEnrollmentGrantToken = (
  token: EnrollmentGrantToken,
  verifier: DeviceTokenVerifier,
  keyRing: DeploymentTokenKeyRing,
): boolean => verifyToken(token, verifier, keyRing);
