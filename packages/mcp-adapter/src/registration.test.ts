import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type CodexMcpCommandRunner,
  OpenCodeMcpRegistrationError,
  type OpenCodeMcpRegistrationFailureReason,
  openCodeMcpManualSnippet,
  registerCodexMcp,
  registeredMcpServerName,
  registerJsonMcp,
  registerOpenCodeMcp,
} from './registration';

const roots: string[] = [];
const restoredModes: { readonly mode: number; readonly target: string }[] = [];

afterEach(async () => {
  await Promise.all(restoredModes.splice(0).map(({ mode, target }) => chmod(target, mode)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-mcp-registration-'));
  roots.push(root);
  const privateStatePath = path.join(root, 'private');
  const registration = {
    args: ['/workspace/apps/mcp/src/main.ts'],
    command: '/usr/bin/bun',
  } as const;
  return { privateStatePath, registration, root };
};

describe('ai-usage MCP registration', () => {
  test('keeps the server name existing operator registrations already carry', () => {
    // Renaming it would leave the old entry orphaned and register a second server beside it.
    expect(registeredMcpServerName).toBe('ai-usage-memory');
  });

  test('atomically adds one managed JSON entry, preserves other entries, and is idempotent under concurrency', async () => {
    const { privateStatePath, registration, root } = await fixture();
    const configPath = path.join(root, '.mcp.json');
    await writeFile(
      configPath,
      `${JSON.stringify({ mcpServers: { existing: { command: 'existing', args: [] } }, unrelated: true })}\n`,
    );

    const results = await Promise.all([
      registerJsonMcp({ configPath, privateStatePath, registration }),
      registerJsonMcp({ configPath, privateStatePath, registration }),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(['created', 'unchanged']);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: {
        [registeredMcpServerName]: registration,
        existing: { args: [], command: 'existing' },
      },
      unrelated: true,
    });
  });

  test('refuses a same-name unmanaged JSON entry without changing the file', async () => {
    const { privateStatePath, registration, root } = await fixture();
    const configPath = path.join(root, 'mcp.json');
    const original = `${JSON.stringify({ mcpServers: { [registeredMcpServerName]: { args: [], command: 'other' } } })}\n`;
    await writeFile(configPath, original);

    await expect(registerJsonMcp({ configPath, privateStatePath, registration })).resolves.toEqual({
      kind: 'refused-unmanaged',
      reason: 'existing-server-differs',
      serverName: registeredMcpServerName,
    });
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  test('refuses a symlink JSON target', async () => {
    const { privateStatePath, registration, root } = await fixture();
    const actualPath = path.join(root, 'actual.json');
    const configPath = path.join(root, '.mcp.json');
    await writeFile(actualPath, '{}\n');
    await symlink(actualPath, configPath);
    await expect(registerJsonMcp({ configPath, privateStatePath, registration })).rejects.toThrow(
      'regular non-symlink file',
    );
  });

  test('uses Codex list/add/list while refusing an existing different entry', async () => {
    const { privateStatePath, registration, root } = await fixture();
    const codexDirectory = path.join(root, '.codex');
    await mkdir(codexDirectory);
    const configPath = path.join(codexDirectory, 'config.toml');
    let server: unknown;
    const calls: string[][] = [];
    const runner: CodexMcpCommandRunner = {
      run: (args) => {
        calls.push([...args]);
        if (args[1] === 'list') {
          return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(server === undefined ? [] : [server]) });
        }
        server = {
          enabled: true,
          name: registeredMcpServerName,
          transport: { args: registration.args, command: registration.command, type: 'stdio' },
        };
        return Promise.resolve({ exitCode: 0, stdout: '' });
      },
    };

    await expect(registerCodexMcp({ configPath, privateStatePath, registration, runner })).resolves.toMatchObject({
      kind: 'created',
    });
    expect(calls).toEqual([
      ['mcp', 'list', '--json'],
      ['mcp', 'add', registeredMcpServerName, '--', registration.command, ...registration.args],
      ['mcp', 'list', '--json'],
    ]);

    server = {
      enabled: true,
      name: registeredMcpServerName,
      transport: { args: [], command: 'unmanaged', type: 'stdio' },
    };
    calls.length = 0;
    await expect(registerCodexMcp({ configPath, privateStatePath, registration, runner })).resolves.toMatchObject({
      kind: 'refused-unmanaged',
    });
    expect(calls).toEqual([['mcp', 'list', '--json']]);
  });
});

describe('ai-usage MCP registration for OpenCode', () => {
  const openCodeFixture = async () => {
    const base = await fixture();
    const directory = path.join(base.root, 'opencode');
    await mkdir(directory);
    return {
      ...base,
      directory,
      directoryTarget: { kind: 'config-directory', path: directory } as const,
      jsoncPath: path.join(directory, 'opencode.jsonc'),
      jsonPath: path.join(directory, 'opencode.json'),
      managedEntry: { command: [base.registration.command, ...base.registration.args], type: 'local' },
    };
  };

  const permissionsOf = async (target: string): Promise<number> => {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission masks require bitwise AND.
    return (await stat(target)).mode & 0o777;
  };

  const makeReadOnly = async (target: string, mode: number): Promise<void> => {
    restoredModes.push({ mode: await permissionsOf(target), target });
    await chmod(target, mode);
  };

  const refusalOf = async (registering: Promise<unknown>): Promise<OpenCodeMcpRegistrationError> => {
    const failure = await registering.then(
      () => null,
      (error: unknown) => error,
    );
    if (!(failure instanceof OpenCodeMcpRegistrationError)) {
      throw new Error(`Expected a typed OpenCode registration failure, received ${String(failure)}.`);
    }
    return failure;
  };

  const refusal = (
    reason: OpenCodeMcpRegistrationFailureReason,
    registration: { readonly args: readonly string[]; readonly command: string },
  ) => ({ manualSnippet: openCodeMcpManualSnippet(registration), reason });

  test('prints a manual snippet in the mcp.servers shape OpenCode reads', async () => {
    const { managedEntry, registration } = await openCodeFixture();
    expect(JSON.parse(openCodeMcpManualSnippet(registration))).toEqual({
      mcp: { servers: { [registeredMcpServerName]: managedEntry } },
    });
  });

  test('creates opencode.json with one managed local server when the directory holds no configuration', async () => {
    const { directory, directoryTarget, jsonPath, managedEntry, privateStatePath, registration } =
      await openCodeFixture();

    await expect(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })).resolves.toEqual({
      kind: 'created',
      serverName: registeredMcpServerName,
    });
    expect(await readdir(directory)).toEqual(['opencode.json']);
    expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual({
      mcp: { servers: { [registeredMcpServerName]: managedEntry } },
    });
    expect(await permissionsOf(jsonPath)).toBe(0o600);
  });

  test('adds the managed entry atomically, preserves every unrelated key, and is idempotent under concurrency', async () => {
    const { directory, directoryTarget, jsonPath, managedEntry, privateStatePath, registration } =
      await openCodeFixture();
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        legacy: { command: ['legacy'], enabled: false, type: 'local' },
        servers: { other: { type: 'remote', url: 'https://example.invalid/mcp' } },
        timeout: { startup: 1000 },
      },
      model: 'provider/model',
      permissions: [{ action: 'allow', tool: 'read' }],
    };
    await writeFile(jsonPath, `${JSON.stringify(existing)}\n`, { mode: 0o640 });

    const results = await Promise.all([
      registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget }),
      registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget }),
    ]);

    expect(results.map(({ kind }) => kind).sort()).toEqual(['created', 'unchanged']);
    expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual({
      ...existing,
      mcp: { ...existing.mcp, servers: { ...existing.mcp.servers, [registeredMcpServerName]: managedEntry } },
    });
    expect(await permissionsOf(jsonPath)).toBe(0o640);
    expect(await readdir(directory)).toEqual(['opencode.json']);
  });

  test('answers unchanged for an existing managed entry and leaves the file bytes alone', async () => {
    const { directoryTarget, jsonPath, managedEntry, privateStatePath, registration } = await openCodeFixture();
    const original = `{"mcp":{"servers":{"${registeredMcpServerName}":${JSON.stringify(managedEntry)}}},"model":"m"}`;
    await writeFile(jsonPath, original);

    await expect(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })).resolves.toEqual({
      kind: 'unchanged',
      serverName: registeredMcpServerName,
    });
    expect(await readFile(jsonPath, 'utf8')).toBe(original);
  });

  const managedCommand = ['/usr/bin/bun', '/workspace/apps/mcp/src/main.ts'];

  test.each([
    [
      'a different mcp.servers entry',
      { servers: { [registeredMcpServerName]: { command: ['other'], type: 'local' } } },
    ],
    [
      'a managed command carrying an extra key',
      { servers: { [registeredMcpServerName]: { command: managedCommand, disabled: true, type: 'local' } } },
    ],
    ['a legacy mcp.<name> entry', { [registeredMcpServerName]: { command: managedCommand, type: 'local' } }],
    [
      'a legacy entry beside the managed one',
      {
        [registeredMcpServerName]: { enabled: false },
        servers: { [registeredMcpServerName]: { command: managedCommand, type: 'local' } },
      },
    ],
  ])('refuses %s with the same name without changing the file', async (_label, mcp) => {
    const { directoryTarget, jsonPath, privateStatePath, registration } = await openCodeFixture();
    const original = `${JSON.stringify({ mcp })}\n`;
    await writeFile(jsonPath, original);

    await expect(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })).resolves.toEqual({
      kind: 'refused-unmanaged',
      reason: 'existing-server-differs',
      serverName: registeredMcpServerName,
    });
    expect(await readFile(jsonPath, 'utf8')).toBe(original);
  });

  test.each([
    ['comments', '{\n  // the operator explains this choice\n  "model": "m" /* inline */\n}\n'],
    ['trailing commas', '{\n  "model": "m",\n}\n'],
  ])('refuses to rewrite a JSONC document with %s and leaves it untouched', async (_label, original) => {
    const { directory, directoryTarget, jsoncPath, privateStatePath, registration } = await openCodeFixture();
    await writeFile(jsoncPath, original);

    expect(
      await refusalOf(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })),
    ).toMatchObject(refusal('jsonc-not-rewritable', registration));
    expect(await readFile(jsoncPath, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['opencode.jsonc']);
  });

  test('refuses a commented opencode.json the same way as a commented opencode.jsonc', async () => {
    const { directoryTarget, jsonPath, privateStatePath, registration } = await openCodeFixture();
    const original = '{\n  // OpenCode reads comments in opencode.json too\n  "model": "m"\n}\n';
    await writeFile(jsonPath, original);

    expect(
      await refusalOf(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })),
    ).toMatchObject(refusal('jsonc-not-rewritable', registration));
    expect(await readFile(jsonPath, 'utf8')).toBe(original);
  });

  test('answers from a JSONC document without rewriting it when no write is needed', async () => {
    const { directoryTarget, jsoncPath, managedEntry, privateStatePath, registration } = await openCodeFixture();
    const managed = `{\n  // pasted by hand\n  "mcp": { "servers": { "${registeredMcpServerName}": ${JSON.stringify(managedEntry)}, }, },\n}\n`;
    await writeFile(jsoncPath, managed);
    await expect(
      registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget }),
    ).resolves.toMatchObject({ kind: 'unchanged' });
    expect(await readFile(jsoncPath, 'utf8')).toBe(managed);

    const unmanaged = `{\n  // another server\n  "mcp": { "servers": { "${registeredMcpServerName}": { "type": "local", "command": ["other"] } } }\n}\n`;
    await writeFile(jsoncPath, unmanaged);
    await expect(
      registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget }),
    ).resolves.toMatchObject({ kind: 'refused-unmanaged' });
    expect(await readFile(jsoncPath, 'utf8')).toBe(unmanaged);
  });

  test('writes a strict-JSON opencode.jsonc, and prefers opencode.json when both exist', async () => {
    const { directory, directoryTarget, jsonPath, jsoncPath, managedEntry, privateStatePath, registration } =
      await openCodeFixture();
    await writeFile(jsoncPath, '{"model":"m"}\n');

    await expect(
      registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget }),
    ).resolves.toMatchObject({ kind: 'created' });
    expect(await readdir(directory)).toEqual(['opencode.jsonc']);
    expect(JSON.parse(await readFile(jsoncPath, 'utf8'))).toEqual({
      mcp: { servers: { [registeredMcpServerName]: managedEntry } },
      model: 'm',
    });

    const untouched = '{"model":"n"}\n';
    await writeFile(jsoncPath, untouched);
    await writeFile(jsonPath, '{}\n');
    await expect(
      registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget }),
    ).resolves.toMatchObject({ kind: 'created' });
    expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual({
      mcp: { servers: { [registeredMcpServerName]: managedEntry } },
    });
    expect(await readFile(jsoncPath, 'utf8')).toBe(untouched);
  });

  test('registers into one explicit configuration file and refuses another file name', async () => {
    const { managedEntry, privateStatePath, registration, root } = await openCodeFixture();
    const project = path.join(root, 'project');
    await mkdir(project);
    const configPath = path.join(project, 'opencode.jsonc');

    await expect(
      registerOpenCodeMcp({ privateStatePath, registration, target: { kind: 'config-file', path: configPath } }),
    ).resolves.toMatchObject({ kind: 'created' });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcp: { servers: { [registeredMcpServerName]: managedEntry } },
    });

    await expect(
      registerOpenCodeMcp({
        privateStatePath,
        registration,
        target: { kind: 'config-file', path: path.join(project, 'config.json') },
      }),
    ).rejects.toThrow('unsupported filename');
    expect(await readdir(project)).toEqual(['opencode.jsonc']);
  });

  test('refuses a symlinked configuration file without replacing it or its target', async () => {
    const { directory, directoryTarget, jsonPath, privateStatePath, registration, root } = await openCodeFixture();
    const actualPath = path.join(root, 'declarative-opencode.json');
    await writeFile(actualPath, '{}\n');
    await symlink(actualPath, jsonPath);

    expect(
      await refusalOf(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })),
    ).toMatchObject(refusal('target-not-regular-file', registration));
    expect(await readFile(actualPath, 'utf8')).toBe('{}\n');
    expect(await readdir(directory)).toEqual(['opencode.json']);
  });

  test('refuses a symlinked opencode.jsonc instead of creating opencode.json beside it', async () => {
    const { directory, directoryTarget, jsoncPath, privateStatePath, registration, root } = await openCodeFixture();
    const actualPath = path.join(root, 'declarative-opencode.jsonc');
    await writeFile(actualPath, '{}\n');
    await symlink(actualPath, jsoncPath);

    expect(
      await refusalOf(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })),
    ).toMatchObject(refusal('target-not-regular-file', registration));
    expect(await readdir(directory)).toEqual(['opencode.jsonc']);
  });

  test('refuses a symlinked or missing configuration directory', async () => {
    const { directory, privateStatePath, registration, root } = await openCodeFixture();
    const linked = path.join(root, 'linked-opencode');
    await symlink(directory, linked);

    expect(
      await refusalOf(
        registerOpenCodeMcp({ privateStatePath, registration, target: { kind: 'config-directory', path: linked } }),
      ),
    ).toMatchObject(refusal('directory-unsafe', registration));
    expect(
      await refusalOf(
        registerOpenCodeMcp({
          privateStatePath,
          registration,
          target: { kind: 'config-directory', path: path.join(root, 'absent') },
        }),
      ),
    ).toMatchObject(refusal('directory-missing', registration));
    expect(await readdir(directory)).toEqual([]);
  });

  test('refuses a read-only configuration file instead of replacing it through its directory', async () => {
    const { directory, directoryTarget, jsonPath, managedEntry, privateStatePath, registration } =
      await openCodeFixture();
    const original = '{"model":"m"}\n';
    await writeFile(jsonPath, original);
    await makeReadOnly(jsonPath, 0o444);

    expect(
      await refusalOf(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })),
    ).toMatchObject(refusal('target-not-writable', registration));
    expect(await readFile(jsonPath, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['opencode.json']);

    await chmod(jsonPath, 0o644);
    await writeFile(jsonPath, JSON.stringify({ mcp: { servers: { [registeredMcpServerName]: managedEntry } } }));
    await chmod(jsonPath, 0o444);
    await expect(
      registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget }),
    ).resolves.toMatchObject({ kind: 'unchanged' });
  });

  test('refuses a read-only configuration directory', async () => {
    const { directory, directoryTarget, privateStatePath, registration } = await openCodeFixture();
    await makeReadOnly(directory, 0o555);

    expect(
      await refusalOf(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })),
    ).toMatchObject(refusal('target-not-writable', registration));
    expect(await readdir(directory)).toEqual([]);
  });

  test.each([
    ['truncated JSON', '{ "mcp": '],
    ['an empty file', ''],
    ['a top-level array', '[]\n'],
    ['a non-object mcp value', '{"mcp":"servers"}\n'],
    ['a non-object mcp.servers value', '{"mcp":{"servers":[]}}\n'],
    ['a null mcp value', '{"mcp":null}\n'],
    ['a null mcp.servers value', '{"mcp":{"servers":null}}\n'],
  ])('refuses %s as a malformed document and leaves it untouched', async (_label, original) => {
    const { directory, directoryTarget, jsonPath, privateStatePath, registration } = await openCodeFixture();
    await writeFile(jsonPath, original);

    expect(
      await refusalOf(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })),
    ).toMatchObject(refusal('malformed-document', registration));
    expect(await readFile(jsonPath, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['opencode.json']);
  });

  test('refuses a configuration file over the byte limit', async () => {
    const { directoryTarget, jsonPath, privateStatePath, registration } = await openCodeFixture();
    await writeFile(jsonPath, `{"padding":"${'x'.repeat(1024 * 1024)}"}`);

    expect(
      await refusalOf(registerOpenCodeMcp({ privateStatePath, registration, target: directoryTarget })),
    ).toMatchObject(refusal('target-too-large', registration));
  });
});
