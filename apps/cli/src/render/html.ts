import fs from 'node:fs';
import path from 'node:path';
import type { UsageReportPayload } from '@ai-usage/core/report-data';

const reportAppTemplatePath = () => path.resolve(import.meta.dir, '../../../report/dist/index.html');

const serializeForInlineScript = (payload: UsageReportPayload) =>
  JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

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

  const template = fs.readFileSync(templatePath, 'utf8');
  const dataScript = `<script>window.__AI_USAGE_REPORT__=${serializeForInlineScript(payload)};</script>`;
  return template.includes('</head>')
    ? template.replace('</head>', `${dataScript}</head>`)
    : `${dataScript}${template}`;
};
