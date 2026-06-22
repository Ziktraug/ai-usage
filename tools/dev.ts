import path from 'node:path';

// Live dev with working HMR for design-system edits.
//
// The web app consumes the design-system's Panda output through a generated
// `panda.buildinfo.json`, not by scanning its source. So a token or recipe
// edit only reaches the browser via this chain:
//
//   design-system source change
//     -> `turbo watch` rebuilds the design-system (rewrites buildinfo)
//     -> web `panda cssgen --watch` (watching the buildinfo) rewrites styles.css
//     -> Vite HMR swaps the stylesheet
//
// Running the steps as separate watchers — rather than one big rebuild — keeps
// each file write atomic, which is what lets Vite's CSS HMR apply cleanly
// instead of leaving the client unhydrated until a restart.

const root = path.resolve(import.meta.dir, '..');
const web = path.join(root, 'apps', 'web');

// One-shot prep so the very first paint is already correct, mirroring the
// prefix of the old `dev` script.
const prep = Bun.spawn(
  [
    'sh',
    '-c',
    'bun --filter @ai-usage/design-system build && CI=1 panda codegen --silent && CI=1 panda cssgen --silent',
  ],
  { cwd: web, stdio: ['inherit', 'inherit', 'inherit'] },
);
if ((await prep.exited) !== 0) {
  console.error('dev: initial Panda build failed');
  process.exit(1);
}

interface Child {
  name: string;
  proc: Bun.Subprocess;
}

const children: Child[] = [
  {
    name: 'design-system',
    // Rebuild the design-system (and its buildinfo) whenever its source changes.
    proc: Bun.spawn(['bunx', 'turbo', 'watch', '@ai-usage/design-system#build'], {
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
    }),
  },
  {
    name: 'panda',
    // Regenerate styles.css when web source or the buildinfo changes.
    proc: Bun.spawn(['bunx', 'panda', 'cssgen', '--watch', '--silent'], {
      cwd: web,
      env: { ...process.env, CI: '1' },
      stdio: ['inherit', 'inherit', 'inherit'],
    }),
  },
  {
    name: 'vite',
    proc: Bun.spawn(['bunx', 'vite', '--host', '127.0.0.1', '--open'], {
      cwd: web,
      stdio: ['inherit', 'inherit', 'inherit'],
    }),
  },
];

let shuttingDown = false;
const shutdown = (code: number) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    child.proc.kill();
  }
  process.exit(code);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// If any watcher dies, tear the whole dev session down so it never limps along
// with a stale stylesheet pipeline.
await Promise.race(
  children.map(async (child) => {
    const code = await child.proc.exited;
    if (!shuttingDown) {
      console.error(`dev: ${child.name} exited (code ${code}) — shutting down`);
    }
    shutdown(code ?? 1);
  }),
);
