import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDeploymentTokenKey,
  createDeviceCredentialToken,
  revealDeviceCredentialTokenForTransport,
} from './device-tokens';
import {
  loadPrivateDeviceCredential,
  privateDeviceCredentialPath,
  storePrivateDeviceCredential,
} from './private-device-credential';

const fixtures: string[] = [];
const key = createDeploymentTokenKey(Buffer.alloc(32, 31).toString('base64url'), 1);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

const createFixture = async (): Promise<string> => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'ai-usage-device-credential-'));
  fixtures.push(fixture);
  return fixture;
};

describe('private Device credential file', () => {
  test('atomically stores and rotates an owner-only redacted credential', async () => {
    const directory = await createFixture();
    const first = createDeviceCredentialToken(key).token;
    const second = createDeviceCredentialToken(key).token;

    const stored = await storePrivateDeviceCredential(directory, first);
    expect(String(stored.credential)).toBe('[REDACTED]');
    expect(JSON.stringify(stored)).not.toContain(revealDeviceCredentialTokenForTransport(first));
    expect((await lstat(directory)).mode % 0o1000).toBe(0o700);
    expect((await lstat(stored.path)).mode % 0o1000).toBe(0o600);

    await storePrivateDeviceCredential(directory, second);
    const loaded = await loadPrivateDeviceCredential(directory);
    if (!loaded) {
      throw new Error('Expected a stored Device credential.');
    }
    expect(revealDeviceCredentialTokenForTransport(loaded.credential)).toBe(
      revealDeviceCredentialTokenForTransport(second),
    );
    expect(JSON.stringify(loaded)).not.toContain(revealDeviceCredentialTokenForTransport(second));
  });

  test('rejects symlinks, hard links, and permissive credential state', async () => {
    const symlinkDirectory = await createFixture();
    const foreignPath = path.join(symlinkDirectory, 'foreign.json');
    const credentialPath = privateDeviceCredentialPath(symlinkDirectory);
    await writeFile(foreignPath, '{}\n', { mode: 0o600 });
    await symlink(foreignPath, credentialPath);
    await expect(
      storePrivateDeviceCredential(symlinkDirectory, createDeviceCredentialToken(key).token),
    ).rejects.toThrow('unsafe');
    await expect(loadPrivateDeviceCredential(symlinkDirectory)).rejects.toThrow();

    const hardLinkDirectory = await createFixture();
    await storePrivateDeviceCredential(hardLinkDirectory, createDeviceCredentialToken(key).token);
    const hardLinkPath = privateDeviceCredentialPath(hardLinkDirectory);
    await link(hardLinkPath, path.join(hardLinkDirectory, 'credential-alias.json'));
    await expect(loadPrivateDeviceCredential(hardLinkDirectory)).rejects.toThrow('unsafe');

    const permissiveDirectory = await createFixture();
    await chmod(permissiveDirectory, 0o755);
    await expect(
      storePrivateDeviceCredential(permissiveDirectory, createDeviceCredentialToken(key).token),
    ).rejects.toThrow('directory is unsafe');

    const permissiveFileDirectory = await createFixture();
    await storePrivateDeviceCredential(permissiveFileDirectory, createDeviceCredentialToken(key).token);
    await chmod(privateDeviceCredentialPath(permissiveFileDirectory), 0o640);
    await expect(loadPrivateDeviceCredential(permissiveFileDirectory)).rejects.toThrow('unsafe');
  });

  test('publishes one complete credential under concurrent rotation without torn state', async () => {
    const directory = await createFixture();
    const credentials = Array.from({ length: 12 }, () => createDeviceCredentialToken(key).token);
    const outcomes = await Promise.allSettled(
      credentials.map((credential) => storePrivateDeviceCredential(directory, credential)),
    );
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);

    const loaded = await loadPrivateDeviceCredential(directory);
    if (!loaded) {
      throw new Error('Expected one concurrently stored Device credential.');
    }
    const plaintext = revealDeviceCredentialTokenForTransport(loaded.credential);
    expect(credentials.map(revealDeviceCredentialTokenForTransport)).toContain(plaintext);
    expect(JSON.parse(await readFile(privateDeviceCredentialPath(directory), 'utf8'))).toEqual({
      credential: plaintext,
      version: 1,
    });
    expect((await lstat(privateDeviceCredentialPath(directory))).nlink).toBe(1);
  });
});
