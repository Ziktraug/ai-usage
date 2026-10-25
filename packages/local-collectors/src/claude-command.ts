import path from 'node:path';

/**
 * The one way this repository names the Claude Code CLI it runs and the environment it runs it
 * with, shared by the executor probe (`claude auth status`), the CLI qualification and the review
 * launch (ADR 0057). The account the engine confirms is therefore the account the review runs
 * under: same executable, same `CLAUDE_CONFIG_DIR`.
 *
 * The executable is `claude`, resolved on the allow-listed PATH by whoever runs it, or the one
 * `AI_USAGE_CLAUDE_EXECUTABLE` names: an absolute path, or a bare name. A relative path is refused
 * rather than resolved against a checkout, where a file of that name would run in the operator's
 * name. Fixtures use the variable to substitute a fake harness without touching the PATH.
 */
export const CLAUDE_EXECUTABLE_ENVIRONMENT_KEY = 'AI_USAGE_CLAUDE_EXECUTABLE';
/** Where the CLI keeps its sign-in; an engine started with it reviews under that account. */
export const CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY = 'CLAUDE_CONFIG_DIR';

export class ClaudeCommandError extends Error {
  readonly kind = 'executable-invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCommandError';
  }
}

export interface ClaudeCommand {
  /** `claude`, a bare name, or an absolute path; a bare name is looked up on the allow-listed PATH. */
  readonly command: string;
  /** Passed by name on top of the bounded allow-list: `CLAUDE_CONFIG_DIR` when the source sets it. */
  readonly environment: Readonly<Record<string, string>>;
}

export const claudeCommandFor = (
  env: Readonly<Record<string, string | undefined>>,
  override?: string,
): ClaudeCommand => {
  const named = override ?? env[CLAUDE_EXECUTABLE_ENVIRONMENT_KEY] ?? 'claude';
  if (named.includes('/') && !path.isAbsolute(named)) {
    throw new ClaudeCommandError(
      `${CLAUDE_EXECUTABLE_ENVIRONMENT_KEY} must be an absolute path or a bare command name; got "${named}"`,
    );
  }
  const configDirectory = env[CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY];
  return {
    command: named,
    environment:
      configDirectory === undefined || configDirectory === ''
        ? {}
        : { [CLAUDE_CONFIG_DIR_ENVIRONMENT_KEY]: configDirectory },
  };
};
