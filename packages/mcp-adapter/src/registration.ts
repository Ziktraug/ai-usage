import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { projectionLockIdentityForTarget, withSkillProjectionLock } from '@ai-usage/skills/projection-lock';

export const memoryMcpServerName = 'ai-usage-memory' as const;

export interface MemoryMcpStdioRegistration {
  readonly args: readonly string[];
  readonly command: string;
}

export type MemoryMcpRegistrationResult =
  | { readonly kind: 'created'; readonly serverName: typeof memoryMcpServerName }
  | { readonly kind: 'unchanged'; readonly serverName: typeof memoryMcpServerName }
  | {
      readonly kind: 'refused-unmanaged';
      readonly reason: 'existing-server-differs';
      readonly serverName: typeof memoryMcpServerName;
    };

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface CodexMcpCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface CodexMcpCommandRunner {
  readonly run: (args: readonly string[]) => Promise<CodexMcpCommandResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validRegistration = (registration: MemoryMcpStdioRegistration): void => {
  if (
    registration.command.length === 0 ||
    registration.command.includes('\0') ||
    registration.args.length > 64 ||
    registration.args.some((entry) => entry.length === 0 || entry.includes('\0'))
  ) {
    throw new Error('Memory MCP stdio registration is invalid.');
  }
};

const identityOf = (stats: Awaited<ReturnType<typeof lstat>>): FileIdentity => ({
  dev: String(stats.dev),
  ino: String(stats.ino),
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission masks require bitwise AND.
  mode: Number(stats.mode) & 0o777,
  mtimeMs: Number(stats.mtimeMs),
  size: Number(stats.size),
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.size === right.size;

const sameObjectIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const observeFile = async (filePath: string): Promise<FileIdentity | null> => {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('Memory MCP registration target must be a regular non-symlink file.');
    }
    return identityOf(stats);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const assertUnchanged = async (filePath: string, observed: FileIdentity | null): Promise<void> => {
  const current = await observeFile(filePath);
  if (
    (observed === null && current !== null) ||
    (observed !== null && (current === null || !sameIdentity(observed, current)))
  ) {
    throw new Error('Memory MCP registration target changed after inspection.');
  }
};

const readObservedText = async (filePath: string, observed: FileIdentity): Promise<string> => {
  if (observed.size > 1024 * 1024) {
    throw new Error('Memory MCP registration target exceeds its byte limit.');
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are combined bitwise.
  const handle = await open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = identityOf(await handle.stat());
    if (!sameIdentity(observed, before)) {
      throw new Error('Memory MCP registration target changed before reading.');
    }
    const text = await handle.readFile({ encoding: 'utf8' });
    const after = identityOf(await handle.stat());
    if (!sameIdentity(before, after)) {
      throw new Error('Memory MCP registration target changed while reading.');
    }
    return text;
  } finally {
    await handle.close();
  }
};

const assertParentIdentity = async (directory: string, canonical: string, observed: FileIdentity): Promise<void> => {
  const current = await lstat(directory);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameObjectIdentity(observed, identityOf(current)) ||
    (await realpath(directory)) !== canonical
  ) {
    throw new Error('Memory MCP registration directory changed after inspection.');
  }
};

const registrationMatches = (value: unknown, expected: MemoryMcpStdioRegistration): boolean =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  value.command === expected.command &&
  Array.isArray(value.args) &&
  value.args.length === expected.args.length &&
  value.args.every((entry, index) => entry === expected.args[index]);

export const registerJsonMemoryMcp = async (input: {
  readonly configPath: string;
  readonly privateStatePath: string;
  readonly registration: MemoryMcpStdioRegistration;
}): Promise<MemoryMcpRegistrationResult> => {
  validRegistration(input.registration);
  const configPath = path.resolve(input.configPath);
  if (!['.mcp.json', 'mcp.json'].includes(path.basename(configPath))) {
    throw new Error('Memory MCP JSON registration target has an unsupported filename.');
  }
  const directory = path.dirname(configPath);
  const canonicalDirectory = await realpath(directory);
  const parentStats = await lstat(directory);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory() || canonicalDirectory !== directory) {
    throw new Error('Memory MCP registration directory is unsafe.');
  }
  const parentIdentity = identityOf(parentStats);
  const lockIdentity = await projectionLockIdentityForTarget(directory);
  return await withSkillProjectionLock(input.privateStatePath, lockIdentity, async () => {
    await assertParentIdentity(directory, canonicalDirectory, parentIdentity);
    const observed = await observeFile(configPath);
    let document: Record<string, unknown> = {};
    if (observed !== null) {
      const parsed = JSON.parse(await readObservedText(configPath, observed)) as unknown;
      if (!isRecord(parsed)) {
        throw new Error('Memory MCP JSON registration target must contain an object.');
      }
      document = parsed;
    }
    const existingServers = document.mcpServers;
    if (existingServers !== undefined && !isRecord(existingServers)) {
      throw new Error('Memory MCP JSON registration target has an invalid mcpServers value.');
    }
    const servers = existingServers ?? {};
    const existing = servers[memoryMcpServerName];
    if (existing !== undefined) {
      return registrationMatches(existing, input.registration)
        ? { kind: 'unchanged', serverName: memoryMcpServerName }
        : {
            kind: 'refused-unmanaged',
            reason: 'existing-server-differs',
            serverName: memoryMcpServerName,
          };
    }
    const updated = {
      ...document,
      mcpServers: { ...servers, [memoryMcpServerName]: input.registration },
    };
    const temporaryPath = path.join(directory, `.${path.basename(configPath)}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', observed?.mode ?? 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await assertParentIdentity(directory, canonicalDirectory, parentIdentity);
      await assertUnchanged(configPath, observed);
      await rename(temporaryPath, configPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return { kind: 'created', serverName: memoryMcpServerName };
  });
};

const parseCodexServer = (stdout: string): unknown => {
  if (Buffer.byteLength(stdout, 'utf8') > 1024 * 1024) {
    throw new Error('Codex MCP list output exceeds its byte limit.');
  }
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Codex MCP list output is invalid.');
  }
  return parsed.find((entry) => isRecord(entry) && entry.name === memoryMcpServerName);
};

const codexServerMatches = (value: unknown, expected: MemoryMcpStdioRegistration): boolean => {
  if (!(isRecord(value) && value.enabled === true && isRecord(value.transport))) {
    return false;
  }
  return (
    value.transport.type === 'stdio' &&
    value.transport.command === expected.command &&
    Array.isArray(value.transport.args) &&
    value.transport.args.length === expected.args.length &&
    value.transport.args.every((entry, index) => entry === expected.args[index])
  );
};

const listCodexServer = async (runner: CodexMcpCommandRunner): Promise<unknown> => {
  const result = await runner.run(['mcp', 'list', '--json']);
  if (result.exitCode !== 0) {
    throw new Error('Codex MCP configuration could not be inspected.');
  }
  return parseCodexServer(result.stdout);
};

export const registerCodexMemoryMcp = async (input: {
  readonly configPath: string;
  readonly privateStatePath: string;
  readonly registration: MemoryMcpStdioRegistration;
  readonly runner: CodexMcpCommandRunner;
}): Promise<MemoryMcpRegistrationResult> => {
  validRegistration(input.registration);
  const configPath = path.resolve(input.configPath);
  if (path.basename(configPath) !== 'config.toml' || path.basename(path.dirname(configPath)) !== '.codex') {
    throw new Error('Codex MCP registration target must be a .codex/config.toml file.');
  }
  const directory = path.dirname(configPath);
  const canonicalDirectory = await realpath(directory);
  const parentStats = await lstat(directory);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory() || canonicalDirectory !== directory) {
    throw new Error('Codex MCP registration directory is unsafe.');
  }
  const parentIdentity = identityOf(parentStats);
  const lockIdentity = await projectionLockIdentityForTarget(directory);
  return await withSkillProjectionLock(input.privateStatePath, lockIdentity, async () => {
    await assertParentIdentity(directory, canonicalDirectory, parentIdentity);
    const observed = await observeFile(configPath);
    const existing = await listCodexServer(input.runner);
    if (existing !== undefined) {
      return codexServerMatches(existing, input.registration)
        ? { kind: 'unchanged', serverName: memoryMcpServerName }
        : {
            kind: 'refused-unmanaged',
            reason: 'existing-server-differs',
            serverName: memoryMcpServerName,
          };
    }
    await assertParentIdentity(directory, canonicalDirectory, parentIdentity);
    await assertUnchanged(configPath, observed);
    const added = await input.runner.run([
      'mcp',
      'add',
      memoryMcpServerName,
      '--',
      input.registration.command,
      ...input.registration.args,
    ]);
    if (added.exitCode !== 0) {
      throw new Error('Codex MCP configuration could not be updated.');
    }
    const verified = await listCodexServer(input.runner);
    if (!codexServerMatches(verified, input.registration)) {
      throw new Error('Codex MCP configuration could not be verified after update.');
    }
    return { kind: 'created', serverName: memoryMcpServerName };
  });
};

export const createCodexMcpCommandRunner = (codexCommand = 'codex'): CodexMcpCommandRunner => ({
  run: async (args) => {
    const child = Bun.spawn([codexCommand, ...args], { stderr: 'ignore', stdout: 'pipe' });
    const stdout = await new Response(child.stdout).text();
    return { exitCode: await child.exited, stdout };
  },
});
