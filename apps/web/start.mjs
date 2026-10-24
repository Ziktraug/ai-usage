import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_LISTENER_PORT = '3000';
// Bun closes idle keep-alive connections after this many seconds; `@sveltejs/adapter-bun` exempts
// event streams, so source SSE outlives it.
const CONNECTION_IDLE_TIMEOUT_SECONDS = '45';
// Graceful drain before the adapter force-closes open streams; stays inside the production
// supervisor's five-second grace so the shutdown hook still exits the process itself.
const SHUTDOWN_TIMEOUT_SECONDS = '2';

const untrustedAdapterEnvironmentKeys = new Set([
  'ADDRESS_HEADER',
  'BODY_SIZE_LIMIT',
  'DEVELOPMENT',
  'HOST_HEADER',
  'IPV6_ONLY',
  'ORIGIN',
  'PORT_HEADER',
  'PROTOCOL_HEADER',
  'REUSE_PORT',
  'SOCKET_PATH',
  'XFF_DEPTH',
]);

if (typeof Bun === 'undefined') {
  throw new Error('The production web server requires the pinned Bun runtime.');
}

const listenerPort = process.env.PORT ?? DEFAULT_LISTENER_PORT;
const numericListenerPort = Number(listenerPort);
if (
  !(
    Number.isSafeInteger(numericListenerPort) &&
    numericListenerPort > 0 &&
    numericListenerPort <= 65_535 &&
    String(numericListenerPort) === listenerPort
  )
) {
  throw new Error('PORT must be a canonical integer between 1 and 65535.');
}

const rootPackage = await Bun.file(new URL('../../package.json', import.meta.url)).json();
const pinnedBunVersion = rootPackage.packageManager?.match(/^bun@(.+)$/)?.[1];
if (!pinnedBunVersion || Bun.version !== pinnedBunVersion) {
  throw new Error(
    `The production web server requires Bun ${pinnedBunVersion ?? '(missing packageManager pin)'}, received ${Bun.version}.`,
  );
}

for (const key of untrustedAdapterEnvironmentKeys) {
  delete process.env[key];
}
process.env.BODY_SIZE_LIMIT = String(MAX_PORTABLE_USAGE_BYTES);
process.env.CONNECTION_IDLE_TIMEOUT = CONNECTION_IDLE_TIMEOUT_SECONDS;
process.env.HOST = LOOPBACK_HOST;
// Read by the hand-off module `sveltekit-loopback-adapter.ts` puts in front of the adapter. The
// canonical spelling drops a default port (`PORT=80`), as browsers do in `Origin`.
process.env.ORIGIN = new URL(`http://${LOOPBACK_HOST}:${listenerPort}`).origin;
process.env.PORT = listenerPort;
process.env.SHUTDOWN_TIMEOUT = SHUTDOWN_TIMEOUT_SECONDS;

await import('./.output-build/sveltekit/index.js');
