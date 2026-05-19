/**
 * Live dashboard for the Node host. Serves an HTML page + four JSON/PNG
 * endpoints that poll for fresh data every ~2s:
 *
 *   GET /             , GET /dashboard       → HTML page
 *   GET /proxy-stats                          → JSON aggregate (running totals)
 *   GET /proxy-recent                         → JSON ring buffer of recent requests
 *   GET /proxy-latest-png[?crop=N]            → raw PNG of the latest rendered image
 *
 * Metric formulas and HTML shell originally ported from the Python reference
 * implementation (deleted after live cache-rate validation hit 98.7% by tokens).
 *
 * Node-only by design (uses node:fs for startup replay + node:zlib for the
 * preview crop). The Worker host doesn't expose a dashboard; use Workers Logs.
 *
 * Memory bound: ring buffer cap 50 events + ONE latest PNG (replaced on each
 * compressed request). At a typical 75 KB PNG that's well under 1 MB resident.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { ProxyEvent } from './core/proxy.js';
import type { TrackEvent } from './core/tracker.js';

const RECENT_CAP = 50;

/** One row in the dashboard's "recent requests" table. Compact on purpose —
 *  this lives in memory and gets serialized on every poll. */
export interface RecentRow {
  ts: number;
  method: string;
  path: string;
  status: number;
  size_in?: number;
  compressed: boolean;
  cc_added?: number;
  expected_image_tokens?: number;
  input_tokens?: number;
  cache_create?: number;
  cache_read?: number;
  effective_actual?: number;
  effective_baseline?: number;
  /** How much the running "saved" total moved on this request. */
  session_saved_so_far_delta?: number;
}

/** Aggregate over the whole session. Reset on process restart unless
 *  replay() is called to seed from the JSONL file. */
interface Totals {
  requests: number;
  compressedRequests: number;
  /** Sum of weighted-token cost we actually paid upstream. */
  effectiveInputActual: number;
  /** Sum of estimated cost if we had NOT compressed. */
  effectiveInputBaselineEst: number;
  startedAt: number;
}

/** Empirical per-image token cost (Opus 4.x at our typical 808×1568 render).
 *  history-researcher's round-3 measurement on N=33 cold-miss events from
 *  events.jsonl (2026-05-18) found the real billable cost averages
 *  ~2,300–2,750 tokens per image; we use 2,500 as the working constant.
 *
 *  The documented theoretical max (Anthropic's published `(w*h)/750`
 *  formula) gives ~1,690 tokens for our render shape and underpredicts
 *  what we actually get billed. The prior implementation here was even
 *  more optimistic — `pngBytes / 375` came out to ~190 tokens, off by
 *  ~12×. That bug made the dashboard's "saved" column wildly overstate
 *  the actual cost reduction.
 *
 *  See /tmp/pixelpipe-history-compression.md for the analysis. */
const OPUS_IMAGE_TOKEN_COST = 2500;

/** Estimated token cost of the N images we emit per compressed request. */
function estImageTokens(imageCount: number): number {
  return imageCount * OPUS_IMAGE_TOKEN_COST;
}

/** Compute the weighted "effective" input cost of a single upstream call.
 *  Matches Python's formula: input + cache_create*1.25 + cache_read*0.10.
 *  cache_create is billed at 1.25× to amortize the first-turn cost; cache_read
 *  at 0.10× is Anthropic's published rate. */
function effectiveCost(
  inputTokens: number,
  cacheCreate: number,
  cacheRead: number,
): number {
  return inputTokens + cacheCreate * 1.25 + cacheRead * 0.1;
}

/** Estimate what the call WOULD have cost if we hadn't compressed. Adds back
 *  the text tokens we removed (minus the image tokens we added) at the SAME
 *  cache mix the actual call paid — otherwise cold-cache turns get scored as
 *  if the baseline were warm-cache and savings look tiny.
 *
 *  Uses `imageCount × OPUS_IMAGE_TOKEN_COST` (=2500/image, empirical from
 *  N=33 cold-miss events 2026-05-18) to estimate image tokens. Prior
 *  implementation used `pngBytes / 375` ≈ 190 tokens/image — wrong by
 *  ~12×, which made the "saved" column wildly overstate cost reduction.
 *  See estImageTokens() above for the analysis link.
 */
function baselineCost(
  actualEff: number,
  origChars: number,
  imageCount: number,
  cacheCreate: number,
  cacheRead: number,
): number {
  const txtReplaced = Math.floor(origChars / 4); // ~4 chars per token in English
  const imgTokensEst = estImageTokens(imageCount);
  const extraText = Math.max(0, txtReplaced - imgTokensEst);
  const cachedTotal = cacheCreate + cacheRead;
  const baselineRate =
    cachedTotal > 0 ? (cacheCreate / cachedTotal) * 1.25 + (cacheRead / cachedTotal) * 0.1 : 0.1;
  return actualEff + extraText * baselineRate;
}

export class DashboardState {
  private recent: RecentRow[] = [];
  private totals: Totals = {
    requests: 0,
    compressedRequests: 0,
    effectiveInputActual: 0,
    effectiveInputBaselineEst: 0,
    startedAt: Date.now() / 1000,
  };
  private latestPng: Uint8Array | null = null;
  private latestPngMeta = '';
  private latestPngWidth = 0;
  private latestPngHeight = 0;

  /** Stash the latest rendered image (called from onRequest with the raw
   *  ProxyEvent before info.firstImagePng is dropped by toTrackEvent). */
  captureImage(info: NonNullable<ProxyEvent['info']>): void {
    if (!info.firstImagePng) return;
    this.latestPng = info.firstImagePng;
    this.latestPngWidth = info.firstImageWidth ?? 0;
    this.latestPngHeight = info.firstImageHeight ?? 0;
    const kb = (info.firstImagePng.length / 1024).toFixed(1);
    this.latestPngMeta =
      `${this.latestPngWidth}×${this.latestPngHeight} · ${kb} KB · ` +
      `${info.imageCount ?? 0} image${info.imageCount === 1 ? '' : 's'} total`;
  }

  /** Fold one event into the running totals + ring buffer. */
  update(ev: ProxyEvent): void {
    // Stash the image bytes before they get GC'd by the request finishing.
    if (ev.info) this.captureImage(ev.info);

    const u = ev.usage;
    const info = ev.info;
    const compressed = info?.compressed === true;

    // No upstream usage data → we can still count the request, but skip the
    // savings math (Python does the same).
    const inp = u?.input_tokens ?? 0;
    const out = u?.output_tokens ?? 0;
    const cc = u?.cache_creation_input_tokens ?? 0;
    const cr = u?.cache_read_input_tokens ?? 0;
    const haveUsage = u !== undefined && (inp > 0 || out > 0 || cc > 0 || cr > 0);

    const eff = haveUsage ? effectiveCost(inp, cc, cr) : 0;
    const baselineEff =
      haveUsage && compressed
        ? baselineCost(eff, info?.origChars ?? 0, info?.imageCount ?? 0, cc, cr)
        : eff;

    const prevSaved = this.totals.effectiveInputBaselineEst - this.totals.effectiveInputActual;
    this.totals.requests += 1;
    if (compressed) this.totals.compressedRequests += 1;
    this.totals.effectiveInputActual += eff;
    this.totals.effectiveInputBaselineEst += baselineEff;
    const savedNow = this.totals.effectiveInputBaselineEst - this.totals.effectiveInputActual;

    const row: RecentRow = {
      ts: Date.now() / 1000,
      method: ev.method,
      path: ev.path,
      status: ev.status,
      compressed,
      cc_added: compressed ? 1 : undefined, // we always emit exactly one cache_control
      expected_image_tokens: compressed ? estImageTokens(info?.imageCount ?? 0) : undefined,
      input_tokens: haveUsage ? inp : undefined,
      cache_create: haveUsage ? cc : undefined,
      cache_read: haveUsage ? cr : undefined,
      effective_actual: haveUsage ? round1(eff) : undefined,
      effective_baseline: haveUsage ? round1(baselineEff) : undefined,
      session_saved_so_far_delta: haveUsage ? round1(savedNow - prevSaved) : undefined,
    };
    this.recent.push(row);
    if (this.recent.length > RECENT_CAP) this.recent.splice(0, this.recent.length - RECENT_CAP);
  }

  /** On startup, fold the last N entries from the JSONL events file back
   *  into the ring buffer so a process restart doesn't show an empty table.
   *  Cumulative totals are *not* restored (the file may have rotated, and
   *  double-counting is worse than starting fresh). */
  async replay(filePath: string): Promise<void> {
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      return; // no file yet, nothing to replay
    }
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const tail: TrackEvent[] = [];
    for await (const line of rl) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as TrackEvent;
        tail.push(ev);
        if (tail.length > RECENT_CAP) tail.shift();
      } catch {
        /* skip malformed line */
      }
    }
    for (const t of tail) {
      const row: RecentRow = {
        ts: Date.parse(t.ts) / 1000,
        method: t.method,
        path: t.path,
        status: t.status,
        compressed: t.compressed === true,
        cc_added: t.compressed === true ? 1 : undefined,
        expected_image_tokens:
          t.compressed === true ? estImageTokens(t.image_count ?? 0) : undefined,
        input_tokens: t.input_tokens,
        cache_create: t.cache_create_tokens,
        cache_read: t.cache_read_tokens,
        effective_actual:
          t.input_tokens !== undefined
            ? round1(
                effectiveCost(
                  t.input_tokens ?? 0,
                  t.cache_create_tokens ?? 0,
                  t.cache_read_tokens ?? 0,
                ),
              )
            : undefined,
      };
      this.recent.push(row);
    }
  }

  // ---- HTTP handlers ------------------------------------------------------

  serveStats(): Response {
    const saved = this.totals.effectiveInputBaselineEst - this.totals.effectiveInputActual;
    const pct =
      this.totals.effectiveInputBaselineEst > 0
        ? (saved / this.totals.effectiveInputBaselineEst) * 100
        : 0;
    const uptimeSec = Date.now() / 1000 - this.totals.startedAt;
    const payload = {
      requests: this.totals.requests,
      compressed_requests: this.totals.compressedRequests,
      effective_input_actual: round1(this.totals.effectiveInputActual),
      effective_input_baseline_est: round1(this.totals.effectiveInputBaselineEst),
      saved_effective_tokens: round1(saved),
      saved_pct: round1(pct),
      saved_usd_opus47: round4((saved * 15.0) / 1e6),
      uptime_sec: uptimeSec,
    };
    return new Response(JSON.stringify(payload, null, 2), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });
  }

  serveRecent(): Response {
    const payload = {
      recent: this.recent,
      has_preview: this.latestPng !== null,
      preview_meta: this.latestPngMeta,
    };
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });
  }

  servePng(): Response {
    // Cropping is done client-side via CSS (object-position + overflow:hidden).
    // Python decoded the PNG to crop server-side; we skip that to avoid
    // pulling a PNG decoder back in — the CSS approach renders identically.
    if (!this.latestPng) {
      return new Response('no image yet', { status: 404 });
    }
    return new Response(this.latestPng as unknown as BodyInit, {
      headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
    });
  }

  serveHtml(port: number): Response {
    return new Response(DASHBOARD_HTML.replace(/__PORT__/g, String(port)), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Match dashboard paths (handle query strings on /proxy-latest-png). */
export function dashboardPath(pathname: string): 'html' | 'stats' | 'recent' | 'png' | null {
  if (pathname === '/' || pathname === '/dashboard') return 'html';
  if (pathname === '/proxy-stats') return 'stats';
  if (pathname === '/proxy-recent') return 'recent';
  if (pathname === '/proxy-latest-png') return 'png';
  return null;
}

// ---- inline HTML template -------------------------------------------------

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pixelpipe — live dashboard</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0d1117; color: #c9d1d9;
         font: 14px/1.45 -apple-system,BlinkMacSystemFont,"SF Mono",Menlo,monospace; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { color: #6e7681; font-size: 12px; margin-bottom: 22px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 22px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
          padding: 14px 16px; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
                 color: #8b949e; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: 600; color: #e6edf3; font-variant-numeric: tabular-nums; }
  .card .small { font-size: 11px; color: #6e7681; margin-top: 4px; }
  .pos { color: #3fb950 !important; }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
           padding: 14px 16px; margin-bottom: 14px; }
  .panel h2 { font-size: 13px; font-weight: 600; color: #8b949e; margin: 0 0 10px;
              text-transform: uppercase; letter-spacing: 0.08em; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #6e7681; font-weight: 500; padding: 6px 8px;
       border-bottom: 1px solid #30363d; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  td { padding: 6px 8px; border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  td.num { text-align: right; }
  td.good { color: #3fb950; }
  td.warn { color: #d29922; }
  td.bad  { color: #f85149; }
  /* Crop the preview to its top-left at native resolution. The full image is
     1466x1568, which would be unreadably small if scaled down to the panel. */
  .preview-crop { width: 100%; height: 480px; overflow: hidden;
                  background: #fff; border: 1px solid #30363d; border-radius: 4px; padding: 4px; }
  .preview-crop img { display: block; image-rendering: pixelated;
                      width: auto; height: auto; max-width: none; }
  .row { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } .row { grid-template-columns: 1fr; } }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
         background: #3fb950; margin-right: 6px; vertical-align: middle;
         animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
</style>
</head>
<body>
<h1><span class="dot"></span>pixelpipe</h1>
<div class="sub" id="sub">connecting...</div>

<div class="grid">
  <div class="card"><div class="label">requests</div>
    <div class="value" id="m_req">0</div>
    <div class="small" id="m_req_sub">— compressed</div>
  </div>
  <div class="card"><div class="label">tokens saved</div>
    <div class="value pos" id="m_saved">0</div>
    <div class="small" id="m_saved_sub">effective input tokens</div>
  </div>
  <div class="card"><div class="label">$ saved (opus 4.7)</div>
    <div class="value pos" id="m_usd">$0.00</div>
    <div class="small" id="m_usd_sub">at $15/M input tokens</div>
  </div>
  <div class="card"><div class="label">reduction</div>
    <div class="value pos" id="m_pct">0%</div>
    <div class="small" id="m_pct_sub">vs uncompressed baseline</div>
  </div>
</div>

<div class="row">
  <div class="panel">
    <h2>recent requests</h2>
    <table>
      <thead>
        <tr>
          <th>#</th><th>status</th><th>path</th>
          <th class="num">cc</th><th class="num">img tok</th>
          <th class="num">actual</th><th class="num">saved</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="panel">
    <h2>latest rendered image</h2>
    <div id="preview_wrap"><div class="sub">(none yet)</div></div>
    <div class="small" id="preview_meta" style="margin-top:8px;color:#6e7681"></div>
  </div>
</div>

<script>
async function tick() {
  try {
    const s = await fetch('/proxy-stats').then(r => r.json());
    const r = await fetch('/proxy-recent').then(r => r.json());
    document.getElementById('sub').textContent =
      \`port :__PORT__   ·   uptime \${formatDuration(s.uptime_sec)}   ·   live\`;
    document.getElementById('m_req').textContent = s.requests;
    document.getElementById('m_req_sub').textContent = \`\${s.compressed_requests} compressed\`;
    document.getElementById('m_saved').textContent = numFmt(s.saved_effective_tokens);
    document.getElementById('m_saved_sub').textContent =
      \`\${numFmt(s.effective_input_actual)} paid · \${numFmt(s.effective_input_baseline_est)} baseline\`;
    document.getElementById('m_usd').textContent = \`$\${s.saved_usd_opus47.toFixed(4)}\`;
    document.getElementById('m_pct').textContent = \`\${s.saved_pct.toFixed(1)}%\`;
    const tbody = document.getElementById('rows');
    tbody.innerHTML = '';
    let i = 0;
    for (const e of r.recent.slice().reverse()) {
      const tr = document.createElement('tr');
      const statusCls = e.status >= 500 ? 'bad' : e.status >= 400 ? 'warn' : 'good';
      const saved = (e.session_saved_so_far_delta || 0);
      tr.innerHTML =
        \`<td>\${++i}</td>\` +
        \`<td class="num \${statusCls}">\${e.status}</td>\` +
        \`<td>\${escapeHtml((e.path || '').slice(0,40))}</td>\` +
        \`<td class="num">\${e.cc_added ?? '—'}</td>\` +
        \`<td class="num">\${numFmt(e.expected_image_tokens || 0)}</td>\` +
        \`<td class="num">\${numFmt(e.effective_actual || 0)}</td>\` +
        \`<td class="num pos">\${saved > 0 ? '+' + numFmt(saved) : '—'}</td>\`;
      tbody.appendChild(tr);
    }
    if (r.has_preview) {
      const wrap = document.getElementById('preview_wrap');
      wrap.innerHTML =
        '<div class="preview-crop">' +
        '<img src="/proxy-latest-png?t=' + Date.now() + '">' +
        '</div>';
      document.getElementById('preview_meta').textContent =
        (r.preview_meta || '') + ' — showing top-left at native resolution';
    }
  } catch (e) {
    document.getElementById('sub').textContent = 'proxy unreachable';
  }
}
function numFmt(n) {
  n = Math.round(Number(n) || 0);
  return n.toLocaleString();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function formatDuration(s) {
  s = Math.floor(s);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return (h>0?h+'h ':'') + (m>0?m+'m ':'') + sec + 's';
}
tick(); setInterval(tick, 2000);
</script>
</body></html>
`;
