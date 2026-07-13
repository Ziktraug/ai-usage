const LOOPBACK_HOST = '127.0.0.1';

process.env.HOST = LOOPBACK_HOST;
process.env.NITRO_HOST = LOOPBACK_HOST;

await import('./.output/server/index.mjs');
