#!/usr/bin/env bun
import { type KnownLocalProjectSourcesRequest, runKnownLocalProjectSources } from './index';

const parseRequest = (serializedRequest: string | undefined): KnownLocalProjectSourcesRequest => {
  if (serializedRequest === undefined) {
    throw new Error('Known project-source runner requires a serialized request.');
  }
  const input: unknown = JSON.parse(serializedRequest);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Known project-source runner request must be an object.');
  }
  const request = input as Record<string, unknown>;
  if (request.harness !== null || request.includeCursor !== true) {
    throw new Error('Known project-source runner request has unsupported selection options.');
  }
  if (request.configCwd !== undefined && typeof request.configCwd !== 'string') {
    throw new Error('Known project-source runner configCwd must be a string.');
  }
  return {
    ...(request.configCwd === undefined ? {} : { configCwd: request.configCwd }),
    harness: null,
    includeCursor: true,
  };
};

const writeStdout = process.stdout.write.bind(process.stdout);
const writeStderr = process.stderr.write.bind(process.stderr);

const withStdoutRedirectedToStderr = async <Result>(run: () => Promise<Result>): Promise<Result> => {
  process.stdout.write = writeStderr as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = writeStdout as typeof process.stdout.write;
  }
};

const request = parseRequest(process.argv[2]);
const result = await withStdoutRedirectedToStderr(() => runKnownLocalProjectSources(request));
process.stdout.write(JSON.stringify(result));
