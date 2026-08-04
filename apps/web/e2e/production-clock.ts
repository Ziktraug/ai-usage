const CLOCK_EPOCH_ENVIRONMENT_KEY = 'AI_USAGE_PRODUCTION_E2E_CLOCK_EPOCH';

const installProductionFixtureClock = (epoch: string): void => {
  const SystemDate = Date;
  const systemNow = SystemDate.now.bind(SystemDate);
  const systemStartedAt = systemNow();
  const fixtureStartedAt = SystemDate.parse(epoch);
  if (!Number.isFinite(fixtureStartedAt)) {
    throw new Error(`${CLOCK_EPOCH_ENVIRONMENT_KEY} must be an ISO timestamp`);
  }

  const fixtureNow = (): number => fixtureStartedAt + (systemNow() - systemStartedAt);
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
  globalThis.Date = FixtureDate;
};

const fixtureEpoch = process.env[CLOCK_EPOCH_ENVIRONMENT_KEY];
if (fixtureEpoch !== undefined) {
  installProductionFixtureClock(fixtureEpoch);
}

export { CLOCK_EPOCH_ENVIRONMENT_KEY, installProductionFixtureClock };
