export interface ExportFile {
  readonly csv: string;
  readonly filename: string;
}

export interface SharingEnvironment {
  readonly copyText: (text: string) => Promise<void>;
  readonly currentUrl: () => string;
  readonly download: (file: ExportFile) => Promise<void> | void;
}

export interface SharingNotice {
  readonly message: string;
  readonly tone: 'error' | 'success';
}

export const copyExactBreakdownUrl = async (environment: SharingEnvironment): Promise<SharingNotice> => {
  try {
    await environment.copyText(environment.currentUrl());
    return { message: 'Link copied', tone: 'success' };
  } catch {
    return { message: 'Could not copy link', tone: 'error' };
  }
};

export const exportVisibleBreakdown = async (
  createExport: () => Promise<ExportFile>,
  environment: SharingEnvironment,
): Promise<SharingNotice> => {
  try {
    await environment.download(await createExport());
    return { message: 'CSV download started', tone: 'success' };
  } catch {
    return { message: 'Could not export CSV', tone: 'error' };
  }
};

export const browserSharingEnvironment = (): SharingEnvironment => ({
  copyText: async (text) => await navigator.clipboard.writeText(text),
  currentUrl: () => window.location.href,
  download: async ({ csv, filename }) => {
    const { downloadReportCsv } = await import('../../../../report-export');
    downloadReportCsv(filename, csv);
  },
});
