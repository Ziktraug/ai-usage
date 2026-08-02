import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'R1' as const;
const feature = (id: string, currentOwner: string, test: string) =>
  currentRecord(owner, {
    currentOwner,
    evidence: [
      { kind: 'source', reference: currentOwner },
      { kind: 'test', reference: test },
    ],
    id,
    kind: 'feature',
  });

export default defineParityShard({
  owner,
  records: [
    feature(
      'SHELL-01',
      'apps/web/src/app-navigation.tsx; apps/web/src/routes/__root.tsx',
      'apps/web/e2e/accessibility.spec.ts › shared navigation and deep-scroll cases',
    ),
    feature(
      'SHELL-02',
      'apps/web/src/dashboard-theme.tsx; apps/web/src/routes/__root.tsx',
      'apps/web/e2e/theme.spec.ts; apps/web/e2e/accessibility.spec.ts › focus and reduced motion',
    ),
    feature(
      'SHELL-03',
      'apps/web/src/router.tsx; apps/web/src/routes/index.tsx',
      'apps/web/e2e/dashboard.spec.ts › retries a failed report through the Router loading lifecycle',
    ),
    feature(
      'PRIVACY-01',
      'apps/web/src/server/demo-boundary.server.ts; apps/web/src/demo-route-guard.ts',
      'apps/web/e2e/demo-privacy.spec.ts › serves only the synthetic report and keeps every local boundary inert',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/app-navigation.tsx',
      'apps/web/src/dashboard-theme.tsx',
      'apps/web/src/router.tsx',
      'apps/web/src/routes/__root.tsx',
    ]),
  ],
});
