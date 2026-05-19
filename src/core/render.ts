/**
 * Text → PNG renderer. Uses the build-time atlas (src/core/atlas.ts) and
 * blits glyphs into a single grayscale framebuffer, then PNG-encodes.
 *
 * The atlas is sparse (Unicode BMP subset) and supports wide cells (East
 * Asian Wide codepoints take 2× the Latin advance width). The renderer
 * iterates by *codepoint* (not UTF-16 code unit) so surrogate pairs above
 * U+FFFF — which are not in our atlas anyway — round-trip cleanly as a
 * single dropped-char event rather than two corrupt halves.
 *
 * Anthropic's vision encoder works best with images ≤ 1568×1568 px, so we
 * cap height there and split into N PNGs when content exceeds the budget.
 */

import {
  ATLAS_CELL_W,
  ATLAS_CELL_H,
  ATLAS_PIXELS,
  ATLAS_OFFSETS,
  ATLAS_WIDE_FLAGS,
  atlasRank,
} from './atlas.js';
import { encodeGrayPng } from './png.js';

const MAX_HEIGHT_PX = 1568;
const DEFAULT_COLS = 100;
const PAD_X = 4;
const PAD_Y = 4;

export interface RenderedImage {
  /** Raw PNG bytes. */
  png: Uint8Array;
  /** Pixel width. */
  width: number;
  /** Pixel height. */
  height: number;
  /** How many input *codepoints* were rendered into this image (covers wide
   *  chars correctly: 中 counts as 1, not 2). */
  charsRendered: number;
  /** Codepoints encountered that aren't in the atlas. They were rendered as
   *  blank cells; the caller may want to surface this as telemetry so a
   *  spike of drops triggers a profile review. */
  droppedChars: number;
  /** Histogram of dropped codepoints: codepoint → count for this render. The
   *  caller can merge across multiple renders to find the top offenders.
   *  Empty when droppedChars === 0; never undefined so callers don't need to
   *  null-check before iterating. */
  droppedCodepoints: Map<number, number>;
}

// --- column-aware wrapping -------------------------------------------------

/** Visual width of a codepoint in cells (1 = Latin, 2 = East Asian Wide).
 *  Codepoints not in the atlas advance by 1 cell — they render as blank but
 *  occupy space so wrap math is stable. */
function cellsFor(codepoint: number): number {
  const rank = atlasRank(codepoint);
  if (rank < 0) return 1;
  return ATLAS_WIDE_FLAGS[rank] === 1 ? 2 : 1;
}

/** Default tab width when expanding `\t` to spaces. 4 is what GitHub, GNU
 *  cat -t, and most editors render by default. Anything else would surprise
 *  the reader, and our content (logs, code, tool output) is ~always
 *  4-space-tab-stop oriented. */
const TAB_WIDTH = 4;

/** Expand `\t` in a single line to a visible `→` (U+2192) glyph + padding
 *  spaces to the next `TAB_WIDTH` tab stop. Honors visual columns: wide
 *  chars (CJK) count as 2 columns so tab alignment after `中\tx` lands
 *  where a human reader would expect.
 *
 *  WHY a visible marker, not silent spaces: the model sees tab indent
 *  *structure* explicitly. Silent spaces would lose the "this was an
 *  indent" signal — diffs, code, log columns all benefit when the OCR
 *  reader can tell indent-spaces apart from intentional-spaces. The arrow
 *  glyph U+2192 is in the Arrows block (already in both `practical` and
 *  `full-bmp` atlas profiles, zero added cost).
 *
 *  WHY this exists at all: U+0009 isn't in the atlas (it's a control
 *  codepoint, not a glyph), so before this fix it counted as a dropped
 *  char and rendered as a blank cell with no width compensation. Real
 *  production telemetry on 2026-05-19 showed 5,339 of 5,358 drops (99.6%)
 *  were tabs — fixed here. */
export function expandTabsInLine(line: string): string {
  if (line.indexOf('\t') < 0) return line; // fast path: no tabs
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const span = TAB_WIDTH - (col % TAB_WIDTH);
      out += '→'; // → arrow at the tab boundary (1 col)
      if (span > 1) out += ' '.repeat(span - 1); // padding to next tab stop
      col += span;
    } else {
      out += ch;
      col += cellsFor(ch.codePointAt(0)!);
    }
  }
  return out;
}

/** Soft-wrap a single logical line at `cols` visual columns, accounting for
 *  wide cells. Wide chars that would exceed the column budget wrap before
 *  the char (leaving the last narrow slot blank). Mirrors the old
 *  character-count behavior for pure-ASCII input — guarantees the
 *  determinism test stays byte-identical.
 *
 *  Also expands tabs to spaces (4-stop) on each line so tab characters
 *  don't fall through to the blit loop as dropped glyphs. */
function wrapLines(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const rawWithTabs of text.split('\n')) {
    const raw = expandTabsInLine(rawWithTabs);
    if (raw.length === 0) {
      out.push('');
      continue;
    }
    let cur = '';
    let curCols = 0;
    // Codepoint iteration: handles surrogate pairs as one unit.
    for (const ch of raw) {
      const w = cellsFor(ch.codePointAt(0)!);
      if (curCols + w > cols) {
        out.push(cur);
        cur = ch;
        curCols = w;
      } else {
        cur += ch;
        curCols += w;
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * Blit a single glyph onto the framebuffer at cell coordinate (cx, cy).
 * Returns the number of cells the glyph occupies (1 or 2). 0 if the
 * codepoint isn't in the atlas — caller MUST still advance by 1 cell to
 * keep wrap math stable.
 *
 * Coordinate convention: `x`, `y` are pixel positions of the cell's
 * top-left corner. The glyph fills `(advance × CELL_W) × CELL_H` pixels.
 */
function blitGlyph(
  fb: Uint8Array,
  fbW: number,
  x: number,
  y: number,
  codepoint: number,
): number {
  const rank = atlasRank(codepoint);
  if (rank < 0) return 0;
  const wide = ATLAS_WIDE_FLAGS[rank] === 1;
  const srcW = wide ? 2 * ATLAS_CELL_W : ATLAS_CELL_W;
  const srcOff = ATLAS_OFFSETS[rank]!;
  for (let gy = 0; gy < ATLAS_CELL_H; gy++) {
    const dstRow = (y + gy) * fbW + x;
    const srcRow = srcOff + gy * srcW;
    for (let gx = 0; gx < srcW; gx++) {
      const v = ATLAS_PIXELS[srcRow + gx]!;
      // max() blending preserves antialiased edges if glyphs overlap (they
      // shouldn't in our grid layout, but the math is correct either way).
      if (v > fb[dstRow + gx]!) fb[dstRow + gx] = v;
    }
  }
  return wide ? 2 : 1;
}

/** Render up to `maxLines` of `text` to a single PNG, returning the unwritten
 *  tail. Each line gets one cell-row in the framebuffer; wide glyphs occupy
 *  two consecutive cells horizontally. */
export async function renderChunkToPng(
  text: string,
  cols: number = DEFAULT_COLS,
): Promise<RenderedImage> {
  const lines = wrapLines(text, cols);

  // Vertical budget: cap by MAX_HEIGHT_PX, then take that many lines.
  const maxLines = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / ATLAS_CELL_H));
  const fitLines = lines.slice(0, maxLines);

  // charsRendered = how many *input* codepoints this image covers. If we fit
  // the whole input, that's just the codepoint count of `text`. If we had to
  // drop overflow lines, we count only the chars in the lines we kept,
  // including the input newlines BETWEEN them but excluding synthetic
  // newlines that `wrapLines` introduced for soft-wrap.
  let charsRendered: number;
  if (fitLines.length === lines.length) {
    // Full coverage: count input codepoints exactly. `for..of` iterates by
    // codepoint, so surrogate pairs above U+FFFF count as 1.
    let n = 0;
    for (const _ of text) n++;
    charsRendered = n;
  } else {
    // Partial coverage: sum codepoints in the lines we kept, plus one for
    // each line break (since the input separator was either a real '\n' or a
    // soft-wrap point — both represent one input position we covered).
    let n = 0;
    for (let i = 0; i < fitLines.length; i++) {
      for (const _ of fitLines[i]!) n++;
    }
    // Each pair of adjacent fitLines was separated by either an input '\n'
    // or a soft-wrap point; we cover (fitLines.length - 1) such separators.
    n += Math.max(0, fitLines.length - 1);
    charsRendered = n;
  }

  const width = 2 * PAD_X + cols * ATLAS_CELL_W;
  const height = 2 * PAD_Y + fitLines.length * ATLAS_CELL_H;

  // Black canvas (matches atlas: text is white-on-black, we invert below to
  // black-on-white for crispness — same convention as the Python proxy).
  const fb = new Uint8Array(width * height);

  let droppedChars = 0;
  const droppedCodepoints = new Map<number, number>();
  for (let row = 0; row < fitLines.length; row++) {
    const line = fitLines[row]!;
    const baseY = PAD_Y + row * ATLAS_CELL_H;
    let col = 0;
    for (const ch of line) {
      if (col >= cols) break; // shouldn't happen — wrap should have prevented
      const codepoint = ch.codePointAt(0)!;
      const baseX = PAD_X + col * ATLAS_CELL_W;
      const advance = blitGlyph(fb, width, baseX, baseY, codepoint);
      if (advance === 0) {
        droppedChars++;
        droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + 1);
        col += 1; // missing glyph still occupies one cell so wrap stays stable
      } else {
        col += advance;
      }
    }
  }

  // Invert: atlas stores white-on-black coverage; black-on-white renders
  // cleaner and matches what the Python proxy emits.
  for (let i = 0; i < fb.length; i++) fb[i] = 255 - fb[i]!;

  const png = await encodeGrayPng(fb, width, height);
  return { png, width, height, charsRendered, droppedChars, droppedCodepoints };
}

/** Split `text` into N PNGs, each ≤ MAX_HEIGHT_PX tall. */
export async function renderTextToPngs(
  text: string,
  cols: number = DEFAULT_COLS,
): Promise<RenderedImage[]> {
  const lines = wrapLines(text, cols);
  const linesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / ATLAS_CELL_H));

  const images: RenderedImage[] = [];
  for (let i = 0; i < lines.length; i += linesPerImg) {
    const chunk = lines.slice(i, i + linesPerImg).join('\n');
    images.push(await renderChunkToPng(chunk, cols));
  }
  return images;
}
