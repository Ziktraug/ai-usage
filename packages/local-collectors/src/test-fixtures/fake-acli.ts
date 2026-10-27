#!/usr/bin/env bun
/**
 * A stand-in for the Atlassian CLI used by the Jira issue observation tests. It is copied onto a
 * temporary PATH as `acli`, reads `scenario.json` from its own directory, appends every invocation
 * (arguments and the environment variable names it saw) to `calls.jsonl` beside it, and always
 * writes a sentinel to stderr so a test can prove stderr never reaches a result. The command shape
 * it answers (`acli jira workitem view <KEY> --json`) is the one the collector assumes; the real
 * CLI was not exercised on the machine this fixture was written on.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface ScenarioResponse {
  readonly delayMs?: number;
  readonly exitCode?: number;
  readonly stdout?: string;
}

interface Scenario {
  readonly auth?: ScenarioResponse;
  readonly issues?: Record<string, ScenarioResponse>;
}

const directory = import.meta.dir;
const scenario = JSON.parse(readFileSync(path.join(directory, 'scenario.json'), 'utf8')) as Scenario;
const args = process.argv.slice(2);
process.stderr.write(`PRIVATE_FAKE_ACLI_STDERR_SENTINEL ${args.join(' ')}\n`);
appendFileSync(
  path.join(directory, 'calls.jsonl'),
  `${JSON.stringify({ args, environment: Object.keys(process.env).sort() })}\n`,
);

const command = args.slice(0, 3).join(' ');
const response = command === 'jira auth status' ? scenario.auth : scenario.issues?.[args[3] ?? ''];
if (response === undefined) {
  process.exit(1);
}
if (response.delayMs !== undefined) {
  await Bun.sleep(response.delayMs);
}
if (response.stdout !== undefined) {
  process.stdout.write(response.stdout);
}
process.exit(response.exitCode ?? 0);
