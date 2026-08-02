import { currentRecord } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'X1' as const;

export default defineParityShard({
  owner,
  records: [
    currentRecord(owner, {
      currentOwner: 'apps/web/vite-production-build.ts; apps/web/start.mjs; tools/check-web-production-start.ts',
      evidence: [
        { kind: 'command', reference: 'bun run test:web-production' },
        { kind: 'command', reference: 'bun run test:web-dev-build-isolation' },
        { kind: 'command', reference: 'bun run test:setup-loopback' },
      ],
      id: 'OPS-02',
      kind: 'feature',
    }),
  ],
});
