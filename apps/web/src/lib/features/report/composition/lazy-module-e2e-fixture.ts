export const REPORT_LAZY_MODULE_E2E_FAILURE_KEY = '__aiUsageE2ELazyReportModuleFailure';

export type ReportLazyModuleTarget = 'breakdown' | 'sessions';

export const importReportLazyModule = async <Module>({
  enabled,
  importModule,
  target,
}: {
  readonly enabled: boolean;
  readonly importModule: () => Promise<Module>;
  readonly target: ReportLazyModuleTarget;
}): Promise<Module> => {
  if (enabled && Reflect.get(globalThis, REPORT_LAZY_MODULE_E2E_FAILURE_KEY) === target) {
    Reflect.deleteProperty(globalThis, REPORT_LAZY_MODULE_E2E_FAILURE_KEY);
    throw new Error(`Expected ${target} module failure`);
  }
  return await importModule();
};
