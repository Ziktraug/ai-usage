#!/usr/bin/env bun
import { type ProjectGroupConfig, parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import type { UsageSnapshot } from '@ai-usage/report-core/snapshot';
import { collectProjectSourcesFromSnapshots, type ProjectSource } from '@ai-usage/report-data/portable-report';
import { Console, Effect } from 'effect';
import { readUsageSnapshotFile } from './snapshot-file';

export const SETUP_SERVER_HOSTNAME = '127.0.0.1';
export const MAX_SETUP_PROJECT_GROUP_BODY_BYTES = 256 * 1024;
export const MAX_SETUP_PROJECT_GROUPS = 256;
export const MAX_SETUP_PROJECT_SOURCES = 500;
const BYTE_COUNT_PATTERN = /^\d+$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

interface SetupServerOptions {
  maxProjectGroupBodyBytes?: number;
  port: number;
  projectGroups: ProjectGroupConfig[];
  sources: ProjectSource[];
  warnings: { harness?: string; message: string }[];
  writeProjectGroups: (projectGroups: ProjectGroupConfig[]) => Promise<unknown>;
}

export interface RunSetupServerOptions {
  readonly localSnapshot?: UsageSnapshot;
  readonly port: number;
  readonly projectGroups: ProjectGroupConfig[];
  readonly signal?: AbortSignal;
  readonly snapshotFiles: string[];
  readonly writeProjectGroups: (projectGroups: ProjectGroupConfig[]) => Promise<unknown>;
}

export interface SetupServerHandle {
  hostname: string;
  port: number;
  stop: (closeActiveConnections?: boolean) => Promise<void>;
}

const setupJsonFailure = (status: number, tag: string, message: string): Response =>
  Response.json({ error: { tag, message } }, { status });

const isTrustedSetupHost = (host: string): boolean => {
  try {
    const parsedHost = new URL(`http://${host}`);
    return (
      parsedHost.username === '' &&
      parsedHost.password === '' &&
      parsedHost.pathname === '/' &&
      parsedHost.search === '' &&
      parsedHost.hash === '' &&
      LOOPBACK_HOSTNAMES.has(parsedHost.hostname)
    );
  } catch {
    return false;
  }
};

const validateSetupHost = (request: Request): Response | null => {
  const host = request.headers.get('host')?.trim();
  if (!host) {
    return setupJsonFailure(400, 'MissingHost', 'Setup requests require a Host header.');
  }
  if (!isTrustedSetupHost(host)) {
    return setupJsonFailure(403, 'UntrustedHost', 'Setup requests are only accepted on loopback.');
  }
  return null;
};

const validateSetupMutationOrigin = (request: Request): Response | null => {
  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return setupJsonFailure(403, 'CrossOriginRequest', 'Setup changes are only accepted from this application.');
  }

  const origin = request.headers.get('origin')?.trim();
  if (!origin) {
    return setupJsonFailure(403, 'MissingOrigin', 'Setup changes require same-origin request metadata.');
  }

  const requestUrl = new URL(request.url);
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.trim().toLowerCase();
  if (forwardedProtocol && forwardedProtocol !== requestUrl.protocol.slice(0, -1)) {
    return setupJsonFailure(403, 'UntrustedForwardedProtocol', 'Forwarded protocol metadata is not trusted.');
  }

  try {
    const host = request.headers.get('host')?.trim() ?? '';
    const parsedOrigin = new URL(origin);
    const expectedOrigin = new URL(`${requestUrl.protocol}//${host}`).origin;
    if (origin !== parsedOrigin.origin) {
      return setupJsonFailure(400, 'InvalidOrigin', 'The request Origin header is invalid.');
    }
    if (parsedOrigin.origin !== expectedOrigin) {
      return setupJsonFailure(403, 'CrossOriginRequest', 'Setup changes are only accepted from this application.');
    }
  } catch {
    return setupJsonFailure(400, 'InvalidOrigin', 'The request Origin or Host header is invalid.');
  }
  return null;
};

const validateSetupJsonContentType = (request: Request): Response | null => {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  return contentType === 'application/json'
    ? null
    : setupJsonFailure(415, 'UnsupportedMediaType', 'Project group updates require Content-Type: application/json.');
};

type SetupBodyResult = { text: string } | { response: Response };

const readBoundedSetupBody = async (request: Request, maxBytes: number): Promise<SetupBodyResult> => {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!BYTE_COUNT_PATTERN.test(contentLength)) {
      return { response: setupJsonFailure(400, 'InvalidContentLength', 'Content-Length must be a byte count.') };
    }
    if (Number(contentLength) > maxBytes) {
      return {
        response: setupJsonFailure(413, 'BodyTooLarge', `Project group updates must not exceed ${maxBytes} bytes.`),
      };
    }
  }

  if (!request.body) {
    return { response: setupJsonFailure(400, 'EmptyBody', 'Project group updates require a JSON body.') };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    byteLength += chunk.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      return {
        response: setupJsonFailure(413, 'BodyTooLarge', `Project group updates must not exceed ${maxBytes} bytes.`),
      };
    }
    chunks.push(chunk.value);
  }

  if (byteLength === 0) {
    return { response: setupJsonFailure(400, 'EmptyBody', 'Project group updates require a JSON body.') };
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { response: setupJsonFailure(400, 'InvalidEncoding', 'Project group updates must contain UTF-8 JSON.') };
  }
};

type ProjectGroupParseResult = { projectGroups: ProjectGroupConfig[] } | { response: Response };

const parseSetupProjectGroups = (text: string): ProjectGroupParseResult => {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { response: setupJsonFailure(400, 'MalformedJson', 'The project group update is not valid JSON.') };
  }
  if (!Array.isArray(value)) {
    return { response: setupJsonFailure(422, 'InvalidProjectGroups', 'Project groups must be a JSON array.') };
  }
  if (value.length > MAX_SETUP_PROJECT_GROUPS) {
    return {
      response: setupJsonFailure(
        413,
        'TooManyProjectGroups',
        `Project group updates support at most ${MAX_SETUP_PROJECT_GROUPS} groups.`,
      ),
    };
  }
  for (const group of value) {
    const sourceCount =
      typeof group === 'object' && group !== null && !Array.isArray(group) && Array.isArray(group.sources)
        ? group.sources.length
        : 0;
    if (sourceCount > MAX_SETUP_PROJECT_SOURCES) {
      return {
        response: setupJsonFailure(
          413,
          'TooManyProjectSources',
          `Each project group supports at most ${MAX_SETUP_PROJECT_SOURCES} source selectors.`,
        ),
      };
    }
  }
  try {
    return { projectGroups: parseProjectGroupConfigs(value) };
  } catch {
    return {
      response: setupJsonFailure(
        422,
        'InvalidProjectGroups',
        'Every project group requires a unique id, a name, and non-overlapping source selectors.',
      ),
    };
  }
};

export const collectSetupSources = (snapshotFiles: string[], localSnapshot?: UsageSnapshot) =>
  Effect.gen(function* () {
    const snapshots: UsageSnapshot[] = [];
    for (const file of snapshotFiles) {
      snapshots.push(yield* readUsageSnapshotFile(file));
    }
    return collectProjectSourcesFromSnapshots({
      snapshots,
      harness: null,
      includeCursor: true,
      includeGitRemote: true,
      ...(localSnapshot === undefined ? {} : { localSnapshots: [localSnapshot] }),
    });
  });

const scriptJson = (value: unknown) => (JSON.stringify(value) ?? 'null').replace(/</g, '\\u003c');

export const setupHTML = (
  sources: ProjectSource[],
  projectGroups: ProjectGroupConfig[],
  warnings: { harness?: string; message: string }[],
) => {
  const sourcesJson = scriptJson(sources);
  const projectGroupsJson = scriptJson(projectGroups);
  const warningsJson = scriptJson(warnings);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-usage setup</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 0 auto; padding: 24px; }
  h1 { margin-bottom: 16px; font-size: 20px; }
  h2 { margin: 24px 0 8px; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #444; white-space: nowrap; }
  th { font-weight: 600; position: sticky; top: 0; background: Canvas; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .actions { position: sticky; top: 0; background: Canvas; padding: 12px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button, input { font: inherit; }
  button { cursor: pointer; padding: 4px 12px; border-radius: 4px; border: 1px solid ButtonText; background: ButtonFace; }
  button:hover { filter: brightness(1.1); }
  button:disabled { opacity: 0.5; cursor: default; }
  input { padding: 4px 8px; border-radius: 4px; border: 1px solid #888; }
  .saved { color: #4caf50; font-weight: 600; }
  .group-list { margin-top: 12px; }
  .group-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #333; }
  .group-name { font-weight: 600; min-width: 120px; }
  .group-sources { color: #999; font-size: 12px; }
  .group-delete { cursor: pointer; color: #e57373; border: none; background: none; font-size: 18px; }
  .row-selected { background: rgba(100, 149, 237, 0.15); }
  .suggestion { color: #999; font-size: 12px; padding: 4px 8px; background: rgba(255,255,255,0.05); border-radius: 4px; margin-right: 4px; }
  .suggestion:hover { background: rgba(255,255,255,0.1); cursor: pointer; }
  .warning-panel { margin: 12px 0 16px; padding: 12px; border: 1px solid #b7791f; border-radius: 8px; background: rgba(183,121,31,0.12); color: #f6c177; }
  .warning-panel h2 { margin: 0 0 8px; font-size: 14px; }
  .warning-panel ul { margin-left: 18px; }
</style>
</head>
<body>
<h1>ai-usage project setup</h1>
<div id="warnings"></div>
<div class="actions" id="toolbar">
  <span id="selected-count">0 selected</span>
  <label>Group name: <input id="group-name" type="text" placeholder="my-project"></label>
  <button id="merge-btn" disabled>Merge into group</button>
  <span id="save-status" role="status" aria-live="polite"></span>
  <span id="group-name-error" role="alert"></span>
</div>
<h2>Sources</h2>
<div style="overflow-x:auto; max-height:60vh;">
<table id="sources-table">
  <thead><tr>
    <th><input type="checkbox" id="select-all" aria-label="Select all project sources"></th>
    <th>Project</th><th>Machine</th><th>Harness</th><th class="num">Sessions</th><th class="num">Tokens</th><th>Path</th><th>Git Remote</th>
  </tr></thead>
  <tbody id="sources-body"></tbody>
</table>
</div>
<h2>Suggestions</h2>
<div id="suggestions"></div>
<h2>Current project groups</h2>
<div id="groups-list" class="group-list"></div>

<script>
const sources = ${sourcesJson};
const initialGroups = ${projectGroupsJson};
const warnings = ${warningsJson};
let projectGroups = JSON.parse(JSON.stringify(initialGroups));
let selected = new Set();

const warningsEl = document.getElementById('warnings');
const tbody = document.getElementById('sources-body');
const nameInput = document.getElementById('group-name');
const mergeBtn = document.getElementById('merge-btn');
const countEl = document.getElementById('selected-count');
const statusEl = document.getElementById('save-status');
const nameErrorEl = document.getElementById('group-name-error');
const sugEl = document.getElementById('suggestions');
const groupListEl = document.getElementById('groups-list');
const selectAllEl = document.getElementById('select-all');

const fmtNum = n => { if (n >= 1e6) return (n/1e6).toFixed(1)+'M'; if (n >= 1e3) return (n/1e3).toFixed(1)+'K'; return String(n); };

function renderSources() {
  tbody.replaceChildren();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const tr = document.createElement('tr');
    if (selected.has(i)) tr.classList.add('row-selected');
    const selectionCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', 'Select ' + s.project);
    checkbox.dataset.idx = String(i);
    checkbox.checked = selected.has(i);
    selectionCell.appendChild(checkbox);
    tr.appendChild(selectionCell);

    const values = [s.project, s.machine, s.harness, fmtNum(s.sessions), fmtNum(s.tokens)];
    for (let column = 0; column < values.length; column++) {
      const cell = document.createElement('td');
      cell.textContent = String(values[column]);
      if (column >= 3) cell.className = 'num';
      tr.appendChild(cell);
    }

    const sourcePathCell = document.createElement('td');
    sourcePathCell.textContent = s.sourcePath || '—';
    sourcePathCell.style.maxWidth = '260px';
    sourcePathCell.style.overflow = 'hidden';
    sourcePathCell.style.textOverflow = 'ellipsis';
    tr.appendChild(sourcePathCell);

    const remoteCell = document.createElement('td');
    remoteCell.textContent = s.gitRemote || '—';
    tr.appendChild(remoteCell);
    tbody.appendChild(tr);
  }
  updateCount();
}

function renderWarnings() {
  warningsEl.replaceChildren();
  if (!warnings.length) return;
  const panel = document.createElement('section');
  panel.className = 'warning-panel';
  const title = document.createElement('h2');
  title.textContent = 'Report warnings';
  const list = document.createElement('ul');
  for (const warning of warnings) {
    const item = document.createElement('li');
    item.textContent = (warning.harness ? warning.harness + ': ' : '') + warning.message;
    list.appendChild(item);
  }
  panel.appendChild(title);
  panel.appendChild(list);
  warningsEl.appendChild(panel);
}

function updateCount() {
  countEl.textContent = selected.size + ' selected';
  mergeBtn.disabled = selected.size === 0;
  selectAllEl.checked = selected.size === sources.length && sources.length > 0;
}

function selectorLabel(selector) {
  return selector.sourcePath || selector.project || selector.gitRemote || selector.machineId || 'unknown source';
}

function renderGroups() {
  groupListEl.replaceChildren();
  if (!projectGroups.length) {
    groupListEl.textContent = 'No project groups configured.';
    return;
  }
  for (const group of projectGroups) {
    const div = document.createElement('div');
    div.className = 'group-item';
    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group.name;
    const groupSources = document.createElement('span');
    groupSources.className = 'group-sources';
    groupSources.textContent = group.sources.map(selectorLabel).join(', ');
    const deleteButton = document.createElement('button');
    deleteButton.className = 'group-delete';
    deleteButton.dataset.id = group.id;
    deleteButton.setAttribute('aria-label', 'Remove project group ' + group.name);
    deleteButton.title = 'Remove project group';
    deleteButton.type = 'button';
    deleteButton.textContent = '×';
    div.appendChild(name);
    div.appendChild(groupSources);
    div.appendChild(deleteButton);
    groupListEl.appendChild(div);
  }
}

function renderSuggestions() {
  sugEl.replaceChildren();
  const groups = [];
  const seen = new Set();

  const byRemote = new Map();
  for (let i = 0; i < sources.length; i++) {
    const remote = sources[i].gitRemote;
    if (!remote) continue;
    if (!byRemote.has(remote)) byRemote.set(remote, []);
    byRemote.get(remote).push(i);
  }
  for (const [remote, idxs] of byRemote) {
    if (idxs.length < 2) continue;
    const key = 'remote:' + remote;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ label: remote + ' (git, ' + idxs.length + ' sources)', idxs, name: remote.split('/').pop() || remote });
  }

  const byBasename = new Map();
  for (let i = 0; i < sources.length; i++) {
    const base = sources[i].project.toLowerCase().replace(/[-_].*$/, '');
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(i);
  }
  for (const [base, idxs] of byBasename) {
    if (idxs.length < 2) continue;
    const key = 'base:' + base;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ label: base + ' (basename, ' + idxs.length + ' sources)', idxs, name: base });
  }

  for (const group of groups) {
    const suggestionButton = document.createElement('button');
    suggestionButton.type = 'button';
    suggestionButton.className = 'suggestion';
    suggestionButton.textContent = group.label;
    suggestionButton.onclick = () => {
      for (const idx of group.idxs) selected.add(idx);
      nameInput.value = group.name;
      nameErrorEl.textContent = '';
      renderSources();
    };
    sugEl.appendChild(suggestionButton);
  }
  if (!sugEl.children.length) sugEl.textContent = 'No obvious suggestions found. Select sources manually.';
}

tbody.addEventListener('change', (e) => {
  const cb = e.target;
  if (!cb.dataset.idx) return;
  const idx = Number(cb.dataset.idx);
  if (cb.checked) selected.add(idx); else selected.delete(idx);
  renderSources();
});

selectAllEl.addEventListener('change', () => {
  if (selectAllEl.checked) { for (let i = 0; i < sources.length; i++) selected.add(i); }
  else selected.clear();
  renderSources();
});

function selectorKey(selector) {
  return JSON.stringify([
    selector.machineId || '',
    selector.sourcePath || '',
    (selector.project || '').toLowerCase(),
    selector.gitRemote || '',
  ]);
}

mergeBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name) {
    nameErrorEl.textContent = 'Enter a project group name.';
    nameInput.focus();
    return;
  }
  nameErrorEl.textContent = '';
  const matchedSources = [...selected].map(i => sources[i]);
  const selectors = matchedSources.map(source => ({
    machineId: source.machineId,
    ...(source.sourcePath ? { sourcePath: source.sourcePath } : { project: source.project }),
    ...(source.gitRemote ? { gitRemote: source.gitRemote } : {}),
  }));
  const selectorKeys = new Set(selectors.map(selectorKey));
  const existing = projectGroups.find(group => group.name === name);
  projectGroups = projectGroups
    .map(group => group === existing ? group : {
      ...group,
      sources: group.sources.filter(selector => !selectorKeys.has(selectorKey(selector))),
    })
    .filter(group => group.sources.length > 0);
  if (existing) {
    const existingKeys = new Set(existing.sources.map(selectorKey));
    existing.sources.push(...selectors.filter(selector => !existingKeys.has(selectorKey(selector))));
  } else {
    projectGroups.push({ id: 'setup-' + crypto.randomUUID(), name, sources: selectors });
  }
  nameInput.value = '';
  selected.clear();
  await saveProjectGroups();
  renderSources();
  renderGroups();
  renderSuggestions();
});

nameInput.addEventListener('input', () => {
  nameErrorEl.textContent = '';
});

groupListEl.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('group-delete')) return;
  const id = e.target.dataset.id;
  projectGroups = projectGroups.filter(group => group.id !== id);
  await saveProjectGroups();
  renderGroups();
  renderSuggestions();
});

async function saveProjectGroups() {
  statusEl.textContent = 'Saving…';
  statusEl.className = '';
  try {
    const res = await fetch('/api/project-groups', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(projectGroups) });
    if (!res.ok) throw new Error(res.statusText);
    statusEl.textContent = 'Saved';
    statusEl.className = 'saved';
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
  setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 2000);
}

renderSources();
renderWarnings();
renderGroups();
renderSuggestions();
</script>
</body>
</html>`;
};

export const createSetupServer = ({
  projectGroups,
  maxProjectGroupBodyBytes = MAX_SETUP_PROJECT_GROUP_BODY_BYTES,
  port,
  sources,
  warnings,
  writeProjectGroups,
}: SetupServerOptions): SetupServerHandle => {
  const html = setupHTML(sources, projectGroups, warnings);
  const server = Bun.serve({
    hostname: SETUP_SERVER_HOSTNAME,
    port,
    async fetch(request) {
      const hostFailure = validateSetupHost(request);
      if (hostFailure) {
        return hostFailure;
      }

      const url = new URL(request.url);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      if (url.pathname === '/api/project-groups' && request.method === 'PUT') {
        const originFailure = validateSetupMutationOrigin(request);
        if (originFailure) {
          return originFailure;
        }
        const contentTypeFailure = validateSetupJsonContentType(request);
        if (contentTypeFailure) {
          return contentTypeFailure;
        }
        const body = await readBoundedSetupBody(request, maxProjectGroupBodyBytes);
        if ('response' in body) {
          return body.response;
        }
        const parsed = parseSetupProjectGroups(body.text);
        if ('response' in parsed) {
          return parsed.response;
        }
        try {
          await writeProjectGroups(parsed.projectGroups);
          return new Response('ok');
        } catch {
          return setupJsonFailure(
            500,
            'ProjectGroupWriteFailed',
            'The project group configuration could not be saved.',
          );
        }
      }

      if (url.pathname === '/api/sources') {
        return Response.json(sources);
      }

      return new Response('not found', { status: 404 });
    },
  });
  if (server.port === undefined) {
    server.stop(true).catch(() => undefined);
    throw new Error('The setup server did not open a TCP port.');
  }
  return {
    hostname: server.hostname ?? SETUP_SERVER_HOSTNAME,
    port: server.port,
    stop: async (closeActiveConnections) => {
      await server.stop(closeActiveConnections);
    },
  };
};

const waitForSetupAbort = (signal: AbortSignal | undefined): Effect.Effect<void> => {
  if (!signal) {
    return Effect.never;
  }
  return Effect.async<void>((resume) => {
    const finish = (): void => resume(Effect.void);
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener('abort', finish, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', finish));
  });
};

export const runSetupServer = (options: RunSetupServerOptions) =>
  Effect.gen(function* () {
    const { sources, warnings } = yield* collectSetupSources(options.snapshotFiles, options.localSnapshot);
    const server = createSetupServer({
      port: options.port,
      projectGroups: options.projectGroups,
      sources,
      warnings,
      writeProjectGroups: options.writeProjectGroups,
    });

    yield* Console.log(`Setup UI: http://${SETUP_SERVER_HOSTNAME}:${server.port}`);
    yield* Console.log('Press Ctrl+C to stop.');
    yield* waitForSetupAbort(options.signal).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await server.stop(true);
        }),
      ),
    );
  });
