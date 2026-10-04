import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { MemoryServiceClient } from '@ai-usage/memory-service/client';
import {
  DistillationError,
  type DistillationRequest,
  distillationBounds,
  parseDistillationRequest,
  parseSessionAnalysis,
} from '@ai-usage/platform-core/session-distillation';

export const analysesHelp = `Usage: ai-usage analyses <command> [options]

Local generated analyses are a distinct corpus from accepted Memory.
Requires an already running local usage engine; no provider is launched.

select  --project ID --revision REV --row ROW [--row ROW ...]   metadata dry-run
prepare --project ID --revision REV --row ROW [--row ROW ...]
        --authorize-provider-processing [--producer-session ID] [--revision-key KEY]
claim   --project ID --job JOB
submit  --file SUBMISSION.json
status  --revision REV --row ROW
get     --project ID --id ANALYSIS [--episode EPISODE]
search  --project ID --query TEXT [--limit 10]
context --project ID --query TEXT [--max-bytes 16384]
cancel  --project ID --job JOB
retry   --project ID --job JOB
cleanup --project ID --before ISO-INSTANT

All output is JSON. Selection uses exact usage row IDs and a retained report revision.
Preparation requires permission for both local reading and active-provider processing.
One active lease, at most 10 selected sessions, 3 attempts/job, 15-minute leases.
Reusing the same packet/revision key resumes its job. A new explicit revision key
permits another interpretation; old analysis revisions remain readable.
Context's UTF-8 byte bound includes its JSON envelope; omissions are reported.
Cleanup removes only terminal job packets, preserving analyses and native history.
`;

export type AnalysesCommand =
  | { kind: 'help' }
  | { kind: 'submit-file'; file: string }
  | { kind: 'request'; request: DistillationRequest; episodeId: string | null };

export const parseAnalysesCommand = (args: readonly string[]): AnalysesCommand => {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') {
    return { kind: 'help' };
  }
  const values = new Map<string, string[]>();
  while (rest.length > 0) {
    const key = rest.shift();
    if (!key?.startsWith('--')) {
      throw new DistillationError('invalid-cli-argument');
    }
    const value = key === '--authorize-provider-processing' ? 'true' : rest.shift();
    if (!value || value.startsWith('--')) {
      throw new DistillationError('missing-cli-value');
    }
    if (key !== '--row' && values.has(key)) {
      throw new DistillationError('duplicate-cli-option');
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const take = (key: string, fallback?: string): string => {
    const value = values.get(key)?.[0] ?? fallback;
    values.delete(key);
    if (value === undefined) {
      throw new DistillationError(`missing-${key.slice(2)}`);
    }
    return value;
  };
  const finish = <T extends AnalysesCommand>(result: T): T => {
    if (values.size) {
      throw new DistillationError('unknown-cli-option');
    }
    return result;
  };
  if (command === 'submit') {
    return finish({ kind: 'submit-file', file: take('--file') });
  }
  if (command === 'status') {
    return finish({
      kind: 'request',
      request: parseDistillationRequest({
        kind: 'status',
        selection: { revision: take('--revision'), rowId: take('--row') },
      }),
      episodeId: null,
    });
  }
  const projectId = take('--project');
  let request: unknown;
  let episodeId: string | null = null;
  if (command === 'select' || command === 'prepare') {
    const revision = take('--revision');
    const rows = values.get('--row') ?? [];
    values.delete('--row');
    request = {
      kind: command,
      projectId,
      selections: rows.map((rowId) => ({ revision, rowId })),
      ...(command === 'prepare'
        ? {
            providerProcessingAuthorized: take('--authorize-provider-processing') === 'true',
            producerSessionId: take('--producer-session', '') || null,
            revisionKey: take('--revision-key', '') || null,
          }
        : {}),
    };
  } else if (command === 'claim' || command === 'cancel' || command === 'retry') {
    request = { kind: command, projectId, jobId: take('--job') };
  } else if (command === 'get') {
    request = { kind: command, projectId, analysisId: take('--id') };
    episodeId = take('--episode', '') || null;
  } else if (command === 'search') {
    request = { kind: command, projectId, query: take('--query'), limit: Number(take('--limit', '10')) };
  } else if (command === 'context') {
    request = { kind: command, projectId, query: take('--query'), maxBytes: Number(take('--max-bytes', '16384')) };
  } else if (command === 'cleanup') {
    request = { kind: command, projectId, before: take('--before') };
  } else {
    throw new DistillationError('unknown-cli-command');
  }
  return finish({ kind: 'request', request: parseDistillationRequest(request), episodeId });
};

const readSubmission = async (file: string): Promise<DistillationRequest> => {
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags reject symlink submissions.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > distillationBounds.requestBytes) {
      throw new DistillationError('submission-file-too-large');
    }
    const buffer = Buffer.alloc(distillationBounds.requestBytes + 1);
    const { bytesRead } = await handle.read(buffer);
    if (bytesRead > distillationBounds.requestBytes) {
      throw new DistillationError('submission-file-too-large');
    }
    const request = parseDistillationRequest(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))),
    );
    if (request.kind !== 'submit') {
      throw new DistillationError('expected-submission');
    }
    return request;
  } finally {
    await handle.close();
  }
};

export const executeAnalysesCommand = async (
  command: AnalysesCommand,
  client: Pick<MemoryServiceClient, 'distillation'>,
  signal?: AbortSignal,
): Promise<string> => {
  if (command.kind === 'help') {
    return analysesHelp;
  }
  const request = command.kind === 'submit-file' ? await readSubmission(command.file) : command.request;
  const result = await client.distillation(request, signal ? { signal } : undefined);
  if (command.kind === 'request' && command.episodeId !== null) {
    const analysis = parseSessionAnalysis(result);
    const episode = analysis.content.episodes.find((item) => item.id === command.episodeId);
    if (!episode) {
      throw new DistillationError('episode-not-found');
    }
    return JSON.stringify({
      ...analysis,
      content: { ...analysis.content, episodes: [episode] },
      omittedEpisodes: analysis.content.episodes.length - 1,
    });
  }
  return JSON.stringify(result);
};
