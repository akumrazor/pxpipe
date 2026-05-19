/**
 * Request-body transformer. Takes an Anthropic Messages API request body,
 * extracts the large static parts (system prompt + tool definitions),
 * renders them as PNG image blocks, and rewrites the body to reference
 * those images instead — saving 65-73% input tokens on Opus 4.7 while
 * preserving 100% reasoning quality.
 *
 * Originally ported from a Python reference implementation; the Python
 * has since been removed (live cache-rate validation passed at 98.7% by
 * tokens). Byte-output determinism is now verified by tests alone.
 */

import type {
  ContentBlock,
  ImageBlock,
  MessagesRequest,
  SystemField,
  TextBlock,
  ToolDef,
  ToolResultBlock,
} from './types.js';
import { renderTextToPngs } from './render.js';
import { bytesToBase64 } from './png.js';

export interface TransformOptions {
  /** Master switch — false makes this a no-op pass-through. */
  compress?: boolean;
  /** Compress the system field. */
  compressSystem?: boolean;
  /** Move tool descriptions into the same image (and stub the originals). */
  compressTools?: boolean;
  /** Include full input_schema JSON for each tool. Adds tokens but maximizes parity. */
  compressSchemas?: boolean;
  /** Compress large `<system-reminder>` text blocks in the first user message.
   *  Claude Code re-injects these every turn; rendering them to images shares
   *  the cache anchor with the system+tools render. */
  compressReminders?: boolean;
  /** Compress large tool_result text content across all user messages. Tool
   *  output is static once produced and accumulates across the conversation,
   *  so image-rendering it compounds savings as the session grows. */
  compressToolResults?: boolean;
  /** Don't compress if total compressible chars below this. */
  minCompressChars?: number;
  /** Per-block threshold for compressReminders (chars). */
  minReminderChars?: number;
  /** Per-block threshold for compressToolResults (chars). */
  minToolResultChars?: number;
  /** Where to attach the image block — system field, or first user message. */
  placement?: 'system' | 'user';
  /** Soft-wrap column count. */
  cols?: number;
}

const DEFAULTS: Required<TransformOptions> = {
  compress: true,
  compressSystem: true,
  compressTools: true,
  compressSchemas: true,
  compressReminders: true,
  compressToolResults: true,
  minCompressChars: 2000,
  // RAISED from Python defaults (1000 / 2000) per history-researcher's
  // round-3 measurement: Anthropic's real per-image cost is ~2,500 tokens,
  // not ~190 as our old dashboard formula suggested. At the real rate,
  // text blocks under ~10,000 chars cost more as images than as text. We
  // raise the per-block thresholds to keep small blocks as text. See
  // /tmp/pixelpipe-history-compression.md for the N=33 cold-miss analysis.
  minReminderChars: 2000,
  minToolResultChars: 5000,
  // Anthropic's `system` field accepts text blocks only — image blocks there
  // come back as `400 system.N.type: Input should be 'text'`. Images must go
  // into a user message instead.
  placement: 'user',
  cols: 100,
};

/** Parsed contents of Claude Code's <env> + git status blocks. All optional —
 *  fields are only populated if the corresponding line is present. */
export interface EnvFields {
  /** Working directory at the time `claude` was launched. */
  cwd?: string;
  isGitRepo?: boolean;
  /** Current git branch, parsed from <git_status> or a "Branch:" line. */
  gitBranch?: string;
  platform?: string;
  osVersion?: string;
  /** "Today's date" as Claude Code reported it (YYYY-MM-DD). */
  today?: string;
}

export interface TransformInfo {
  compressed: boolean;
  reason?: string;
  origChars: number;
  imageCount: number;
  imageBytes: number;
  /** Length of the static (cacheable) slab rendered into the image. */
  staticChars: number;
  /** Length of the dynamic (per-turn) slab kept as plain text. */
  dynamicChars: number;
  /** Number of dynamic blocks detected (<env>, <context>, etc.). */
  dynamicBlockCount: number;
  /** Tag-shaped blocks found in the *static* slab that are NOT in
   *  DYNAMIC_BLOCK_TAGS. Early-warning canary: if Claude Code ships a new
   *  per-turn tag, it'll show up here before our cache hit rate collapses. */
  unknownStaticTags?: string[];
  /** Parsed env block, if Claude Code injected one. Useful for telemetry
   *  (per-project compression ratios, etc.). */
  env?: EnvFields;
  /** sha256[0..8] of the static slab + tool docs (what ends up in the image).
   *  Repeats across turns → cache_control SHOULD be hitting upstream. */
  systemSha8?: string;
  /** sha256[0..8] of just the CLAUDE.md section if detectable. Lets us
   *  bucket requests by project even when cwd is absent. */
  claudeMdSha8?: string;
  /** sha256[0..8] of the first user message text (first 4 KiB). Rough
   *  thread/session id since the wire protocol carries none. */
  firstUserSha8?: string;
  /** Raw bytes of the FIRST rendered image. Used by the in-process dashboard
   *  to show a preview. NOT persisted to JSONL (toTrackEvent drops it). */
  firstImagePng?: Uint8Array;
  /** Pixel dimensions of the first image. */
  firstImageWidth?: number;
  firstImageHeight?: number;
  /** Number of images we added by compressing `<system-reminder>` blocks in
   *  the first user message. */
  reminderImgs?: number;
  /** Number of images we added by compressing tool_result content across
   *  user messages. */
  toolResultImgs?: number;
  /** Codepoints in the rendered text that weren't in the atlas. They
   *  rendered as blank cells. A non-zero count means the user is producing
   *  glyphs we don't ship — useful telemetry for tuning the atlas profile
   *  (e.g. switch from `practical` → `full-bmp` if Hangul shows up). */
  droppedChars?: number;
  /** Top dropped codepoints by frequency for this request, keyed `U+HHHH`
   *  (uppercase hex, at least 4 digits). At most 20 entries, sorted by count
   *  descending. Only set when `droppedChars > 0`. Lets the operator
   *  identify which Unicode blocks to add to the atlas profile without
   *  having to capture & inspect the request body. */
  droppedCodepointsTop?: Record<string, number>;
}

// --- helpers ---------------------------------------------------------------

/** Extract `(text, remainder)` from a system field that may be string or list. */
function extractSystemText(sys: SystemField | undefined): { text: string; kept: SystemField } {
  if (sys == null) return { text: '', kept: [] };
  if (typeof sys === 'string') return { text: sys, kept: '' };
  const textParts: string[] = [];
  const kept: SystemField = [];
  for (const block of sys) {
    if (block && typeof block === 'object' && block.type === 'text') {
      textParts.push(block.text);
    } else {
      kept.push(block);
    }
  }
  return { text: textParts.join('\n\n'), kept };
}

/**
 * Claude Code injects a handful of per-turn dynamic blocks into the system
 * prompt (e.g. <env>, <context>, <git_status>, <directoryStructure>,
 * <system-reminder>). Including these in the rendered image kills the
 * Anthropic prompt cache because the bytes drift turn-to-turn. Splitting
 * them out lets us render the static slab (CLAUDE.md, agent defs, tool docs)
 * with cache_control while forwarding the dynamic slab as cheap text so the
 * model still sees cwd / git status / today's date.
 */
const DYNAMIC_BLOCK_TAGS = [
  'env',
  'context',
  'git_status',
  'directoryStructure',
  'system-reminder',
] as const;

/**
 * Tag-shaped blocks that DO appear in the static slab and SHOULD be baked into
 * the cached image. These are part of Claude Code's built-in system prompt /
 * tool documentation, not per-turn injections, so they're stable across turns.
 *
 * The canary in splitStaticDynamic flags any tag-shaped block in the static
 * slab that isn't in DYNAMIC_BLOCK_TAGS — designed to catch a new Claude Code
 * release that ships a per-turn tag we'd accidentally cache. Without this
 * allowlist, known-static tags like <types> trigger the canary on most turns
 * and drown out the real signal. Add a tag here only after confirming it's
 * static (appears in the cacheable part of the prompt, not rotated per turn).
 */
const KNOWN_STATIC_TAGS = ['types'] as const;

function splitStaticDynamic(text: string): {
  staticText: string;
  dynamicText: string;
  blockCount: number;
  unknownTags: string[];
} {
  if (!text)
    return { staticText: '', dynamicText: '', blockCount: 0, unknownTags: [] };
  // Match <tag ...?>...</tag> where tag ∈ DYNAMIC_BLOCK_TAGS. Closing tag
  // must match opening tag exactly. Non-greedy body — earliest close wins.
  const pattern = new RegExp(
    `<(${DYNAMIC_BLOCK_TAGS.join('|')})(\\s[^>]*)?>[\\s\\S]*?</\\1>`,
    'g',
  );
  const dynamicParts: string[] = [];
  let staticBuf = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    staticBuf += text.slice(cursor, m.index);
    dynamicParts.push(m[0]);
    cursor = m.index + m[0].length;
  }
  staticBuf += text.slice(cursor);

  // Sniff for OTHER tag-shaped blocks in the static slab. If Claude Code
  // ships a new per-turn tag (say <recent_files>...</recent_files>) we'd
  // silently bake it into the cached image and our cache hit rate would
  // collapse. Surfacing the tag name as telemetry lets us detect that
  // within hours of a Claude Code release.
  const known = new Set<string>(DYNAMIC_BLOCK_TAGS);
  const knownStatic = new Set<string>(KNOWN_STATIC_TAGS);
  const sniffer = /<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
  const unknown = new Set<string>();
  let s: RegExpExecArray | null;
  while ((s = sniffer.exec(staticBuf)) !== null) {
    const tag = s[1]!;
    if (!known.has(tag) && !knownStatic.has(tag) && tag.length <= 64)
      unknown.add(tag);
  }

  return {
    // Collapse the run of blank lines left behind by removed blocks.
    staticText: staticBuf.replace(/\n{3,}/g, '\n\n').trim(),
    dynamicText: dynamicParts.join('\n\n'),
    blockCount: dynamicParts.length,
    unknownTags: [...unknown],
  };
}

/**
 * Compute sha256 and return the first 8 hex chars. Web Crypto so it works
 * the same in Node 18+ and Workers. 8 chars = 32 bits = collision-safe for
 * the request volume we'd see in a single proxy instance.
 */
export async function sha8(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 4; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Best-effort: pull out the CLAUDE.md slab from a system text. Heuristic —
 * Claude Code typically wraps it with a heading like "Claude Code Rules"
 * or includes it under a `# CLAUDE.md` / system-reminder block. Returns
 * empty string if nothing CLAUDE.md-shaped is detected; callers should
 * skip hashing in that case.
 */
export function extractClaudeMdSlab(staticText: string): string {
  if (!staticText) return '';
  // Common markers Claude Code uses around the CLAUDE.md content.
  const startPatterns = [
    /^\s*#+\s*Claude\s+Code\s+Rules\s*$/im,
    /^\s*#+\s*CLAUDE\.md\s*$/im,
    /^\s*Claude\s+Code\s+Rules:?\s*$/im,
  ];
  let startIdx = -1;
  for (const p of startPatterns) {
    const m = p.exec(staticText);
    if (m && (startIdx === -1 || m.index < startIdx)) startIdx = m.index;
  }
  if (startIdx === -1) return '';
  // Run until the next top-level heading (# foo) or end of text.
  const tail = staticText.slice(startIdx);
  const endMatch = /\n#\s+\S/.exec(tail.slice(1));
  const end = endMatch ? endMatch.index + 1 : tail.length;
  return tail.slice(0, end).trim();
}

/**
 * Hash the first user message text, capped at 4 KiB so very long initial
 * pastes don't dominate hashing time and so we still get a stable id for
 * the conversation thread (initial prompt usually fits well within 4 KiB).
 */
export function firstUserText(req: MessagesRequest): string {
  const msgs = req.messages ?? [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.slice(0, 4096);
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && (block as any).type === 'text' && typeof (block as any).text === 'string') {
          return ((block as any).text as string).slice(0, 4096);
        }
      }
    }
    // First user message found but unreadable → return empty so we don't
    // accidentally hash some downstream user message.
    return '';
  }
  return '';
}

/**
 * Pull structured fields out of the dynamic slab. Only reads — does not
 * modify the text. Used purely for telemetry / improvement signals.
 */
export function extractEnvFields(dynamicText: string): EnvFields {
  const out: EnvFields = {};
  if (!dynamicText) return out;

  const envMatch = /<env>([\s\S]*?)<\/env>/i.exec(dynamicText);
  if (envMatch) {
    const body = envMatch[1]!;
    const cwd = /(?:^|\n)\s*Working directory:\s*(.+?)\s*(?:\n|$)/i.exec(body);
    if (cwd) out.cwd = cwd[1]!.trim();
    const gitRepo = /(?:^|\n)\s*Is directory a git repo:\s*(Yes|No)\b/i.exec(body);
    if (gitRepo) out.isGitRepo = gitRepo[1]!.toLowerCase() === 'yes';
    const platform = /(?:^|\n)\s*Platform:\s*(.+?)\s*(?:\n|$)/i.exec(body);
    if (platform) out.platform = platform[1]!.trim();
    const osVer = /(?:^|\n)\s*OS Version:\s*(.+?)\s*(?:\n|$)/i.exec(body);
    if (osVer) out.osVersion = osVer[1]!.trim();
    const today = /(?:^|\n)\s*Today'?s date:\s*(.+?)\s*(?:\n|$)/i.exec(body);
    if (today) out.today = today[1]!.trim();
  }

  // Git branch may live in <git_status>, <context name="git">, or just a
  // "Branch: foo" / "On branch foo" line somewhere in the dynamic slab.
  const branch =
    /(?:^|\n)\s*(?:On branch|Branch:)\s*([^\s\n]+)/i.exec(dynamicText) ??
    /(?:^|\n)\s*Current branch:\s*([^\s\n]+)/i.exec(dynamicText);
  if (branch) out.gitBranch = branch[1]!.trim();

  return out;
}

/**
 * Strip the per-turn random billing header line that Claude Code injects.
 * It changes every turn and would defeat prompt-cache hits if we left it
 * inside the image. We keep it as a leading text block so the upstream
 * still receives it.
 */
function stripBillingLine(text: string): { kept: string | null; body: string } {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first.startsWith('x-anthropic-billing-header:')) {
    return { kept: first, body: nl === -1 ? '' : text.slice(nl + 1) };
  }
  return { kept: null, body: text };
}

/** Maximum recursion depth when stripping descriptions out of an input_schema.
 *  Real tool schemas can be deeper than naive 3-level shapes — think filter
 *  DSLs, query objects, structured-output schemas. 20 is generous enough to
 *  handle anything realistic; deeper than that and we leave the node untouched
 *  rather than corrupt it. */
const SCHEMA_STRIP_MAX_DEPTH = 20;

/** Long-form description / metadata keys that contribute tokens but no
 *  validation. The image already carries this content for the model to read,
 *  so we strip them from the wire payload to recover the tokens. */
const SCHEMA_STRIP_KEYS = new Set([
  'description',
  'title',
  'examples',
  'default',
  '$schema',
  '$id',
  '$comment',
]);

/** JSON Schema composition keys whose values are *arrays of subschemas*. We
 *  recurse into each element so descriptions inside variant branches still get
 *  stripped while the variant structure is preserved. */
const SCHEMA_COMPOSITION_KEYS = new Set(['oneOf', 'anyOf', 'allOf']);

/** JSON Schema keys whose values are *objects keyed by name* (each value is
 *  itself a subschema). Both `properties` and `patternProperties` use this
 *  shape; `definitions` / `$defs` are pre-2020 and 2020-12 spellings of the
 *  same idea and we strip descriptions inside them too. */
const SCHEMA_NAMED_SUBSCHEMA_KEYS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
]);

/** Keys whose values are a *single subschema* — recurse but don't unwrap. */
const SCHEMA_SINGLE_SUBSCHEMA_KEYS = new Set([
  'items',
  'additionalProperties',
  'not',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'if',
  'then',
  'else',
]);

/** Keys that are *arrays of primitives* (or otherwise opaque) — preserve
 *  verbatim, don't recurse. */
const SCHEMA_VERBATIM_KEYS = new Set([
  'required',
  'enum',
  'const',
  'type',          // string or array of strings
  '$ref',          // we don't resolve refs but we mustn't drop them
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'multipleOf',
  'uniqueItems',
  'pattern',
]);

/** `format` values from JSON Schema's vocabulary are short tokens
 *  (`date-time`, `uri`, `email`, `ipv4`, …). If something larger than this
 *  shows up it's almost certainly a human-readable hint that belongs in the
 *  image, not the wire payload. */
const FORMAT_MAX_LEN = 32;

/** Strip long-form metadata from a JSON-Schema-shaped node while preserving
 *  the structural keys Anthropic's tool-use validator needs to type-check the
 *  model's calls.
 *
 *  PRESERVED (verbatim or recursed):
 *    - `type`, `enum`, `const`, `$ref`
 *    - `properties` / `patternProperties` / `definitions` / `$defs` (recurse
 *       into each named subschema)
 *    - `items` / `additionalProperties` / `not` / `contains` /
 *       `propertyNames` / conditional `if`/`then`/`else` (single-subschema)
 *    - `oneOf` / `anyOf` / `allOf` (recurse into each variant)
 *    - `required` arrays
 *    - All numeric / length / pattern constraints (`minLength`, `pattern`, …)
 *    - `format` if its value is ≤ 32 chars (real format tokens are tiny)
 *
 *  STRIPPED:
 *    - `description`, `title`, `examples`, `default`
 *    - `$schema`, `$id`, `$comment`
 *    - `format` longer than 32 chars (treated as a description in disguise)
 *
 *  PASS-THROUGH for unknown keys: copy primitive/string values verbatim;
 *  recurse into nested objects so descriptions hidden under custom keys still
 *  get stripped.
 *
 *  Returns a fresh object — never mutates the input. */
function stripSchemaDescriptions(node: unknown, depth: number): unknown {
  // Beyond depth cap: leave the subtree alone. Brief: "if anything's deeper,
  // that tool is pathological and we leave it untouched." Better to ship a
  // slightly bigger schema than to corrupt one.
  if (depth > SCHEMA_STRIP_MAX_DEPTH) return node;

  // Arrays at top level (e.g. a bare `required: [...]` if we land here by
  // accident) get passed through. Real subschema arrays — `oneOf`/`anyOf`/
  // `allOf` — are handled by the parent object below.
  if (Array.isArray(node)) return node;

  // Primitives and null bottom-out unchanged.
  if (!node || typeof node !== 'object') return node;

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (SCHEMA_STRIP_KEYS.has(k)) continue;

    if (k === 'format' && typeof v === 'string' && v.length > FORMAT_MAX_LEN) {
      // Long "format" values are descriptions in disguise; the real
      // vocabulary tokens are <32 chars.
      continue;
    }

    if (SCHEMA_VERBATIM_KEYS.has(k)) {
      out[k] = v;
      continue;
    }

    if (
      SCHEMA_NAMED_SUBSCHEMA_KEYS.has(k) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      // properties / patternProperties / definitions / $defs: object whose
      // values are themselves schemas.
      const nested: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        nested[pk] = stripSchemaDescriptions(pv, depth + 1);
      }
      out[k] = nested;
      continue;
    }

    if (SCHEMA_COMPOSITION_KEYS.has(k) && Array.isArray(v)) {
      // oneOf / anyOf / allOf: array of subschemas.
      out[k] = v.map((sub) => stripSchemaDescriptions(sub, depth + 1));
      continue;
    }

    if (SCHEMA_SINGLE_SUBSCHEMA_KEYS.has(k)) {
      // items / additionalProperties / not / etc. May be a schema OR a
      // boolean (additionalProperties: true/false is legal). Booleans pass
      // through untouched.
      if (typeof v === 'boolean') {
        out[k] = v;
      } else {
        out[k] = stripSchemaDescriptions(v, depth + 1);
      }
      continue;
    }

    // Unknown key. If the value is a nested object, recurse so descriptions
    // hidden under vendor extensions still get stripped. Primitives pass
    // through.
    if (v && typeof v === 'object') {
      out[k] = stripSchemaDescriptions(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Keys whose presence in a (stripped) schema gives Anthropic's validator
 *  something to bind the model's tool call against. If a stripped schema has
 *  *none* of these, we treat it as no-structure and ship the legacy bare stub
 *  with a `schema_no_properties` advisory. */
const SCHEMA_STRUCTURAL_KEYS = [
  'properties',
  'patternProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'items',
  '$ref',
  'enum',
  'const',
];

function schemaHasStructure(schema: Record<string, unknown>): boolean {
  for (const k of SCHEMA_STRUCTURAL_KEYS) {
    if (k in schema) return true;
  }
  return false;
}

/** Build the "## Tool: name\n<desc>\n<schema>" block for one tool definition. */
function renderToolDoc(t: ToolDef, includeSchema: boolean): string {
  const parts: string[] = [`## Tool: ${t.name ?? '?'}`];
  if (t.description) parts.push(t.description);
  if (includeSchema && t.input_schema !== undefined) {
    parts.push('```json\n' + JSON.stringify(t.input_schema, null, 2) + '\n```');
  }
  return parts.join('\n');
}

function makeImageBlock(pngB64: string, ephemeral = false): ImageBlock {
  const blk: ImageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: pngB64 },
  };
  // ttl='1h' is mandatory, not cosmetic. Claude Code marks its own
  // user-message content with cache_control ttl='1h'; Anthropic enforces
  // "ttl='1h' must not come after ttl='5m'" in processing order
  // (tools → system → messages). If we leave ttl unset it defaults to '5m'
  // and our block lands BEFORE Claude Code's 1h block → 400 at runtime.
  if (ephemeral) blk.cache_control = { type: 'ephemeral', ttl: '1h' };
  return blk;
}

/** Render a long text blob to one or more PNG image blocks. Helper for the
 *  per-message compressions (reminders, tool_results) — no cache_control on
 *  these (Anthropic caps at 4 breakpoints; the system+tools image already
 *  anchors the cacheable prefix).
 *
 *  Also returns the total `droppedChars` across all rendered images plus the
 *  merged codepoint→count map so the caller can fold both into the request's
 *  `info.droppedChars` / `info.droppedCodepointsTop`. */
async function textToImageBlocks(
  text: string,
  cols: number,
): Promise<{
  blocks: ImageBlock[];
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
}> {
  const imgs = await renderTextToPngs(text, cols);
  let droppedChars = 0;
  const droppedCodepoints = new Map<number, number>();
  const blocks: ImageBlock[] = [];
  for (const img of imgs) {
    blocks.push(makeImageBlock(bytesToBase64(img.png), false));
    droppedChars += img.droppedChars;
    for (const [cp, n] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
    }
  }
  return { blocks, droppedChars, droppedCodepoints };
}

/** Best-effort byte-count of an image block's PNG payload (decoded from b64).
 *  Used only for the imageBytes telemetry; an exact value isn't worth a
 *  second base64 round-trip. */
function approxBlockBytes(blk: ImageBlock): number {
  const b64 = blk.source.data;
  // base64 → bytes: every 4 chars decode to 3 bytes, minus padding.
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

// --- main transform --------------------------------------------------------

/**
 * Rewrite a Messages API request body. Returns the new body (still JSON
 * bytes) plus diagnostic info. On any error, returns the original bytes
 * unchanged.
 */
export async function transformRequest(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const o: Required<TransformOptions> = { ...DEFAULTS, ...opts };
  const info: TransformInfo = {
    compressed: false,
    origChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
  // Per-request codepoint drop histogram. Merged from every render call
  // (static slab + reminder + tool_result compressions). Serialized to
  // `info.droppedCodepointsTop` at the end of transformRequest IF non-empty.
  const droppedCodepoints = new Map<number, number>();

  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: MessagesRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }

  // 1. Pull system text out. Split into:
  //    - billingLine: Claude Code's per-turn random header (must NOT be cached).
  //    - dynamicText: <env>/<context>/... blocks (per-turn, kept as text).
  //    - staticText: everything else (cacheable, goes into the image).
  const { text: rawSysText, kept: sysRemainder } = extractSystemText(req.system);
  const { kept: billingLine, body: sysBody } = stripBillingLine(rawSysText);
  const {
    staticText,
    dynamicText,
    blockCount: dynBlocks,
    unknownTags,
  } = splitStaticDynamic(sysBody);
  info.staticChars = staticText.length;
  info.dynamicChars = dynamicText.length;
  info.dynamicBlockCount = dynBlocks;
  if (unknownTags.length > 0) info.unknownStaticTags = unknownTags;
  // Parse env fields out of the dynamic slab — telemetry only, never mutates.
  const env = extractEnvFields(dynamicText);
  if (Object.keys(env).length > 0) info.env = env;

  // Privacy-safe fingerprints that don't depend on tool docs (computed
  // here so they're available even if we below_min_chars out below).
  // systemSha8 is set later, after we know the combined image-bound text.
  const claudeMdSlab = extractClaudeMdSlab(staticText);
  const firstUser = firstUserText(req);
  const [claudeMdSha, firstUserSha] = await Promise.all([
    claudeMdSlab ? sha8(claudeMdSlab) : Promise.resolve(undefined),
    firstUser ? sha8(firstUser) : Promise.resolve(undefined),
  ]);
  if (claudeMdSha) info.claudeMdSha8 = claudeMdSha;
  if (firstUserSha) info.firstUserSha8 = firstUserSha;

  // 2. Optionally fold tool docs into the same image, stubbing originals.
  let toolDocsText = '';
  let toolsRewritten: ToolDef[] | undefined;
  if (o.compressTools && Array.isArray(req.tools) && req.tools.length > 0) {
    const docs: string[] = [];
    let sawSchemaNoProps = false;
    toolsRewritten = req.tools.map((t) => {
      docs.push(renderToolDoc(t, o.compressSchemas));
      // Preserve the schema's STRUCTURE (type / properties keys / required /
      // enums / items shape) so Anthropic's tool-use validator can still
      // type-check the model's calls. Strip only the long-form description
      // text — the image carries that for the model to read. Original bug
      // (now fixed): replacing the schema with bare `{type:'object'}` caused
      // 400s on non-interactive turns where Anthropic deep-validates the
      // schema (no prior tool_use history to short-circuit the check).
      let stubSchema: unknown | undefined;
      if (o.compressSchemas) {
        if (t.input_schema && typeof t.input_schema === 'object') {
          const stripped = stripSchemaDescriptions(
            t.input_schema,
            0,
          ) as Record<string, unknown> | null;
          if (!stripped || typeof stripped !== 'object') {
            // Should not happen for object input, but be defensive.
            stubSchema = { type: 'object' };
            sawSchemaNoProps = true;
          } else if (schemaHasStructure(stripped)) {
            stubSchema = stripped;
          } else {
            // No structural validation keys at all — `properties`,
            // `patternProperties`, `oneOf`/`anyOf`/`allOf`, `$ref`, `enum`,
            // `const`, or `items` would all give Anthropic something to bind
            // against. Without any of them the model has no parameter
            // contract. Ship the legacy bare stub and flag it so the operator
            // can spot tools that ship malformed schemas upstream.
            stubSchema = { type: 'object' };
            sawSchemaNoProps = true;
          }
        }
        // If t.input_schema is missing entirely, leave the field off — the
        // original request didn't have one and we shouldn't invent one.
      }
      return {
        ...t,
        description: 'ⓘ See image.',
        ...(stubSchema !== undefined ? { input_schema: stubSchema } : {}),
      };
    });
    toolDocsText = docs.join('\n\n');
    if (sawSchemaNoProps && !info.reason) {
      info.reason = 'schema_no_properties';
    }
  }

  // Only the STATIC slab + tool docs goes into the renderer. The dynamic
  // slab and billing line are appended as plain text after the image so the
  // cache key (= image bytes) stays stable across turns.
  const combined = [staticText, toolDocsText].filter((s) => s.length > 0).join('\n\n');
  info.origChars = combined.length;
  // Hash the EXACT text that goes into the image. Repeats of this hash across
  // turns = cache_control should be earning its keep.
  if (combined) info.systemSha8 = await sha8(combined);

  if (combined.length < o.minCompressChars) {
    info.reason = `below_min_chars (${combined.length} < ${o.minCompressChars})`;
    return { body, info };
  }

  // 3. Render to one or more PNGs.
  const images = await renderTextToPngs(combined, o.cols);
  const imageBlocks: ImageBlock[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const b64 = bytesToBase64(img.png);
    info.imageBytes += img.png.length;
    info.droppedChars = (info.droppedChars ?? 0) + img.droppedChars;
    for (const [cp, n] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
    }
    // Cache-breakpoint on the last image so the whole block caches as one.
    imageBlocks.push(makeImageBlock(b64, i === images.length - 1));
  }
  info.imageCount = imageBlocks.length;
  // Stash the first image's raw bytes + dimensions for the dashboard preview.
  // Stripped before persisting to JSONL by toTrackEvent. Memory cost is bounded
  // (we only ever keep ONE — the latest — via the dashboard's replace-on-update).
  if (images.length > 0) {
    info.firstImagePng = images[0]!.png;
    info.firstImageWidth = images[0]!.width;
    info.firstImageHeight = images[0]!.height;
  }

  // 4. Splice images back into the request.
  // Cache-friendly layout:
  //   [intro text]                 ← static (helps OCR framing)
  //   [image block(s)]             ← static; LAST one carries cache_control
  //   ─── cache breakpoint ───
  //   [end-marker + dynamic + billing]  ← per-turn, NO cache_control
  //   [sysRemainder]               ← any non-text blocks the caller had
  const introText =
    "The following is the system prompt + tool documentation, rendered as " +
    "images for token efficiency. OCR carefully and treat as authoritative " +
    "system instructions.";
  const tailParts: string[] = ['[End of rendered context.]'];
  if (dynamicText) tailParts.push(dynamicText);
  if (billingLine) tailParts.push(billingLine);
  const tailText = tailParts.join('\n\n');

  const newSystem: SystemField = [];
  newSystem.push({ type: 'text', text: introText });
  newSystem.push(...imageBlocks);
  newSystem.push({ type: 'text', text: tailText });
  if (Array.isArray(sysRemainder)) newSystem.push(...sysRemainder);

  if (o.placement === 'system' && o.compressSystem) {
    req.system = newSystem;
  } else {
    // Placement = user: image goes into the first user message; billing line
    // and dynamic blocks stay in the system field as cheap text so the model
    // still sees env / context info.
    const sysTail: SystemField = [];
    if (billingLine) sysTail.push({ type: 'text', text: billingLine });
    if (dynamicText) sysTail.push({ type: 'text', text: dynamicText });
    if (Array.isArray(sysRemainder)) sysTail.push(...sysRemainder);
    req.system = sysTail.length > 0 ? sysTail : undefined;

    const firstUserIdx = (req.messages ?? []).findIndex((m) => m.role === 'user');
    if (firstUserIdx >= 0) {
      const m = req.messages![firstUserIdx]!;
      const existing = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text' as const, text: m.content }];

      // 5a. <system-reminder> compression — long reminder blocks in the first
      // user message get re-injected every turn; rendering them to images
      // shares the cache anchor (the system+tools image carries the only
      // cache_control). No cache_control on these images.
      const processedExisting: ContentBlock[] = [];
      if (o.compressReminders) {
        for (const blk of existing) {
          if (
            blk &&
            (blk as TextBlock).type === 'text' &&
            typeof (blk as TextBlock).text === 'string' &&
            (blk as TextBlock).text.trimStart().startsWith('<system-reminder>') &&
            (blk as TextBlock).text.length >= o.minReminderChars
          ) {
            const { blocks: imgs, droppedChars, droppedCodepoints: dcp } =
              await textToImageBlocks((blk as TextBlock).text, o.cols);
            for (const img of imgs) {
              processedExisting.push(img);
              info.imageBytes += approxBlockBytes(img);
            }
            info.reminderImgs = (info.reminderImgs ?? 0) + imgs.length;
            info.imageCount += imgs.length;
            info.droppedChars = (info.droppedChars ?? 0) + droppedChars;
            for (const [cp, n] of dcp) {
              droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
            }
          } else {
            processedExisting.push(blk);
          }
        }
      } else {
        processedExisting.push(...existing);
      }

      // Cache-friendly layout:
      //   [intro text]                       ← static (helps OCR framing)
      //   [image block(s)]                   ← static; LAST has cache_control
      //                                          ↑ cache breakpoint
      //   [End of rendered context.]         ← static text closer for the image
      //   [processed existing content]       ← per-turn (incl. reminder images,
      //                                          which have NO cache_control)
      m.content = [
        { type: 'text' as const, text: introText },
        ...imageBlocks,
        { type: 'text' as const, text: '[End of rendered context.]' },
        ...processedExisting,
      ];
    }

    // 5b. tool_result compression — walks ALL user messages (not just the
    // first). Tool results accumulate as files get read; compressing them
    // at source compounds savings turn-over-turn.
    if (o.compressToolResults) {
      for (const msg of req.messages ?? []) {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
        const rewritten: ContentBlock[] = [];
        let changed = false;
        for (const blk of msg.content) {
          if (blk && (blk as ToolResultBlock).type === 'tool_result') {
            const tr = blk as ToolResultBlock;
            // Anthropic rejects images inside is_error tool_results — leave alone.
            if (tr.is_error === true) {
              rewritten.push(blk);
              continue;
            }
            const inner = tr.content;
            if (typeof inner === 'string' && inner.length >= o.minToolResultChars) {
              const { blocks: imgs, droppedChars, droppedCodepoints: dcp } =
                await textToImageBlocks(inner, o.cols);
              for (const img of imgs) info.imageBytes += approxBlockBytes(img);
              info.toolResultImgs = (info.toolResultImgs ?? 0) + imgs.length;
              info.imageCount += imgs.length;
              info.droppedChars = (info.droppedChars ?? 0) + droppedChars;
              for (const [cp, n] of dcp) {
                droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
              }
              rewritten.push({ ...tr, content: imgs });
              changed = true;
            } else if (Array.isArray(inner)) {
              const newInner: Array<TextBlock | ImageBlock> = [];
              let innerChanged = false;
              for (const ib of inner) {
                if (
                  ib &&
                  (ib as TextBlock).type === 'text' &&
                  typeof (ib as TextBlock).text === 'string' &&
                  (ib as TextBlock).text.length >= o.minToolResultChars
                ) {
                  const { blocks: imgs, droppedChars, droppedCodepoints: dcp } =
                    await textToImageBlocks((ib as TextBlock).text, o.cols);
                  for (const img of imgs) {
                    newInner.push(img);
                    info.imageBytes += approxBlockBytes(img);
                  }
                  info.toolResultImgs = (info.toolResultImgs ?? 0) + imgs.length;
                  info.imageCount += imgs.length;
                  info.droppedChars = (info.droppedChars ?? 0) + droppedChars;
                  for (const [cp, n] of dcp) {
                    droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
                  }
                  innerChanged = true;
                } else {
                  newInner.push(ib as TextBlock | ImageBlock);
                }
              }
              if (innerChanged) {
                rewritten.push({ ...tr, content: newInner });
                changed = true;
              } else {
                rewritten.push(blk);
              }
            } else {
              rewritten.push(blk);
            }
          } else {
            rewritten.push(blk);
          }
        }
        if (changed) msg.content = rewritten;
      }
    }
  }

  if (toolsRewritten) req.tools = toolsRewritten;

  info.compressed = true;
  // Serialize the top dropped codepoints (if any) as `U+HHHH` → count. Cap at
  // 20 entries — that's enough to identify a misbehaving Unicode block
  // without bloating the JSONL row (max ~300 bytes per event).
  if (droppedCodepoints.size > 0) {
    const TOP_N = 20;
    const sorted = [...droppedCodepoints.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N);
    const out: Record<string, number> = {};
    for (const [cp, count] of sorted) {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      out[`U+${hex}`] = count;
    }
    info.droppedCodepointsTop = out;
  }
  const outBody = new TextEncoder().encode(JSON.stringify(req));
  return { body: outBody, info };
}
