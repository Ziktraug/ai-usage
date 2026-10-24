import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_LISTENER_PORT = '3000';
// Bun closes idle keep-alive connections after this many seconds; `@sveltejs/adapter-bun` exempts
// event streams, so source SSE outlives it.
const CONNECTION_IDLE_TIMEOUT_SECONDS = '45';
// Graceful drain before the adapter force-closes open streams; stays inside the production
// supervisor's five-second grace so the shutdown hook still exits the process itself.
const SHUTDOWN_TIMEOUT_SECONDS = '2';
// The adapter reads its configuration only under this prefix (`envPrefix` in
// `sveltekit-loopback-adapter.ts`, whose test pins this copy), so inherited variables under its
// unprefixed names (`HOST`, `SOCKET_PATH`, `ADDRESS_HEADER`, ...) never configure the server.
const ADAPTER_ENVIRONMENT_PREFIX = 'AI_USAGE_WEB_ADAPTER_';

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

// This entry owns the prefixed namespace: an inherited prefixed variable is removed rather than
// passed on (the adapter also refuses to start on a prefixed name it does not read), and only the
// values below are set.
for (const key of Object.keys(process.env)) {
  if (key.startsWith(ADAPTER_ENVIRONMENT_PREFIX)) {
    delete process.env[key];
  }
}
const adapterEnvironment = {
  BODY_SIZE_LIMIT: String(MAX_PORTABLE_USAGE_BYTES),
  CONNECTION_IDLE_TIMEOUT: CONNECTION_IDLE_TIMEOUT_SECONDS,
  HOST: LOOPBACK_HOST,
  PORT: listenerPort,
  SHUTDOWN_TIMEOUT: SHUTDOWN_TIMEOUT_SECONDS,
};
for (const [key, value] of Object.entries(adapterEnvironment)) {
  process.env[`${ADAPTER_ENVIRONMENT_PREFIX}${key}`] = value;
}
// Read by the hand-off module `sveltekit-loopback-adapter.ts` puts in front of the adapter, never
// by the adapter itself, so it stays unprefixed; an inherited value is overwritten here. The
// canonical spelling drops a default port (`PORT=80`), as browsers do in `Origin`.
process.env.ORIGIN = new URL(`http://${LOOPBACK_HOST}:${listenerPort}`).origin;

await import('./.output-build/sveltekit/index.js');
