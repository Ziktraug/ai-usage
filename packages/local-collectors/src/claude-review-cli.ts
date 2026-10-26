import { stat } from 'node:fs/promises';
import { BoundedProcessError, executeBoundedProcess } from '@ai-usage/local-machine/bounded-process';
import type { ClaudeReviewHarnessGuarantee } from '@ai-usage/report-core/work-attempts';

/**
 * Qualifies the installed Claude Code CLI before a launch (ADR 0055) and states the guarantee the
 * launch rests on. The launcher relies on per-invocation controls only:
 *
 * - `--setting-sources ""`: none of the user, project or local settings files is loaded, so none
 *   of their hooks, permission rules, environment or helper commands applies;
 * - `--safe-mode`: installed plugins, skills, CLAUDE.md, hooks and MCP servers from any
 *   customization are off, while the operator's sign-in keeps working;
 * - `--tools Read Grep Glob`: the session has no other built-in tool, Bash included;
 * - `--strict-mcp-config` without `--mcp-config`: no MCP server;
 * - `--permission-mode plan` and `--session-id`, the marker the engine looks for later.
 *
 * Each flag must appear in `claude --help` (read once per launch, so an updated CLI is qualified
 * again); a CLI that lacks one is refused, never launched with a weaker guarantee. `--max-turns`
 * is not listed by `--help` and cannot be qualified this way; a CLI that rejected it would fail
 * the attempt visibly at its first output.
 *
 * Managed (policy) settings cannot be excluded by any flag. Their file is looked for at the
 * documented locations and declared in the guarantee; policy delivered by the account's
 * organization is not observable locally and is stated as such where the guarantee is shown.
 */
export const CLAUDE_REVIEW_REQUIRED_FLAGS = [
  '--print',
  '--output-format',
  '--verbose',
  '--session-id',
  '--setting-sources',
  '--safe-mode',
  '--tools',
  '--strict-mcp-config',
  '--permission-mode',
  '--allowedTools',
  '--disallowedTools',
] as const;

/** Where Claude Code reads managed settings, per platform; a drop-in directory counts when it exists. */
export const CLAUDE_MANAGED_SETTINGS_PATHS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: [
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/Library/Application Support/ClaudeCode/managed-settings.d',
  ],
  linux: ['/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-settings.d'],
};

export class ClaudeCliQualificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCliQualificationError';
  }
}

export interface ClaudeCliQualification {
  readonly flags: ReadonlySet<string>;
  readonly version: string;
}

export interface QualifyClaudeCliOptions {
  /** Explicit variables on top of the bounded allow-list (`CLAUDE_CONFIG_DIR` when set). */
  readonly environment?: Readonly<Record<string, string>>;
  /** Flags needed beyond the fixed set (`--model`, `--effort` when declared). */
  readonly extraFlags?: readonly string[];
}

const HELP_TIMEOUT_MS = 15_000;
const HELP_OUTPUT_BYTES = 256 * 1024;
const VERSION = /^\s*(\d+\.\d+\.\d+)\b/u;
const LONG_FLAG = /(?<![\w-])--[A-Za-z][\w-]*/gu;

/** Every long option `--help` names, aliases included (`--allowedTools, --allowed-tools <tools...>`). */
export const parseClaudeHelpFlags = (help: string): ReadonlySet<string> => new Set(help.match(LONG_FLAG) ?? []);

const read = async (
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<string> => {
  let result: Awaited<ReturnType<typeof executeBoundedProcess>>;
  try {
    result = await executeBoundedProcess({
      args,
      command: executable,
      env: environment,
      maximumOutputBytes: HELP_OUTPUT_BYTES,
      timeoutMs: HELP_TIMEOUT_MS,
    });
  } catch (error) {
    const kind = error instanceof BoundedProcessError ? error.kind : 'failed';
    throw new ClaudeCliQualificationError(`claude ${args.join(' ')} ${kind}; the CLI cannot be qualified`);
  }
  if (result.exitCode !== 0) {
    throw new ClaudeCliQualificationError(
      `claude ${args.join(' ')} exited ${result.exitCode}; the CLI cannot be qualified`,
    );
  }
  return result.stdout;
};

export const qualifyClaudeCli = async (
  executable: string,
  options: QualifyClaudeCliOptions = {},
): Promise<ClaudeCliQualification> => {
  const environment = options.environment ?? {};
  const version = VERSION.exec(await read(executable, ['--version'], environment))?.[1];
  if (version === undefined) {
    throw new ClaudeCliQualificationError('claude --version did not answer a version number');
  }
  const flags = parseClaudeHelpFlags(await read(executable, ['--help'], environment));
  const missing = [...CLAUDE_REVIEW_REQUIRED_FLAGS, ...(options.extraFlags ?? [])].filter((flag) => !flags.has(flag));
  if (missing.length > 0) {
    throw new ClaudeCliQualificationError(
      `claude ${version} does not offer ${missing.join(', ')}; a read-only review needs every one of them`,
    );
  }
  return { flags, version };
};

/** Whether a managed settings file (or drop-in directory) exists on this machine. */
export const observeManagedSettings = async (
  paths: readonly string[] = CLAUDE_MANAGED_SETTINGS_PATHS[process.platform] ?? [],
): Promise<ClaudeReviewHarnessGuarantee['managedSettings']> => {
  for (const candidate of paths) {
    try {
      await stat(candidate);
      return 'present';
    } catch {
      // Absent or unreadable at this location; the next one is looked at.
    }
  }
  return 'absent';
};
