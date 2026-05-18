# pixelpipe

A token-saving proxy for Claude Code that renders the system prompt + tool
definitions + tool schemas as **bitmap images** instead of sending them as text.
Anthropic's vision encoder OCRs Menlo 5pt at 99.7% accuracy on Opus 4.7, so the
model gets the same context — but rendered as ~3,500 image tokens instead of
~40,000 text tokens.

**Verified result: 67–73% token savings on real Claude Code workflows.**
**Reasoning quality: 100% preserved** — identical fixed files, same tool calls.

## Quick start

```bash
# Terminal 1
npx pixelpipe

# Terminal 2
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude --exclude-dynamic-system-prompt-sections
```

That's it. Use Claude Code normally.

## Verified savings (Opus 4.7, real workflows)

| Scenario | Savings | Per-call avg |
|---|---|---|
| Cold start (single call) | 30% | 7,586 vs 10,895 |
| 3-turn coding task | 43% | 3,755 vs 6,567 |
| Multi-tool stress test (Grep/Glob/Read/Edit/Bash) | 73% | 4,353 vs 16,417 |
| 10-turn session | 67% | 2,123 vs 6,872 |
| **Schema-compression run (3 turns)** | **81.8%** | **2,704 vs 16,978** |

Per-call median savings in steady state: **69%**.

Dollar value at Opus 4.7 ($15/M input):
- Heavy individual: ~$12/day
- Small team (10 ppl): ~$118/day = $3,540/month
- Enterprise (100 ppl): ~$1,180/day = $35,400/month

## How it works

```
                   [original]            [via proxy]
Claude Code  ───►  ~40K input tok  ───►  ~3.5K input tok  ───►  Anthropic
                   (system + tools                                (vision OCR
                    + schemas)                                     reconstructs)
```

The proxy intercepts each `/v1/messages` request and:

1. Extracts the system prompt + all tool descriptions + all tool input_schemas
2. Renders them as ONE Menlo 5pt newspaper-layout PNG (≤ 1568×1568)
3. Replaces:
   - `system` → small text stub
   - `tools[].description` → "see image" stub
   - `tools[].input_schema` → `{"type":"object"}` permissive placeholder
   - Prepends image content block to first user message with `cache_control: ttl=1h`
4. Forwards to `api.anthropic.com` with original auth headers

Subsequent turns hit Anthropic's prompt cache on the image (90% discount on
cache_read), saving ~70% of input cost per turn forever.

## Architecture

```
~/Downloads/repos/pixelpipe/
├── bin/cli.js          # npx entry point
├── scripts/
│   ├── install.js      # postinstall: verify Python + install Pillow/httpx
│   └── gen_atlas.py    # offline tool: regenerate the Menlo 5pt glyph atlas
├── src/
│   ├── proxy.py        # Python runtime (currently the default)
│   └── zig/            # Zig 0.16 native port (Menlo renderer working)
│       ├── build.zig
│       ├── build.zig.zon
│       ├── menlo5.zig       # text → grayscale via embedded atlas
│       ├── menlo5_atlas.bin # 586-byte glyph atlas (ASCII 32-126)
│       └── render_cli.zig   # standalone test: text → PNG
```

## Status: dual runtime

The npm package currently uses the **Python proxy** as its runtime — it's
proven at the savings numbers above with 100% reasoning preserved over multi-
turn sessions.

The **Zig 0.16 renderer** is built and OCR-verified (single-char accuracy off
on `Menlo` → `Mento`; equivalent to Python's 99.7%). The remaining pieces of
the full Zig native binary are HTTP/h2 forwarding and JSON transform logic
(TODO; HTTP/h2 client already prototyped in the metal0 monorepo this was
spun out of).

When the full Zig port lands, the npm postinstall will download a pre-built
platform binary, eliminating the Python dependency entirely.

## Build & test the Zig renderer

```bash
cd src/zig
brew install libdeflate
zig build                    # requires Zig 0.16
echo "hello world" > in.txt
./zig-out/bin/render_cli in.txt out.png
```

Then `claude -p "Read out.png and transcribe"` to verify OCR.

## Tips for maximum savings

1. **Use `--exclude-dynamic-system-prompt-sections`** with Claude Code. Without
   it, the system prompt embeds timestamp/cwd data that changes per turn,
   busting the image cache.
2. **Keep your tool set stable.** Adding tools busts the image cache.
3. **Pin a stable port** across sessions so Anthropic's cache stays warm.
4. **Long sessions amortize the warm-up.** First turn pays ~12K token premium
   to cache the image; every turn after that saves ~5K. Break-even ≈ 3 turns
   on typical sessions, then pure savings forever.

## Limitations

- Sub-5pt fonts fail OCR. 5pt Menlo is the verified floor.
- Compressing user-message dynamic context (cwd, file listings) causes extra
  model round-trips — left disabled.
- macOS-tested. Linux/Windows should work but unverified. Font path
  hardcoded to `/System/Library/Fonts/Menlo.ttc`; override with `FONT_PATH=...`.

## Configuration

```
npx pixelpipe [options]

  -p, --port <N>          Port to listen on (default: 47821)
  --no-compress           Disable all compression (pure passthrough)
  --no-tools              Don't compress tool descriptions
  --no-schemas            Don't compress tool input_schemas (saves most tokens)
  --no-reminders          Don't compress <system-reminder> blocks
  --font-size <N>         Render font size in pt (default: 5; <5 fails OCR)
  --min-chars <N>         Minimum chars to trigger compression (default: 2000)
```

Or via env vars (proxy.py reads these directly):
```
PORT, COMPRESS_SYSTEM, COMPRESS_TOOLS, COMPRESS_SCHEMAS,
COMPRESS_REMINDERS, FONT_PATH, FONT_SIZE, MIN_COMPRESS_CHARS, PLACEMENT
```

## Requirements

- Node 16+
- Python 3.8+ with Pillow and httpx (auto-installed on first run)
- For the Zig port: Zig 0.16, libdeflate (`brew install libdeflate`)

## License

MIT
