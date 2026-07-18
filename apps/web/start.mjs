const LOOPBACK_HOST = '127.0.0.1';

if (typeof Bun === 'undefined') {
  throw new Error('The production web server requires the pinned Bun runtime.');
}

const rootPackage = await Bun.file(new URL('../../package.json', import.meta.url)).json();
const pinnedBunVersion = rootPackage.packageManager?.match(/^bun@(.+)$/)?.[1];
if (!pinnedBunVersion || Bun.version !== pinnedBunVersion) {
  throw new Error(
    `The production web server requires Bun ${pinnedBunVersion ?? '(missing packageManager pin)'}, received ${Bun.version}.`,
  );
}

process.env.HOST = LOOPBACK_HOST;
process.env.NITRO_HOST = LOOPBACK_HOST;

await import('./.output/server/index.mjs');
