import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryServiceClient } from '@ai-usage/memory-service/client';
import {
  type DistillationDiscoveryRequest,
  parseDistillationDiscoveryRequest,
} from '@ai-usage/platform-core/distillation-discovery';
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
projects [--limit 50] [--cursor CURSOR]                         mapped local Projects
discover [--checkout PATH | --project ID-OR-EXACT-NAME]
         [--since ISO-INSTANT] [--until ISO-INSTANT] [--limit 10]
         (defaults to the current checkout; metadata only)
prepare --selection TOKEN [--row ROW ...] --authorize-provider-processing
        [--producer-session ID] [--revision-key KEY]
prepare --project ID --revision REV --row ROW [--row ROW ...]
        --authorize-provider-processing [--producer-session ID] [--revision-key KEY]
claim   --project ID --job JOB
segment --project ID --job JOB --snapshot DIGEST --segment INDEX
submit  --file SUBMISSION.json
status  --revision REV --row ROW
get     --project ID --id ANALYSIS [--episode EPISODE]
evidence --project ID --id ANALYSIS --event EVENT [--event EVENT ...]
search  --project ID --query TEXT [--mode literal|task] [--limit 10]
context --project ID --query TEXT [--mode literal|task] [--max-bytes 16384]
jobs    --project ID [--limit 50] [--cursor CURSOR]
history --project ID --id ANALYSIS [--limit 20] [--cursor CURSOR]
browse  [--project ID] [--since ISO-INSTANT] [--until ISO-INSTANT]
        [--query TEXT] [--limit 20] [--cursor CURSOR]
cancel  --project ID --job JOB
retry   --project ID --job JOB
cleanup --project ID --before ISO-INSTANT
removal-preview --project ID --id ANALYSIS
remove --project ID --id ANALYSIS --mode withdraw|purge --confirm --preserve-knowledge

All output is JSON. Discovery returns a copyable prepareCommand for its exact selection.
Stale selections fail closed; discover again explicitly to choose a fresh selection.
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
  | { kind: 'request'; request: DistillationRequest | DistillationDiscoveryRequest; episodeId: string | null };

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
    const value = ['--authorize-provider-processing', '--confirm', '--preserve-knowledge'].includes(key)
      ? 'true'
      : rest.shift();
    if (!value || value.startsWith('--')) {
      throw new DistillationError('missing-cli-value');
    }
    if (key !== '--row' && key !== '--event' && values.has(key)) {
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
  const discovery = (request: unknown) =>
    finish({ kind: 'request' as const, request: parseDistillationDiscoveryRequest(request), episodeId: null });
  if (command === 'projects') {
    return discovery({ kind: command, limit: Number(take('--limit', '50')), cursor: take('--cursor', '') || null });
  }
  if (command === 'discover') {
    const project = take('--project', '');
    const checkout = take('--checkout', '');
    if (project && checkout) {
      throw new DistillationError('ambiguous-cli-selector');
    }
    return discovery({
      kind: command,
      selector: project
        ? { kind: 'project', value: project }
        : { kind: 'checkout', value: path.resolve(checkout || process.cwd()) },
      since: take('--since', '') || null,
      until: take('--until', '') || null,
      limit: Number(take('--limit', '10')),
    });
  }
  if (command === 'prepare' && values.has('--selection')) {
    const chosenRowIds = values.get('--row');
    values.delete('--row');
    return discovery({
      kind: 'prepare-selection',
      selectionToken: take('--selection'),
      providerProcessingAuthorized: take('--authorize-provider-processing') === 'true',
      producerSessionId: take('--producer-session', '') || null,
      revisionKey: take('--revision-key', '') || null,
      ...(chosenRowIds ? { chosenRowIds } : {}),
    });
  }
  if (command === 'browse') {
    return discovery({
      kind: command,
      projectId: take('--project', '') || null,
      since: take('--since', '') || null,
      until: take('--until', '') || null,
      query: take('--query', ''),
      limit: Number(take('--limit', '20')),
      cursor: take('--cursor', '') || null,
    });
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
  if (command === 'history') {
    return discovery({
      kind: command,
      projectId,
      analysisId: take('--id'),
      limit: Number(take('--limit', '20')),
      cursor: take('--cursor', '') || null,
    });
  }
  if (command === 'jobs') {
    return discovery({
      kind: command,
      projectId,
      limit: Number(take('--limit', '50')),
      cursor: take('--cursor', '') || null,
    });
  }
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
  } else if (command === 'segment') {
    request = {
      kind: command,
      projectId,
      jobId: take('--job'),
      snapshotDigest: take('--snapshot'),
      segmentIndex: Number(take('--segment')),
    };
  } else if (command === 'get') {
    request = { kind: command, projectId, analysisId: take('--id') };
    episodeId = take('--episode', '') || null;
  } else if (command === 'evidence') {
    const eventIds = values.get('--event') ?? [];
    values.delete('--event');
    if (!eventIds.length || new Set(eventIds).size !== eventIds.length) {
      throw new DistillationError('invalid-evidence-selection');
    }
    request = { kind: command, projectId, analysisId: take('--id'), eventIds };
  } else if (command === 'search') {
    request = {
      kind: command,
      projectId,
      query: take('--query'),
      limit: Number(take('--limit', '10')),
      ...(values.has('--mode') ? { mode: take('--mode') } : {}),
    };
  } else if (command === 'context') {
    request = {
      kind: command,
      projectId,
      query: take('--query'),
      maxBytes: Number(take('--max-bytes', '16384')),
      ...(values.has('--mode') ? { mode: take('--mode') } : {}),
    };
  } else if (command === 'cleanup') {
    request = { kind: command, projectId, before: take('--before') };
  } else if (command === 'removal-preview') {
    request = { kind: command, projectId, analysisId: take('--id') };
  } else if (command === 'remove') {
    request = {
      kind: command,
      projectId,
      analysisId: take('--id'),
      mode: take('--mode'),
      confirmed: take('--confirm') === 'true',
      preserveKnowledge: take('--preserve-knowledge') === 'true',
    };
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
    if (request.kind !== 'submit' && request.kind !== 'advance') {
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
  let request = command.kind === 'submit-file' ? await readSubmission(command.file) : command.request;
  if (request.kind === 'evidence') {
    const analysis = parseSessionAnalysis(
      await client.distillation(
        {
          kind: 'get',
          ...('projectId' in request ? { projectId: request.projectId } : { selection: request.selection }),
          analysisId: request.analysisId,
        },
        signal ? { signal } : undefined,
      ),
    );
    request = {
      ...request,
      identity: { packetDigest: analysis.packetDigest, sourceDigest: analysis.source.version.digest },
    };
  }
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
