const escapeScriptContent = (content: string) => content.replace(/<\/script/gi, '<\\/script');

const escapeStyleContent = (content: string) => content.replace(/<\/style/gi, '<\\/style');

export interface InlineReportHtmlInput {
  html: string;
  payload: unknown;
  readAssetContent: (src: string) => string | Promise<string>;
}

export const serializeForInlineScript = (json: string) =>
  json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export const createReportPayloadScript = (payload: unknown) =>
  `<script>window.__AI_USAGE_REPORT_STATIC__=true;window.__AI_USAGE_REPORT__=${serializeForInlineScript(JSON.stringify(payload))};</script>`;

export const discoverHtmlAssetUrls = (html: string) => {
  const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>[\s\S]*?<\/script>/gi)].map(
    (match) => match[1]!,
  );
  const stylesheetHrefs = [
    ...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/gi),
  ].map((match) => match[1]!);
  return [...new Set([...scriptSrcs, ...stylesheetHrefs])];
};

export const inlineAssetsIntoHTML = (
  html: string,
  readAssetContent: (src: string) => string,
  payloadScript: string,
) => {
  let result = html;

  // Inline stylesheets.
  result = result.replace(
    /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/gi,
    (_match, href: string) => {
      const content = readAssetContent(href);
      return content ? `<style>${escapeStyleContent(content)}</style>` : _match;
    },
  );

  // Inline scripts: drop type="module" (breaks on file://), move each inline
  // script from <head> to just before </body> so the DOM is ready when they run.
  const movedScripts: string[] = [];
  result = result.replace(
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/script>/gi,
    (_match, _before: string, src: string, _after: string, body: string) => {
      if (body.trim()) {
        return _match;
      }
      if (src.includes('__AI_USAGE_REPORT__')) {
        return _match;
      }
      const content = readAssetContent(src);
      if (!content) {
        return _match;
      }
      movedScripts.push(`<script>${escapeScriptContent(content)}</script>`);
      return '';
    },
  );

  result = result.replace(/<link\b[^>]*\brel=["'](?:modulepreload|icon)["'][^>]*\/?>/gi, '');

  // Inject the payload before the *structural* </head> — the last one, which
  // appears after all inline script/style content. Earlier </head> occurrences
  // inside inline JS/template literals are not structural HTML boundaries.
  const lastHeadClose = result.lastIndexOf('</head>');
  if (lastHeadClose === -1) {
    result = `${payloadScript}${result}`;
  } else {
    result = result.slice(0, lastHeadClose) + payloadScript + result.slice(lastHeadClose);
  }

  // Append the moved scripts before </body> so the DOM (#root) is ready.
  if (movedScripts.length > 0) {
    const lastBodyClose = result.lastIndexOf('</body>');
    if (lastBodyClose !== -1) {
      result = result.slice(0, lastBodyClose) + movedScripts.join('') + result.slice(lastBodyClose);
    }
  }

  return result;
};

export const inlineReportHTML = async ({ html, payload, readAssetContent }: InlineReportHtmlInput) => {
  const assetContent = new Map<string, string>();
  await Promise.all(
    discoverHtmlAssetUrls(html).map(async (src) => {
      const content = await readAssetContent(src);
      if (content) {
        assetContent.set(src, content);
      }
    }),
  );

  return inlineAssetsIntoHTML(html, (src) => assetContent.get(src) ?? '', createReportPayloadScript(payload));
};
