/**
 * Cloudflare Workers entrypoint. Identical proxy logic to the Node build,
 * just wired up through the Worker `fetch` export.
 *
 * Deploy:
 *   npx wrangler deploy
 *
 * Dev:
 *   npx wrangler dev
 *
 * Config lives in wrangler.toml.
 */

import { createProxy, type ProxyConfig } from './core/proxy.js';
import type { TransformOptions } from './core/transform.js';
import { toTrackEvent, JsonLogTracker, noopTracker, type Tracker } from './core/tracker.js';

export interface Env {
  ANTHROPIC_UPSTREAM?: string;
  /** Optional override — if set, replaces whatever x-api-key the client sent. */
  ANTHROPIC_API_KEY?: string;
  COMPRESS?: string;
  COMPRESS_TOOLS?: string;
  COMPRESS_SCHEMAS?: string;
  COMPRESS_REMINDERS?: string;
  COMPRESS_TOOL_RESULTS?: string;
  /** Variant C history-image compression. OFF by default — round-3 spec
   *  rated savings as MARGINAL vs HIGH cache-topology risk. */
  COMPRESS_HISTORY?: string;
  HISTORY_KEEP_TAIL?: string;
  HISTORY_MIN_PREFIX?: string;
  MIN_COMPRESS_CHARS?: string;
  MIN_REMINDER_CHARS?: string;
  MIN_TOOL_RESULT_CHARS?: string;
  PLACEMENT?: string;
  COLS?: string;
  /** When "0" / "false", disable per-request event JSON logs. Default-on.
   *  Cloudflare ingests console.log as Workers Logs; pipe via Logpush to
   *  R2/S3 for the same JSONL shape Node writes to disk. */
  PIXELPIPE_TRACK?: string;
}

const truthy = (v: string | undefined, fallback: boolean): boolean =>
  v == null ? fallback : v === '1' || v.toLowerCase() === 'true';

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const transform: TransformOptions = {
      compress: truthy(env.COMPRESS, true),
      compressTools: truthy(env.COMPRESS_TOOLS, true),
      compressSchemas: truthy(env.COMPRESS_SCHEMAS, true),
      compressReminders: truthy(env.COMPRESS_REMINDERS, true),
      compressToolResults: truthy(env.COMPRESS_TOOL_RESULTS, true),
      // Variant C history-image: OFF by default. Round-3 spec marks the
      // savings as MARGINAL (~1% per-call) against HIGH cache-topology risk.
      // Flip via COMPRESS_HISTORY=1 once telemetry confirms safe rollout.
      compressHistory: truthy(env.COMPRESS_HISTORY, false),
      historyKeepTail: env.HISTORY_KEEP_TAIL ? Number(env.HISTORY_KEEP_TAIL) : 4,
      historyMinPrefix: env.HISTORY_MIN_PREFIX ? Number(env.HISTORY_MIN_PREFIX) : 10,
      minCompressChars: env.MIN_COMPRESS_CHARS ? Number(env.MIN_COMPRESS_CHARS) : 2000,
      // Raised to 10,000 — per-block break-even point at current renderer
      // config (Unifont 10px, cell 5×11, 100 cols). Real gate is
      // `isCompressionProfitable()` in transform.ts; this is a fast-path
      // skip for obvious-no cases. Keep in sync with DEFAULTS.
      minReminderChars: env.MIN_REMINDER_CHARS ? Number(env.MIN_REMINDER_CHARS) : 10000,
      minToolResultChars: env.MIN_TOOL_RESULT_CHARS ? Number(env.MIN_TOOL_RESULT_CHARS) : 10000,
      placement: (env.PLACEMENT as 'system' | 'user') ?? 'user',
      cols: env.COLS ? Number(env.COLS) : 100,
    };
    const trackingOn = truthy(env.PIXELPIPE_TRACK, true);
    // Workers Logs ingests stdout as separate log lines. Emit one JSON line
    // per event so downstream (Logpush → R2/S3) reads the same JSONL shape
    // the Node host writes to disk.
    const tracker: Tracker = trackingOn ? new JsonLogTracker((s) => console.log(s)) : noopTracker;

    const config: ProxyConfig = {
      upstream: env.ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com',
      apiKey: env.ANTHROPIC_API_KEY,
      transform,
      onRequest: (e) => {
        // Terse human-readable line (separate from the JSON event below;
        // shows up in `wrangler tail`).
        const tag = e.info?.compressed
          ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B`
          : (e.info?.reason ?? '');
        const cacheRead = e.usage?.cache_read_input_tokens ?? 0;
        console.log(`${e.method} ${e.path} → ${e.status} (${e.durationMs}ms) ${tag} cache_read=${cacheRead}`);

        if (e.info?.unknownStaticTags && e.info.unknownStaticTags.length > 0) {
          console.warn(
            `[pixelpipe warn] unknown tag(s) in static slab: ${e.info.unknownStaticTags.join(', ')}`,
          );
        }

        tracker.emit(toTrackEvent(e));
      },
    };
    const handle = createProxy(config);
    return handle(req);
  },
};
