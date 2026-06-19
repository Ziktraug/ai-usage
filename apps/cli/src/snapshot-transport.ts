import fs from 'node:fs';
import { parseUsageSnapshot, type UsageSnapshot } from '@ai-usage/core/snapshot';
import { Effect } from 'effect';
import { CliArgumentError } from './errors';

const fileError = (operation: string, filePath: string) => (cause: unknown) =>
  new CliArgumentError({
    message: `${operation} ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const readFile = (filePath: string) =>
  Effect.try({
    try: () => fs.readFileSync(filePath, 'utf8'),
    catch: fileError('readFile', filePath),
  });

export const readSnapshotFile = (filePath: string): Effect.Effect<UsageSnapshot, CliArgumentError> =>
  readFile(filePath).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => parseUsageSnapshot(text),
        catch: fileError('parseSnapshot', filePath),
      }),
    ),
  );

export const fetchRemoteSnapshot = (
  url: string,
  token: string | null,
): Effect.Effect<UsageSnapshot, CliArgumentError> =>
  Effect.gen(function* () {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { headers }),
      catch: (cause) =>
        new CliArgumentError({ message: `fetch ${url}: ${cause instanceof Error ? cause.message : String(cause)}` }),
    });
    if (!response.ok) {
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new CliArgumentError({ message: `read ${url}: ${cause instanceof Error ? cause.message : String(cause)}` }),
      });
      return yield* Effect.fail(new CliArgumentError({ message: `fetch ${url}: HTTP ${response.status} ${body}` }));
    }
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new CliArgumentError({ message: `read ${url}: ${cause instanceof Error ? cause.message : String(cause)}` }),
    });
    return yield* Effect.try({
      try: () => parseUsageSnapshot(text),
      catch: (cause) =>
        new CliArgumentError({ message: `parse ${url}: ${cause instanceof Error ? cause.message : String(cause)}` }),
    });
  });
