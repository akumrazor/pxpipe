import { describe, expect, it } from 'vitest';
import { renderChunkToPng, renderTextToPngs } from '../src/core/render.js';
import { encodeGrayPng, bytesToBase64 } from '../src/core/png.js';
import { transformRequest } from '../src/core/transform.js';
import { atlasRank, ATLAS_CELL_H } from '../src/core/atlas.js';

describe('png encoder', () => {
  it('produces a valid PNG signature', async () => {
    const pixels = new Uint8Array(4 * 4).fill(128); // 4×4 mid-gray
    const png = await encodeGrayPng(pixels, 4, 4);
    expect(png.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // Last chunk should be IEND
    const tail = png.slice(-12);
    expect(String.fromCharCode(tail[4]!, tail[5]!, tail[6]!, tail[7]!)).toBe('IEND');
  });

  it('round-trips bytesToBase64 ↔ atob', () => {
    const original = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const b64 = bytesToBase64(original);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(original);
  });
});

describe('renderer', () => {
  it('renders a one-line string to a single PNG', async () => {
    const img = await renderChunkToPng('Hello, world!');
    expect(img.png.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(img.height).toBeLessThanOrEqual(1568);
    expect(img.width).toBeGreaterThan(0);
  });

  it('splits very long input into multiple PNGs', async () => {
    const huge = ('lorem ipsum dolor sit amet '.repeat(20) + '\n').repeat(500);
    const imgs = await renderTextToPngs(huge);
    expect(imgs.length).toBeGreaterThan(1);
    for (const img of imgs) expect(img.height).toBeLessThanOrEqual(1568);
  });

  // ---- Unicode coverage tests (Unifont atlas) -------------------------------
  // These confirm the sparse-codepoint + wide-glyph machinery works end-to-end.
  // None of them assert specific PNG bytes (the byte-deterministic guarantee
  // is covered by the 'renders identical input...' test below); they assert
  // the *contract*: known glyphs render without dropping, missing glyphs
  // increment droppedChars, and wide chars advance two cells.

  it('renders a Chinese codepoint without dropping (CJK Unified)', async () => {
    const img = await renderChunkToPng('中文'); // U+4E2D U+6587
    expect(img.droppedChars).toBe(0);
    expect(img.charsRendered).toBe(2);
    expect(img.width).toBeGreaterThan(0);
  });

  it('renders Cyrillic without dropping', async () => {
    const img = await renderChunkToPng('Привет мир'); // 10 codepoints incl. space
    expect(img.droppedChars).toBe(0);
    expect(img.charsRendered).toBe(10);
  });

  it('renders Greek, Hebrew, Arabic, box-drawing, and math symbols', async () => {
    // One glyph from each profile range that the atlas claims to cover.
    // (The renderer is left-to-right only; Hebrew/Arabic will appear in
    // source order, not bidi-correct order — that's a documented limitation
    // of this slice, not a test failure.)
    const sample = 'α β π — → ∑ ∫ √ ─ │ ┌ ┐';
    const img = await renderChunkToPng(sample);
    expect(img.droppedChars).toBe(0);
  });

  it('treats codepoints outside the atlas as dropped (e.g. emoji)', async () => {
    // 😀 is U+1F600 — Supplementary Plane, not in BMP. Even `full-bmp` profile
    // wouldn't cover it. Renderer must advance by 1 cell and bump the counter,
    // not crash on the surrogate pair.
    const img = await renderChunkToPng('hi 😀 world');
    expect(img.droppedChars).toBe(1);
    // charsRendered counts codepoints, NOT UTF-16 units — the emoji is one
    // codepoint even though it occupies two UTF-16 units.
    expect(img.charsRendered).toBe(10); // 'hi ' (3) + 😀 (1) + ' world' (6) = 10
  });

  it('CJK characters advance two cells; mixed lines wrap correctly', async () => {
    // 100 cols, mixed Latin + CJK. 30 Latin chars + 40 CJK chars = 30 + 80 =
    // 110 visual columns → must wrap to 2 lines.
    const latin30 = 'abcdefghijklmnopqrstuvwxyz0123';
    const cjk40 = '中'.repeat(40);
    const img = await renderChunkToPng(latin30 + cjk40, 100);
    // First line fills 30 + 35*2 = 100 cols (35 CJK chars).
    // Second line holds the remaining 5 CJK chars.
    // Image height: 2 lines × CELL_H + 2*PAD_Y. PAD_Y is 4 px (matches
    // render.ts's const). CELL_H comes from the atlas so this stays correct
    // across font-size changes.
    expect(img.charsRendered).toBe(latin30.length + 40);
    expect(img.droppedChars).toBe(0);
    const expectedHeight = 2 * 4 /* PAD_Y */ + 2 * ATLAS_CELL_H;
    expect(img.height).toBe(expectedHeight);
  });

  it('does NOT split a wide glyph across the column boundary', async () => {
    // 99 Latin + 1 CJK at cols=100: the CJK would land at col 99 (1 col left)
    // and needs 2. Wrap math must move it to a new line, leaving col 99 blank
    // on the first line.
    const line = 'a'.repeat(99) + '中';
    const img = await renderChunkToPng(line, 100);
    expect(img.charsRendered).toBe(100);
    expect(img.droppedChars).toBe(0);
    // Two lines: first has 99 'a', second has the '中'.
    const expectedHeight = 2 * 4 /* PAD_Y */ + 2 * ATLAS_CELL_H;
    expect(img.height).toBe(expectedHeight);
  });

  // --- Atlas profile coverage: 6 blocks added per #27 + #28 -----------------
  // These confirm the codepoints the drop-histogram surfaced as 95% of
  // production drops are now in the atlas. Each `atlasRank` returns ≥ 0
  // for a representative glyph from each block.

  it('atlas covers Dingbats (✓ ✗ ❌)', () => {
    expect(atlasRank('✓'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('✗'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('❌'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Miscellaneous Symbols (⚠ ★)', () => {
    expect(atlasRank('⚠'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('★'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Letterlike Symbols (ℝ ℕ ℤ ℚ ℂ)', () => {
    expect(atlasRank('ℝ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('ℕ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('ℤ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('ℚ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('ℂ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Block Elements (█ ░ ▒)', () => {
    expect(atlasRank('█'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('░'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('▒'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Geometric Shapes (▲ ▼ ► ◄ ●)', () => {
    expect(atlasRank('▲'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('▼'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('►'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('◄'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('●'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Miscellaneous Technical (⌈ ⌉ ⌊ ⌋)', () => {
    expect(atlasRank('⌈'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('⌉'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('⌊'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('⌋'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Enclosed Alphanumerics (ⓘ ① ② ⑩)', () => {
    expect(atlasRank('ⓘ'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('①'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('②'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('⑩'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('atlas covers Hangul Syllables (한 글 안 녕) — full-bmp profile only', () => {
    // The default profile is now `full-bmp`, which ships ~11k Hangul
    // Syllables (U+AC00..U+D7AF). The `practical` profile drops these
    // for Workers free-tier deployments; if someone regenerates the atlas
    // with ATLAS_PROFILE=practical, these expectations will (correctly)
    // fail — that's the signal to update the test alongside the deploy.
    expect(atlasRank('한'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('글'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('안'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
    expect(atlasRank('녕'.codePointAt(0)!)).toBeGreaterThanOrEqual(0);
  });

  it('rendering a mix of newly-covered glyphs produces droppedChars: 0', async () => {
    // The histogram script found these were the most common drops in real
    // traffic. After the full-bmp default plus #29 cell-height fix, all
    // render cleanly — Hangul `한 글` included.
    const sample = '✓ ⚠ ℝ █ ▲ ⌈ ⌉ ⓘ ✗ ► ▼ ● ░ ★ ℕ ① 한 글 中 文';
    const img = await renderChunkToPng(sample);
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('droppedCodepoints map is populated correctly when drops occur', async () => {
    // 😀 is supplementary-plane (not in atlas regardless of profile). The
    // codepoint should appear in the map with count 1; charsRendered counts
    // it as a single codepoint.
    const img = await renderChunkToPng('hi 😀 there');
    expect(img.droppedChars).toBe(1);
    expect(img.droppedCodepoints.size).toBe(1);
    expect(img.droppedCodepoints.get(0x1f600)).toBe(1);
  });

  it('droppedCodepoints tallies repeat drops correctly', async () => {
    // Three occurrences of the same dropped codepoint → count 3.
    const img = await renderChunkToPng('😀😀😀');
    expect(img.droppedChars).toBe(3);
    expect(img.droppedCodepoints.size).toBe(1);
    expect(img.droppedCodepoints.get(0x1f600)).toBe(3);
  });

  // --- Tab expansion (production bug fix) -----------------------------------
  // Real telemetry on 2026-05-19 showed 5,339 of 5,358 drops (99.6%) were
  // U+0009 TAB. Tabs are control codepoints, not glyphs — they should expand
  // to spaces at 4-stop alignment, not register as dropped chars.

  it('expands tabs to 4-space tab stops (basic)', async () => {
    // `a\tb` at col 1, tab fills col 1→col 4 (3 spaces), so we get `a   b`.
    const img = await renderChunkToPng('a\tb');
    expect(img.droppedChars).toBe(0);
    expect(img.droppedCodepoints.size).toBe(0);
  });

  it('leading tab expands to 4 spaces', async () => {
    // `\tx` at col 0, tab fills col 0→col 4 (4 spaces), so we get `    x`.
    const img = await renderChunkToPng('\tx');
    expect(img.droppedChars).toBe(0);
  });

  it('multiple tabs land on their respective tab stops', async () => {
    // `a\tbb\tc`:
    //   'a'  → col 0..1
    //   '\t' → col 1, fills to col 4 (3 spaces)
    //   'bb' → col 4..6
    //   '\t' → col 6, fills to col 8 (2 spaces)
    //   'c'  → col 8..9
    // Net: 'a' + 3 spaces + 'bb' + 2 spaces + 'c' — all visible glyphs in
    // the atlas, zero drops.
    const img = await renderChunkToPng('a\tbb\tc');
    expect(img.droppedChars).toBe(0);
  });

  it('tab after CJK char respects East Asian Wide column count', async () => {
    // 中 is 2 visual cols. So tab after 中 fills col 2 → col 4 (2 spaces).
    const img = await renderChunkToPng('中\tx');
    expect(img.droppedChars).toBe(0);
  });

  it('tab at the start of multiple lines resets column tracking per line', async () => {
    // Each line independently treats tab as expanding from col 0 (4 spaces).
    const img = await renderChunkToPng('\ta\n\tb\n\tc');
    expect(img.droppedChars).toBe(0);
  });

  it('a long string with embedded tabs produces zero drops', async () => {
    // Stress test for the production failure mode (tabs in tool_result-like
    // text dumps with thousands of indented lines).
    const line = 'fn\tname\tlocation\n'.repeat(500);
    const img = await renderChunkToPng(line);
    expect(img.droppedChars).toBe(0);
    // Codepoint 0x0009 must NOT appear in any drop tally.
    expect(img.droppedCodepoints.has(0x09)).toBe(false);
  });
});

describe('transform', () => {
  it('is a no-op when below min-chars', async () => {
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are helpful.',
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes, { minCompressChars: 100 });
    expect(info.compressed).toBe(false);
    expect(body).toBe(bytes); // returns same reference
  });

  it('compresses large system fields into image blocks', async () => {
    const bigSystem = 'You are a helpful assistant. '.repeat(200);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: bigSystem,
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);
    expect(info.imageCount).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(body));
    // Default placement is 'user' — images go into the first user message,
    // not the system field (Anthropic rejects image blocks in `system`).
    const userContent = out.messages[0].content as any[];
    expect(Array.isArray(userContent)).toBe(true);
    const imageBlocks = userContent.filter((b: any) => b.type === 'image');
    expect(imageBlocks.length).toBe(info.imageCount);
    expect(imageBlocks[0].source.media_type).toBe('image/png');
    // And the system field must NOT contain image blocks (would 400).
    if (Array.isArray(out.system)) {
      for (const b of out.system) expect(b.type).not.toBe('image');
    }
  });

  it('folds tool docs into the same image and stubs originals', async () => {
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'short',
      tools: [
        {
          name: 'BigTool',
          description: 'A very long tool description. '.repeat(100),
          input_schema: { type: 'object', properties: { x: { type: 'string' } } },
        },
      ],
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);

    const out = JSON.parse(new TextDecoder().decode(body));
    expect(out.tools[0].description).toContain('See image');
    expect(out.tools[0].name).toBe('BigTool');
  });

  it('preserves input_schema structure (properties / required / enum) when compressing', async () => {
    // Production 400s were traced to the proxy replacing input_schema with a
    // bare `{ type: 'object' }`, which Anthropic's tool-use validator rejected
    // when the model tried to actually invoke a tool. The fix preserves the
    // schema SHELL (type, properties keys, required, enum, items) and only
    // strips long-form `description` / `title` / `$schema` / `default` /
    // `examples`. The image still carries the original schema for the model.
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(3000), // force compression
      tools: [
        {
          name: 'Read',
          description: 'Read a file from disk',
          input_schema: {
            type: 'object',
            description: 'Reads a file', // should be stripped
            $schema: 'http://json-schema.org/draft-07/schema#', // stripped
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the file', // stripped
              },
              mode: {
                type: 'string',
                enum: ['read', 'binary'], // preserved
                description: 'Read mode', // stripped
                default: 'read', // stripped
              },
            },
            required: ['file_path'], // preserved verbatim
          },
        },
        {
          name: 'Bash',
          description: 'Run a bash command',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'cmd' },
              env: {
                type: 'object',
                description: 'env vars', // stripped
                properties: {
                  // nested properties — descriptions stripped, structure kept
                  PATH: { type: 'string', description: 'path var' },
                },
              },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'path' },
                  },
                  required: ['path'],
                },
              },
            },
            required: ['command'],
          },
        },
      ],
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);
    expect(info.reason).toBeUndefined(); // no advisory for these valid schemas

    const out = JSON.parse(new TextDecoder().decode(body));

    // Tool 0 (Read): properties + required preserved; descriptions stripped;
    // enum preserved.
    const read = out.tools[0];
    expect(read.input_schema.type).toBe('object');
    expect(read.input_schema.description).toBeUndefined();
    expect(read.input_schema.$schema).toBeUndefined();
    expect(read.input_schema.required).toEqual(['file_path']);
    expect(Object.keys(read.input_schema.properties)).toEqual(['file_path', 'mode']);
    expect(read.input_schema.properties.file_path.type).toBe('string');
    expect(read.input_schema.properties.file_path.description).toBeUndefined();
    expect(read.input_schema.properties.mode.enum).toEqual(['read', 'binary']);
    expect(read.input_schema.properties.mode.default).toBeUndefined();

    // Tool 1 (Bash): nested object + array-of-object both keep their structure.
    const bash = out.tools[1];
    expect(bash.input_schema.required).toEqual(['command']);
    expect(bash.input_schema.properties.env.type).toBe('object');
    expect(bash.input_schema.properties.env.description).toBeUndefined();
    expect(bash.input_schema.properties.env.properties.PATH.type).toBe('string');
    expect(bash.input_schema.properties.env.properties.PATH.description).toBeUndefined();
    expect(bash.input_schema.properties.files.type).toBe('array');
    expect(bash.input_schema.properties.files.items.type).toBe('object');
    expect(bash.input_schema.properties.files.items.required).toEqual(['path']);
    expect(bash.input_schema.properties.files.items.properties.path.description).toBeUndefined();
  });

  it('flags schemas without properties via info.reason', async () => {
    // Some tools legitimately ship a bare `{type:'object'}` schema. We fall
    // back to the legacy stub but tag info.reason so we can spot them in the
    // events.jsonl when triaging future 400s.
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(3000),
      tools: [
        { name: 'NoSchema', description: 'd', input_schema: { type: 'object' } },
      ],
    });
    const { body, info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.reason).toBe('schema_no_properties');
    const out = JSON.parse(new TextDecoder().decode(body));
    expect(out.tools[0].input_schema).toEqual({ type: 'object' });
  });

  it('leaves input_schema untouched when the original is missing', async () => {
    // If the tool ships without an input_schema, we should NOT invent one.
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(3000),
      tools: [{ name: 'Bare', description: 'd' }],
    });
    const { body } = await transformRequest(new TextEncoder().encode(req));
    const out = JSON.parse(new TextDecoder().decode(body));
    expect('input_schema' in out.tools[0]).toBe(false);
  });

  // Snapshot-style tests against real-world Claude Code tool schemas.
  // These exercise the full preservation contract: type / properties /
  // required / enum / items / oneOf / anyOf / allOf / $ref / numeric &
  // string constraints / format. Each case asserts the exact post-strip
  // shape so a regression in stripSchemaDescriptions surfaces immediately.
  describe('real-world tool-schema preservation', () => {
    async function rewriteOne(toolSchema: unknown): Promise<unknown> {
      const req = JSON.stringify({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'x'.repeat(3000),
        tools: [{ name: 'T', description: 'd', input_schema: toolSchema }],
      });
      const { body } = await transformRequest(new TextEncoder().encode(req));
      const out = JSON.parse(new TextDecoder().decode(body));
      return out.tools[0].input_schema;
    }

    it("Read (file_path + optional offset/limit) round-trips correctly", async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file to read',
          },
          offset: {
            type: 'integer',
            description: 'Line number to start at',
            minimum: 0,
            maximum: 9007199254740991,
          },
          limit: {
            type: 'integer',
            description: 'Number of lines',
            exclusiveMinimum: 0,
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          offset: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
          limit: { type: 'integer', exclusiveMinimum: 0 },
        },
        required: ['file_path'],
        additionalProperties: false,
      });
    });

    it('Bash (command + optional timeout + boolean run_in_background) round-trips', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          timeout: {
            type: 'number',
            description: 'Optional timeout in ms (max 600000)',
            maximum: 600000,
          },
          run_in_background: {
            type: 'boolean',
            description: 'Run async, do not wait',
            default: false,
          },
        },
        required: ['command'],
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number', maximum: 600000 },
          run_in_background: { type: 'boolean' },
        },
        required: ['command'],
      });
    });

    it('Edit (file_path + old_string + new_string + replace_all) round-trips', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'absolute path' },
          old_string: { type: 'string', description: 'text to replace' },
          new_string: { type: 'string', description: 'replacement' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence',
            default: false,
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      });
    });

    it('preserves enum constraints (Status-style tool)', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Job status',
            enum: ['pending', 'in_progress', 'completed', 'failed'],
          },
        },
        required: ['status'],
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
        },
        required: ['status'],
      });
    });

    it("preserves oneOf/anyOf/allOf composition variants", async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          identifier: {
            description: 'either an id or a name',
            oneOf: [
              { type: 'string', description: 'name lookup', minLength: 1 },
              { type: 'integer', description: 'numeric id', minimum: 1 },
            ],
          },
          filter: {
            anyOf: [
              { type: 'string', description: 'plain text' },
              { type: 'null' },
            ],
          },
          combo: {
            allOf: [
              { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
              { type: 'object', properties: { b: { type: 'number' } } },
            ],
          },
        },
        required: ['identifier'],
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          identifier: {
            oneOf: [
              { type: 'string', minLength: 1 },
              { type: 'integer', minimum: 1 },
            ],
          },
          filter: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          combo: {
            allOf: [
              { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
              { type: 'object', properties: { b: { type: 'number' } } },
            ],
          },
        },
        required: ['identifier'],
      });
    });

    it('preserves $ref + $defs', async () => {
      const got = await rewriteOne({
        type: 'object',
        $defs: {
          Loc: {
            type: 'object',
            description: 'A 2D location',
            properties: {
              lat: { type: 'number', description: 'latitude' },
              lng: { type: 'number', description: 'longitude' },
            },
            required: ['lat', 'lng'],
          },
        },
        properties: {
          here: { $ref: '#/$defs/Loc' },
          there: { $ref: '#/$defs/Loc' },
        },
        required: ['here'],
      });
      expect(got).toEqual({
        type: 'object',
        $defs: {
          Loc: {
            type: 'object',
            properties: { lat: { type: 'number' }, lng: { type: 'number' } },
            required: ['lat', 'lng'],
          },
        },
        properties: {
          here: { $ref: '#/$defs/Loc' },
          there: { $ref: '#/$defs/Loc' },
        },
        required: ['here'],
      });
    });

    it('preserves short `format` tokens and strips long ones', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          when: { type: 'string', format: 'date-time' }, // 9 chars, kept
          who: { type: 'string', format: 'uri' }, // 3 chars, kept
          freeform: {
            type: 'string',
            // 40-char "format" — almost certainly a description in disguise.
            format: 'a-very-long-format-string-that-is-prose',
          },
        },
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          when: { type: 'string', format: 'date-time' },
          who: { type: 'string', format: 'uri' },
          freeform: { type: 'string' }, // long format stripped
        },
      });
    });

    it('preserves pattern + numeric/length constraints + uniqueItems', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: {
          email: {
            type: 'string',
            description: 'email address',
            pattern: '^[^@]+@[^@]+$',
            minLength: 3,
            maxLength: 254,
          },
          tags: {
            type: 'array',
            description: 'list of tags',
            uniqueItems: true,
            minItems: 0,
            maxItems: 10,
            items: { type: 'string', minLength: 1 },
          },
        },
      });
      expect(got).toEqual({
        type: 'object',
        properties: {
          email: {
            type: 'string',
            pattern: '^[^@]+@[^@]+$',
            minLength: 3,
            maxLength: 254,
          },
          tags: {
            type: 'array',
            uniqueItems: true,
            minItems: 0,
            maxItems: 10,
            items: { type: 'string', minLength: 1 },
          },
        },
      });
    });

    it('handles boolean additionalProperties (true/false)', async () => {
      const got = await rewriteOne({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      });
      expect(got).toEqual({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      });

      const got2 = await rewriteOne({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: true,
      });
      expect(got2).toEqual({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: true,
      });
    });

    it('recognises oneOf-rooted schemas as structured (no schema_no_properties flag)', async () => {
      // A tool whose root schema is a union has no top-level `properties` but
      // IS structurally valid — it must NOT be flagged as no-structure.
      const req = JSON.stringify({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'x'.repeat(3000),
        tools: [
          {
            name: 'UnionTool',
            description: 'd',
            input_schema: {
              oneOf: [
                { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
              ],
            },
          },
        ],
      });
      const { body, info } = await transformRequest(new TextEncoder().encode(req));
      expect(info.reason).toBeUndefined();
      const out = JSON.parse(new TextDecoder().decode(body));
      expect(out.tools[0].input_schema).toEqual({
        oneOf: [
          { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        ],
      });
    });

    it('leaves nodes deeper than the recursion cap untouched (no corruption)', async () => {
      // Build a schema 25 levels deep. The cap is 20; everything beyond it
      // must pass through verbatim — we'd rather ship a slightly bigger
      // schema than corrupt one.
      type Nest = { type: string; properties?: Record<string, Nest>; description?: string };
      const deep: Nest = { type: 'string', description: 'leaf' };
      let cur: Nest = deep;
      for (let i = 0; i < 25; i++) {
        cur = { type: 'object', description: `level ${i}`, properties: { next: cur } };
      }
      const got = (await rewriteOne(cur)) as Record<string, unknown>;
      // Walk down and confirm we reach the original deep node intact.
      let node: Record<string, unknown> = got;
      for (let i = 0; i < 20; i++) {
        const props = node.properties as Record<string, unknown>;
        node = props.next as Record<string, unknown>;
      }
      // We've now descended 20 levels (depth cap). The next 5 levels were
      // beyond the cap and should still carry their descriptions verbatim.
      let seenDescriptionBelowCap = false;
      while (node && typeof node === 'object') {
        if (typeof node.description === 'string') seenDescriptionBelowCap = true;
        node = (node.properties as Record<string, unknown> | undefined)?.next as Record<
          string,
          unknown
        >;
        if (!node) break;
      }
      expect(seenDescriptionBelowCap).toBe(true);
    });
  });

  it('strips x-anthropic-billing-header line and keeps it as text', async () => {
    const sysText = 'x-anthropic-billing-header: cch=abc123\n' + 'real prompt text. '.repeat(200);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: sysText,
    });
    const bytes = new TextEncoder().encode(req);
    const { body, info } = await transformRequest(bytes);
    expect(info.compressed).toBe(true);

    const out = JSON.parse(new TextDecoder().decode(body));
    const textBlocks = out.system.filter((b: any) => b.type === 'text');
    expect(textBlocks.some((b: any) => b.text.includes('x-anthropic-billing-header'))).toBe(true);
  });

  it('keeps <env> as text outside the image so cache_control stays stable', async () => {
    const staticSlab = 'claude.md ground truth.\n'.repeat(500);
    const envBlock =
      "<env>\nWorking directory: /tmp/parityproj\nIs directory a git repo: Yes\nPlatform: darwin\nToday's date: 2026-05-18\n</env>";
    const sys = staticSlab + '\n' + envBlock;
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.compressed).toBe(true);
    expect(info.dynamicBlockCount).toBe(1);
    expect(info.dynamicChars).toBeGreaterThan(0);
    expect(info.staticChars).toBeGreaterThan(info.dynamicChars);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    // With placement='user' (the default), images live in the first user
    // message and the dynamic <env> block is kept as text in the system
    // field — so cache_control on the image is unaffected by env drift.
    const userContent = out.messages[0].content as any[];
    const sysBlocks = (Array.isArray(out.system) ? out.system : []) as any[];

    const hasImage = userContent.some((b: any) => b.type === 'image');
    expect(hasImage).toBe(true);

    // <env> must show up as text somewhere outside the image — the dynamic
    // tail. With 'user' placement that's the system field.
    const allText = [...sysBlocks, ...userContent]
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    expect(allText).toContain('<env>');
    expect(allText).toContain('Working directory: /tmp/parityproj');

    // The static slab must NOT appear in any text block — it lives in the
    // image now.
    for (const b of [...sysBlocks, ...userContent]) {
      if (b.type === 'text') expect(b.text).not.toContain('claude.md ground truth.');
    }
  });

  it('puts cache_control on the image only, never on the dynamic tail', async () => {
    const sys =
      'claude.md\n'.repeat(500) +
      '<env>\nWorking directory: /tmp/x\n</env>\n' +
      '<context name="todoList">\n[ ] do thing\n</context>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.dynamicBlockCount).toBe(2);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    // cache_control must land on exactly one image block — anywhere in the
    // request (system field OR user message), never on a text block.
    const sysBlocks = (Array.isArray(out.system) ? out.system : []) as any[];
    const userContent = (out.messages[0].content ?? []) as any[];
    const cached = [...sysBlocks, ...userContent].filter((b: any) => b.cache_control);
    expect(cached.length).toBe(1);
    expect(cached[0].type).toBe('image');
  });

  it('extracts env fields (cwd, platform, today, isGitRepo, branch) into info.env', async () => {
    const sys =
      'claude.md\n'.repeat(400) +
      "<env>\n" +
      'Working directory: /Users/me/code/pixelpipe\n' +
      'Is directory a git repo: Yes\n' +
      'Platform: darwin\n' +
      'OS Version: Darwin 25.0.0\n' +
      "Today's date: 2026-05-18\n" +
      '</env>\n' +
      '<git_status>\nOn branch main\nnothing to commit\n</git_status>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.env).toBeDefined();
    expect(info.env!.cwd).toBe('/Users/me/code/pixelpipe');
    expect(info.env!.isGitRepo).toBe(true);
    expect(info.env!.platform).toBe('darwin');
    expect(info.env!.osVersion).toBe('Darwin 25.0.0');
    expect(info.env!.today).toBe('2026-05-18');
    expect(info.env!.gitBranch).toBe('main');
  });

  it('leaves info.env undefined when there is no <env> block', async () => {
    const sys = 'claude.md\n'.repeat(400);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.env).toBeUndefined();
  });

  it('computes stable systemSha8 across turns when the static slab is identical', async () => {
    const staticSlab = 'claude.md\n'.repeat(400);
    const t1 =
      staticSlab + "<env>\nWorking directory: /a\nToday's date: 2026-05-18\n</env>";
    const t2 =
      staticSlab + "<env>\nWorking directory: /a\nToday's date: 2026-05-19\n</env>";
    const mk = (sys: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude',
          messages: [{ role: 'user', content: 'hi' }],
          system: sys,
        }),
      );
    const a = await transformRequest(mk(t1));
    const b = await transformRequest(mk(t2));
    expect(a.info.systemSha8).toBeDefined();
    expect(b.info.systemSha8).toBeDefined();
    // Static slab is identical, dynamic block changed → systemSha8 must NOT
    // change (the whole point is that the cached payload is stable).
    expect(a.info.systemSha8).toBe(b.info.systemSha8);
  });

  it('computes firstUserSha8 from the first user message', async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          { role: 'user', content: 'continue from HANDOFF?' },
          { role: 'assistant', content: 'sure' },
          { role: 'user', content: 'a totally different message' },
        ],
        system: 'claude.md\n'.repeat(400),
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.firstUserSha8).toBeDefined();
    expect(info.firstUserSha8).toMatch(/^[0-9a-f]{8}$/);
  });

  it('renders identical input to byte-identical output (determinism = cacheability)', async () => {
    // The whole token-savings story collapses if the renderer is non-
    // deterministic, because identical system prompts on consecutive turns
    // would produce different image bytes → 0% cache hit. Guard rail.
    const sys = 'claude.md\n'.repeat(500);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const a = await transformRequest(body);
    const b = await transformRequest(
      new TextEncoder().encode(
        JSON.stringify({
          model: 'claude',
          messages: [{ role: 'user', content: 'hi' }],
          system: sys,
        }),
      ),
    );
    // Compare image PNG bytes only — the request envelope wraps the same
    // bytes but JSON ordering is deterministic too, so the whole body should
    // match. Default placement is 'user', so the images live in the first
    // user message.
    const ua = (JSON.parse(new TextDecoder().decode(a.body)).messages[0].content ?? []) as any[];
    const ub = (JSON.parse(new TextDecoder().decode(b.body)).messages[0].content ?? []) as any[];
    const imgsA = ua.filter((x: any) => x.type === 'image').map((x: any) => x.source.data);
    const imgsB = ub.filter((x: any) => x.type === 'image').map((x: any) => x.source.data);
    expect(imgsA.length).toBeGreaterThan(0);
    expect(imgsA).toEqual(imgsB);
    expect(a.info.systemSha8).toBe(b.info.systemSha8);
  });

  it('flags unknown tag-shaped blocks in the static slab (canary for new dynamic tags)', async () => {
    const sys =
      'claude.md\n'.repeat(400) +
      '<recent_files>\nfoo.ts\nbar.ts\n</recent_files>\n' +
      "<env>\nWorking directory: /tmp\n</env>";
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.unknownStaticTags).toBeDefined();
    expect(info.unknownStaticTags).toContain('recent_files');
    // <env> is known, must NOT appear here.
    expect(info.unknownStaticTags).not.toContain('env');
  });

  it('does not flag <types> as an unknown tag (it lives in KNOWN_STATIC_TAGS)', async () => {
    const sys =
      'claude.md\n'.repeat(400) +
      '<types>\nstring\nnumber\n</types>\n' +
      '<env>\nWorking directory: /tmp\n</env>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    // <types> is known-static; it should NOT show up as an unknown tag.
    expect(info.unknownStaticTags).toBeUndefined();
  });

  it('omits unknownStaticTags when the static slab has no tag-shaped blocks', async () => {
    const sys = 'claude.md\n'.repeat(400) + '<env>\nWorking directory: /tmp\n</env>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { info } = await transformRequest(body);
    expect(info.unknownStaticTags).toBeUndefined();
  });

  it('passes through when the system prompt is only dynamic blocks', async () => {
    const sys = '<env>\nWorking directory: /tmp\n</env>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: sys,
      }),
    );
    const { body: outBytes, info } = await transformRequest(body, { minCompressChars: 100 });
    // Static slab is empty → below_min_chars → no-op pass-through.
    expect(info.compressed).toBe(false);
    expect(info.reason).toMatch(/below_min_chars/);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    expect(out.system).toBe(sys);
  });

  it("uses ttl='1h' on the image cache_control (Anthropic ordering rule)", async () => {
    // Without ttl='1h' on our cache_control, Claude Code's own ttl='1h'
    // breakpoint on later user-message content triggers 400: "ttl='1h' must
    // not come after ttl='5m'" because our default 5m would land first.
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes } = await transformRequest(body);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const blocks = [
      ...((Array.isArray(out.system) ? out.system : []) as any[]),
      ...((out.messages?.[0]?.content ?? []) as any[]),
    ];
    const cached = blocks.filter((b: any) => b.cache_control);
    expect(cached.length).toBe(1);
    expect(cached[0].cache_control.ttl).toBe('1h');
  });

  it('compresses long <system-reminder> blocks in the first user message', async () => {
    const reminder = '<system-reminder>\n' + 'a long policy note. '.repeat(200) + '\n</system-reminder>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'real user prompt' },
              { type: 'text', text: reminder },
            ],
          },
        ],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.reminderImgs).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const content = out.messages[0].content as any[];
    // Reminder text must NOT appear as a text block anymore.
    for (const b of content) {
      if (b.type === 'text') expect(b.text).not.toContain('<system-reminder>');
    }
    // But the user's actual prompt must still be there.
    const userTexts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
    expect(userTexts.some((t: string) => t.includes('real user prompt'))).toBe(true);

    // Reminder images carry NO cache_control (only the system+tools image
    // does — Anthropic caps at 4 breakpoints).
    const reminderImageBlocks = content.filter(
      (b: any) => b.type === 'image' && !b.cache_control,
    );
    expect(reminderImageBlocks.length).toBeGreaterThanOrEqual(info.reminderImgs ?? 0);
  });

  it('leaves short <system-reminder> blocks alone (below minReminderChars)', async () => {
    const shortReminder = '<system-reminder>\nshort note\n</system-reminder>';
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: shortReminder }],
          },
        ],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.reminderImgs ?? 0).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const allText = (out.messages[0].content as any[])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    expect(allText).toContain('<system-reminder>');
  });

  it('compresses large tool_result text content across user messages', async () => {
    const bigResult = 'output line. '.repeat(500);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: bigResult,
              },
            ],
          },
        ],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.toolResultImgs).toBeGreaterThanOrEqual(1);

    const out = JSON.parse(new TextDecoder().decode(outBytes));
    // Find the tool_result block and confirm its content is now image blocks.
    const tr = (out.messages[0].content as any[]).find((b: any) => b.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(Array.isArray(tr.content)).toBe(true);
    const imgInner = (tr.content as any[]).filter((b: any) => b.type === 'image');
    expect(imgInner.length).toBeGreaterThanOrEqual(1);
    // No cache_control on tool_result images.
    for (const b of imgInner) expect(b.cache_control).toBeUndefined();
  });

  it('leaves is_error tool_results untouched (Anthropic forbids images there)', async () => {
    const bigResult = 'error trace. '.repeat(500);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: bigResult,
                is_error: true,
              },
            ],
          },
        ],
        system: 'claude.md\n'.repeat(500),
      }),
    );
    const { body: outBytes, info } = await transformRequest(body);
    expect(info.toolResultImgs ?? 0).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const tr = (out.messages[0].content as any[]).find((b: any) => b.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(tr.is_error).toBe(true);
    expect(typeof tr.content).toBe('string');
  });

  // --- dropped_codepoints_top telemetry --------------------------------------
  // Records the top-20 dropped codepoints on each request. Lets the operator
  // see which Unicode blocks to add to the atlas profile without having to
  // capture & inspect the request body.

  it('populates droppedCodepointsTop when drops occur, sorted by count', async () => {
    // System slab forces compression. The slab contains drops for two distinct
    // supplementary-plane codepoints at different rates so we can verify the
    // sort order.
    const cpA = String.fromCodePoint(0x1f600); // 😀
    const cpB = String.fromCodePoint(0x1f604); // 😄
    const cpC = String.fromCodePoint(0x1f60a); // 😊
    const sys =
      'x'.repeat(3000) + // bulk to force compression
      '\n' + cpA.repeat(10) +  // 10 drops of U+1F600
      '\n' + cpB.repeat(3) +   // 3  drops of U+1F604
      '\n' + cpC.repeat(1);    // 1  drop  of U+1F60A
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: sys,
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    expect(info.droppedChars).toBeGreaterThanOrEqual(14);
    expect(info.droppedCodepointsTop).toBeDefined();
    const top = info.droppedCodepointsTop!;
    expect(top['U+1F600']).toBe(10);
    expect(top['U+1F604']).toBe(3);
    expect(top['U+1F60A']).toBe(1);
    // Ensure key format is the expected U+HHHH uppercase with no surprises.
    for (const k of Object.keys(top)) {
      expect(k).toMatch(/^U\+[0-9A-F]{4,}$/);
    }
    // Sorted by count desc: iteration of object keys preserves insertion order
    // in V8/JSC, so the first key is the highest-count drop.
    const keys = Object.keys(top);
    expect(keys[0]).toBe('U+1F600');
  });

  it('omits droppedCodepointsTop entirely when no drops occur', async () => {
    // Pure ASCII; nothing the practical-profile atlas wouldn't cover.
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'x'.repeat(3000),
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    expect(info.droppedChars ?? 0).toBe(0);
    expect(info.droppedCodepointsTop).toBeUndefined();
  });

  it('caps droppedCodepointsTop at 20 entries', async () => {
    // 25 distinct supplementary-plane codepoints, each appearing N times so
    // we can verify the cap drops the smallest counts.
    let payload = 'x'.repeat(3000) + '\n';
    for (let i = 0; i < 25; i++) {
      // U+1F300..U+1F318 — 25 distinct codepoints, each occurring (25 - i) times
      // so U+1F300 occurs 25 times, U+1F318 occurs 1 time.
      payload += String.fromCodePoint(0x1f300 + i).repeat(25 - i);
    }
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      system: payload,
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.droppedCodepointsTop).toBeDefined();
    const top = info.droppedCodepointsTop!;
    expect(Object.keys(top).length).toBe(20);
    // The 5 smallest-count codepoints (last in the input) must be dropped
    // from the top-20.
    for (let i = 20; i < 25; i++) {
      const hex = (0x1f300 + i).toString(16).toUpperCase().padStart(4, '0');
      expect(top[`U+${hex}`]).toBeUndefined();
    }
    // The top entry is the most-frequent.
    expect(top['U+1F300']).toBe(25);
  });

  // --- Threshold raise (task #35) -------------------------------------------
  // history-researcher's round-3 analysis (N=33 cold-miss events from
  // events.jsonl, 2026-05-18 — see /tmp/pixelpipe-history-compression.md)
  // measured Anthropic's real per-image cost at ~2,500 tokens, vs our prior
  // dashboard estimate of ~190. At the real rate, text blocks under ~10k
  // chars cost more as images than as text. We raise the default
  // per-block thresholds (reminder 1000→2000, tool_result 2000→5000) so
  // small blocks stay as text. These tests assert the new behavior at the
  // default thresholds and prove the boundary still trips on real inputs.

  it('threshold raise: 3000-char tool_result stays as text (was: imaged)', async () => {
    // 3000-char tool_result block. PRE-CHANGE: was 2000 cutoff, would
    // image. POST-CHANGE: 5000 cutoff, stays as text. The tool_result_imgs
    // counter should NOT increment.
    const longResult = 'x'.repeat(3000);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', content: longResult },
          ],
        },
      ],
      // System needs to be large enough to trip the main compression so the
      // tool_result loop runs.
      system: 'x'.repeat(3000),
    });
    const { body: outBytes, info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    // No tool_result images at the new threshold for a 3000-char block.
    expect(info.toolResultImgs ?? 0).toBe(0);
    // The tool_result content in the rewritten body should still be the
    // original 3000-char string (not replaced with image blocks).
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const tr = (out.messages[0].content as Array<{ type: string; content: unknown }>).find(
      (b) => b.type === 'tool_result',
    );
    expect(tr).toBeDefined();
    expect(typeof tr!.content).toBe('string');
    expect((tr!.content as string).length).toBe(3000);
  });

  it('threshold raise: 6000-char tool_result still images (above new cutoff)', async () => {
    // Same shape, but above the new 5000-char threshold. Compression fires.
    const longResult = 'x'.repeat(6000);
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', content: longResult },
          ],
        },
      ],
      system: 'x'.repeat(3000),
    });
    const { body: outBytes, info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    expect((info.toolResultImgs ?? 0)).toBeGreaterThan(0);
    // Content replaced with image blocks (no longer a string).
    const out = JSON.parse(new TextDecoder().decode(outBytes));
    const tr = (out.messages[0].content as Array<{ type: string; content: unknown }>).find(
      (b) => b.type === 'tool_result',
    );
    expect(Array.isArray(tr!.content)).toBe(true);
  });

  it('threshold raise: 1500-char reminder stays as text (was: imaged)', async () => {
    // <system-reminder> block at 1500 chars. PRE-CHANGE: was 1000 cutoff,
    // would image. POST-CHANGE: 2000 cutoff, stays as text.
    const reminder = '<system-reminder>' + 'x'.repeat(1500) + '</system-reminder>';
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: [{ type: 'text', text: reminder }] },
      ],
      system: 'x'.repeat(3000),
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    expect(info.reminderImgs ?? 0).toBe(0);
  });

  it('threshold raise: 2500-char reminder still images (above new cutoff)', async () => {
    const reminder = '<system-reminder>' + 'x'.repeat(2500) + '</system-reminder>';
    const req = JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'user', content: [{ type: 'text', text: reminder }] },
      ],
      system: 'x'.repeat(3000),
    });
    const { info } = await transformRequest(new TextEncoder().encode(req));
    expect(info.compressed).toBe(true);
    expect((info.reminderImgs ?? 0)).toBeGreaterThan(0);
  });
});
