#!/usr/bin/env bun
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCodexMcpCommandRunner,
  type McpRegistrationResult,
  OpenCodeMcpRegistrationError,
  type OpenCodeMcpRegistrationTarget,
  registerCodexMcp,
  registerJsonMcp,
  registerOpenCodeMcp,
  TemporaryFileNotRemovedError,
} from '@ai-usage/mcp-adapter/registration';
import { resolveUsageRuntimePaths } from '@ai-usage/usage-engine-control/node';

export interface McpRegistrationCommandOptions {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

/**
 * The directory OpenCode's own `opencode mcp add --global` edits: `$OPENCODE_CONFIG_DIR`, else `opencode` under
 * `$XDG_CONFIG_HOME` or `~/.config`; OpenCode reads an empty value of either variable as unset. One absolute path
 * selects a single configuration file instead.
 */
const openCodeTarget = (
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): OpenCodeMcpRegistrationTarget => {
  const configPath = argv[1];
  if (configPath !== undefined) {
    if (!(path.isAbsolute(configPath) && argv.length === 2)) {
      throw new Error('OpenCode MCP registration expects at most one absolute opencode.json or opencode.jsonc path.');
    }
    return { kind: 'config-file', path: configPath };
  }
  const directory =
    environment.OPENCODE_CONFIG_DIR ||
    path.join(environment.XDG_CONFIG_HOME || path.join(homeDirectory, '.config'), 'opencode');
  if (!path.isAbsolute(directory)) {
    throw new Error('OpenCode configuration directory must be an absolute path.');
  }
  return { kind: 'config-directory', path: directory };
};

export const runMcpRegistrationCommand = async ({
  argv,
  cwd = process.cwd(),
  environment = process.env,
  homeDirectory = os.homedir(),
}: McpRegistrationCommandOptions): Promise<McpRegistrationResult> => {
  const mode = argv[0];
  if (mode !== 'codex' && mode !== 'json' && mode !== 'opencode') {
    throw new Error(
      'Usage: ai-usage MCP registration expects codex, opencode [absolute-config-path] or json <absolute-config-path>.',
    );
  }
  const paths = resolveUsageRuntimePaths({
    cwd,
    databasePathForHome: (home) => path.join(home, '.local', 'share', 'ai-usage', 'usage.sqlite'),
    env: environment,
    systemHome: homeDirectory,
  });
  const registration = {
    args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts')],
    command: process.execPath,
  };
  if (mode === 'json') {
    const configPath = argv[1];
    if (!(configPath && path.isAbsolute(configPath) && argv.length === 2)) {
      throw new Error('JSON MCP registration expects one absolute .mcp.json or mcp.json path.');
    }
    return await registerJsonMcp({
      configPath,
      privateStatePath: paths.stateDirectory,
      registration,
    });
  }
  if (mode === 'opencode') {
    return await registerOpenCodeMcp({
      privateStatePath: paths.stateDirectory,
      registration,
      target: openCodeTarget(argv, environment, paths.homeDirectory),
    });
  }
  if (argv.length !== 1) {
    throw new Error('Codex MCP registration takes no additional arguments.');
  }
  const codexHome = environment.CODEX_HOME ?? path.join(paths.homeDirectory, '.codex');
  if (!path.isAbsolute(codexHome)) {
    throw new Error('Codex home must be an absolute path.');
  }
  return await registerCodexMcp({
    configPath: path.join(codexHome, 'config.toml'),
    privateStatePath: paths.stateDirectory,
    registration,
    runner: createCodexMcpCommandRunner(),
  });
};

/**
 * What a failed registration writes to stderr. An OpenCode refusal names its reason, the system error code behind it
 * when there is one, and the entry to add by hand. A write that left its temporary file behind says so in its own fixed
 * line; every other failure stays one fixed line, so no private path or system error message reaches the terminal.
 */
export const describeMcpRegistrationFailure = (error: unknown): string => {
  if (error instanceof OpenCodeMcpRegistrationError) {
    return [
      `ai-usage MCP registration failed (${[error.reason, error.systemErrorCode].filter(Boolean).join(', ')}): ${error.message}`,
      'Nothing was written. Merge this into your OpenCode configuration by hand:',
      error.manualSnippet,
      '',
    ].join('\n');
  }
  // Its message is fixed and path-free; the system errors it carries are not printed.
  return error instanceof TemporaryFileNotRemovedError ? `${error.message}\n` : 'ai-usage MCP registration failed.\n';
};

if (import.meta.main) {
  try {
    const result = await runMcpRegistrationCommand({ argv: process.argv.slice(2) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.kind === 'refused-unmanaged' ? 2 : 0;
  } catch (error) {
    process.stderr.write(describeMcpRegistrationFailure(error));
    process.exitCode = 1;
  }
}
