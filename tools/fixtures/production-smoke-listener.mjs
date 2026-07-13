import { createServer } from 'node:http';

const port = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isSafeInteger(port) || port <= 0) {
  throw new Error('PORT must be a positive integer.');
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('fixture-ready');
});

const close = () => {
  server.close(() => process.exit(0));
};

process.on('SIGTERM', close);
process.on('SIGINT', close);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('listening\n');
  process.stderr.write('fixture diagnostic\n');
});
