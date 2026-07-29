import { afterAll, describe, expect, test } from 'bun:test';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import type { SyncFleetMachineView } from './manual-transfer-model';

interface ComparisonRow {
  current: boolean;
  freshness: 'fresh' | 'stale' | 'unavailable';
  freshnessLabel: string;
  id: string;
  label: string;
  newestSessionAt: string | null;
  newestSessionLabel: string;
  sessionCount: number;
  sessionShareLabel: string;
  sessionSharePercent: number;
}

interface MachineFleetComparisonProps {
  rows: readonly ComparisonRow[];
}

interface MachineFleetPanelProps {
  machines: readonly SyncFleetMachineView[];
  omittedMachines: number;
  skipped: number;
}

const COLUMN_HEADERS = ['Machine', 'Sessions', 'Fleet share', 'Newest session', 'Freshness', 'Current'] as const;

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loaded: unknown = await viteServer.ssrLoadModule('/src/sync-machine-comparison.tsx');
if (
  !(
    loaded &&
    typeof loaded === 'object' &&
    'MachineFleetComparison' in loaded &&
    typeof loaded.MachineFleetComparison === 'function'
  )
) {
  throw new Error('Vite did not load MachineFleetComparison');
}
const MachineFleetComparison = loaded.MachineFleetComparison as Component<MachineFleetComparisonProps>;

const loadedFleet: unknown = await viteServer.ssrLoadModule('/src/sync-machine-fleet.tsx');
if (
  !(
    loadedFleet &&
    typeof loadedFleet === 'object' &&
    'MachineFleetPanel' in loadedFleet &&
    typeof loadedFleet.MachineFleetPanel === 'function'
  )
) {
  throw new Error('Vite did not load MachineFleetPanel');
}
const MachineFleetPanel = loadedFleet.MachineFleetPanel as Component<MachineFleetPanelProps>;

afterAll(async () => viteServer.close());

const renderComparison = (rows: readonly ComparisonRow[]): string =>
  renderToString(() => createComponent(MachineFleetComparison, { rows }));

const rows: readonly ComparisonRow[] = [
  {
    current: true,
    freshness: 'fresh',
    freshnessLabel: 'Fresh · 1h ago',
    id: 'current',
    label: 'Shared label',
    newestSessionAt: '2026-07-05T11:00:00.000Z',
    newestSessionLabel: '1h ago',
    sessionCount: 4,
    sessionShareLabel: '40%',
    sessionSharePercent: 40,
  },
  {
    current: false,
    freshness: 'stale',
    freshnessLabel: 'Stale · 34d ago',
    id: 'peer-stale',
    label: 'Shared label',
    newestSessionAt: '2026-05-31T12:00:00.000Z',
    newestSessionLabel: '35d ago',
    sessionCount: 3,
    sessionShareLabel: '30%',
    sessionSharePercent: 30,
  },
  {
    current: false,
    freshness: 'unavailable',
    freshnessLabel: 'Freshness unavailable',
    id: 'peer-unknown',
    label: 'Peer unknown',
    newestSessionAt: null,
    newestSessionLabel: 'No activity recorded',
    sessionCount: 3,
    sessionShareLabel: '30%',
    sessionSharePercent: 30,
  },
];

describe('MachineFleetComparison', () => {
  test('renders accessible desktop headers and equivalent mobile summaries for every freshness state', () => {
    const html = renderComparison(rows);

    expect(html).toContain('<table aria-labelledby="machine-contribution-title"');
    for (const columnHeader of COLUMN_HEADERS) {
      expect(html).toContain(`scope="col">${columnHeader}</th>`);
    }
    expect(html).toContain('aria-label="Machine contribution summaries"');
    expect(html).toContain('data-machine-id="current"');
    expect(html).toContain('data-machine-id="peer-stale"');
    expect(html).toContain('Fresh · 1h ago');
    expect(html).toContain('Stale · 34d ago');
    expect(html).toContain('Freshness unavailable');
    expect(html).toContain('>Yes<');
    expect(html).toContain('>No<');
  });
});

const fleetMachines: readonly SyncFleetMachineView[] = [
  {
    current: true,
    hasLocalObservedRows: true,
    hasPortableRows: false,
    id: 'current',
    label: 'Current',
    lastSeenAt: '2026-07-05T11:00:00.000Z',
    newestSessionAt: '2026-07-05T11:00:00.000Z',
    sessionCount: 4,
    stale: false,
  },
  {
    current: false,
    hasLocalObservedRows: false,
    hasPortableRows: true,
    id: 'stale-peer',
    label: 'Stale peer',
    lastSeenAt: '2026-06-01T12:00:00.000Z',
    newestSessionAt: '2026-05-31T12:00:00.000Z',
    sessionCount: 3,
    stale: true,
  },
];

describe('MachineFleetPanel', () => {
  test('retains every machine and discloses only immutable invalid-row and stale guidance', () => {
    const html = renderToString(() =>
      createComponent(MachineFleetPanel, {
        machines: fleetMachines,
        omittedMachines: 0,
        skipped: 2,
      }),
    );

    expect(html.split('data-machine-stale=').length - 1).toBe(fleetMachines.length);
    expect(html).toContain('Current');
    expect(html).toContain('Stale peer');
    expect(html).toContain('2 invalid stored rows were excluded from fleet metadata.');
    expect(html).toContain('Rows failed stored-row validation; details were not retained.');
    expect(html.split('data-stale-machine-guidance').length - 1).toBe(1);
    expect(html).toContain('30-day freshness window');
    expect(html).toContain('bun run cli -- snapshot --out &lt;path>');
    expect(html).not.toContain('/home/');
  });
});
