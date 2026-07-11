#!/usr/bin/env bun
import fs from 'node:fs';
import { LocalHistoryStorage, readAiUsageConfig, updateAiUsageConfig } from '@ai-usage/local-collectors';
import type { ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import { parseUsageSnapshot, type UsageSnapshot } from '@ai-usage/report-core/snapshot';
import { listProjectSourcesWithWarnings, type ProjectSource } from '@ai-usage/report-data';
import { Console, Effect } from 'effect';

const collectSetupSources = (snapshotFiles: string[], local: boolean) =>
  Effect.gen(function* () {
    const snapshots: UsageSnapshot[] = [];
    for (const file of snapshotFiles) {
      snapshots.push(parseUsageSnapshot(fs.readFileSync(file, 'utf8')));
    }
    return yield* listProjectSourcesWithWarnings({
      snapshots,
      includeLocal: local,
      harness: null,
      includeCursor: true,
      includeGitRemote: true,
    });
  });

const scriptJson = (value: unknown) => (JSON.stringify(value) ?? 'null').replace(/</g, '\\u003c');

export const saveSetupProjectAliases = (projectAliases: ProjectAliasEntry[]) =>
  updateAiUsageConfig((config) => ({ ...config, projectAliases }));

export const setupHTML = (
  sources: ProjectSource[],
  aliases: ProjectAliasEntry[],
  warnings: { harness?: string; message: string }[],
) => {
  const sourcesJson = scriptJson(sources);
  const aliasesJson = scriptJson(aliases);
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
  .alias-list { margin-top: 12px; }
  .alias-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #333; }
  .alias-name { font-weight: 600; min-width: 120px; }
  .alias-patterns { color: #999; font-size: 12px; }
  .alias-delete { cursor: pointer; color: #e57373; border: none; background: none; font-size: 18px; }
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
  <label>Alias name: <input id="alias-name" type="text" placeholder="my-project"></label>
  <button id="merge-btn" disabled>Merge into alias</button>
  <span id="save-status"></span>
</div>
<h2>Sources</h2>
<div style="overflow-x:auto; max-height:60vh;">
<table id="sources-table">
  <thead><tr>
    <th><input type="checkbox" id="select-all"></th>
    <th>Project</th><th>Machine</th><th>Harness</th><th class="num">Sessions</th><th class="num">Tokens</th><th>Path</th><th>Git Remote</th>
  </tr></thead>
  <tbody id="sources-body"></tbody>
</table>
</div>
<h2>Suggestions</h2>
<div id="suggestions"></div>
<h2>Current aliases</h2>
<div id="aliases-list" class="alias-list"></div>

<script>
const sources = ${sourcesJson};
const initialAliases = ${aliasesJson};
const warnings = ${warningsJson};
let aliases = JSON.parse(JSON.stringify(initialAliases));
let selected = new Set();

const warningsEl = document.getElementById('warnings');
const tbody = document.getElementById('sources-body');
const nameInput = document.getElementById('alias-name');
const mergeBtn = document.getElementById('merge-btn');
const countEl = document.getElementById('selected-count');
const statusEl = document.getElementById('save-status');
const sugEl = document.getElementById('suggestions');
const aliasListEl = document.getElementById('aliases-list');
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

function effectiveProject(source) {
  for (const alias of aliases) {
    for (const pattern of alias.match) {
      const regex = globToRegex(pattern);
      if (regex.test(source.sourcePath) || regex.test(source.project)) return alias.name;
    }
  }
  return source.project;
}

function globToRegex(glob) {
  const parts = glob.split('*');
  const escaped = parts.map(p => p.replace(/[^a-zA-Z0-9_/ -]/g, '\\\\$&'));
  return new RegExp('^' + escaped.join('.*') + '$', 'i');
}

function renderAliases() {
  aliasListEl.replaceChildren();
  if (!aliases.length) {
    aliasListEl.textContent = 'No aliases configured.';
    return;
  }
  for (const alias of aliases) {
    const div = document.createElement('div');
    div.className = 'alias-item';
    const name = document.createElement('span');
    name.className = 'alias-name';
    name.textContent = alias.name;
    const patterns = document.createElement('span');
    patterns.className = 'alias-patterns';
    patterns.textContent = alias.match.join(', ');
    const deleteButton = document.createElement('button');
    deleteButton.className = 'alias-delete';
    deleteButton.dataset.name = alias.name;
    deleteButton.title = 'Remove alias';
    deleteButton.type = 'button';
    deleteButton.textContent = '×';
    div.appendChild(name);
    div.appendChild(patterns);
    div.appendChild(deleteButton);
    aliasListEl.appendChild(div);
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
    const span = document.createElement('span');
    span.className = 'suggestion';
    span.textContent = group.label;
    span.onclick = () => {
      for (const idx of group.idxs) selected.add(idx);
      nameInput.value = group.name;
      renderSources();
    };
    sugEl.appendChild(span);
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

mergeBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name) { alert('Enter an alias name'); return; }
  const matchedSources = [...selected].map(i => sources[i]);
  const paths = [...new Set(matchedSources.map(s => s.sourcePath).filter(Boolean))];
  const basenames = [...new Set(matchedSources.map(s => s.project))];
  const match = [...paths, ...basenames.map(b => '*/' + b)];
  const existing = aliases.find(a => a.name === name);
  if (existing) { existing.match = [...new Set([...existing.match, ...match])]; }
  else aliases.push({ name, match });
  nameInput.value = '';
  selected.clear();
  await saveAliases();
  renderSources();
  renderAliases();
  renderSuggestions();
});

aliasListEl.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('alias-delete')) return;
  const name = e.target.dataset.name;
  aliases = aliases.filter(a => a.name !== name);
  await saveAliases();
  renderAliases();
  renderSuggestions();
});

async function saveAliases() {
  statusEl.textContent = 'Saving…';
  statusEl.className = '';
  try {
    const res = await fetch('/api/aliases', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(aliases) });
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
renderAliases();
renderSuggestions();
</script>
</body>
</html>`;
};

export const runSetupServer = (snapshotFiles: string[], local: boolean, port: number) =>
  Effect.gen(function* () {
    const { sources, warnings } = yield* collectSetupSources(snapshotFiles, local);
    const config = yield* readAiUsageConfig;
    const storage = yield* LocalHistoryStorage;
    const aliases = config.projectAliases ?? [];
    const html = setupHTML(sources, aliases, warnings);

    const writeAliases = (newAliases: ProjectAliasEntry[]) =>
      Effect.runPromise(saveSetupProjectAliases(newAliases).pipe(Effect.provideService(LocalHistoryStorage, storage)));

    const server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/' || url.pathname === '/index.html') {
          return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }

        if (url.pathname === '/api/aliases' && req.method === 'PUT') {
          try {
            const body = (await req.json()) as ProjectAliasEntry[];
            await writeAliases(body);
            return new Response('ok', { status: 200 });
          } catch (err) {
            return new Response(JSON.stringify({ error: String(err) }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          }
        }

        if (url.pathname === '/api/sources') {
          return Response.json(sources);
        }

        return new Response('not found', { status: 404 });
      },
    });

    yield* Console.log(`Setup UI: http://localhost:${server.port}`);
    yield* Console.log('Press Ctrl+C to stop.');
    yield* Effect.never;
  });
