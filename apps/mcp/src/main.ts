#!/usr/bin/env bun
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createUsageMcpServer,
  type DelegationMcpPort,
  type DelegationMcpResult,
  type WorkContextMcpReadService,
} from '@ai-usage/mcp-adapter';
import { connectMcpStdio } from '@ai-usage/mcp-adapter/stdio';
import { parseDelegationEvaluationInput, summarizeDelegationJobView } from '@ai-usage/report-core/delegation-job';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import {
  type DelegationRequestIssue,
  parseDelegationRequest,
  parseDelegationSelection,
} from '@ai-usage/report-core/delegation-request';
import { DELEGATION_DEPTH_ENVIRONMENT_KEY } from '@ai-usage/report-core/delegation-vocabulary';
import {
  type DelegationReadResult,
  listDelegationJobViews,
  readDelegationJobView,
} from '@ai-usage/report-data/delegation-read';
import { readWorkContext } from '@ai-usage/report-data/work-context-read';
import {
  connectDelegationEngine,
  createDelegationCommands,
  type DelegationOperationResult,
} from '@ai-usage/usage-engine-control/delegation-operations';
import { resolveUsageRuntimePaths } from '@ai-usage/usage-engine-control/node';
import { USAGE_STORE_SCHEMA_VERSION, usageStorePath } from '@ai-usage/usage-store/reader';

export interface McpProcessDependencies {
  readonly connect: typeof connectMcpStdio;
  /** The engine connection the delegation port uses; the default finds the running daemon. */
  readonly connectDelegationEngine?: typeof connectDelegationEngine;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** The AI Usage checkout this server belongs to; defaults to the one containing this file. */
  readonly installationRoot?: string;
}

const defaultDependencies: McpProcessDependencies = {
  connect: connectMcpStdio,
  cwd: process.cwd(),
  environment: process.env,
};

/** The AI Usage checkout this server file belongs to: `apps/mcp/src/main.ts` is three levels below it. */
export const mcpInstallationRoot = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The config root the engine identifies itself with (its rendezvous target is the database path and
 * this root): `AI_USAGE_ROOT_DIR` when the engine runs with it, else the AI Usage installation. An
 * MCP client starts this server in its own project directory, so the caller's cwd is never used.
 */
export const delegationConfigCwd = (environment: NodeJS.ProcessEnv, installationRoot: string): string => {
  const root = environment.AI_USAGE_ROOT_DIR ?? installationRoot;
  if (!path.isAbsolute(root)) {
    throw new Error('Usage config root must be an absolute path.');
  }
  return path.resolve(root);
};

/**
 * `work.context` over the usage store the CLI and the web read (`AI_USAGE_DATABASE_PATH`, else the
 * home store), through `report-data`'s read-only connection (ADR 0058). The store is opened per
 * call and never created; only the failure code crosses the MCP edge.
 */
export const createLocalWorkContextMcpReadService = (dbPath: string): WorkContextMcpReadService => ({
  readWorkContext: async (scope, signal, options) => {
    const result = await readWorkContext({ dbPath, scope, signal, ...options });
    return result.kind === 'success'
      ? { kind: 'success', value: result.value }
      : { code: result.failure.code, kind: 'error' };
  },
});

export interface LocalDelegationMcpPortOptions {
  readonly configCwd: string;
  readonly connect?: typeof connectDelegationEngine;
  readonly databasePath: string;
  /** The instant job views measure heartbeat ages against; defaults to the read time. */
  readonly now?: () => string;
  readonly rendezvousPath: string;
}

const engineResult = <Value>(result: DelegationOperationResult<Value>): DelegationMcpResult<Value> =>
  result.kind === 'success' ? result : { code: result.code, kind: 'error' };

const readResult = <Value>(result: DelegationReadResult<Value>): DelegationMcpResult<Value> =>
  result.kind === 'success' ? result : { code: result.failure.code, kind: 'error' };

/** Issue locations with the parser's fixed reasons; a value is never echoed. */
const locatedIssues = (argument: string, issues: readonly DelegationRequestIssue[]): string[] =>
  issues.map(({ path: where, reason }) => `${where === '' ? argument : `${argument}.${where}`} (${reason})`);

const invalidInput = (issues: readonly string[]): DelegationMcpResult<never> => ({
  code: 'invalid-input',
  issues,
  kind: 'error',
});

/**
 * The delegation port of the local server (ADR 0077). Every payload the adapter's schema admitted
 * is parsed again, strictly, with the report-core parsers before anything else looks at it: an
 * invalid one answers `invalid-input` with its issue paths, a reserved action or scope answers the
 * typed refusal. Qualify, start, cancel and evaluate go to the running engine through its control
 * plane, found again on every call so an engine that starts or stops between calls is seen as it
 * is; status and list read the store through `report-data`'s query-only connection and answer while
 * the engine is down. This process never spawns an engine or a worker and never opens the store
 * writable.
 */
export const createLocalDelegationMcpPort = (options: LocalDelegationMcpPortOptions): DelegationMcpPort => {
  const connect = options.connect ?? connectDelegationEngine;
  const now = options.now ?? (() => new Date().toISOString());
  const { configCwd, databasePath, rendezvousPath } = options;
  const commands = createDelegationCommands({
    execute: async (command, signal) => {
      const execute = await connect({
        configCwd,
        expectedStoreSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
        runtimePaths: { databasePath, rendezvousPath },
        ...(signal === undefined ? {} : { signal }),
      });
      return await execute(command, signal);
    },
  });
  return {
    cancel: async (jobId, signal) => engineResult(await commands.cancel(jobId, signal)),
    evaluate: async (input, signal) => {
      const parsed = parseDelegationEvaluationInput(input.evaluation, {
        author: input.author,
        authorLabel: input.authorLabel,
      });
      if (parsed.kind === 'invalid') {
        return invalidInput(parsed.issues);
      }
      return engineResult(
        await commands.evaluate(
          {
            author: input.author,
            authorLabel: input.authorLabel,
            evaluation: { ...input.evaluation },
            jobId: input.jobId,
          },
          signal,
        ),
      );
    },
    list: async (input, signal) => {
      const listed = await listDelegationJobViews({
        dbPath: databasePath,
        limit: input.limit,
        liveOnly: input.liveOnly,
        now: now(),
        signal,
      });
      if (listed.kind !== 'success') {
        return { code: listed.failure.code, kind: 'error' };
      }
      // One compact summary per job, every one the read answered: the adapter keeps as many as fit
      // its response bound and counts the rest in `omitted`. The full view (findings, evidence,
      // evaluations, notes) is read one job at a time with `status`.
      return {
        kind: 'success',
        value: {
          jobs: listed.value.jobs.map(summarizeDelegationJobView),
          skipped: listed.value.skipped,
          truncated: listed.value.truncated,
        },
      };
    },
    qualify: async (request, signal) => {
      const parsed = parseDelegationRequest(request);
      if (parsed.kind === 'invalid') {
        return invalidInput(locatedIssues('request', parsed.issues));
      }
      if (parsed.kind === 'unsupported') {
        return {
          kind: 'success',
          value: { qualification: null, refusal: { message: parsed.message, reason: parsed.reason } },
        };
      }
      const result = await commands.qualify(parsed.request, 'delegation', signal);
      if (result.kind === 'error') {
        return result;
      }
      // The control plane typed the envelope; the full qualification is trusted only once parsed.
      const qualification = parseDelegationQualification(result.value);
      return qualification === null
        ? { code: 'unavailable', kind: 'error' }
        : { kind: 'success', value: { qualification, refusal: qualification.refusal } };
    },
    start: async (input, signal) => {
      const request = parseDelegationRequest(input.request);
      const selection = parseDelegationSelection(input.selection);
      const issues = [
        ...(request.kind === 'invalid' ? locatedIssues('request', request.issues) : []),
        ...(selection.kind === 'invalid' ? locatedIssues('selection', selection.issues) : []),
      ];
      if (request.kind === 'invalid' || selection.kind === 'invalid') {
        return invalidInput(issues);
      }
      if (request.kind === 'unsupported') {
        return { kind: 'success', value: { job: null, refusal: { message: request.message, reason: request.reason } } };
      }
      return engineResult(
        await commands.start(
          { idempotencyKey: input.idempotencyKey, request: request.request, selection: selection.selection },
          signal,
        ),
      );
    },
    status: async (jobId, signal) =>
      readResult(await readDelegationJobView({ dbPath: databasePath, jobId, now: now(), signal })),
  };
};

/**
 * The local MCP process: `work.context` and the delegation tools over stdio. Every tool opens what
 * it needs per call (the read-only store, or the engine's control plane), so starting the server
 * opens no store and contacts no engine.
 */
export const runMcpProcess = async (dependencies: McpProcessDependencies = defaultDependencies): Promise<void> => {
  const runtimePaths = resolveUsageRuntimePaths({
    cwd: dependencies.cwd,
    databasePathForHome: usageStorePath,
    env: dependencies.environment,
  });
  const server = createUsageMcpServer({
    delegation: {
      port: createLocalDelegationMcpPort({
        configCwd: delegationConfigCwd(
          dependencies.environment,
          dependencies.installationRoot ?? mcpInstallationRoot(),
        ),
        ...(dependencies.connectDelegationEngine === undefined
          ? {}
          : { connect: dependencies.connectDelegationEngine }),
        databasePath: runtimePaths.databasePath,
        rendezvousPath: runtimePaths.rendezvousPath,
      }),
      // A delegated worker never delegates: every worker runs with the depth variable set.
      recursionGuard: DELEGATION_DEPTH_ENVIRONMENT_KEY in dependencies.environment,
    },
    work: createLocalWorkContextMcpReadService(runtimePaths.databasePath),
  });
  await dependencies.connect(server);
};

if (import.meta.main) {
  try {
    await runMcpProcess();
  } catch {
    process.stderr.write('ai-usage MCP failed to start.\n');
    process.exitCode = 1;
  }
}
