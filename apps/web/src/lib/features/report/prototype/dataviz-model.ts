import type { DatavizPrototypeSnapshot, PrototypeRow } from '@ai-usage/web-contract/dataviz-prototype';

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Missing chart coordinate');
  }
  return value;
}
export const OTHER = 'Autres';
export const colors = ['#bba0ee', '#7dc6b0', '#e0ab82', '#89aee0', '#ce8eb2', '#bbc68a', '#8b8994'];
export type Mark =
  | {
      kind: 'path';
      d: string;
      color: string;
      opacity?: number;
      dash?: string;
      width?: number;
      stroke?: boolean;
      title?: string;
    }
  | {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      opacity?: number;
      title?: string;
    }
  | { kind: 'circle'; x: number; y: number; r: number; color: string; title?: string }
  | {
      kind: 'text';
      x: number;
      y: number;
      text: string;
      anchor?: 'start' | 'middle' | 'end';
      strong?: boolean;
      small?: boolean;
    };
export interface Plot {
  headers: string[];
  height: number;
  label: string;
  legend: { label: string; color: string }[];
  marks: Mark[];
  note: string;
  rows: string[][];
}
export const fmt = (n: number) =>
  new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const exact = (n: number) => new Intl.NumberFormat('fr-FR').format(n);
export const short = (value: string, length = 26) => (value.length > length ? `${value.slice(0, length - 1)}…` : value);
const text = (x: number, y: number, value: string, anchor: 'start' | 'middle' | 'end' = 'start'): Mark => ({
  kind: 'text',
  x,
  y,
  text: value,
  anchor,
});
const total = (rows: readonly PrototypeRow[]) => rows.reduce((s, r) => s + r.tokens, 0);
export const sumTokens = total;
export function filterRows(snapshot: DatavizPrototypeSnapshot, days: number, project: string): PrototypeRow[] {
  const latest = snapshot.rows.reduce((v, r) => (r.day && r.day > v ? r.day : v), '');
  const floor =
    days && latest
      ? new Date(Date.parse(`${latest}T12:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10)
      : '';
  return snapshot.rows.filter(
    (r) => (!floor || Boolean(r.day && r.day >= floor)) && (!project || r.project === project),
  );
}
export function rankedModels(rows: readonly PrototypeRow[]): string[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    for (const segment of row.segments) {
      totals.set(segment.model, (totals.get(segment.model) ?? 0) + segment.tokens);
    }
  }
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}
export function alluvial(rows: readonly PrototypeRow[], focus: string): Plot {
  const projects = new Map<string, { label: string; tokens: number }>();
  for (const row of rows) {
    const previous = projects.get(row.project);
    projects.set(row.project, { label: row.projectLabel, tokens: (previous?.tokens ?? 0) + row.tokens });
  }
  const topProjects = [...projects]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 6)
    .map(([key]) => key);
  const topModels = rankedModels(rows).slice(0, 6);
  const focusedProject = focus && !topProjects.includes(focus) ? OTHER : focus;
  const flows = new Map<string, { h: string; m: string; p: string; label: string; tokens: number }>();
  for (const row of rows) {
    for (const s of row.segments) {
      if (!s.tokens) {
        continue;
      }
      const m = topModels.includes(s.model) ? s.model : OTHER;
      const p = topProjects.includes(row.project) ? row.project : OTHER;
      const key = JSON.stringify([row.harness, m, p]);
      const prior = flows.get(key);
      flows.set(key, {
        h: row.harness,
        m,
        p,
        label: p === OTHER ? OTHER : row.projectLabel,
        tokens: (prior?.tokens ?? 0) + s.tokens,
      });
    }
  }
  const values = [...flows.values()].sort((a, b) => a.p.localeCompare(b.p) || b.tokens - a.tokens);
  const columns: Map<string, { label: string; tokens: number; y: number; used: number }>[] = [
    new Map(),
    new Map(),
    new Map(),
  ];
  for (const f of values) {
    [f.h, f.m, f.p].forEach((key, index) => {
      const prior = required(columns[index]).get(key);
      required(columns[index]).set(key, {
        label: index === 2 ? f.label : key,
        tokens: (prior?.tokens ?? 0) + f.tokens,
        y: 0,
        used: 0,
      });
    });
  }
  const grand = values.reduce((s, f) => s + f.tokens, 0);
  const maxNodes = Math.max(...columns.map((c) => c.size), 1);
  const available = 490 - (maxNodes - 1) * 30;
  const scale = grand ? available / grand : 0;
  for (const c of columns) {
    let y = 70;
    for (const [key, node] of [...c].sort((a, b) => b[1].tokens - a[1].tokens)) {
      node.y = y;
      y += node.tokens * scale + 30;
      c.delete(key);
      c.set(key, node);
    }
  }
  const projectKeys = [...required(columns[2]).keys()];
  const marks: Mark[] = [text(25, 24, 'HARNESS'), text(435, 24, 'MODÈLE'), text(845, 24, 'PROJET')];
  const xs = [35, 445, 855];
  for (const f of values) {
    const nodes = [f.h, f.m, f.p].map((key, index) => required(columns[index]).get(key)!);
    const starts = nodes.map((n) => n.y + n.used);
    const height = f.tokens * scale;
    for (const n of nodes) {
      n.used += height;
    }
    const color = required(colors[projectKeys.indexOf(f.p) % colors.length]);
    for (let i = 0; i < 2; i++) {
      const left = required(xs[i]) + 12,
        right = required(xs[i + 1]),
        mid = (left + right) / 2,
        a = required(starts[i]),
        b = required(starts[i + 1]);
      marks.push({
        kind: 'path',
        color,
        opacity: focusedProject && focusedProject !== f.p ? 0.08 : 0.53,
        d: `M${left},${a} C${mid},${a} ${mid},${b} ${right},${b} L${right},${b + height} C${mid},${b + height} ${mid},${a + height} ${left},${a + height} Z`,
        title: `${f.h} → ${f.m} → ${f.label} : ${exact(f.tokens)} tokens`,
      });
    }
  }
  for (const [i, c] of columns.entries()) {
    for (const n of c.values()) {
      marks.push({
        kind: 'rect',
        x: required(xs[i]),
        y: n.y,
        width: 12,
        height: n.tokens * scale,
        color: 'var(--colors-ink)',
        opacity: 0.8,
      });
      marks.push(
        text(
          i === 2 ? 1040 : required(xs[i]),
          n.y - 8,
          `${short(n.label, 29)} · ${fmt(n.tokens)}`,
          i === 2 ? 'end' : 'start',
        ),
      );
    }
  }
  return {
    marks,
    height: 590,
    label: 'Attribution des tokens : harness, modèle et projet',
    legend: projectKeys.map((key, i) => ({
      label: required(columns[2]).get(key)!.label,
      color: required(colors[i % colors.length]),
    })),
    headers: ['Harness', 'Modèle', 'Projet', 'Tokens'],
    rows: values.map((f) => [f.h, f.m, f.label, exact(f.tokens)]),
    note: `${exact(grand)} tokens représentés. Six modèles et six projets principaux ; le reste est conservé dans Autres. Épaisseur = tokens, position verticale sans unité.`,
  };
}
const weekFor = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
export function weeklySeries(rows: readonly PrototypeRow[]) {
  const names = rankedModels(rows).slice(0, 5);
  const dates = rows.flatMap((r) => (r.day ? [weekFor(r.day)] : [])).sort();
  if (!dates.length) {
    return { names: [], dates: [], values: [] as number[][] };
  }
  const weeks: string[] = [];
  for (let d = Date.parse(`${dates[0]}T12:00:00Z`); d <= Date.parse(`${dates.at(-1)}T12:00:00Z`); d += 7 * 86_400_000) {
    weeks.push(new Date(d).toISOString().slice(0, 10));
  }
  const labels = [...names, OTHER],
    values = labels.map(() => weeks.map(() => 0));
  for (const row of rows) {
    if (!row.day) {
      continue;
    }
    const j = weeks.indexOf(weekFor(row.day));
    for (const s of row.segments) {
      const i = names.indexOf(s.model);
      const series = required(values[i < 0 ? names.length : i]);
      series[j] = required(series[j]) + s.tokens;
    }
  }
  return { names: labels, dates: weeks, values };
}
export function temporal(rows: readonly PrototypeRow[], mode: 'stream' | 'bump', focus: string): Plot {
  const series = weeklySeries(rows);
  const { names, dates, values } = series;
  const marks: Mark[] = [];
  const x = (i: number) => 85 + (i * 780) / Math.max(1, dates.length - 1);
  if (!dates.length) {
    return {
      marks,
      height: 400,
      label: 'Aucune session datée',
      legend: [],
      headers: [],
      rows: [],
      note: 'Aucune session datée dans cette sélection.',
    };
  }
  if (mode === 'stream') {
    const sums = dates.map((_, j) => values.reduce((sum, a) => sum + required(a[j]), 0));
    const scale = 300 / Math.max(...sums, 1);
    const tops = sums.map((s) => 230 - (s * scale) / 2);
    values.forEach((a, i) => {
      const bottom = tops.map((v, j) => v + required(a[j]) * scale);
      let path = `M${tops.map((v, j) => `${x(j)},${v}`).join(' L')} L${bottom
        .map((v, j) => `${x(j)},${v}`)
        .reverse()
        .join(' L')} Z`;
      if (dates.length === 1) {
        path = `M85,${required(tops[0])} H865 V${required(bottom[0])} H85 Z`;
      }
      marks.push({
        kind: 'path',
        d: path,
        color: required(colors[i]),
        opacity: focus && focus !== names[i] ? 0.1 : 0.82,
        title: required(names[i]),
      });
      for (const [j, v] of bottom.entries()) {
        tops[j] = v;
      }
    });
    marks.push(text(85, 30, 'Épaisseur = tokens par semaine · bandes centrées'));
  } else {
    const count = names.length - 1;
    const y = (rank: number) => 85 + ((rank - 1) * 270) / Math.max(count - 1, 1);
    for (let rank = 1; rank <= count; rank++) {
      marks.push(text(50, y(rank) + 4, String(rank)));
    }
    values.slice(0, count).forEach((a, i) => {
      let points: string[] = [];
      const flush = () => {
        if (points.length > 1) {
          marks.push({
            kind: 'path',
            d: `M${points.join(' L')}`,
            color: required(colors[i]),
            width: 3,
            stroke: true,
            opacity: focus && focus !== names[i] ? 0.12 : 0.8,
          });
        }
        points = [];
      };
      a.forEach((v, j) => {
        if (v === 0) {
          flush();
          return;
        }
        const rank = 1 + values.slice(0, count).filter((other) => required(other[j]) > v).length;
        points.push(`${x(j)},${y(rank)}`);
        marks.push({
          kind: 'circle',
          x: x(j),
          y: y(rank),
          r: 4,
          color: required(colors[i]),
          title: `${names[i]} · ${dates[j]} · rang ${rank} · ${exact(v)} tokens`,
        });
        if (j === a.length - 1) {
          marks.push(text(885, y(rank) + 4, short(required(names[i]), 22)));
        }
      });
      flush();
    });
    marks.push(text(85, 30, 'Rang par volume parmi les cinq modèles dominants de la période'));
  }
  const stride = Math.max(1, Math.ceil(dates.length / 8));
  dates.forEach((day, j) => {
    if (j % stride === 0 || j === dates.length - 1) {
      marks.push(text(x(j), 414, `${day.slice(8, 10)}/${day.slice(5, 7)}`, 'middle'));
    }
  });
  marks.push(text(470, 450, 'Semaine commençant le…', 'middle'));
  return {
    marks,
    height: 470,
    label: mode === 'stream' ? 'Paysage des modèles par semaine' : 'Classement des modèles par semaine',
    legend: names
      .slice(0, mode === 'bump' ? -1 : undefined)
      .map((name, i) => ({ label: name, color: required(colors[i]) })),
    headers: ['Modèle', ...dates],
    rows: values.map((a, i) => [required(names[i]), ...a.map(exact)]),
    note:
      mode === 'stream'
        ? 'La dernière semaine peut être incomplète. Les bandes suivent les totaux hebdomadaires, pas des mesures continues. Un zéro désigne les tokens présents dans cette capture ; la couverture de collecte peut être partielle.'
        : 'Rang 1 = premier. Un modèle à zéro est absent du tracé. Les ex æquo partagent un rang ; Autres est exclu. Le rang ne mesure pas l’amplitude du changement.',
  };
}
export function ridgeline(rows: readonly PrototypeRow[]): Plot {
  const grouped = new Map<string, PrototypeRow[]>();
  for (const r of rows) {
    if (!r.day) {
      continue;
    }
    const key = weekFor(r.day);
    const group = grouped.get(key) ?? [];
    group.push(r);
    grouped.set(key, group);
  }
  const weeks = [...grouped.keys()].sort().slice(-6);
  const marks: Mark[] = [];
  const bins = [0, 1000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, Number.POSITIVE_INFINITY];
  const counts = weeks.map((w) => {
    const a = new Array(7).fill(0);
    for (const row of grouped.get(w) ?? []) {
      const i = bins.findIndex((v, j) => j < bins.length - 1 && row.tokens >= v && row.tokens < required(bins[j + 1]));
      if (i >= 0) {
        a[i] = required(a[i]) + 1;
      }
    }
    return a;
  });
  const maxPercent = Math.max(
    1,
    ...counts.flatMap((a, i) => a.map((v) => (v / (grouped.get(required(weeks[i]))?.length ?? 1)) * 100)),
  );
  counts.forEach((a, i) => {
    const base = 115 + i * 62,
      n = grouped.get(required(weeks[i]))!.length;
    marks.push(text(15, base, `${required(weeks[i]).slice(5)} · n=${n}`));
    let d = `M150,${base}`;
    a.forEach((v, j) => {
      const y = base - (((v / n) * 100) / maxPercent) * 90;
      d += ` L${150 + j * 115},${y} L${150 + (j + 1) * 115},${y}`;
    });
    d += ` L955,${base} Z`;
    marks.push({ kind: 'path', d, color: required(colors[0]), opacity: 0.36, title: `${weeks[i]} : ${n} sessions` });
  });
  ['0–1k', '1–10k', '10–100k', '100k–1M', '1–10M', '10–100M', '≥100M'].forEach((label, j) => {
    marks.push(text(207 + j * 115, 125 + weeks.length * 62, label, 'middle'));
  });
  marks.push(text(150, 25, `Part des sessions par classe · hauteur max. commune : ${Math.round(maxPercent)} %`));
  return {
    marks,
    height: 170 + weeks.length * 62,
    label: 'Distribution hebdomadaire des tokens par session',
    legend: [],
    headers: ['Semaine', 'Sessions', '<1k', '1–10k', '10–100k', '100k–1M', '1–10M', '10–100M', '≥100M'],
    rows: weeks.map((w, i) => [w, String(grouped.get(w)!.length), ...required(counts[i]).map(String)]),
    note: 'Hauteur = proportion de sessions par classe, sans lissage. Les classes sont logarithmiques et de largeurs numériques différentes : ce tracé compare des proportions, pas une densité. Sessions individuelles, jamais campagnes additionnées aux membres.',
  };
}
export function campaignOptions(rows: readonly PrototypeRow[]) {
  const groups = new Map<
    string,
    { key: string; label: string; tokens: number; count: number; rootId: string | null; day: string }
  >();
  for (const r of rows) {
    const c = groups.get(r.campaign) ?? {
      key: r.campaign,
      label: r.campaignLabel,
      tokens: 0,
      count: 0,
      rootId: null,
      day: '',
    };
    c.tokens += r.tokens;
    c.count++;
    if (r.root) {
      c.rootId = r.id;
    }
    if (r.day && r.day > c.day) {
      c.day = r.day;
    }
    groups.set(r.campaign, c);
  }
  return [...groups.values()].filter((c) => c.count > 1).sort((a, b) => b.tokens - a.tokens);
}
export function campaignPartition(rows: readonly PrototypeRow[], key: string, zoom: string): Plot {
  const members = rows.filter((r) => r.campaign === key);
  const bySource = new Map(members.flatMap((r) => (r.sourceId ? [[r.sourceId, r] as const] : [])));
  const children = new Map<string, PrototypeRow[]>();
  const roots: PrototypeRow[] = [];
  let unresolved = 0;
  for (const r of members) {
    const parent = r.parentId ? bySource.get(r.parentId) : undefined;
    if (parent && parent.id !== r.id) {
      const list = children.get(parent.id) ?? [];
      list.push(r);
      children.set(parent.id, list);
    } else {
      roots.push(r);
      if (r.parentId) {
        unresolved++;
      }
    }
  }
  const weight = (r: PrototypeRow, seen = new Set<string>()): number => {
    if (seen.has(r.id)) {
      return 0;
    }
    const next = new Set(seen).add(r.id);
    return r.tokens + (children.get(r.id) ?? []).reduce((s, c) => s + weight(c, next), 0);
  };
  const selected = members.find((r) => r.id === zoom);
  const tops = selected ? [selected] : roots;
  const denominator = tops.reduce((s, r) => s + weight(r), 0);
  const marks: Mark[] = [];
  let maxDepth = 0;
  const cap = 5;
  let collapsed = 0;
  function visit(r: PrototypeRow, start: number, depth: number, seen: Set<string>) {
    if (seen.has(r.id)) {
      return;
    }
    const next = new Set(seen).add(r.id);
    const value = weight(r),
      width = denominator ? (value / denominator) * 950 : 0;
    maxDepth = Math.max(maxDepth, depth);
    const color = required(colors[members.indexOf(r) % colors.length]);
    marks.push({
      kind: 'rect',
      x: 40 + start,
      y: 70 + depth * 76,
      width: Math.max(0, width - 2),
      height: 65,
      color,
      opacity: 0.56,
      title: `${r.label} · ${exact(r.tokens)} tokens propres · ${exact(value)} avec descendants`,
    });
    if (width > 80) {
      marks.push(text(48 + start, 94 + depth * 76, short(r.label, Math.max(7, Math.floor(width / 8)))));
      marks.push(text(48 + start, 116 + depth * 76, `${fmt(value)} · propre ${fmt(r.tokens)}`));
    }
    const kids = children.get(r.id) ?? [];
    if (depth >= cap) {
      collapsed += kids.length;
      return;
    }
    if (kids.length) {
      let cursor = start;
      const ownWidth = denominator ? (r.tokens / denominator) * 950 : 0;
      if (ownWidth > 0) {
        marks.push({
          kind: 'rect',
          x: 40 + cursor,
          y: 70 + (depth + 1) * 76,
          width: Math.max(0, ownWidth - 2),
          height: 65,
          color,
          opacity: 0.25,
          title: `${r.label} · tokens propres ${exact(r.tokens)}`,
        });
        if (ownWidth > 75) {
          marks.push(text(48 + cursor, 106 + (depth + 1) * 76, `Propre ${fmt(r.tokens)}`));
        }
        maxDepth = Math.max(maxDepth, depth + 1);
        cursor += ownWidth;
      }
      for (const child of kids) {
        visit(child, cursor, depth + 1, next);
        cursor += denominator ? (weight(child) / denominator) * 950 : 0;
      }
    }
  }
  let cursor = 0;
  for (const r of tops) {
    visit(r, cursor, 0, new Set());
    cursor += denominator ? (weight(r) / denominator) * 950 : 0;
  }
  marks.unshift(text(40, 25, `${fmt(denominator)} tokens · largeur = volume · profondeur = filiation observée`));
  return {
    marks,
    height: 170 + maxDepth * 76,
    label: 'Partition des tokens de la campagne et de ses branches',
    legend: [],
    headers: ['Session', 'Tokens propres', 'Tokens avec descendants', 'Parent observé'],
    rows: members.map((r) => [
      r.label,
      exact(r.tokens),
      exact(weight(r)),
      r.parentId ? (bySource.get(r.parentId)?.label ?? 'Hors campagne / non résolu') : 'Non déclaré',
    ]),
    note: `${members.length} sessions. ${unresolved} parent(s) hors du groupe ; ${collapsed} branche(s) repliée(s) au niveau ${cap}. Chaque session contribue une seule fois au total ; les niveaux ne s’additionnent pas. Le zoom change l’échelle.`,
  };
}
export function campaignArcs(snapshot: DatavizPrototypeSnapshot, key: string, round: number): Plot {
  const members = snapshot.rows.filter((r) => r.campaign === key);
  const root = members.find((r) => r.root);
  const detail = snapshot.details.find((d) => d.rowId === root?.id);
  const ordered = [...members].sort(
    (a, b) => Number(b.root) - Number(a.root) || (a.day ?? '').localeCompare(b.day ?? '') || b.tokens - a.tokens,
  );
  const shown = ordered.slice(0, 16);
  const indices = new Map(shown.map((r, i) => [r.id, i]));
  const bySource = new Map(members.flatMap((r) => (r.sourceId ? [[r.sourceId, r] as const] : [])));
  const edges = new Map<string, { from: number; to: number; count: number; kind: string }>();
  let unknown = 0;
  let outside = 0;
  for (const r of shown) {
    const parent = r.parentId ? bySource.get(r.parentId) : undefined;
    const from = parent ? indices.get(parent.id) : undefined;
    const to = indices.get(r.id);
    if (from !== undefined && to !== undefined) {
      edges.set(`parent:${r.id}`, { from, to, count: 1, kind: 'Filiation' });
    }
  }
  for (const interaction of detail?.interactions ?? []) {
    if (interaction.round === null) {
      unknown++;
      continue;
    }
    if (interaction.round > round) {
      continue;
    }
    const from = root ? indices.get(root.id) : undefined;
    const to = interaction.to ? indices.get(interaction.to) : undefined;
    if (from === undefined || to === undefined) {
      if (interaction.to) {
        outside++;
      } else {
        unknown++;
      }
      continue;
    }
    const k = `${interaction.kind}:${to}`;
    const prev = edges.get(k);
    edges.set(k, {
      from,
      to,
      count: (prev?.count ?? 0) + 1,
      kind: interaction.kind === 'message' ? 'Message' : 'Lancement',
    });
  }
  const marks: Mark[] = [text(40, 25, 'Sessions alignées · liens de filiation et interactions observées')];
  const x = (i: number) => 60 + (i * 900) / Math.max(shown.length - 1, 1),
    baseline = 330;
  for (const e of edges.values()) {
    const a = x(e.from),
      b = x(e.to),
      height = Math.min(270, Math.abs(a - b) * 0.45 + 40);
    marks.push({
      kind: 'path',
      d: `M${a},${baseline} Q${(a + b) / 2},${baseline - height * 2} ${b},${baseline}`,
      color: e.kind === 'Filiation' ? '#8b8994' : required(colors[0]),
      stroke: true,
      width: e.kind === 'Message' ? 2 + Math.log2(e.count) : 2,
      dash: e.kind === 'Message' ? '6 5' : '',
      opacity: 0.75,
      title: `${required(shown[e.from]).label} → ${required(shown[e.to]).label} · ${e.kind} ×${e.count}`,
    });
  }
  shown.forEach((r, i) => {
    marks.push({
      kind: 'circle',
      x: x(i),
      y: baseline,
      r: 5,
      color: r.root ? 'var(--colors-ink)' : required(colors[0]),
      title: r.label,
    });
    marks.push(text(x(i), 355, String(i + 1), 'middle'));
  });
  return {
    marks,
    height: 395,
    label: 'Relations de délégation de la campagne',
    legend: [
      { label: 'Filiation observée', color: '#8b8994' },
      { label: 'Lancement / message (pointillés)', color: required(colors[0]) },
    ],
    headers: ['Type', 'Repère', 'Session / relation', 'Tokens propres / occurrences'],
    rows: [
      ...shown.map((r, i) => ['Session', String(i + 1), r.label, exact(r.tokens)]),
      ...[...edges.values()].map((e) => [
        e.kind,
        `${e.from + 1} → ${e.to + 1}`,
        `${required(shown[e.from]).label} → ${required(shown[e.to]).label}`,
        String(e.count),
      ]),
    ],
    note: `${shown.length}/${members.length} sessions affichées ; ${unknown} interaction(s) non situable(s), ${outside} vers des membres hors vue. ${detail?.status === 'available' ? `${detail.interactions.length} interactions enregistrées pour la racine. ${detail.note}` : 'Détails de rounds non capturés pour cette campagne.'} Les liens gris prouvent la filiation uniquement, sans heure ni round inventés.`,
  };
}
