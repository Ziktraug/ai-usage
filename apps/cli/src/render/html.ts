import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inlineReportHTML } from '@ai-usage/report-core/html-export';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';

const reportAppDistPath = () => path.resolve(import.meta.dir, '../../../report/dist');
const reportAppOutputPath = () => path.resolve(import.meta.dir, '../../../report/.output');
const reportAppServerPath = () => {
  const outputServer = path.join(reportAppOutputPath(), 'server/_ssr/ssr.mjs');
  if (fs.existsSync(outputServer)) return outputServer;
  const serverDir = path.join(reportAppDistPath(), 'server');
  return ['entry-server.js', 'server.js'].map((file) => path.join(serverDir, file)).find((file) => fs.existsSync(file));
};
const reportAppClientPath = () => {
  const outputPublic = path.join(reportAppOutputPath(), 'public');
  return fs.existsSync(outputPublic) ? outputPublic : path.join(reportAppDistPath(), 'client');
};

const missingTemplateHTML = (templatePath: string) =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>ai-usage report app not built</title></head>',
    '<body>',
    '<h1>ai-usage report app not built</h1>',
    `<p>Run <code>bun run build</code>, then retry <code>--html</code>. Missing template: <code>${templatePath}</code>.</p>`,
    '</body>',
    '</html>',
  ].join('');

type StartServerModule = {
  default: ((request: Request) => Response | Promise<Response>) | {
    fetch: (request: Request) => Response | Promise<Response>;
  };
};

const clientAssetTags = (clientDir: string) => {
  const assetsDir = path.join(clientDir, 'assets');
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const css = files.find((file) => file.endsWith('.css'));
  return css ? `<link rel="stylesheet" href="/assets/${css}">` : '';
};

const injectClientAssets = (html: string, clientDir: string) => {
  const tags = clientAssetTags(clientDir);
  if (!tags) return html;
  const lastHeadClose = html.lastIndexOf('</head>');
  if (lastHeadClose === -1) return `${tags}${html}`;
  return html.slice(0, lastHeadClose) + tags + html.slice(lastHeadClose);
};

export const renderReportAppHTML = async (payload: UsageReportPayload) => {
  const serverPath = reportAppServerPath();
  if (!serverPath) return missingTemplateHTML(path.join(reportAppOutputPath(), 'server/_ssr/ssr.mjs'));

  const globalPayload = globalThis as { __AI_USAGE_REPORT_EXPORT_PAYLOAD__?: UsageReportPayload | undefined };
  const hadPreviousPayload = Object.hasOwn(globalPayload, '__AI_USAGE_REPORT_EXPORT_PAYLOAD__');
  const previousPayload = globalPayload.__AI_USAGE_REPORT_EXPORT_PAYLOAD__;
  let html: string;
  try {
    globalPayload.__AI_USAGE_REPORT_EXPORT_PAYLOAD__ = payload;
    const startServer = (await import(pathToFileURL(serverPath).href)) as StartServerModule;
    const startFetch = typeof startServer.default === 'function' ? startServer.default : startServer.default.fetch;
    const response = await startFetch(new Request('http://localhost/', { headers: { accept: 'text/html' } }));
    html = await response.text();
  } finally {
    if (hadPreviousPayload) globalPayload.__AI_USAGE_REPORT_EXPORT_PAYLOAD__ = previousPayload;
    else delete globalPayload.__AI_USAGE_REPORT_EXPORT_PAYLOAD__;
  }

  const clientDir = reportAppClientPath();
  html = injectClientAssets(html, clientDir);

  const readAssetContent = (src: string): string => {
    const assetPath = path.join(clientDir, src.replace(/^\//, ''));
    try {
      return fs.readFileSync(assetPath, 'utf8');
    } catch {
      return '';
    }
  };

  return inlineReportHTML({ html, payload, readAssetContent });
};
