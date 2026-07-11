import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inlineReportHTML } from '@ai-usage/report-core/html-export';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';

const reportAppRootPath = () =>
  process.env.AI_USAGE_REPORT_APP_DIR
    ? path.resolve(process.env.AI_USAGE_REPORT_APP_DIR)
    : path.resolve(import.meta.dir, '../../../web');
const reportAppDistPath = () => path.join(reportAppRootPath(), 'dist');
const reportAppOutputPath = () => path.join(reportAppRootPath(), '.output');
const reportAppServerPath = () => {
  const outputServer = path.join(reportAppOutputPath(), 'server/_ssr/ssr.mjs');
  if (fs.existsSync(outputServer)) {
    return outputServer;
  }
  const serverDir = path.join(reportAppDistPath(), 'server');
  return ['entry-server.js', 'server.js'].map((file) => path.join(serverDir, file)).find((file) => fs.existsSync(file));
};
const reportAppClientPath = () => {
  const outputPublic = path.join(reportAppOutputPath(), 'public');
  if (fs.existsSync(outputPublic)) {
    return outputPublic;
  }
  const distClient = path.join(reportAppDistPath(), 'client');
  return fs.existsSync(distClient) ? distClient : undefined;
};

interface StartServerModule {
  default:
    | ((request: Request) => Response | Promise<Response>)
    | {
        fetch: (request: Request) => Response | Promise<Response>;
      };
}

const LEADING_SLASH = /^\//;

const clientAssetTags = (clientDir: string) => {
  const assetsDir = path.join(clientDir, 'assets');
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const css = files.find((file) => file.endsWith('.css'));
  return css ? `<link rel="stylesheet" href="/assets/${css}">` : '';
};

const injectClientAssets = (html: string, clientDir: string) => {
  const tags = clientAssetTags(clientDir);
  if (!tags) {
    return html;
  }
  const lastHeadClose = html.lastIndexOf('</head>');
  if (lastHeadClose === -1) {
    return `${tags}${html}`;
  }
  return html.slice(0, lastHeadClose) + tags + html.slice(lastHeadClose);
};

export const renderReportAppHTML = async (payload: UsageReportPayload) => {
  const serverPath = reportAppServerPath();
  if (!serverPath) {
    const expectedServerPath = path.join(reportAppOutputPath(), 'server/_ssr/ssr.mjs');
    throw new Error(
      `Report app build artifact is missing: ${expectedServerPath}. Run \`bun run --cwd apps/web build\`, then retry the HTML export.`,
    );
  }

  const globalPayload = globalThis as { __AI_USAGE_REPORT_EXPORT_PAYLOAD__?: UsageReportPayload | undefined };
  const hadPreviousPayload = Object.hasOwn(globalPayload, '__AI_USAGE_REPORT_EXPORT_PAYLOAD__');
  const previousPayload = globalPayload.__AI_USAGE_REPORT_EXPORT_PAYLOAD__;
  let html: string;
  try {
    globalPayload.__AI_USAGE_REPORT_EXPORT_PAYLOAD__ = payload;
    const startServer = (await import(pathToFileURL(serverPath).href)) as StartServerModule;
    const startFetch = typeof startServer.default === 'function' ? startServer.default : startServer.default.fetch;
    const response = await startFetch(new Request('http://localhost/', { headers: { accept: 'text/html' } }));
    if (!response.ok) {
      const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      throw new Error(`Report app SSR failed with ${status}`);
    }
    html = await response.text();
  } finally {
    if (hadPreviousPayload) {
      globalPayload.__AI_USAGE_REPORT_EXPORT_PAYLOAD__ = previousPayload;
    } else {
      globalPayload.__AI_USAGE_REPORT_EXPORT_PAYLOAD__ = undefined;
    }
  }

  const clientDir = reportAppClientPath();
  if (!clientDir) {
    const expectedOutputPath = path.join(reportAppOutputPath(), 'public');
    const expectedDistPath = path.join(reportAppDistPath(), 'client');
    throw new Error(
      `Report app client build artifact is missing. Expected ${expectedOutputPath} or ${expectedDistPath}. Run \`bun run --cwd apps/web build\`, then retry the HTML export.`,
    );
  }
  html = injectClientAssets(html, clientDir);

  const readAssetContent = (src: string): string => {
    const assetPath = path.join(clientDir, src.replace(LEADING_SLASH, ''));
    if (!fs.existsSync(assetPath)) {
      throw new Error(`Report app client artifact is missing: ${assetPath}`);
    }
    return fs.readFileSync(assetPath, 'utf8');
  };

  return inlineReportHTML({ html, payload, readAssetContent });
};
