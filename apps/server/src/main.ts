import { createPlatformApplicationHandler } from './application';
import { parsePlatformServerConfig } from './config';
import { type PlatformServerDiagnostic, startPlatformServer } from './server';

export type PlatformProcessDiagnostic =
  | { readonly code: 'device-token-key-version-active'; readonly keyVersion: number; readonly operation: 'security' }
  | { readonly code: 'process-ready'; readonly operation: 'startup' }
  | { readonly code: 'process-shutdown'; readonly operation: 'shutdown' }
  | { readonly code: 'process-start-failed'; readonly operation: 'startup' }
  | { readonly code: 'process-stop-failed'; readonly operation: 'shutdown' }
  | Extract<PlatformServerDiagnostic, { readonly code: 'replication-batch' }>
  | { readonly code: 'runtime-event'; readonly operation: 'runtime' };

export interface PlatformProcessDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly onDiagnostic: (diagnostic: PlatformProcessDiagnostic) => void;
}

const writeDiagnostic = (diagnostic: PlatformProcessDiagnostic): void => {
  process.stderr.write(`${JSON.stringify({ component: 'platform-server', ...diagnostic })}\n`);
};

const defaultDependencies: PlatformProcessDependencies = {
  environment: process.env,
  onDiagnostic: writeDiagnostic,
};

export const runPlatformServerProcess = async (
  dependencies: PlatformProcessDependencies = defaultDependencies,
): Promise<void> => {
  try {
    const config = parsePlatformServerConfig(dependencies.environment);
    const server = await startPlatformServer(config, {
      createApplicationHandler: createPlatformApplicationHandler,
      createStore: async (storeConfig) => {
        const { createPlatformStore } = await import('@ai-usage/postgres-store/writer');
        return createPlatformStore(storeConfig);
      },
      onDiagnostic: (diagnostic) => {
        if (diagnostic.code === 'device-token-key-version-active' || diagnostic.code === 'replication-batch') {
          dependencies.onDiagnostic(diagnostic);
          return;
        }
        dependencies.onDiagnostic({ code: 'runtime-event', operation: 'runtime' });
      },
      startHttpServer: ({ fetch, host, port }) => {
        const listener = Bun.serve({ fetch, hostname: host, port });
        return {
          port: listener.port ?? port,
          stop: (force?: boolean) => listener.stop(force),
        };
      },
    });
    dependencies.onDiagnostic({ code: 'process-ready', operation: 'startup' });

    let stopping = false;
    const stop = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      server.close().then(
        () => dependencies.onDiagnostic({ code: 'process-shutdown', operation: 'shutdown' }),
        () => {
          process.exitCode = 1;
          dependencies.onDiagnostic({ code: 'process-stop-failed', operation: 'shutdown' });
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    process.exitCode = 1;
    dependencies.onDiagnostic({ code: 'process-start-failed', operation: 'startup' });
  }
};

if (import.meta.main) {
  await runPlatformServerProcess();
}
