import { describe, expect, test } from 'bun:test';
import { inlineAssetsIntoHTML, inlineReportHTML } from './html-export';

describe('static HTML asset inlining', () => {
  test('keeps an inlined client module executable when it uses import.meta', () => {
    const html =
      '<!doctype html><html><head><script type="module" src="/assets/client.js"></script></head><body><main></main></body></html>';

    const result = inlineAssetsIntoHTML(
      html,
      () => 'window.clientModuleUrl = import.meta.url;',
      '<script>window.payload = true;</script>',
    );

    expect(result).toContain('<script type="module">window.clientModuleUrl = import.meta.url;</script>');
  });

  test('neutralizes serialized framework references to assets that were inlined', async () => {
    const assetUrl = '/assets/client.js';
    const html = `<html><head><script type="module" src="${assetUrl}"></script></head><body><script>window.manifest={preloads:["${assetUrl}"]}</script></body></html>`;

    const result = await inlineReportHTML({
      html,
      payload: {},
      readAssetContent: () => 'window.clientLoaded = true;',
    });

    expect(result).not.toContain(assetUrl);
    expect(result).toContain('data:text/javascript,export{}');
  });

  test('preserves asset-like strings inside the injected report payload', async () => {
    const assetUrl = '/assets/client.js';
    const result = await inlineReportHTML({
      html: `<html><head><script type="module" src="${assetUrl}"></script></head><body></body></html>`,
      payload: { title: assetUrl },
      readAssetContent: () => 'window.clientLoaded = true;',
    });

    expect(result).toContain(`"title":"${assetUrl}"`);
  });

  test('injects the payload at the structural head when a client bundle contains HTML closing tags', async () => {
    const assetUrl = '/assets/client.js';
    const result = await inlineReportHTML({
      html: `<html><head><script type="module" src="${assetUrl}"></script></head><body></body></html>`,
      payload: { title: 'Static report' },
      readAssetContent: () => 'window.templates = ["</head>", "</body>"];',
    });

    const payloadIndex = result.indexOf('window.__AI_USAGE_REPORT__');
    const structuralHeadIndex = result.indexOf('</head>');
    const clientBundleIndex = result.indexOf('window.templates');
    expect(payloadIndex).toBeGreaterThan(-1);
    expect(payloadIndex).toBeLessThan(structuralHeadIndex);
    expect(clientBundleIndex).toBeGreaterThan(structuralHeadIndex);
  });
});
