#!/usr/bin/env bun
/**
 * A stand-in for the GitHub CLI used by the pull request observation tests. It is copied onto a
 * temporary PATH as `gh`, reads `scenario.json` from its own directory, appends every invocation
 * (arguments, whether GH_TOKEN was set, the environment variable names) to `calls.jsonl` beside
 * it, and always writes a sentinel to stderr so a test can prove stderr never reaches a result.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface ScenarioResponse {
  readonly delayMs?: number;
  readonly exitCode?: number;
  readonly stdout?: string;
}

interface Scenario {
  readonly api?: Record<string, ScenarioResponse>;
  readonly authToken?: ScenarioResponse;
  readonly pullRequests?: Record<string, ScenarioResponse>;
}

const directory = import.meta.dir;
const scenario = JSON.parse(readFileSync(path.join(directory, 'scenario.json'), 'utf8')) as Scenario;
const args = process.argv.slice(2);
process.stderr.write(`PRIVATE_FAKE_GH_STDERR_SENTINEL ${args.join(' ')}\n`);
appendFileSync(
  path.join(directory, 'calls.jsonl'),
  `${JSON.stringify({ args, environment: Object.keys(process.env).sort(), token: process.env.GH_TOKEN ?? null })}\n`,
);

const command = args.slice(0, 2).join(' ');
let response: ScenarioResponse | undefined;
if (command === 'auth token') {
  response = scenario.authToken;
} else if (command === 'pr view') {
  response = scenario.pullRequests?.[`${args[4] ?? ''}#${args[2] ?? ''}`];
} else if (args[0] === 'api') {
  response = scenario.api?.[args[1] ?? ''];
}
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
