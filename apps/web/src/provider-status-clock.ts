import { type Accessor, createSignal, onCleanup } from 'solid-js';

const PROVIDER_STATUS_CLOCK_INTERVAL_MS = 60_000;

type ProviderStatusClockValue = Date | string;
type ProviderStatusClockSchedule = (tick: () => void, intervalMs: number) => () => void;

export interface ProviderStatusClockOptions {
  initialNow: ProviderStatusClockValue;
  readNow?: () => ProviderStatusClockValue;
  schedule?: ProviderStatusClockSchedule;
}

export interface ProviderStatusClock {
  now: Accessor<ProviderStatusClockValue>;
  start: () => void;
}

const readSystemNow = (): Date => new Date();

const scheduleWindowInterval: ProviderStatusClockSchedule = (tick, intervalMs) => {
  const interval = window.setInterval(tick, intervalMs);
  return () => window.clearInterval(interval);
};

export const createProviderStatusClock = (options: ProviderStatusClockOptions): ProviderStatusClock => {
  const [now, setNow] = createSignal<ProviderStatusClockValue>(options.initialNow);
  const readNow = options.readNow ?? readSystemNow;
  const schedule = options.schedule ?? scheduleWindowInterval;
  let started = false;

  const start = () => {
    if (started) {
      return;
    }
    started = true;
    const tick = () => setNow(readNow());
    tick();
    const cancel = schedule(tick, PROVIDER_STATUS_CLOCK_INTERVAL_MS);
    onCleanup(() => {
      cancel();
      started = false;
    });
  };

  return { now, start };
};
