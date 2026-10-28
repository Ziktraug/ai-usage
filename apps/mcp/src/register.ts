#!/usr/bin/env bun
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCodexMcpCommandRunner,
  type McpRegistrationResult,
  registerCodexMcp,
  registerJsonMcp,
} from '@ai-usage/mcp-adapter/registration';
import { resolveUsageRuntimePaths } from '@ai-usage/usage-engine-control/node';

export interface McpRegistrationCommandOptions {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export const runMcpRegistrationCommand = async ({
  argv,
  cwd = process.cwd(),
  environment = process.env,
  homeDirectory = os.homedir(),
}: McpRegistrationCommandOptions): Promise<McpRegistrationResult> => {
  const mode = argv[0];
  if (mode !== 'codex' && mode !== 'json') {
    throw new Error('Usage: ai-usage MCP registration expects codex or json <absolute-config-path>.');
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

if (import.meta.main) {
  try {
    const result = await runMcpRegistrationCommand({ argv: process.argv.slice(2) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.kind === 'refused-unmanaged' ? 2 : 0;
  } catch {
    process.stderr.write('ai-usage MCP registration failed.\n');
    process.exitCode = 1;
  }
}
