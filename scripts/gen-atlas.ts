/**
 * Build-time glyph atlas generator — Unicode-capable variant.
 *
 * Reads assets/Unifont-16.0.04.otf, rasterizes a configurable subset of
 * Unicode BMP into a sparse-indexed grayscale atlas, and emits
 * src/core/atlas.ts with binary-packed lookup tables inlined as base64.
 *
 * Why Unifont:
 * - Single font covers ~57k BMP codepoints (Latin + Cyrillic + CJK + Hira +
 *   Kata + Greek + Hebrew + Arabic + box-drawing + math symbols + …).
 * - Pixel-perfect at 10px (it's a bitmap font designed for that grid).
 * - East Asian Width property respected by @napi-rs/canvas — CJK measures as
 *   2× Latin width. The renderer assumes this; gen-atlas asserts it.
 * - License: OFL + GPL-with-font-exception. Ship-friendly.
 *
 * Why sparse:
 * - The contiguous-range approach (FIRST..LAST) doesn't work when we want
 *   widely-separated blocks (e.g. ASCII + Cyrillic + CJK). A sparse codepoint
 *   list + binary search at render time is the natural shape.
 *
 * Profiles (selected via ATLAS_PROFILE env, default 'full-bmp'):
 * - 'full-bmp'  (~35k codepoints): everything Unifont covers in BMP,
 *    including Hangul. Default. Bundle exceeds the Cloudflare Workers
 *    free-tier 1 MB compressed-bundle cap; suitable for Node and paid
 *    Workers tier deployments.
 * - 'practical' (~24k codepoints): drops Hangul Syllables to fit Workers
 *    free-tier. Use via `ATLAS_PROFILE=practical pnpm run build:atlas`
 *    when deploying under the 1 MB compressed-bundle cap.
 *
 * Runs only at build time. Has zero runtime deps — the generated atlas.ts
 * works identically in Node and Cloudflare Workers.
 */

import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OTF_PATH = resolve(ROOT, 'assets/Unifont-16.0.04.otf');
const OUT_PATH = resolve(ROOT, 'src/core/atlas.ts');

const FONT_FAMILY = 'Unifont';
const FONT_PX = Number(process.env.FONT_PX ?? 10);
// Default to `full-bmp` so Korean / decorative blocks / math symbols all
// ship by default. `ATLAS_PROFILE=practical` is the Workers-free-tier
// escape hatch for deployments under the 1 MB compressed-bundle cap.
const PROFILE = (process.env.ATLAS_PROFILE ?? 'full-bmp') as 'practical' | 'full-bmp';

/** Codepoint blocks included in each profile. The order doesn't affect
 *  correctness (we sort by codepoint before emitting); it's just a
 *  readable build log. */
const PRACTICAL_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [0x0020, 0x007e, 'ASCII printable'],
  [0x00a0, 0x024f, 'Latin-1 Supp + Latin Extended-A + Latin Extended-B'],
  [0x0370, 0x03ff, 'Greek and Coptic'],
  [0x0400, 0x04ff, 'Cyrillic'],
  [0x0590, 0x05ff, 'Hebrew'],
  [0x0600, 0x06ff, 'Arabic'],
  [0x2000, 0x206f, 'General Punctuation'],
  // Added based on production drop histogram (#27 + #28): 95% of live drops
  // fall in these seven blocks — mostly decorative symbols, math notation,
  // and info bullets Claude Code's tool output uses heavily (✓ ✗ ⚠ ℝ ℕ ℤ ⓘ).
  [0x2100, 0x214f, 'Letterlike Symbols'],
  [0x2190, 0x21ff, 'Arrows'],
  [0x2200, 0x22ff, 'Mathematical Operators'],
  [0x2300, 0x23ff, 'Miscellaneous Technical'],
  [0x2460, 0x24ff, 'Enclosed Alphanumerics'],
  [0x2500, 0x257f, 'Box Drawing'],
  [0x2580, 0x259f, 'Block Elements'],
  [0x25a0, 0x25ff, 'Geometric Shapes'],
  [0x2600, 0x26ff, 'Miscellaneous Symbols'],
  [0x2700, 0x27bf, 'Dingbats'],
  [0x3000, 0x303f, 'CJK Symbols and Punctuation'],
  [0x3040, 0x309f, 'Hiragana'],
  [0x30a0, 0x30ff, 'Katakana'],
  [0xff00, 0xffef, 'Halfwidth and Fullwidth Forms'],
  [0x4e00, 0x9fff, 'CJK Unified Ideographs'],
];

const HANGUL: ReadonlyArray<readonly [number, number, string]> = [
  [0xac00, 0xd7af, 'Hangul Syllables'],
];

const RANGES = PROFILE === 'full-bmp' ? [...PRACTICAL_RANGES, ...HANGUL] : PRACTICAL_RANGES;

// --- Register the font -----------------------------------------------------
const otfBytes = readFileSync(OTF_PATH);
GlobalFonts.register(otfBytes, FONT_FAMILY);

// --- Probe cell dimensions -------------------------------------------------
// Use a measurement canvas large enough to hold a wide glyph + descenders.
const probe = createCanvas(64, 64);
const pctx = probe.getContext('2d');
pctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
pctx.textBaseline = 'alphabetic';

// --- cell dimensions: derive from probe data, not hardcoded ---------------
//
// Latin advance ('M') and CJK advance ('中') give the visual cell widths.
// East Asian Width = Wide requires CJK = 2 × Latin EXACTLY — verified on the
// UNROUNDED floats (Unifont at 11px reports Latin=5.5, CJK=11.0; that's a
// clean 2× ratio that integer rounding would falsely reject as 6 ≠ 11). Use
// Math.ceil for the cell width so half-pixel sizes round UP and CJK glyphs
// don't clip on the right edge.
//
// Cell height: probe a representative set of glyphs covering Latin caps,
// Latin descenders, CJK extremes (tallest + lowest), and box-drawing /
// math symbols. Take the max ascent and max descent across the set; cellH =
// ceil(maxAscent + maxDescent). At 10px this works out to 7 + 2 = 9,
// matching the previous hardcoded value byte-for-byte; at 12px it gives
// 8 + 2 = 10; at 16px it gives 10 + 6 = 16 (CJK descenders kick in).
const mLatin = pctx.measureText('M');
const mCjk = pctx.measureText('中');
const ratio = mCjk.width / mLatin.width;
// Allow tiny float drift (e.g. 1.99999 vs 2.0) but reject anything that
// clearly isn't East Asian Wide. 0.01 absolute tolerance is generous.
if (Math.abs(ratio - 2) > 0.01) {
  throw new Error(
    `[gen-atlas] expected CJK advance = 2×Latin, got ratio=${ratio.toFixed(4)} ` +
      `(latin=${mLatin.width}, cjk=${mCjk.width}). ` +
      `Renderer assumes East Asian Width = Wide for CJK Unified Ideographs.`,
  );
}
const cellW = Math.ceil(mLatin.width);

// Probe glyphs covering the extremes we need to cover:
//   - 'M'      : Latin caps (mid ascent, no descent)
//   - 'gpy'    : Latin descenders (deepest in Latin)
//   - '中漢國' : CJK ascent ceiling
//   - '⌊∫'    : math + box-drawing descenders
// We measure each, take max(ascent), max(descent), and round up.
const heightProbes = ['M', 'g', 'p', 'y', 'j', '中', '漢', '國', '⌊', '∫', '日', 'カ'];
let maxAscent = 0;
let maxDescent = 0;
for (const ch of heightProbes) {
  const m = pctx.measureText(ch);
  // actualBoundingBoxAscent / Descent give the inked extent of the glyph
  // (in pixels above / below the baseline). Some glyphs (box-drawing) have
  // NEGATIVE descent (they sit above baseline); clamp to 0 for those.
  const asc = m.actualBoundingBoxAscent;
  const desc = m.actualBoundingBoxDescent;
  if (Number.isFinite(asc) && asc > maxAscent) maxAscent = asc;
  if (Number.isFinite(desc) && desc > maxDescent) maxDescent = desc;
}
const ascent = Math.ceil(maxAscent);
const descent = Math.ceil(maxDescent);
const cellH = ascent + descent;

console.log(
  `[gen-atlas] font=${FONT_FAMILY} px=${FONT_PX} profile=${PROFILE} ` +
    `cell=${cellW}×${cellH} (asc=${ascent} desc=${descent}, wide=${2 * cellW}×${cellH})`,
);

// --- Enumerate the codepoint set ------------------------------------------
// For each range, walk every codepoint and keep only those Unifont actually
// has a glyph for. @napi-rs/canvas returns 0 for codepoints not in the cmap;
// we use that as the absence test. Then categorize by advance width: narrow
// (== cellW) or wide (== 2*cellW). Anything else means a font version drift
// — fail loudly rather than silently corrupt the atlas.

interface Found {
  cp: number;
  wide: boolean;
}
const found: Found[] = [];
for (const [lo, hi, label] of RANGES) {
  let kept = 0;
  for (let cp = lo; cp <= hi; cp++) {
    const w = pctx.measureText(String.fromCodePoint(cp)).width;
    if (w === 0) continue; // not in cmap
    // Classify by raw advance ratio against the Latin baseline. Tolerant of
    // half-pixel drift (Unifont at odd sizes reports e.g. 5.5 / 11.0). Round
    // up to integer cells so glyphs never get clipped on the right edge.
    const ratioToLatin = w / mLatin.width;
    if (Math.abs(ratioToLatin - 1) < 0.01) found.push({ cp, wide: false });
    else if (Math.abs(ratioToLatin - 2) < 0.01) found.push({ cp, wide: true });
    else {
      throw new Error(
        `[gen-atlas] codepoint U+${cp.toString(16).toUpperCase()} has advance ` +
          `${w}px (Latin=${mLatin.width}px, ratio=${ratioToLatin.toFixed(3)}; ` +
          `expected 1× or 2×). Font version drift?`,
      );
    }
    kept++;
  }
  console.log(
    `[gen-atlas]   ${label.padEnd(48)} ` +
      `U+${lo.toString(16).padStart(4, '0').toUpperCase()}..` +
      `U+${hi.toString(16).padStart(4, '0').toUpperCase()}  ` +
      `kept ${kept}/${hi - lo + 1}`,
  );
}
// Sort by codepoint so the runtime can binary-search.
found.sort((a, b) => a.cp - b.cp);
const wideCount = found.filter((f) => f.wide).length;
console.log(`[gen-atlas] total glyphs: ${found.length} (${wideCount} wide)`);

// --- Rasterize each glyph --------------------------------------------------
// All glyphs go into a single flat Uint8Array; OFFSETS[] points into it.
// Width depends on the glyph (cellW or 2*cellW); height is always cellH.

const wideCanvas = createCanvas(2 * cellW, cellH);
const wideCtx = wideCanvas.getContext('2d');
wideCtx.font = `${FONT_PX}px ${FONT_FAMILY}`;
wideCtx.textBaseline = 'alphabetic';

const narrowCanvas = createCanvas(cellW, cellH);
const narrowCtx = narrowCanvas.getContext('2d');
narrowCtx.font = `${FONT_PX}px ${FONT_FAMILY}`;
narrowCtx.textBaseline = 'alphabetic';

const codepoints = new Uint32Array(found.length);
const offsets = new Uint32Array(found.length);
const wideFlags = new Uint8Array(found.length);
const cellSlices: Uint8Array[] = [];
let totalBytes = 0;

for (let i = 0; i < found.length; i++) {
  const { cp, wide } = found[i]!;
  codepoints[i] = cp;
  wideFlags[i] = wide ? 1 : 0;
  offsets[i] = totalBytes;

  const w = wide ? 2 * cellW : cellW;
  const ctx = wide ? wideCtx : narrowCtx;

  // Paint glyph: black canvas, white text. R-channel coverage is what we keep.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, cellH);
  ctx.fillStyle = '#fff';
  ctx.fillText(String.fromCodePoint(cp), 0, ascent);

  const img = ctx.getImageData(0, 0, w, cellH);
  const buf = new Uint8Array(w * cellH);
  for (let p = 0; p < buf.length; p++) buf[p] = img.data[p * 4]!;
  cellSlices.push(buf);
  totalBytes += buf.length;
}

const pixels = new Uint8Array(totalBytes);
{
  let off = 0;
  for (const s of cellSlices) {
    pixels.set(s, off);
    off += s.length;
  }
}

// --- Encode binary blobs as base64 ----------------------------------------
// JSON array literals of 41k numbers would blow up atlas.ts to several MB
// of TS source. base64'd typed-array bytes are ~6× tighter and the decoder
// is 10 lines that runs once at module load.

function bytesB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
const codepointsB64 = bytesB64(new Uint8Array(codepoints.buffer));
const offsetsB64 = bytesB64(new Uint8Array(offsets.buffer));
const wideFlagsB64 = bytesB64(wideFlags);
const pixelsB64 = bytesB64(pixels);

console.log(
  `[gen-atlas] sizes (base64 chars): codepoints=${codepointsB64.length} ` +
    `offsets=${offsetsB64.length} wide=${wideFlagsB64.length} pixels=${pixelsB64.length}`,
);

// --- Emit src/core/atlas.ts -----------------------------------------------
const banner = `// AUTO-GENERATED by scripts/gen-atlas.ts — DO NOT EDIT.
// Regenerate with: pnpm run build:atlas
//   (or ATLAS_PROFILE=practical pnpm run build:atlas to drop Hangul for
//    Workers free-tier deployments under the 1 MB compressed-bundle cap)
// Source font: assets/Unifont-16.0.04.otf @ ${FONT_PX}px (profile: ${PROFILE})
// Glyphs: ${found.length} codepoints (${wideCount} wide)
`;

const body = `
/** Latin advance width in pixels. CJK glyphs advance ${2 * cellW}px (= 2 × this). */
export const ATLAS_CELL_W = ${cellW};
/** Cell height in pixels. */
export const ATLAS_CELL_H = ${cellH};
/** Distance from cell top to baseline. */
export const ATLAS_ASCENT = ${ascent};
/** Distance from baseline to cell bottom. */
export const ATLAS_DESCENT = ${descent};
/** Font size used when rasterizing. */
export const ATLAS_FONT_PX = ${FONT_PX};
/** Font family name used at build time. Renderer never re-loads the font. */
export const ATLAS_FONT_FAMILY = ${JSON.stringify(FONT_FAMILY)};
/** Profile used to build this atlas. */
export const ATLAS_PROFILE = ${JSON.stringify(PROFILE)};

// ---- base64 blobs (decoded once at module init) --------------------------

const CODEPOINTS_B64 = ${JSON.stringify(codepointsB64)};
const OFFSETS_B64    = ${JSON.stringify(offsetsB64)};
const WIDE_FLAGS_B64 = ${JSON.stringify(wideFlagsB64)};
const PIXELS_B64     = ${JSON.stringify(pixelsB64)};

/** Decode base64 → Uint8Array. Workers-safe (no Buffer / no node:zlib). */
function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeU32(b64: string): Uint32Array {
  const bytes = decodeB64(b64);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Sorted codepoint table. \`ATLAS_CODEPOINTS[rank]\` is the codepoint stored
 *  at \`rank\` in OFFSETS / WIDE_FLAGS / PIXELS. */
export const ATLAS_CODEPOINTS: Uint32Array = /* @__PURE__ */ decodeU32(CODEPOINTS_B64);

/** Byte offset into ATLAS_PIXELS for the glyph at each rank. */
export const ATLAS_OFFSETS: Uint32Array = /* @__PURE__ */ decodeU32(OFFSETS_B64);

/** 1 if the glyph at this rank is double-wide (East Asian Wide), 0 otherwise. */
export const ATLAS_WIDE_FLAGS: Uint8Array = /* @__PURE__ */ decodeB64(WIDE_FLAGS_B64);

/** Packed grayscale pixel buffer. Glyph at rank \`r\` occupies
 *  \`OFFSETS[r] .. OFFSETS[r] + (WIDE_FLAGS[r] ? 2 : 1) * CELL_W * CELL_H\`. */
export const ATLAS_PIXELS: Uint8Array = /* @__PURE__ */ decodeB64(PIXELS_B64);

/** Number of glyphs in the atlas. */
export const ATLAS_NUM_GLYPHS = ATLAS_CODEPOINTS.length;

/** Binary-search the sparse codepoint table. Returns rank (≥0) or -1 if the
 *  codepoint is not in the atlas. Hot path; called once per rendered char. */
export function atlasRank(codepoint: number): number {
  let lo = 0;
  let hi = ATLAS_CODEPOINTS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ATLAS_CODEPOINTS[mid]!;
    if (v === codepoint) return mid;
    if (v < codepoint) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
`;

writeFileSync(OUT_PATH, banner + body);
console.log(
  `[gen-atlas] wrote ${OUT_PATH} ` +
    `(${pixels.length} pixel bytes, ${pixelsB64.length} b64 chars; total file ~${Math.round((banner.length + body.length) / 1024)} KB)`,
);
