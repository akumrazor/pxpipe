"""
Experimental Python proxy for testing system-prompt-as-image compression.

Sits between Claude Code and api.anthropic.com. Forwards Claude Code's own auth
(OAuth bearer + headers) untouched. When COMPRESS_SYSTEM is set, intercepts the
request body and rewrites the system prompt as image content blocks rendered
with a popular terminal font (Menlo) at small pt-size so Anthropic's vision
encoder can OCR it. Logs the full token breakdown (input / output / cache_read /
cache_create) so we can measure the actual win/loss vs plain text.

Usage:
    PORT=47821 COMPRESS_SYSTEM=1 python3 proxy_py.py
    # in another shell:
    ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude -p "..."
"""
from __future__ import annotations
import base64, io, json, os, sys, threading, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import httpx
from PIL import Image, ImageDraw, ImageFont

PORT = int(os.environ.get("PORT", "47821"))
COMPRESS = os.environ.get("COMPRESS_SYSTEM", "0") == "1"
FONT_PATH = os.environ.get("FONT_PATH", "/System/Library/Fonts/Menlo.ttc")
FONT_SIZE = int(os.environ.get("FONT_SIZE", "5"))  # 5pt verified OCR=99.7% on Opus 4.7
MAX_EDGE = 1568  # Anthropic resizes larger images, destroying tiny-font OCR
MIN_COMPRESS_CHARS = int(os.environ.get("MIN_COMPRESS_CHARS", "2000"))
UPSTREAM = "https://api.anthropic.com"

# Memoize rendered images so the SAME system prompt across turns produces
# byte-identical PNGs (PIL's PNG encoder has tiny non-determinism that breaks
# Anthropic's prompt cache lookup).
import hashlib
_render_cache: dict[str, list[bytes]] = {}

# Inject COMPRESS_SYSTEM as default value for compress_mode placement
# 'system'  : put images in the system field (may not be supported by API)
# 'user'    : prepend image to first user message (cache_control on the image)
# 'replace_system' : replace system with an empty text + add image to first user msg
PLACEMENT = os.environ.get("PLACEMENT", "user")

_font_cache: dict[int, ImageFont.FreeTypeFont] = {}

def get_font(size: int) -> ImageFont.FreeTypeFont:
    if size not in _font_cache:
        _font_cache[size] = ImageFont.truetype(FONT_PATH, size)
    return _font_cache[size]


_render_dims_cache: dict[str, list[tuple[int, int]]] = {}

def render_chunks(text: str, font_size: int = FONT_SIZE) -> list[bytes]:
    """Render text into the MINIMUM number of MAXIMALLY-PACKED images.

    Layout strategy: NEWSPAPER (multi-column). For 26K-char system prompt
    rendered at 5pt, a single-column layout would be ~3600 px tall (exceeds
    1568 cap → forces multiple images + per-image overhead). Multi-column
    packs the same text into a SQUAREish image: width = N_cols × col_width,
    height ≤ 1568. One image avoids per-image overhead doubling.

    Memoized on text content so the same prompt across turns yields BYTE-
    IDENTICAL PNG (PIL's PNG encoder has tiny non-determinism that breaks
    Anthropic's prompt cache hash if not memoized).
    """
    key = hashlib.sha256(f"{font_size}:{text}".encode()).hexdigest()
    if key in _render_cache:
        return _render_cache[key]

    font = get_font(font_size)
    asc, desc = font.getmetrics()
    line_h = asc + desc
    char_w = font.getlength("M") or (font_size * 0.6)
    col_gap_px = 4  # tighter gap — every pixel matters
    edge = MAX_EDGE

    # Minify: kill trailing whitespace + collapse runs of blank lines.
    # Critical because system prompt has lots of blank lines that waste rows.
    raw = []
    last_blank = False
    for ln in text.split("\n"):
        ln = ln.rstrip()
        if ln == "":
            if last_blank:
                continue
            last_blank = True
        else:
            last_blank = False
        raw.append(ln if ln else " ")

    # Force aggressive wrapping at FIXED_COL_CHARS. Narrower cols pack better:
    # short lines (bullets, headers) waste the unused chars in their row.
    FIXED_COL_CHARS = int(os.environ.get("COL_CHARS", "80"))
    lines: list[str] = []
    for ln in raw:
        if len(ln) <= FIXED_COL_CHARS:
            lines.append(ln)
        else:
            for i in range(0, len(ln), FIXED_COL_CHARS):
                lines.append(ln[i:i + FIXED_COL_CHARS])

    col_w_px = int(FIXED_COL_CHARS * char_w) + 1
    lines_per_col = max(8, edge // line_h)
    n_cols_total = max(1, (len(lines) + lines_per_col - 1) // lines_per_col)
    img_w = n_cols_total * col_w_px + (n_cols_total - 1) * col_gap_px
    pngs: list[bytes] = []

    dims: list[tuple[int, int]] = []
    max_cols_per_img = max(1, edge // (col_w_px + col_gap_px))
    lines_per_img = lines_per_col * max_cols_per_img

    for s in range(0, len(lines), lines_per_img):
        chunk = lines[s:s + lines_per_img]
        c_needed = max(1, (len(chunk) + lines_per_col - 1) // lines_per_col)
        # Width: ONLY as wide as the cols actually used in this image
        chunk_img_w = c_needed * col_w_px + (c_needed - 1) * col_gap_px
        # Height: ONLY as tall as the tallest column in this image
        max_col_lines = min(lines_per_col, len(chunk) - (c_needed - 1) * lines_per_col)
        if c_needed > 1:
            # Earlier cols are full, last col may be partial
            tallest = lines_per_col if c_needed > 1 else len(chunk)
        else:
            tallest = len(chunk)
        # All non-last columns are full lines_per_col; last col has the remainder.
        # Single-column case → tight bound (just last_col_lines, no canvas pad).
        # Multi-column case → all earlier cols are full lines_per_col tall, so
        #                     the image must be lines_per_col rows tall to fit them.
        last_col_lines = len(chunk) - (c_needed - 1) * lines_per_col
        tallest = max(1, last_col_lines) if c_needed == 1 else lines_per_col
        chunk_img_h = line_h * tallest
        img = Image.new("L", (chunk_img_w, chunk_img_h), 255)
        d = ImageDraw.Draw(img)
        for c in range(c_needed):
            col_lines = chunk[c * lines_per_col:(c + 1) * lines_per_col]
            x = c * (col_w_px + col_gap_px)
            for i, ln in enumerate(col_lines):
                d.text((x, i * line_h - desc // 2), ln, fill=0, font=font)
        buf = io.BytesIO()
        # Save as 8-bit grayscale PNG so the rendered image has full contrast
        # AND preserves antialiasing. Previously used `P + ADAPTIVE colors=2`
        # which picked white+gray instead of white+black on AA-heavy content,
        # producing washed-out images that visually look broken (and OCR worse).
        # Grayscale PNG bytes are still deterministic → Anthropic cache still hits.
        img.save(buf, "PNG", optimize=True)
        pngs.append(buf.getvalue())
        dims.append((chunk_img_w, chunk_img_h))

    _render_cache[key] = pngs
    _render_dims_cache[key] = dims
    return pngs


def render_dims(text: str, font_size: int = FONT_SIZE) -> list[tuple[int, int]]:
    key = hashlib.sha256(f"{font_size}:{text}".encode()).hexdigest()
    if key not in _render_dims_cache:
        render_chunks(text, font_size)
    return _render_dims_cache.get(key, [])


def image_block(png_bytes: bytes, cache: bool = False) -> dict:
    blk = {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.standard_b64encode(png_bytes).decode("ascii"),
        },
    }
    if cache:
        # Match Claude Code's extended cache TTL. If we use ephemeral (5m) here
        # while CC uses 1h later in the request, Anthropic rejects with
        # "ttl='1h' cache_control must not come after ttl='5m'".
        blk["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
    return blk


def extract_system_text(system_field) -> tuple[str, list[dict] | str | None]:
    """Return (extracted_text, remainder).
    remainder is what should stay in the system field (or None to delete it)."""
    if system_field is None:
        return "", None
    if isinstance(system_field, str):
        return system_field, ""  # replace with empty string
    if isinstance(system_field, list):
        # Concatenate all text blocks; keep non-text blocks in place.
        text_parts = []
        kept = []
        for b in system_field:
            if isinstance(b, dict) and b.get("type") == "text":
                text_parts.append(b.get("text", ""))
            else:
                kept.append(b)
        return "\n\n".join(text_parts), kept
    return "", system_field


def transform_request(body: bytes) -> tuple[bytes, dict]:
    """Compress system prompt + tool descriptions to image content."""
    info = {"compressed": False}
    try:
        req = json.loads(body)
    except Exception as e:
        info["parse_error"] = str(e)
        return body, info

    sys_field = req.get("system")
    text, remainder = extract_system_text(sys_field)

    # Strip Claude Code's per-turn-random `x-anthropic-billing-header: ...; cch=<rand>;`
    # line so the rest renders byte-identical across turns.
    billing_line_kept = None
    lines = text.split("\n", 1)
    if lines and lines[0].startswith("x-anthropic-billing-header:"):
        billing_line_kept = lines[0]
        text = lines[1] if len(lines) > 1 else ""

    # COMPRESS_TOOLS: move tool descriptions (+ optionally schemas) into the
    # same image. Replace each tool's description with a tiny stub.
    compress_tools = os.environ.get("COMPRESS_TOOLS", "1") == "1"
    compress_schemas = os.environ.get("COMPRESS_SCHEMAS", "1") == "1"
    tool_text_added = 0
    schemas_compressed = 0
    if compress_tools and isinstance(req.get("tools"), list):
        tool_doc_blocks = []
        for t in req["tools"]:
            if not isinstance(t, dict):
                continue
            name = t.get("name", "?")
            desc = t.get("description", "")
            doc_part = ""
            if desc and len(desc) > 80:
                doc_part = f"### Tool: {name}\n{desc}"
                t["description"] = f"See `{name}` docs in system context image."
            elif desc:
                doc_part = f"### Tool: {name}\n{desc}"
            # Compress input_schema: serialize full schema to text inside the
            # image, replace tools[].input_schema with a permissive stub. The
            # model still emits well-formed tool_use because it sees the real
            # schema in the image; Anthropic accepts any JSON object against
            # the {"type":"object"} placeholder.
            if compress_schemas and isinstance(t.get("input_schema"), dict):
                schema_json = json.dumps(t["input_schema"], indent=1)
                if len(schema_json) > 200:  # only worth it for non-trivial schemas
                    doc_part += f"\n#### Schema for `{name}`\n```json\n{schema_json}\n```"
                    t["input_schema"] = {"type": "object"}
                    schemas_compressed += 1
            if doc_part:
                tool_doc_blocks.append(doc_part)
        if tool_doc_blocks:
            tool_section = "\n\n# Tool Documentation\n\n" + "\n\n".join(tool_doc_blocks)
            text = text + tool_section
            tool_text_added = len(tool_section)
    info["tool_text_added"] = tool_text_added
    info["schemas_compressed"] = schemas_compressed

    info["system_text_chars"] = len(text)
    info["system_text_sha8"] = hashlib.sha256(text.encode()).hexdigest()[:8]
    # Dump every system text we see to /tmp so we can diff what changes.
    if os.environ.get("DUMP_SYSTEM") == "1":
        n = 0
        while os.path.exists(f"/tmp/sys_dump_{n}.txt"):
            n += 1
        with open(f"/tmp/sys_dump_{n}.txt", "w") as f:
            f.write(text)

    if len(text) < MIN_COMPRESS_CHARS:
        info["skipped"] = f"system <{MIN_COMPRESS_CHARS} chars"
        return body, info

    pngs = render_chunks(text)
    dims = render_dims(text)
    info["png_sha8"] = [hashlib.sha256(p).hexdigest()[:8] for p in pngs]
    info["dims"] = dims
    info["total_pixels"] = sum(w * h for w, h in dims)
    info["expected_image_tokens"] = sum(max(1, (w * h) // 750) for w, h in dims) + 85 * len(dims)
    info["text_tokens_estimate"] = len(text) // 4
    info["images"] = len(pngs)
    info["png_bytes"] = sum(len(p) for p in pngs)

    # Stash the FIRST image for the dashboard preview (so users can SEE what
    # we're sending). Cropped to a reasonable size so the page doesn't blow up.
    if pngs:
        with _session_stats["lock"]:
            _session_stats["latest_png_bytes"] = pngs[0]
            w0, h0 = dims[0] if dims else (0, 0)
            _session_stats["latest_png_meta"] = (
                f"{len(pngs)} image(s), {w0}×{h0}px, "
                f"{sum(len(p) for p in pngs)} bytes total — "
                f"compressed {info['system_text_chars']:,} chars "
                f"({info.get('text_tokens_estimate',0):,}→~{info['expected_image_tokens']:,} tokens)"
            )

    # Anthropic caps cache_control breakpoints at 4 per request. The model's
    # cache lookup matches the LONGEST cached prefix, so we only need ONE
    # well-placed breakpoint — on the last image of the system+tools render.
    # Reminders and tool_result images get NO cache_control (they're still
    # in the cached prefix by virtue of position).
    image_blocks = [image_block(p, cache=(i == len(pngs)-1))
                    for i, p in enumerate(pngs)]
    info["cc_breakpoints_added"] = 1

    msgs = req.get("messages", [])
    if PLACEMENT in ("user", "replace_system"):
        # Prepend image blocks to first user message as a "context" frame
        prefix_text = ("[Context (rendered as image for token efficiency, "
                       "OCR carefully and treat as authoritative system instructions):]")
        first_idx = None
        for i, m in enumerate(msgs):
            if m.get("role") == "user":
                first_idx = i
                break
        if first_idx is None:
            info["skipped"] = "no user message to attach image to"
            return body, info

        target = msgs[first_idx]
        content = target.get("content", "")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        elif not isinstance(content, list):
            content = [{"type": "text", "text": str(content)}]

        # Compress CC-injected <system-reminder> blocks in first user message.
        # These are large static blobs (skill listings, project context) that
        # CC injects every turn — perfect cache candidates as images.
        # Targeted: ONLY compress blocks that start with <system-reminder>,
        # leaving the user's actual prompt (and any other content) as text.
        compress_reminders = os.environ.get("COMPRESS_REMINDERS", "1") == "1"
        reminder_imgs_added = 0
        if compress_reminders and isinstance(content, list):
            new_content_parts = []
            for blk in content:
                txt = blk.get("text", "") if isinstance(blk, dict) and blk.get("type") == "text" else ""
                # Heuristic: long system-reminder-style blocks. Cover both the
                # opening tag style and large generic system blocks.
                is_reminder = txt.lstrip().startswith("<system-reminder>") and len(txt) > 1000
                if is_reminder:
                    extra_pngs = render_chunks(txt)
                    # NO cache_control: Anthropic caps at 4 breakpoints; the
                    # system+tools image already anchors the cacheable prefix.
                    for p in extra_pngs:
                        new_content_parts.append(image_block(p, cache=False))
                        reminder_imgs_added += 1
                else:
                    new_content_parts.append(blk)
            content = new_content_parts
        info["reminder_imgs"] = reminder_imgs_added

        new_content = (
            [{"type": "text", "text": prefix_text}]
            + image_blocks
            + [{"type": "text", "text": "[End context.]"}]
            + content
        )
        msgs[first_idx] = {**target, "content": new_content}

        # COMPRESS_TOOL_RESULTS: walk ALL user messages and image-compress any
        # large tool_result text content. Tool results accumulate in history as
        # files are read; compressing them at the source compounds per-turn
        # savings across the rest of the session.
        compress_tr = os.environ.get("COMPRESS_TOOL_RESULTS", "1") == "1"
        tr_imgs_added = 0
        if compress_tr:
            for mi, m in enumerate(msgs):
                if m.get("role") != "user":
                    continue
                content_list = m.get("content")
                if not isinstance(content_list, list):
                    continue
                changed = False
                new_blocks = []
                for blk in content_list:
                    if (isinstance(blk, dict) and blk.get("type") == "tool_result"):
                        # Anthropic API constraint: when is_error=true, the
                        # tool_result content MUST be type=text only (no images).
                        # Leave error tool_results untouched.
                        if blk.get("is_error") is True:
                            new_blocks.append(blk)
                            continue
                        inner = blk.get("content")
                        # tool_result.content can be str or list[block]
                        # NO cache_control on tool_result images (Anthropic
                        # caps at 4 breakpoints, and these aren't useful as
                        # cache anchors — they change every session).
                        if isinstance(inner, str) and len(inner) > 2000:
                            pngs_tr = render_chunks(inner)
                            new_inner = [image_block(p, cache=False)
                                         for p in pngs_tr]
                            blk = {**blk, "content": new_inner}
                            tr_imgs_added += len(pngs_tr)
                            changed = True
                        elif isinstance(inner, list):
                            new_inner = []
                            for ib in inner:
                                if (isinstance(ib, dict) and ib.get("type") == "text"
                                        and len(ib.get("text", "")) > 2000):
                                    pngs_tr = render_chunks(ib["text"])
                                    for p in pngs_tr:
                                        new_inner.append(image_block(p, cache=False))
                                    tr_imgs_added += len(pngs_tr)
                                    changed = True
                                else:
                                    new_inner.append(ib)
                            blk = {**blk, "content": new_inner}
                    new_blocks.append(blk)
                if changed:
                    msgs[mi] = {**m, "content": new_blocks}
        info["tool_result_imgs"] = tr_imgs_added
        req["messages"] = msgs

        if PLACEMENT == "replace_system":
            req["system"] = "Follow the instructions in the first image of the user message exactly."
        elif billing_line_kept is not None:
            # Replace original system with JUST the billing header line (small, stable
            # in spirit but per-turn random — keep it as text so it doesn't pollute
            # our cacheable image).
            req["system"] = billing_line_kept
        # else: leave system unchanged so Anthropic still has guardrails
        info["placement"] = PLACEMENT
    else:
        # PLACEMENT == 'system': put images directly into system field
        new_sys = []
        if isinstance(remainder, list):
            new_sys.extend(remainder)
        new_sys.extend(image_blocks)
        req["system"] = new_sys
        info["placement"] = "system"

    info["compressed"] = True
    return json.dumps(req).encode(), info


# Running session totals so users can see live savings.
# Persisted to ~/.cache/pixelpipe/stats.json on every update so
# restarts don't wipe history. Recent feed + latest PNG stay in-memory only.
import threading, time, collections, pathlib

_STATS_DIR = pathlib.Path.home() / ".cache" / "pixelpipe"
_STATS_FILE = _STATS_DIR / "stats.json"     # cumulative totals (rewritten atomically)
_REQUESTS_FILE = _STATS_DIR / "requests.jsonl"  # full per-request log (append-only)
_REQUESTS_ROTATE_BYTES = 10 * 1024 * 1024  # rotate at 10 MB

_session_stats = {
    "requests": 0,
    "compressed_requests": 0,
    "effective_input_actual": 0.0,
    "effective_input_baseline_est": 0.0,
    "started_at": time.time(),
    "first_seen_at": time.time(),  # persists across restarts; "uptime since first install"
    "recent": collections.deque(maxlen=50),  # in-memory only — restart resets
    "latest_png_bytes": None,                # in-memory only
    "latest_png_meta": "",
    "lock": threading.Lock(),
}


def _load_persisted_stats():
    """Load cumulative totals + recent request history on startup."""
    try:
        if _STATS_FILE.exists():
            with open(_STATS_FILE) as f:
                d = json.load(f)
            _session_stats["requests"] = int(d.get("requests", 0))
            _session_stats["compressed_requests"] = int(d.get("compressed_requests", 0))
            _session_stats["effective_input_actual"] = float(d.get("effective_input_actual", 0.0))
            _session_stats["effective_input_baseline_est"] = float(d.get("effective_input_baseline_est", 0.0))
            _session_stats["first_seen_at"] = float(d.get("first_seen_at", time.time()))
            saved = _session_stats["effective_input_baseline_est"] - _session_stats["effective_input_actual"]
            print(f"[PROXY] loaded persisted stats: {_session_stats['requests']} requests, "
                  f"~{saved:.0f} effective tokens saved (~${saved * 15.0 / 1e6:.4f})", flush=True)
    except Exception as e:
        print(f"[PROXY] could not load persisted stats: {e}", flush=True)

    # Replay last N entries from requests.jsonl into the in-memory recent feed
    try:
        if _REQUESTS_FILE.exists():
            tail = collections.deque(maxlen=_session_stats["recent"].maxlen)
            with open(_REQUESTS_FILE) as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    try:
                        tail.append(json.loads(line))
                    except Exception:
                        pass
            _session_stats["recent"].extend(tail)
            if tail:
                print(f"[PROXY] replayed {len(tail)} recent requests from {_REQUESTS_FILE.name}",
                      flush=True)
    except Exception as e:
        print(f"[PROXY] could not load request history: {e}", flush=True)


def _persist_stats():
    """Atomically rewrite cumulative totals."""
    try:
        _STATS_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "requests": _session_stats["requests"],
            "compressed_requests": _session_stats["compressed_requests"],
            "effective_input_actual": _session_stats["effective_input_actual"],
            "effective_input_baseline_est": _session_stats["effective_input_baseline_est"],
            "first_seen_at": _session_stats["first_seen_at"],
            "saved_at": time.time(),
        }
        tmp = _STATS_FILE.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(payload, f, indent=2)
        tmp.replace(_STATS_FILE)
    except Exception as e:
        print(f"[PROXY] could not persist stats: {e}", flush=True)


def _append_request_log(entry: dict):
    """Append one JSONL line for the per-request log. Rotate when oversize."""
    try:
        _STATS_DIR.mkdir(parents=True, exist_ok=True)
        # Rotate if file is too big
        if _REQUESTS_FILE.exists() and _REQUESTS_FILE.stat().st_size > _REQUESTS_ROTATE_BYTES:
            rotated = _STATS_DIR / "requests.jsonl.1"
            try: rotated.unlink()
            except FileNotFoundError: pass
            _REQUESTS_FILE.rename(rotated)
        with open(_REQUESTS_FILE, "a") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except Exception as e:
        # Don't crash request handling on disk errors
        print(f"[PROXY] could not append request log: {e}", flush=True)


_load_persisted_stats()


DASHBOARD_HTML = """<!doctype html>
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
  img.preview { max-width: 100%; image-rendering: pixelated; border: 1px solid #30363d;
                background: #fff; padding: 4px; border-radius: 4px; }
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
          <th>#</th><th>status</th><th>path</th><th class="num">size in</th>
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
      `port :__PORT__   ·   uptime ${formatDuration(s.uptime_sec)}   ·   live`;
    document.getElementById('m_req').textContent = s.requests;
    document.getElementById('m_req_sub').textContent = `${s.compressed_requests} compressed`;
    document.getElementById('m_saved').textContent = numFmt(s.saved_effective_tokens);
    document.getElementById('m_saved_sub').textContent =
      `${numFmt(s.effective_input_actual)} paid · ${numFmt(s.effective_input_baseline_est)} baseline`;
    document.getElementById('m_usd').textContent = `$${s.saved_usd_opus47.toFixed(4)}`;
    document.getElementById('m_pct').textContent = `${s.saved_pct.toFixed(1)}%`;
    const tbody = document.getElementById('rows');
    tbody.innerHTML = '';
    let i = 0;
    for (const e of r.recent.slice().reverse()) {
      const tr = document.createElement('tr');
      const statusCls = e.status >= 500 ? 'bad' : e.status >= 400 ? 'warn' : 'good';
      const saved = (e.session_saved_so_far_delta || 0);
      tr.innerHTML = `
        <td>${++i}</td>
        <td class="num ${statusCls}">${e.status}</td>
        <td>${escapeHtml((e.path || '').slice(0,40))}</td>
        <td class="num">${numFmt(e.size_in)}</td>
        <td class="num">${e.cc_added ?? '—'}</td>
        <td class="num">${numFmt(e.expected_image_tokens || 0)}</td>
        <td class="num">${numFmt(e.effective_actual || 0)}</td>
        <td class="num pos">${saved > 0 ? '+'+numFmt(saved) : '—'}</td>`;
      tbody.appendChild(tr);
    }
    if (r.has_preview) {
      const wrap = document.getElementById('preview_wrap');
      // Show a native-resolution crop so the tiny font is actually readable
      // (the full image is 1466×1568, gets unreadably downsampled in the panel).
      // Pixelated upscaling via CSS preserves crisp edges.
      wrap.innerHTML =
        `<img class="preview" src="/proxy-latest-png?crop=480&t=${Date.now()}" `
        + `style="width:100%;image-rendering:pixelated">`;
      document.getElementById('preview_meta').textContent =
        (r.preview_meta || '') + ' — showing top-left 480×480 crop';
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
"""


class ProxyHandler(BaseHTTPRequestHandler):
    server_version = "TokenProxy/0.1"

    def log_message(self, fmt, *args):
        pass

    def _serve_stats(self):
        with _session_stats["lock"]:
            saved = _session_stats["effective_input_baseline_est"] - _session_stats["effective_input_actual"]
            pct = (saved / _session_stats["effective_input_baseline_est"] * 100.0
                   if _session_stats["effective_input_baseline_est"] > 0 else 0)
            uptime = time.time() - _session_stats["started_at"]
            payload = {
                "requests": _session_stats["requests"],
                "compressed_requests": _session_stats["compressed_requests"],
                "effective_input_actual": round(_session_stats["effective_input_actual"], 1),
                "effective_input_baseline_est": round(_session_stats["effective_input_baseline_est"], 1),
                "saved_effective_tokens": round(saved, 1),
                "saved_pct": round(pct, 1),
                "saved_usd_opus47": round(saved * 15.0 / 1e6, 4),
                "uptime_sec": uptime,
            }
        body = json.dumps(payload, indent=2).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_recent(self):
        with _session_stats["lock"]:
            recent = list(_session_stats["recent"])
            has_preview = _session_stats["latest_png_bytes"] is not None
            preview_meta = _session_stats.get("latest_png_meta", "")
        body = json.dumps({
            "recent": recent,
            "has_preview": has_preview,
            "preview_meta": preview_meta,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_latest_png(self):
        """Serve the current rendered image. Supports `?crop=N` to return only
        the top-left N×N region at native resolution (so humans can actually
        SEE the tiny font — at 1466x1568 full-image scaled to 280px wide
        the browser turns the antialiased glyphs into unreadable noise)."""
        with _session_stats["lock"]:
            data = _session_stats["latest_png_bytes"]
        if not data:
            self.send_response(404)
            self.end_headers()
            return

        # Parse ?crop=N from query string
        crop_n = 0
        if "?" in self.path:
            qs = self.path.split("?", 1)[1]
            for kv in qs.split("&"):
                if kv.startswith("crop="):
                    try: crop_n = int(kv[5:])
                    except: pass

        if crop_n > 0:
            try:
                img = Image.open(io.BytesIO(data))
                cw = min(crop_n, img.width)
                ch = min(crop_n, img.height)
                cropped = img.crop((0, 0, cw, ch))
                buf = io.BytesIO()
                cropped.save(buf, "PNG", optimize=True)
                data = buf.getvalue()
            except Exception:
                pass  # fall back to full image

        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _do_proxy(self, method: str):
        # Local endpoints — never forwarded to Anthropic.
        if method == "GET" and self.path in ("/", "/dashboard"):
            html = DASHBOARD_HTML.replace("__PORT__", str(PORT)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        if method == "GET" and self.path == "/proxy-stats":
            self._serve_stats()
            return
        if method == "GET" and self.path == "/proxy-recent":
            self._serve_recent()
            return
        if method == "GET" and self.path.split("?", 1)[0] == "/proxy-latest-png":
            self._serve_latest_png()
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length > 0 else b""

            # Strip hop-by-hop headers
            HOP = {"connection", "keep-alive", "proxy-connection",
                   "transfer-encoding", "upgrade", "te", "host",
                   "content-length", "expect", "accept-encoding"}
            fwd_headers = {k: v for k, v in self.headers.items()
                           if k.lower() not in HOP}
            fwd_headers.setdefault("anthropic-version", "2023-06-01")

            log = {"method": method, "path": self.path, "size_in": len(body)}

            if COMPRESS and method == "POST" and self.path.startswith("/v1/messages"):
                new_body, info = transform_request(body)
                log.update(info)
                body = new_body
                log["size_after"] = len(body)

            with httpx.Client(http2=False, timeout=120.0) as c:
                resp = c.request(method, UPSTREAM + self.path,
                                 content=body if body else None,
                                 headers=fwd_headers)

            log["status"] = resp.status_code
            log["size_out"] = len(resp.content)
            log["upstream_ms"] = log.get("upstream_ms")  # placeholder if added

            # Try plain JSON first; if that fails, parse SSE event stream for usage.
            usage = None
            try:
                usage = resp.json().get("usage")
            except Exception:
                pass
            if not usage and b"event:" in resp.content[:200]:
                # SSE: aggregate usage from message_start (input) + message_delta (output).
                txt = resp.content.decode("utf-8", errors="replace")
                inp = cr = cc = out = 0
                for raw in txt.split("\n"):
                    if not raw.startswith("data: "):
                        continue
                    try:
                        ev = json.loads(raw[6:])
                    except Exception:
                        continue
                    if ev.get("type") == "message_start":
                        u = ev.get("message", {}).get("usage", {})
                        inp = u.get("input_tokens", inp)
                        cr = u.get("cache_read_input_tokens", cr)
                        cc = u.get("cache_creation_input_tokens", cc)
                    elif ev.get("type") == "message_delta":
                        u = ev.get("usage", {})
                        if "output_tokens" in u:
                            out = u["output_tokens"]
                if inp or out or cr or cc:
                    usage = {"input_tokens": inp, "output_tokens": out,
                             "cache_read_input_tokens": cr,
                             "cache_creation_input_tokens": cc}
            if usage:
                inp = usage.get("input_tokens", 0) or 0
                out = usage.get("output_tokens", 0) or 0
                cr = usage.get("cache_read_input_tokens", 0) or 0
                cc = usage.get("cache_creation_input_tokens", 0) or 0
                eff = inp + cc * 1.25 + cr * 0.10
                log["tokens"] = {
                    "in": inp, "out": out,
                    "cache_read": cr, "cache_create": cc,
                    "effective_cost": round(eff, 1),
                }

                # Update session totals + estimate the baseline (uncompressed) cost.
                # Baseline estimate: add back the text-token equivalent of whatever
                # we replaced with images. Conservative — assumes baseline would
                # also have cached, so we apply the 10% cache_read rate to the
                # uncompressed delta.
                if log.get("compressed"):
                    txt_replaced = (log.get("system_text_chars", 0)
                                    + log.get("tool_text_added", 0)) // 4
                    img_tokens_est = log.get("expected_image_tokens", 0)
                    extra_text_input_baseline = max(0, txt_replaced - img_tokens_est)
                    # CRITICAL: the extra text would have been billed at the
                    # SAME mix of cache_create/cache_read as the actual call,
                    # NOT all at cache_read (10%). On cold-start turns where
                    # cache_create dominates, baseline should be billed at 1.25
                    # not 0.10 — otherwise we drastically under-estimate the
                    # savings and the dashboard shows tiny numbers.
                    cached_total = (cr or 0) + (cc or 0)
                    if cached_total > 0:
                        cc_share = (cc or 0) / cached_total
                        # Effective rate the extra text would have paid:
                        baseline_rate = cc_share * 1.25 + (1 - cc_share) * 0.10
                    else:
                        baseline_rate = 0.10  # fully warm-cache assumption
                    baseline_eff = eff + extra_text_input_baseline * baseline_rate
                else:
                    baseline_eff = eff

                with _session_stats["lock"]:
                    prev_saved = (_session_stats["effective_input_baseline_est"]
                                  - _session_stats["effective_input_actual"])
                    _session_stats["requests"] += 1
                    if log.get("compressed"):
                        _session_stats["compressed_requests"] += 1
                    _session_stats["effective_input_actual"] += eff
                    _session_stats["effective_input_baseline_est"] += baseline_eff
                    saved_so_far = (_session_stats["effective_input_baseline_est"]
                                    - _session_stats["effective_input_actual"])
                    # Push compact row for dashboard
                    row = {
                        "ts": time.time(),
                        "method": method,
                        "path": log.get("path", ""),
                        "status": log.get("status", 0),
                        "size_in": log.get("size_in", 0),
                        "size_out": log.get("size_out", 0),
                        "compressed": bool(log.get("compressed")),
                        "cc_added": log.get("cc_breakpoints_added"),
                        "expected_image_tokens": log.get("expected_image_tokens"),
                        "input_tokens": inp,
                        "cache_create": cc,
                        "cache_read": cr,
                        "effective_actual": round(eff, 1),
                        "effective_baseline": round(baseline_eff, 1),
                        "session_saved_so_far_delta": round(saved_so_far - prev_saved, 1),
                    }
                    _session_stats["recent"].append(row)

                # Persist cumulative totals (atomic JSON rewrite) + append
                # per-request line to the JSONL log so dashboards survive restart.
                _persist_stats()
                _append_request_log(row)

                log["session_saved_so_far"] = round(saved_so_far, 1)
                log["session_saved_usd"] = round(saved_so_far * 15.0 / 1e6, 4)

            print(f"[PROXY] {json.dumps(log)}", flush=True)

            try:
                self.send_response(resp.status_code)
                for k, v in resp.headers.items():
                    if k.lower() in HOP or k.lower() == "content-encoding":
                        continue
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(resp.content)))
                self.end_headers()
                self.wfile.write(resp.content)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as e:
                # Client (Claude Code) closed before we finished writing. Common
                # on stream timeouts / Ctrl-C / fast aborts. Not fatal — just log.
                print(f"[PROXY] client disconnect during response: {type(e).__name__}", flush=True)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as e:
            print(f"[PROXY] transport error: {type(e).__name__}", flush=True)
        except Exception as e:
            traceback.print_exc()
            try:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                msg = json.dumps({"error": "proxy_error", "detail": str(e)}).encode()
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
            except Exception:
                pass

    def do_GET(self): self._do_proxy("GET")
    def do_POST(self): self._do_proxy("POST")
    def do_PUT(self): self._do_proxy("PUT")
    def do_DELETE(self): self._do_proxy("DELETE")
    def do_HEAD(self): self._do_proxy("HEAD")


def main():
    print(f"Python token proxy listening on http://127.0.0.1:{PORT}", flush=True)
    print(f"  COMPRESS_SYSTEM={COMPRESS}  FONT={FONT_PATH}@{FONT_SIZE}pt  "
          f"PLACEMENT={PLACEMENT}  MIN_CHARS={MIN_COMPRESS_CHARS}", flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), ProxyHandler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
