import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { access, lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { projectionLockIdentityForTarget, withSkillProjectionLock } from '@ai-usage/skills/projection-lock';

/** Keeps its Memory-era value: operator configs already register this name, and a rename would orphan them. */
export const registeredMcpServerName = 'ai-usage-memory' as const;

export interface McpStdioRegistration {
  readonly args: readonly string[];
  readonly command: string;
}

export type McpRegistrationResult =
  | { readonly kind: 'created'; readonly serverName: typeof registeredMcpServerName }
  | { readonly kind: 'unchanged'; readonly serverName: typeof registeredMcpServerName }
  | {
      readonly kind: 'refused-unmanaged';
      readonly reason: 'existing-server-differs';
      readonly serverName: typeof registeredMcpServerName;
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

const validRegistration = (registration: McpStdioRegistration): void => {
  if (
    registration.command.length === 0 ||
    registration.command.includes('\0') ||
    registration.args.length > 64 ||
    registration.args.some((entry) => entry.length === 0 || entry.includes('\0'))
  ) {
    throw new Error('ai-usage MCP stdio registration is invalid.');
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

const maxConfigBytes = 1024 * 1024;

class UnsafeTargetFileError extends Error {
  override readonly name = 'UnsafeTargetFileError';

  constructor() {
    super('ai-usage MCP registration target must be a regular non-symlink file.');
  }
}

const observeFile = async (filePath: string): Promise<FileIdentity | null> => {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new UnsafeTargetFileError();
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
    throw new Error('ai-usage MCP registration target changed after inspection.');
  }
};

const readObservedText = async (filePath: string, observed: FileIdentity): Promise<string> => {
  if (observed.size > maxConfigBytes) {
    throw new Error('ai-usage MCP registration target exceeds its byte limit.');
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are combined bitwise.
  const handle = await open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = identityOf(await handle.stat());
    if (!sameIdentity(observed, before)) {
      throw new Error('ai-usage MCP registration target changed before reading.');
    }
    const text = await handle.readFile({ encoding: 'utf8' });
    const after = identityOf(await handle.stat());
    if (!sameIdentity(before, after)) {
      throw new Error('ai-usage MCP registration target changed while reading.');
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
    throw new Error('ai-usage MCP registration directory changed after inspection.');
  }
};

/** Writes the document beside the target and renames it over it, unless the directory or target changed since inspection. */
const replaceObservedDocument = async (input: {
  readonly canonicalDirectory: string;
  readonly configPath: string;
  readonly directory: string;
  readonly document: Record<string, unknown>;
  readonly observed: FileIdentity | null;
  readonly parentIdentity: FileIdentity;
}): Promise<void> => {
  const temporaryPath = path.join(input.directory, `.${path.basename(input.configPath)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', input.observed?.mode ?? 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(input.document, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertParentIdentity(input.directory, input.canonicalDirectory, input.parentIdentity);
    await assertUnchanged(input.configPath, input.observed);
    await rename(temporaryPath, input.configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

const registrationMatches = (value: unknown, expected: McpStdioRegistration): boolean =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  value.command === expected.command &&
  Array.isArray(value.args) &&
  value.args.length === expected.args.length &&
  value.args.every((entry, index) => entry === expected.args[index]);

export const registerJsonMcp = async (input: {
  readonly configPath: string;
  readonly privateStatePath: string;
  readonly registration: McpStdioRegistration;
}): Promise<McpRegistrationResult> => {
  validRegistration(input.registration);
  const configPath = path.resolve(input.configPath);
  if (!['.mcp.json', 'mcp.json'].includes(path.basename(configPath))) {
    throw new Error('ai-usage MCP JSON registration target has an unsupported filename.');
  }
  const directory = path.dirname(configPath);
  const canonicalDirectory = await realpath(directory);
  const parentStats = await lstat(directory);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory() || canonicalDirectory !== directory) {
    throw new Error('ai-usage MCP registration directory is unsafe.');
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
        throw new Error('ai-usage MCP JSON registration target must contain an object.');
      }
      document = parsed;
    }
    const existingServers = document.mcpServers;
    if (existingServers !== undefined && !isRecord(existingServers)) {
      throw new Error('ai-usage MCP JSON registration target has an invalid mcpServers value.');
    }
    const servers = existingServers ?? {};
    const existing = servers[registeredMcpServerName];
    if (existing !== undefined) {
      return registrationMatches(existing, input.registration)
        ? { kind: 'unchanged', serverName: registeredMcpServerName }
        : {
            kind: 'refused-unmanaged',
            reason: 'existing-server-differs',
            serverName: registeredMcpServerName,
          };
    }
    const updated = {
      ...document,
      mcpServers: { ...servers, [registeredMcpServerName]: input.registration },
    };
    await replaceObservedDocument({
      canonicalDirectory,
      configPath,
      directory,
      document: updated,
      observed,
      parentIdentity,
    });
    return { kind: 'created', serverName: registeredMcpServerName };
  });
};

export type OpenCodeMcpRegistrationFailureReason =
  | 'directory-missing'
  | 'directory-unsafe'
  | 'jsonc-not-rewritable'
  | 'malformed-document'
  | 'target-not-regular-file'
  | 'target-not-writable'
  | 'target-too-large';

const openCodeFailureMessages: Record<OpenCodeMcpRegistrationFailureReason, string> = {
  'directory-missing': 'The OpenCode configuration directory does not exist.',
  'directory-unsafe': 'The OpenCode configuration directory is a symlink or is reached through one.',
  'jsonc-not-rewritable':
    'The OpenCode configuration file holds comments or trailing commas that a rewrite would drop.',
  'malformed-document':
    'The OpenCode configuration file is not a JSON or JSONC object with object-valued mcp and mcp.servers.',
  'target-not-regular-file': 'The OpenCode configuration file is a symlink or not a regular file.',
  'target-not-writable': 'The OpenCode configuration file or its directory is read-only.',
  'target-too-large': 'The OpenCode configuration file exceeds the 1 MiB registration limit.',
};

const openCodeEntry = (registration: McpStdioRegistration) => ({
  type: 'local' as const,
  command: [registration.command, ...registration.args],
});

/** The `mcp.servers` document an operator pastes when registration refuses to rewrite their configuration. */
export const openCodeMcpManualSnippet = (registration: McpStdioRegistration): string =>
  JSON.stringify({ mcp: { servers: { [registeredMcpServerName]: openCodeEntry(registration) } } }, null, 2);

/** A typed, path-free refusal to rewrite an OpenCode configuration; nothing was written when it is thrown. */
export class OpenCodeMcpRegistrationError extends Error {
  readonly manualSnippet: string;
  override readonly name = 'OpenCodeMcpRegistrationError';
  readonly reason: OpenCodeMcpRegistrationFailureReason;

  constructor(
    reason: OpenCodeMcpRegistrationFailureReason,
    registration: McpStdioRegistration,
    options?: ErrorOptions,
  ) {
    super(openCodeFailureMessages[reason], options);
    this.manualSnippet = openCodeMcpManualSnippet(registration);
    this.reason = reason;
  }
}

/** OpenCode reads both names with comments and trailing commas allowed; `opencode mcp add` prefers the first. */
const openCodeConfigFileNames = ['opencode.json', 'opencode.jsonc'] as const;

export type OpenCodeMcpRegistrationTarget =
  /** The first existing of `opencode.json` and `opencode.jsonc` in the directory, else a new `opencode.json`. */
  | { readonly kind: 'config-directory'; readonly path: string }
  /** One `opencode.json` or `opencode.jsonc` file, for example a project configuration. */
  | { readonly kind: 'config-file'; readonly path: string };

const openCodeEntryMatches = (value: unknown, registration: McpStdioRegistration): boolean => {
  const expected = openCodeEntry(registration);
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.type === expected.type &&
    Array.isArray(value.command) &&
    value.command.length === expected.command.length &&
    value.command.every((entry, index) => entry === expected.command[index])
  );
};

const hasErrorCode = (error: unknown, codes: readonly string[]): boolean =>
  isRecord(error) && typeof error.code === 'string' && codes.includes(error.code);

const parsedOrNull = (parse: (text: string) => unknown, text: string): { readonly value: unknown } | null => {
  try {
    return { value: parse(text) };
  } catch {
    return null;
  }
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, ['ENOENT'])) {
      return false;
    }
    throw error;
  }
};

const notWritableCodes = ['EACCES', 'EPERM', 'EROFS'] as const;

export const registerOpenCodeMcp = async (input: {
  readonly privateStatePath: string;
  readonly registration: McpStdioRegistration;
  readonly target: OpenCodeMcpRegistrationTarget;
}): Promise<McpRegistrationResult> => {
  validRegistration(input.registration);
  const refusal = (reason: OpenCodeMcpRegistrationFailureReason, cause?: unknown): OpenCodeMcpRegistrationError =>
    new OpenCodeMcpRegistrationError(reason, input.registration, cause === undefined ? undefined : { cause });
  const targetPath = path.resolve(input.target.path);
  if (
    input.target.kind === 'config-file' &&
    !openCodeConfigFileNames.some((fileName) => fileName === path.basename(targetPath))
  ) {
    throw new Error('ai-usage MCP OpenCode registration target has an unsupported filename.');
  }
  const directory = input.target.kind === 'config-file' ? path.dirname(targetPath) : targetPath;
  const canonicalDirectory = await realpath(directory).catch((error: unknown) => {
    throw hasErrorCode(error, ['ENOENT']) ? refusal('directory-missing', error) : error;
  });
  const parentStats = await lstat(directory);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory() || canonicalDirectory !== directory) {
    throw refusal('directory-unsafe');
  }
  const parentIdentity = identityOf(parentStats);
  const lockIdentity = await projectionLockIdentityForTarget(directory);
  return await withSkillProjectionLock(input.privateStatePath, lockIdentity, async () => {
    await assertParentIdentity(directory, canonicalDirectory, parentIdentity);
    let configPath = targetPath;
    if (input.target.kind === 'config-directory') {
      const candidates = openCodeConfigFileNames.map((fileName) => path.join(directory, fileName));
      const existing = await Promise.all(candidates.map(pathExists));
      configPath = candidates[existing.indexOf(true)] ?? path.join(directory, openCodeConfigFileNames[0]);
    }
    const observed = await observeFile(configPath).catch((error: unknown) => {
      throw error instanceof UnsafeTargetFileError ? refusal('target-not-regular-file', error) : error;
    });
    let document: Record<string, unknown> = {};
    let rewritable = true;
    if (observed !== null) {
      if (observed.size > maxConfigBytes) {
        throw refusal('target-too-large');
      }
      const text = await readObservedText(configPath, observed);
      const strict = parsedOrNull(JSON.parse, text);
      // A document that is only valid as JSONC is read, never rewritten: a rewrite would drop its comments.
      const parsed = strict ?? parsedOrNull(Bun.JSONC.parse, text);
      if (!(parsed && isRecord(parsed.value))) {
        throw refusal('malformed-document');
      }
      document = parsed.value;
      rewritable = strict !== null;
    }
    const mcp = document.mcp === undefined ? {} : document.mcp;
    if (!isRecord(mcp)) {
      throw refusal('malformed-document');
    }
    const servers = mcp.servers === undefined ? {} : mcp.servers;
    if (!isRecord(servers)) {
      throw refusal('malformed-document');
    }
    // OpenCode still merges the deprecated `mcp.<name>` form into `mcp.servers`, so a same-name entry there is unmanaged too.
    if (mcp[registeredMcpServerName] !== undefined) {
      return { kind: 'refused-unmanaged', reason: 'existing-server-differs', serverName: registeredMcpServerName };
    }
    const existing = servers[registeredMcpServerName];
    if (existing !== undefined) {
      return openCodeEntryMatches(existing, input.registration)
        ? { kind: 'unchanged', serverName: registeredMcpServerName }
        : { kind: 'refused-unmanaged', reason: 'existing-server-differs', serverName: registeredMcpServerName };
    }
    if (!rewritable) {
      throw refusal('jsonc-not-rewritable');
    }
    const updated = {
      ...document,
      mcp: { ...mcp, servers: { ...servers, [registeredMcpServerName]: openCodeEntry(input.registration) } },
    };
    try {
      // A rename would replace a read-only file through its writable directory; the operator's mode is a refusal.
      await Promise.all(
        [directory, ...(observed === null ? [] : [configPath])].map((entry) => access(entry, fs.constants.W_OK)),
      );
      await replaceObservedDocument({
        canonicalDirectory,
        configPath,
        directory,
        document: updated,
        observed,
        parentIdentity,
      });
    } catch (error) {
      throw hasErrorCode(error, notWritableCodes) ? refusal('target-not-writable', error) : error;
    }
    return { kind: 'created', serverName: registeredMcpServerName };
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
  return parsed.find((entry) => isRecord(entry) && entry.name === registeredMcpServerName);
};

const codexServerMatches = (value: unknown, expected: McpStdioRegistration): boolean => {
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

export const registerCodexMcp = async (input: {
  readonly configPath: string;
  readonly privateStatePath: string;
  readonly registration: McpStdioRegistration;
  readonly runner: CodexMcpCommandRunner;
}): Promise<McpRegistrationResult> => {
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
        ? { kind: 'unchanged', serverName: registeredMcpServerName }
        : {
            kind: 'refused-unmanaged',
            reason: 'existing-server-differs',
            serverName: registeredMcpServerName,
          };
    }
    await assertParentIdentity(directory, canonicalDirectory, parentIdentity);
    await assertUnchanged(configPath, observed);
    const added = await input.runner.run([
      'mcp',
      'add',
      registeredMcpServerName,
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
    return { kind: 'created', serverName: registeredMcpServerName };
  });
};

export const createCodexMcpCommandRunner = (codexCommand = 'codex'): CodexMcpCommandRunner => ({
  run: async (args) => {
    const child = Bun.spawn([codexCommand, ...args], { stderr: 'ignore', stdout: 'pipe' });
    const stdout = await new Response(child.stdout).text();
    return { exitCode: await child.exited, stdout };
  },
});
