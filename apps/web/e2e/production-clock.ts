const CLOCK_EPOCH_ENVIRONMENT_KEY = 'AI_USAGE_PRODUCTION_E2E_CLOCK_EPOCH';

interface ProductionFixtureClockSources {
  readonly monotonicNow?: () => number;
  readonly systemDate?: DateConstructor;
}

const createProductionFixtureDate = (epoch: string, sources: ProductionFixtureClockSources = {}): DateConstructor => {
  const SystemDate = sources.systemDate ?? Date;
  const monotonicNow = sources.monotonicNow ?? (() => performance.now());
  const monotonicStartedAt = monotonicNow();
  const fixtureStartedAt = SystemDate.parse(epoch);
  if (!(Number.isFinite(fixtureStartedAt) && new SystemDate(fixtureStartedAt).toISOString() === epoch)) {
    throw new Error(`${CLOCK_EPOCH_ENVIRONMENT_KEY} must be a canonical ISO timestamp`);
  }

  const fixtureNow = (): number => fixtureStartedAt + (monotonicNow() - monotonicStartedAt);
  let FixtureDate: DateConstructor;
  FixtureDate = new Proxy(SystemDate, {
    apply: (target) => new target(fixtureNow()).toString(),
    construct: (target, argumentsList, newTarget) =>
      Reflect.construct(
        target,
        argumentsList.length === 0 ? [fixtureNow()] : argumentsList,
        newTarget === FixtureDate ? target : newTarget,
      ),
    get: (target, property, receiver) => (property === 'now' ? fixtureNow : Reflect.get(target, property, receiver)),
  });
  return FixtureDate;
};

const installProductionFixtureClock = (epoch: string): void => {
  globalThis.Date = createProductionFixtureDate(epoch);
};

const fixtureEpoch = process.env[CLOCK_EPOCH_ENVIRONMENT_KEY];
if (fixtureEpoch !== undefined) {
  installProductionFixtureClock(fixtureEpoch);
}

export { CLOCK_EPOCH_ENVIRONMENT_KEY, createProductionFixtureDate, installProductionFixtureClock };
