import fs from 'node:fs';
import path from 'node:path';
import { inlineAssetsIntoHTML, serializeForInlineScript } from '@ai-usage/core/html-export';
import type { UsageReportPayload } from '@ai-usage/core/report-data';

const reportAppDistPath = () => path.resolve(import.meta.dir, '../../../report/dist');
const reportAppTemplatePath = () => path.join(reportAppDistPath(), 'index.html');

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

export const renderReportAppHTML = (payload: UsageReportPayload) => {
  const templatePath = reportAppTemplatePath();
  if (!fs.existsSync(templatePath)) return missingTemplateHTML(templatePath);

  const distDir = reportAppDistPath();
  const html = fs.readFileSync(templatePath, 'utf8');
  const payloadScript = `<script>window.__AI_USAGE_REPORT__=${serializeForInlineScript(JSON.stringify(payload))};</script>`;

  const readAssetContent = (src: string): string => {
    const assetPath = path.join(distDir, src);
    try {
      return fs.readFileSync(assetPath, 'utf8');
    } catch {
      return '';
    }
  };

  return inlineAssetsIntoHTML(html, readAssetContent, payloadScript);
};
