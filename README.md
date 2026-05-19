# pixelpipe

A token-saving proxy for Claude Code that renders the system prompt + tool
definitions as images, so Claude OCRs them instead of paying for them as
text. **65-73% input-token savings** on Opus 4.7, **100% reasoning quality**
preserved, **identical fixed text** every turn for a clean prompt-cache.

Runs on **Node 18+** and **Cloudflare Workers** from the same source.

---

## How it works

```
                                  ┌─ original ────────────────────┐
                                  │ ~68K input tok                │
Claude Code  ──►  pixelpipe  ──►  │  (system + tools as text)     │  ──►  Anthropic
                       │          └───────────────────────────────┘
                       └──────►   ┌─ via proxy ───────────────────┐
                                  │ ~3.5K input tok               │
                                  │  (system + tools as PNG +     │
                                  │   prompt-cache breakpoint)    │
                                  └───────────────────────────────┘
                                          ↓ Anthropic vision OCR
                                          100% reasoning quality retained
```

The proxy intercepts `POST /v1/messages`, pulls the system prompt + tool
documentation out of the JSON body, renders it into one or more grayscale
PNGs using a build-time-generated GNU Unifont glyph atlas (covers ~35k
BMP codepoints by default — Latin, Cyrillic, Greek, CJK, Hiragana,
Katakana, Hangul, Hebrew, Arabic, math symbols, box drawing, decorative
symbols), and substitutes those PNGs back in as `image` content blocks
with an `ephemeral` cache_control breakpoint.

Token math (Opus 4.7, real Claude Code workflow):

| metric                       | original | via proxy   | savings |
| ---------------------------- | -------- | ----------- | ------- |
| Cold input tokens            | ~68K     | ~3.5K       | 95%     |
| Cache-warm input tokens      | ~7.5K    | ~3.5K       | 53%     |
| Per-call median (mixed)      | -        | -           | 65-73%  |
| Per-image OCR quality vs txt | -        | -           | ~99.5%  |

---

## Quick start (Node)

```bash
npm install
npm run build           # produces dist/node.js
node bin/cli.js         # listens on 127.0.0.1:47821 by default
```

After editing code, restart in one step:

```bash
pnpm run restart                              # graceful SIGTERM of any running
                                               # instance → rebuild → fresh start
pnpm run restart -- --no-build                # skip rebuild (dist/ is fresh)
pnpm run restart -- --port 47822 --no-tools   # forward CLI flags to the proxy
```

`pnpm run restart` does, in order:

1. Lists every running pixelpipe PID (via `pgrep`) and SIGTERMs them all.
   Orphans from prior crashed sessions are cleaned up too.
2. Waits up to 5s for graceful exit (the SIGTERM handler flushes the JSONL
   tracker). Escalates to SIGKILL only if anything's still alive.
3. Runs `pnpm run build`. Build failures abort the restart — the script
   refuses to start a stale binary. Pass `--no-build` to skip when you
   know `dist/` is fresh.
4. Checks the target port is free. If it isn't, names the holding process
   and refuses to start (cheaper than a crashed Node stacktrace).
5. `exec`s `node bin/cli.js "$@"` in the foreground so Ctrl-C reaches Node.

Point Claude Code at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 \
  claude --exclude-dynamic-system-prompt-sections
```

That's it. Use Claude Code normally.

The `--exclude-dynamic-system-prompt-sections` flag suppresses the small
per-turn variable section so the rendered image stays byte-identical
across turns — that's what makes the prompt cache actually hit.

---

## Quick start (Cloudflare Workers)

```bash
npx wrangler dev        # local dev on :8787
npx wrangler deploy     # ship to *.workers.dev
```

Then in Claude Code:

```bash
ANTHROPIC_BASE_URL=https://pixelpipe.<your-account>.workers.dev \
  claude --exclude-dynamic-system-prompt-sections
```

You can attach a custom hostname and route in `wrangler.toml`.

---

## Configuration

Both runtimes read the same options — Node from CLI flags or env, Worker
from `wrangler.toml` `[vars]`.

| flag / var               | default                       | meaning                                     |
| ------------------------ | ----------------------------- | ------------------------------------------- |
| `--port`     `PORT`      | `47821`                       | Node only — listen port                     |
| `--upstream` `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | where to forward                     |
| `--no-compress` `COMPRESS=0`     | on            | master switch                               |
| `--no-tools`    `COMPRESS_TOOLS=0` | on          | fold tool docs into the image               |
| `--no-schemas`  `COMPRESS_SCHEMAS=0` | on        | include `input_schema` JSON in the image    |
| `--min-chars` `MIN_COMPRESS_CHARS` | `2000`      | skip compression below this many chars      |
| `--placement` `PLACEMENT` | `system`                     | `system` or `user` — where image lands      |
| `--cols`     `COLS`      | `100`                         | soft-wrap column count                      |

In Workers, set the optional upstream API key with:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

If unset, the proxy forwards whatever `x-api-key` the client sent.

---

## Architecture

```
src/
├── core/              100% runtime-agnostic (Web Standard APIs only)
│   ├── atlas.ts         (generated) sparse Unicode atlas, base64-inlined
│   ├── png.ts           minimal grayscale PNG encoder
│   ├── render.ts        text → PNG bytes
│   ├── transform.ts     request body rewriter
│   ├── proxy.ts         the fetch handler
│   └── types.ts         Anthropic API types
├── node.ts            node:http adapter + CLI
└── worker.ts          export default { fetch }

scripts/
├── gen-atlas.ts       build-time: OTF → atlas.ts (uses @napi-rs/canvas)
└── build.mjs          esbuild bundler for Node target

assets/
├── Unifont-16.0.04.otf       primary font (~35k BMP codepoints w/ full-bmp profile)
├── UNIFONT_LICENSE.txt       OFL + GPL-with-font-exception
└── JetBrainsMono-Regular.ttf legacy / ASCII-only fallback (kept on disk)
```

The atlas is generated **at build time** from `Unifont-16.0.04.otf`,
base64-inlined into a `.ts` file with sparse codepoint + offset tables
(binary-packed), and shipped with the bundle. At runtime there are zero
external files to read and zero non-Web-Standard imports — that's the
only way this works in Workers without per-request asset fetches.

Regenerate the atlas (after swapping fonts, sizes, or codepoint profile):

```bash
pnpm run build:atlas                          # default: full-bmp (~35k cp, all BMP Unifont covers)
ATLAS_PROFILE=practical pnpm run build:atlas  # drops Hangul (~24k cp; for Workers free-tier)
FONT_PX=12 pnpm run build:atlas               # nondefault size; verify cells
```

---

## Limitations

- The bundled GNU Unifont at 10px (cell 5×11 px Latin, 10×11 CJK) is
  Anthropic-OCR-clean for ~35k BMP codepoints by default (`full-bmp`
  profile): Latin, Cyrillic, Greek, CJK Unified Ideographs, Hiragana,
  Katakana, Hangul, Hebrew, Arabic, math symbols, box-drawing, arrows,
  Dingbats, Letterlike Symbols, Enclosed Alphanumerics, etc. Drops for
  codepoints outside the profile (e.g. emoji 😀 — supplementary plane)
  get counted in `events.jsonl#dropped_chars` (with the top-20 broken
  out as `dropped_codepoints_top`) so you can spot patterns. For
  Workers free-tier deployments under the 1 MB compressed-bundle cap,
  switch to `ATLAS_PROFILE=practical pnpm run build:atlas` (~24k cp;
  drops Hangul). Right-to-left scripts render left-to-right in source
  order (no bidi shaping); Devanagari / Thai / similar
  complex shaping is also unsupported.
- Compression sets a 5-minute prompt-cache TTL. Adding `cache_control:
  ephemeral` causes warm-cache rotation, not eviction.
- A 5KB break-even point: if input is `< MIN_COMPRESS_CHARS` chars we
  skip compression entirely (overhead would exceed savings).
- Per-machine font: regenerate the atlas if you swap fonts. The
  generated `src/core/atlas.ts` is checked in so consumers don't need
  `@napi-rs/canvas` to install.
- Workers CPU limit: this is fine for free-tier (10ms CPU) on small
  prompts; large prompts (>30K chars) may need the paid tier.

---

## Development

```bash
npm install
npm run dev:node              # tsx watch on src/node.ts
npm run dev:worker            # wrangler dev
npm run test                  # vitest
npm run test:watch
npm run typecheck             # tsc --noEmit
pnpm run build:atlas          # regenerate src/core/atlas.ts from OTF
npm run build                 # build dist/node.js
npm run deploy:worker         # wrangler deploy
```

## License

MIT.
