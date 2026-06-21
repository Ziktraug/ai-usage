export const fmtNum = (n: number) => {
  if (!Number.isFinite(n)) {
    return '';
  }
  const abs = Math.abs(n);
  if (abs >= 1e9) {
    return `${(n / 1e9).toFixed(2)}B`;
  }
  if (abs >= 1e6) {
    return `${(n / 1e6).toFixed(2)}M`;
  }
  if (abs >= 1e3) {
    return `${(n / 1e3).toFixed(1)}K`;
  }
  return String(Math.round(n));
};

export const fmtDate = (d: Date | null) => {
  if (!d) {
    return '';
  }
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const fmtDur = (ms: number | null) => {
  if (ms == null || ms <= 0) {
    return '';
  }
  const s = ms / 1000;
  if (s < 90) {
    return `${Math.round(s)}s`;
  }
  if (s < 5400) {
    return `${Math.round(s / 60)}m`;
  }
  return `${(s / 3600).toFixed(1)}h`;
};

export const trunc = (s: string, w: number) => (s.length <= w ? s : `${s.slice(0, w - 1)}…`);

export const pad = (s: string, w: number, right = false) => (right ? s.padStart(w) : s.padEnd(w));

export const median = (a: number[]) => {
  if (!a.length) {
    return 0;
  }
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
