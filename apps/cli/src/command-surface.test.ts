import { expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { helpText, parseCommand } from './cli';
import { withCliSandbox } from './test-support/run-cli';

test('the CLI advertises the delegation operations and says which ones need a running engine', () => {
  expect(helpText).toContain('delegation <command>');
  expect(helpText).toContain('delegation qualify --request <file|-> [--simulation] [--json]');
  expect(helpText).toContain('delegation start --request <file|-> --qualification <id> --key <idempotency-key>');
  expect(helpText).toContain('--route <id> [--selector-version <v>] [--confidence <0..1>] | --abstain <reason>');
  expect(helpText).toContain('delegation status <jobId> [--json]');
  expect(helpText).toContain('delegation list [--live] [--limit <n>] [--json]');
  expect(helpText).toContain('delegation cancel <jobId> [--json]');
  expect(helpText).toContain('need a running engine and never start one');
  // The CLI records no evaluation: a verification is the calling model's, an acceptance the operator's.
  expect(helpText).not.toContain('delegation evaluate');
});

test('the CLI no longer advertises or dispatches generated-account commands', () => {
  expect(helpText).not.toContain('analyses');
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

test('the CLI no longer advertises or dispatches Memory search or replication status', () => {
  expect(helpText.toLowerCase()).not.toContain('memory');
  expect(helpText.toLowerCase()).not.toContain('replication');
  for (const args of [
    ['memory', 'search', 'release checklist'],
    ['memory', 'search', 'release checklist', '--json'],
    ['replication', 'status'],
    ['replication', 'status', '--json'],
  ]) {
    const error = Effect.runSync(Effect.flip(parseCommand(args)));
    expect(error._tag).toBe('CliArgumentError');
    expect(error.message).toBe(`Unknown option: ${args[0]}`);
  }
});

test.each([
  ['analyses', ['analyses', 'prepare', '--project', 'synthetic', '--authorize-provider-processing']],
  ['memory', ['memory', 'search', 'release checklist', '--json']],
  ['replication', ['replication', 'status', '--json']],
] as const)(
  'an isolated executable rejects the former %s command before creating the store or engine state',
  async (command, argv) => {
    await withCliSandbox(async ({ environment, root, runCli }) => {
      const result = await runCli([...argv]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`Error: Unknown option: ${command}\n`);
      await expect(access(environment.AI_USAGE_DATABASE_PATH!)).rejects.toThrow();
      await expect(access(path.join(root, 'state'))).rejects.toThrow();
    });
  },
);
