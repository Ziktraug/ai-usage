import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCodeMcpManualSnippet, registeredMcpServerName } from '@ai-usage/mcp-adapter/registration';
import { describeMcpRegistrationFailure, runMcpRegistrationCommand } from './register';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A disposable home: every path the command resolves stays under it, never under the operator's home. */
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-mcp-register-'));
  roots.push(root);
  return { homeDirectory: root, root };
};

const registration = {
  args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts')],
  command: process.execPath,
};

const managedDocument = {
  mcp: {
    servers: { [registeredMcpServerName]: { command: [registration.command, ...registration.args], type: 'local' } },
  },
};

describe('ai-usage MCP registration command, OpenCode mode', () => {
  test('registers this checkout in the default OpenCode configuration directory of the home', async () => {
    const { homeDirectory, root } = await fixture();
    const directory = path.join(root, '.config', 'opencode');
    await mkdir(directory, { recursive: true });

    await expect(
      runMcpRegistrationCommand({ argv: ['opencode'], cwd: root, environment: {}, homeDirectory }),
    ).resolves.toEqual({ kind: 'created', serverName: registeredMcpServerName });
    expect(JSON.parse(await readFile(path.join(directory, 'opencode.json'), 'utf8'))).toEqual(managedDocument);

    await expect(
      runMcpRegistrationCommand({ argv: ['opencode'], cwd: root, environment: {}, homeDirectory }),
    ).resolves.toEqual({ kind: 'unchanged', serverName: registeredMcpServerName });
  });

  test('follows XDG_CONFIG_HOME, and OPENCODE_CONFIG_DIR before it', async () => {
    const { homeDirectory, root } = await fixture();
    const xdgDirectory = path.join(root, 'xdg', 'opencode');
    const explicitDirectory = path.join(root, 'explicit');
    await mkdir(xdgDirectory, { recursive: true });
    await mkdir(explicitDirectory);
    const environment = { XDG_CONFIG_HOME: path.join(root, 'xdg') };

    await runMcpRegistrationCommand({ argv: ['opencode'], cwd: root, environment, homeDirectory });
    expect(await readdir(xdgDirectory)).toEqual(['opencode.json']);

    await runMcpRegistrationCommand({
      argv: ['opencode'],
      cwd: root,
      environment: { ...environment, OPENCODE_CONFIG_DIR: explicitDirectory },
      homeDirectory,
    });
    expect(JSON.parse(await readFile(path.join(explicitDirectory, 'opencode.json'), 'utf8'))).toEqual(managedDocument);
  });

  test('registers into one explicit absolute configuration file', async () => {
    const { homeDirectory, root } = await fixture();
    const project = path.join(root, 'project');
    await mkdir(project);
    const configPath = path.join(project, 'opencode.json');
    await writeFile(configPath, '{"model":"m"}\n');

    await expect(
      runMcpRegistrationCommand({ argv: ['opencode', configPath], cwd: root, environment: {}, homeDirectory }),
    ).resolves.toMatchObject({ kind: 'created' });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ ...managedDocument, model: 'm' });
    // The explicit file is the only target: no global OpenCode configuration directory appears in the home.
    expect(await readdir(path.join(root, '.config'))).toEqual(['ai-usage']);
  });

  test('rejects a relative path, extra arguments and a relative configuration directory', async () => {
    const { homeDirectory, root } = await fixture();
    const run = (argv: readonly string[], environment: NodeJS.ProcessEnv = {}) =>
      runMcpRegistrationCommand({ argv, cwd: root, environment, homeDirectory });

    await expect(run(['opencode', 'opencode.json'])).rejects.toThrow('absolute opencode.json or opencode.jsonc path');
    await expect(run(['opencode', path.join(root, 'opencode.json'), 'extra'])).rejects.toThrow(
      'absolute opencode.json or opencode.jsonc path',
    );
    await expect(run(['opencode'], { OPENCODE_CONFIG_DIR: 'relative' })).rejects.toThrow('must be an absolute path');
    await expect(run(['unknown'])).rejects.toThrow('expects codex, opencode');
    expect(await readdir(root)).toEqual([]);
  });

  test('describes a typed OpenCode refusal with its reason and the manual snippet', async () => {
    const { homeDirectory, root } = await fixture();
    const directory = path.join(root, '.config', 'opencode');
    await mkdir(directory, { recursive: true });
    const declarative = path.join(root, 'declarative.json');
    await writeFile(declarative, '{}\n');
    await symlink(declarative, path.join(directory, 'opencode.json'));

    const failure = await runMcpRegistrationCommand({
      argv: ['opencode'],
      cwd: root,
      environment: {},
      homeDirectory,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    const described = describeMcpRegistrationFailure(failure);
    expect(described).toBe(
      [
        'ai-usage MCP registration failed (target-not-regular-file): The OpenCode configuration file is a symlink or not a regular file.',
        'Nothing was written. Merge this into your OpenCode configuration by hand:',
        openCodeMcpManualSnippet(registration),
        '',
      ].join('\n'),
    );
    expect(described).not.toContain(root);
    expect(await readFile(declarative, 'utf8')).toBe('{}\n');
  });

  test('keeps every other failure to one fixed line', () => {
    expect(describeMcpRegistrationFailure(new Error(`cannot open ${tmpdir()}/private`))).toBe(
      'ai-usage MCP registration failed.\n',
    );
  });
});
