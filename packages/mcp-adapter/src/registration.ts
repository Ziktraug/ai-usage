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

/**
 * A replacement that failed and left its temporary file beside the target: `cause` is the failure of the write and
 * `cleanupError` that of the removal. Its message is fixed and path-free.
 */
export class TemporaryFileNotRemovedError extends Error {
  readonly cleanupError: unknown;
  override readonly name = 'TemporaryFileNotRemovedError';

  constructor(failure: unknown, cleanupError: unknown) {
    super('ai-usage MCP registration failed and could not remove its temporary file beside the target.', {
      cause: failure,
    });
    this.cleanupError = cleanupError;
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

interface ObservedFile {
  readonly filePath: string;
  readonly observed: FileIdentity | null;
}

/**
 * Writes the document beside the target and renames it over it, unless the directory, the target or a file read beside
 * it changed since inspection. The checks run once the temporary file is synced, right before the rename.
 */
const replaceObservedDocument = async (input: {
  /** Files the outcome depends on that are not written, for example the other OpenCode configuration file. */
  readonly beside: readonly ObservedFile[];
  readonly canonicalDirectory: string;
  readonly configPath: string;
  readonly directory: string;
  readonly document: Record<string, unknown>;
  readonly observed: FileIdentity | null;
  readonly parentIdentity: FileIdentity;
}): Promise<void> => {
  const temporaryPath = path.join(input.directory, `.${path.basename(input.configPath)}.${randomUUID()}.tmp`);
  const mode = input.observed?.mode ?? 0o600;
  const handle = await open(temporaryPath, 'wx', mode);
  try {
    try {
      // The mode given to open is narrowed by the umask; the replacement keeps the mode of the file it replaces.
      await handle.chmod(mode);
      await handle.writeFile(`${JSON.stringify(input.document, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertParentIdentity(input.directory, input.canonicalDirectory, input.parentIdentity);
    await assertUnchanged(input.configPath, input.observed);
    await Promise.all(input.beside.map(({ filePath, observed }) => assertUnchanged(filePath, observed)));
    await rename(temporaryPath, input.configPath);
  } catch (error) {
    const cleanupError = await rm(temporaryPath, { force: true }).then(
      () => null,
      (failure: unknown) => ({ failure }),
    );
    throw cleanupError === null ? error : new TemporaryFileNotRemovedError(error, cleanupError.failure);
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
      beside: [],
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
  | 'directory-not-a-directory'
  | 'directory-not-accessible'
  | 'directory-unsafe'
  | 'jsonc-not-rewritable'
  | 'malformed-document'
  | 'target-not-readable'
  | 'target-not-regular-file'
  | 'target-not-writable'
  | 'target-too-large'
  | 'unsupported-file-name';

/** "A configuration file" is the one to write or the other of `opencode.json` and `opencode.jsonc` beside it. */
const openCodeFailureMessages: Record<OpenCodeMcpRegistrationFailureReason, string> = {
  'directory-missing': 'The OpenCode configuration directory does not exist.',
  'directory-not-a-directory': 'The OpenCode configuration directory path, or one of its parents, is not a directory.',
  'directory-not-accessible': 'The OpenCode configuration directory cannot be reached or searched.',
  'directory-unsafe': 'The OpenCode configuration directory is a symlink or is reached through one.',
  'jsonc-not-rewritable':
    'The OpenCode configuration file holds comments or trailing commas that a rewrite would drop.',
  'malformed-document':
    'An OpenCode configuration file is not a JSON or JSONC object with object-valued mcp and mcp.servers.',
  'target-not-readable': 'An OpenCode configuration file cannot be read.',
  'target-not-regular-file': 'An OpenCode configuration file is a symlink or not a regular file.',
  'target-not-writable': 'The OpenCode configuration file or its directory is read-only.',
  'target-too-large': 'An OpenCode configuration file exceeds the 1 MiB registration limit.',
  'unsupported-file-name': 'An OpenCode configuration file must be named opencode.json or opencode.jsonc.',
};

const openCodeEntry = (registration: McpStdioRegistration) => ({
  type: 'local' as const,
  command: [registration.command, ...registration.args],
});

/** The `mcp.servers` document an operator pastes when registration refuses to rewrite their configuration. */
export const openCodeMcpManualSnippet = (registration: McpStdioRegistration): string =>
  JSON.stringify({ mcp: { servers: { [registeredMcpServerName]: openCodeEntry(registration) } } }, null, 2);

const errorCodeOf = (error: unknown): string | null =>
  isRecord(error) && typeof error.code === 'string' ? error.code : null;

/**
 * A typed refusal to rewrite an OpenCode configuration; nothing was written when it is thrown. It is path-free: of the
 * system error behind it only the code is kept, never the error itself, whose message names the operator's paths.
 */
export class OpenCodeMcpRegistrationError extends Error {
  readonly manualSnippet: string;
  override readonly name = 'OpenCodeMcpRegistrationError';
  readonly reason: OpenCodeMcpRegistrationFailureReason;
  readonly systemErrorCode: string | null;

  constructor(
    reason: OpenCodeMcpRegistrationFailureReason,
    registration: McpStdioRegistration,
    systemErrorCode: string | null = null,
  ) {
    super(openCodeFailureMessages[reason]);
    this.manualSnippet = openCodeMcpManualSnippet(registration);
    this.reason = reason;
    this.systemErrorCode = systemErrorCode;
  }
}

/** OpenCode loads both names from one directory, comments and trailing commas allowed, as separate documents. */
const openCodeConfigFileNames = ['opencode.json', 'opencode.jsonc'] as const;

export type OpenCodeMcpRegistrationTarget =
  /** The first existing of `opencode.json` and `opencode.jsonc` in the directory, else a new `opencode.json`. */
  | { readonly kind: 'config-directory'; readonly path: string }
  /** One `opencode.json` or `opencode.jsonc` file, for example a project configuration. */
  | { readonly kind: 'config-file'; readonly path: string };

type SystemFailureReasons = ReadonlyMap<string, OpenCodeMcpRegistrationFailureReason>;

const directoryFailureReasons: SystemFailureReasons = new Map([
  ['EACCES', 'directory-not-accessible'],
  ['ENOENT', 'directory-missing'],
  ['ENOTDIR', 'directory-not-a-directory'],
  ['EPERM', 'directory-not-accessible'],
]);

const readFailureReasons: SystemFailureReasons = new Map([
  ['EACCES', 'target-not-readable'],
  ['ELOOP', 'target-not-regular-file'],
  ['EPERM', 'target-not-readable'],
]);

const writeFailureReasons: SystemFailureReasons = new Map([
  ['EACCES', 'target-not-writable'],
  ['EPERM', 'target-not-writable'],
  ['EROFS', 'target-not-writable'],
]);

interface OpenCodeRefusals {
  readonly refuse: (reason: OpenCodeMcpRegistrationFailureReason) => OpenCodeMcpRegistrationError;
  /** The typed refusal a system error stands for at one step, or the error itself when its code means nothing there. */
  readonly translate: (error: unknown, reasons: SystemFailureReasons) => unknown;
}

const openCodeRefusals = (registration: McpStdioRegistration): OpenCodeRefusals => ({
  refuse: (reason) => new OpenCodeMcpRegistrationError(reason, registration),
  translate: (error, reasons) => {
    const code = errorCodeOf(error);
    const reason = code === null ? undefined : reasons.get(code);
    return reason === undefined ? error : new OpenCodeMcpRegistrationError(reason, registration, code);
  },
});

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

const parsedOrNull = (parse: (text: string) => unknown, text: string): { readonly value: unknown } | null => {
  try {
    return { value: parse(text) };
  } catch {
    return null;
  }
};

interface InspectedOpenCodeDocument {
  readonly document: Record<string, unknown>;
  /** What the document says about the registered name: nothing, exactly the managed entry, or anything else. */
  readonly entry: 'absent' | 'managed' | 'unmanaged';
  readonly filePath: string;
  readonly mcp: Record<string, unknown>;
  readonly observed: FileIdentity | null;
  /** False for a document that is valid only as JSONC: a rewrite would drop its comments. */
  readonly rewritable: boolean;
  readonly servers: Record<string, unknown>;
}

const readOpenCodeDocument = async (
  filePath: string,
  observed: FileIdentity | null,
  refusals: OpenCodeRefusals,
): Promise<{ readonly document: Record<string, unknown>; readonly rewritable: boolean }> => {
  if (observed === null) {
    return { document: {}, rewritable: true };
  }
  if (observed.size > maxConfigBytes) {
    throw refusals.refuse('target-too-large');
  }
  const text = await readObservedText(filePath, observed).catch((error: unknown) => {
    throw refusals.translate(error, readFailureReasons);
  });
  const strict = parsedOrNull(JSON.parse, text);
  const parsed = strict ?? parsedOrNull(Bun.JSONC.parse, text);
  if (!(parsed && isRecord(parsed.value))) {
    throw refusals.refuse('malformed-document');
  }
  return { document: parsed.value, rewritable: strict !== null };
};

const inspectOpenCodeDocument = async (
  filePath: string,
  registration: McpStdioRegistration,
  refusals: OpenCodeRefusals,
): Promise<InspectedOpenCodeDocument> => {
  const observed = await observeFile(filePath).catch((error: unknown) => {
    throw error instanceof UnsafeTargetFileError
      ? refusals.refuse('target-not-regular-file')
      : refusals.translate(error, directoryFailureReasons);
  });
  const { document, rewritable } = await readOpenCodeDocument(filePath, observed, refusals);
  const mcp = document.mcp === undefined ? {} : document.mcp;
  if (!isRecord(mcp)) {
    throw refusals.refuse('malformed-document');
  }
  const servers = mcp.servers === undefined ? {} : mcp.servers;
  if (!isRecord(servers)) {
    throw refusals.refuse('malformed-document');
  }
  const current = servers[registeredMcpServerName];
  // OpenCode still merges the deprecated `mcp.<name>` form into `mcp.servers`, so a same-name entry there is unmanaged.
  const deprecated = mcp[registeredMcpServerName];
  let entry: InspectedOpenCodeDocument['entry'] = 'absent';
  if (deprecated !== undefined || (current !== undefined && !openCodeEntryMatches(current, registration))) {
    entry = 'unmanaged';
  } else if (current !== undefined) {
    entry = 'managed';
  }
  return { document, entry, filePath, mcp, observed, rewritable, servers };
};

/** The directory the registration locks and writes in, refused unless it is a real directory reached without a symlink. */
const inspectOpenCodeDirectory = async (
  directory: string,
  refusals: OpenCodeRefusals,
): Promise<{ readonly canonicalDirectory: string; readonly parentIdentity: FileIdentity }> => {
  const refuseSystemError = (error: unknown): never => {
    throw refusals.translate(error, directoryFailureReasons);
  };
  // The link itself first: resolving a dangling symlink would report a missing directory instead of an unsafe one.
  const parentStats = await lstat(directory).catch(refuseSystemError);
  if (parentStats.isSymbolicLink()) {
    throw refusals.refuse('directory-unsafe');
  }
  if (!parentStats.isDirectory()) {
    throw refusals.refuse('directory-not-a-directory');
  }
  const canonicalDirectory = await realpath(directory).catch(refuseSystemError);
  if (canonicalDirectory !== directory) {
    throw refusals.refuse('directory-unsafe');
  }
  return { canonicalDirectory, parentIdentity: identityOf(parentStats) };
};

/** The file to write in a configuration directory: the first candidate that exists, else the first candidate. */
const selectOpenCodeTarget = async (
  directory: string,
  candidates: readonly string[],
  refusals: OpenCodeRefusals,
): Promise<string> => {
  const present = await Promise.all(
    candidates.map((candidate) =>
      lstat(candidate).then(
        () => true,
        (error: unknown) => {
          if (errorCodeOf(error) === 'ENOENT') {
            return false;
          }
          throw refusals.translate(error, directoryFailureReasons);
        },
      ),
    ),
  );
  return candidates[present.indexOf(true)] ?? path.join(directory, openCodeConfigFileNames[0]);
};

const managedOutcome = (documents: readonly InspectedOpenCodeDocument[]): McpRegistrationResult | null => {
  const entries = documents.map(({ entry }) => entry);
  if (entries.includes('unmanaged')) {
    return { kind: 'refused-unmanaged', reason: 'existing-server-differs', serverName: registeredMcpServerName };
  }
  return entries.includes('managed') ? { kind: 'unchanged', serverName: registeredMcpServerName } : null;
};

export const registerOpenCodeMcp = async (input: {
  readonly privateStatePath: string;
  readonly registration: McpStdioRegistration;
  readonly target: OpenCodeMcpRegistrationTarget;
}): Promise<McpRegistrationResult> => {
  validRegistration(input.registration);
  const refusals = openCodeRefusals(input.registration);
  const requestedPath = path.resolve(input.target.path);
  if (
    input.target.kind === 'config-file' &&
    !openCodeConfigFileNames.some((fileName) => fileName === path.basename(requestedPath))
  ) {
    throw refusals.refuse('unsupported-file-name');
  }
  const directory = input.target.kind === 'config-file' ? path.dirname(requestedPath) : requestedPath;
  const { canonicalDirectory, parentIdentity } = await inspectOpenCodeDirectory(directory, refusals);
  const lockIdentity = await projectionLockIdentityForTarget(directory);
  return await withSkillProjectionLock(input.privateStatePath, lockIdentity, async () => {
    await assertParentIdentity(directory, canonicalDirectory, parentIdentity);
    const candidates = openCodeConfigFileNames.map((fileName) => path.join(directory, fileName));
    const configPath =
      input.target.kind === 'config-file' ? requestedPath : await selectOpenCodeTarget(directory, candidates, refusals);
    const target = await inspectOpenCodeDocument(configPath, input.registration, refusals);
    // OpenCode reads both files of the directory, so the one left alone can still define or override the name.
    const beside = await Promise.all(
      candidates
        .filter((candidate) => candidate !== configPath)
        .map((filePath) => inspectOpenCodeDocument(filePath, input.registration, refusals)),
    );
    const outcome = managedOutcome([target, ...beside]);
    if (outcome !== null) {
      return outcome;
    }
    if (!target.rewritable) {
      throw refusals.refuse('jsonc-not-rewritable');
    }
    const updated = {
      ...target.document,
      mcp: {
        ...target.mcp,
        servers: { ...target.servers, [registeredMcpServerName]: openCodeEntry(input.registration) },
      },
    };
    try {
      // A rename would replace a read-only file through its writable directory; the operator's mode is a refusal.
      await Promise.all(
        [directory, ...(target.observed === null ? [] : [configPath])].map((entry) => access(entry, fs.constants.W_OK)),
      );
      await Promise.all(beside.map(({ filePath, observed }) => assertUnchanged(filePath, observed)));
      await replaceObservedDocument({
        beside,
        canonicalDirectory,
        configPath,
        directory,
        document: updated,
        observed: target.observed,
        parentIdentity,
      });
    } catch (error) {
      throw refusals.translate(error, writeFailureReasons);
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
