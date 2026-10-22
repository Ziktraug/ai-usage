import { expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { helpText, parseCommand } from './cli';
import { withCliSandbox } from './test-support/run-cli';

test('the CLI no longer advertises or dispatches generated-account commands', () => {
  expect(helpText).not.toContain('analyses');
  expect(helpText).toContain('memory search <query>');
  for (const args of [
    ['analyses'],
    ['analyses', 'projects'],
    ['analyses', 'prepare'],
    ['analyses', 'search', 'cache'],
  ]) {
    const error = Effect.runSync(Effect.flip(parseCommand(args)));
    expect(error._tag).toBe('CliArgumentError');
    expect(error.message).toBe('Unknown option: analyses');
  }
  expect(Effect.runSync(parseCommand(['analyses', '--help']))).toEqual({ _tag: 'Help' });
});

test('an isolated executable rejects a former mutation before creating either local store', async () => {
  await withCliSandbox(async ({ environment, root, runCli }) => {
    const result = await runCli(['analyses', 'prepare', '--project', 'synthetic', '--authorize-provider-processing']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Error: Unknown option: analyses\n');
    await expect(access(environment.AI_USAGE_DATABASE_PATH!)).rejects.toThrow();
    await expect(access(path.join(root, 'state', 'memory.sqlite'))).rejects.toThrow();
  });
});
