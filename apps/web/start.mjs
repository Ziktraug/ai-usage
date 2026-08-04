import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_LISTENER_PORT = '3000';

const untrustedAdapterEnvironmentKeys = new Set([
  'ADDRESS_HEADER',
  'BODY_SIZE_LIMIT',
  'HOST_HEADER',
  'ORIGIN',
  'PORT_HEADER',
  'PROTOCOL_HEADER',
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

for (const key of Object.keys(process.env)) {
  if (key.startsWith('NITRO_') || untrustedAdapterEnvironmentKeys.has(key)) {
    delete process.env[key];
  }
}
process.env.BODY_SIZE_LIMIT = String(MAX_PORTABLE_USAGE_BYTES);
process.env.HOST = LOOPBACK_HOST;
process.env.IDLE_TIMEOUT = '45';
process.env.ORIGIN = `http://${LOOPBACK_HOST}:${listenerPort}`;
process.env.PORT = listenerPort;

await import('./.output-build/sveltekit/index.js');
