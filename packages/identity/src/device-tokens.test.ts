import { describe, expect, test } from 'bun:test';
import {
  createDeploymentTokenKey,
  createDeploymentTokenKeyRing,
  createDeviceCredentialToken,
  createEnrollmentGrantToken,
  parseDeviceCredentialToken,
  parseEnrollmentGrantToken,
  revealDeviceCredentialTokenForTransport,
  revealEnrollmentGrantTokenForTransport,
  verifyDeviceCredentialToken,
  verifyEnrollmentGrantToken,
} from './device-tokens';

const encode = (value: Uint8Array): string => Buffer.from(value).toString('base64url');
const keyOne = createDeploymentTokenKey(encode(Uint8Array.from({ length: 32 }, (_, index) => index + 1)), 1);
const keyTwo = createDeploymentTokenKey(encode(Uint8Array.from({ length: 32 }, (_, index) => 255 - index)), 2);
const keyRing = createDeploymentTokenKeyRing([keyOne, keyTwo], 2);
const bearerTokenPattern = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const bearerTokenErrorPattern = /bearer token/u;
const deploymentTokenKeyErrorPattern = /deployment token key/u;
const keyRingErrorPattern = /key ring/u;

const deterministicEntropy = (byteLength: number): Uint8Array =>
  Uint8Array.from({ length: byteLength }, (_, index) => (byteLength + index * 17) % 256);

describe('Device and enrollment bearer tokens', () => {
  test('returns plaintext exactly through the narrow transport accessor and redacts ordinary rendering', () => {
    const created = createDeviceCredentialToken(keyTwo, deterministicEntropy);
    const raw = revealDeviceCredentialTokenForTransport(created.token);

    expect(raw).toMatch(bearerTokenPattern);
    expect(String(created.token)).toBe('[REDACTED]');
    expect(`${created.token}`).toBe('[REDACTED]');
    expect(JSON.stringify(created.token)).toBe('"[REDACTED]"');
    expect(JSON.stringify(keyTwo)).toBe('"[REDACTED]"');
    expect(created.verifier).not.toContainValue(raw);
  });

  test('verifies HMAC digests by indexed public ID and retained key version', () => {
    const created = createEnrollmentGrantToken(keyOne, deterministicEntropy);
    const parsed = parseEnrollmentGrantToken(revealEnrollmentGrantTokenForTransport(created.token));

    expect(verifyEnrollmentGrantToken(parsed, created.verifier, keyRing)).toBe(true);
    expect(verifyEnrollmentGrantToken(parsed, { ...created.verifier, keyedDigest: 'A'.repeat(43) }, keyRing)).toBe(
      false,
    );
    expect(verifyEnrollmentGrantToken(parsed, { ...created.verifier, publicTokenId: 'B'.repeat(22) }, keyRing)).toBe(
      false,
    );
    expect(verifyEnrollmentGrantToken(parsed, { ...created.verifier, keyVersion: 99 }, keyRing)).toBe(false);
  });

  test('keeps Device credentials and enrollment grants nominally separate', () => {
    const credential = createDeviceCredentialToken(keyTwo, deterministicEntropy);
    const grant = createEnrollmentGrantToken(keyTwo, deterministicEntropy);
    const parsedCredential = parseDeviceCredentialToken(revealDeviceCredentialTokenForTransport(credential.token));

    expect(verifyDeviceCredentialToken(parsedCredential, credential.verifier, keyRing)).toBe(true);
    expect(verifyEnrollmentGrantToken(grant.token, grant.verifier, keyRing)).toBe(true);
    expect(() => parseDeviceCredentialToken('missing-secret')).toThrow(bearerTokenErrorPattern);
    expect(() => createDeploymentTokenKey('short', 1)).toThrow(deploymentTokenKeyErrorPattern);
    expect(() => createDeploymentTokenKeyRing([keyOne, keyOne], 1)).toThrow(keyRingErrorPattern);
  });
});
