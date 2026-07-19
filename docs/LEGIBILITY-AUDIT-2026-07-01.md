# Imaged-text legibility audit — 2026-07-01

Motivated by a demo failure: the pxpipe arm of `demo/effective-context` read all
files but could not report the `AUDIT-ZX9` line count, and hedged that imaged text
was uncertain. This audit measured **why**, with data, and shipped the fixes that
follow from it.

## TL;DR

- The Anthropic API **downscales every image** to fit BOTH long-edge ≤1568 px AND
  ~1.15 MP, then bills ≈ px/750 (per-image). Our old 1932×1932 page was billed at
  the cap but resampled **0.555×** — 5×8 glyphs reached the vision encoder at
  ~2.8×4.4 px. We were paying full price for pixels destroyed in transit.
- **Shipped:** page geometry clamped to **1568×728 = 1.14 MP** (WYSIWYG: billed/actual
  pixel ratio 3.25 → 1.04). No token-cost change per image; 614/614 tests green.
- **Update (2026-07-04):** the `px/750` figure above is a ~4–5% continuous
  approximation. Anthropic's current docs bill the exact **28-px patch count**
  `⌈w/28⌉×⌈h/28⌉` (a 1568×728 page = 56×26 = **1456** tokens, ≈ the px/750 slope
  measured here). The gate and export now use that exact formula via
  `src/core/anthropic-vision.ts` (tiers: standard 1568/1568, high-res 2576/4784).
- Reading exact strings off even **crisp** 5×8 tops out at **63%** (24-token blind
  test). Every miss is one of two classes the glyph-confusability matrix predicts:
  **case-normalization** (camelCase) and **single-glyph substitution** (hex/num).
- **7 of 9 misses are already covered by the factsheet** (SHAs, numbers ride as
  text). The 2 residual misses are camelCase code identifiers — not a factsheet shape.
- **Answer to "factsheet vs. RAG-escape":** both, split on a *sparsity* axis. Sparse
  precision (a few ids/page) → factsheet. Dense precision (every symbol in a code
  dump, >64 distinct) → the factsheet's 64-token budget can't hold it; that needs the
  re-fetch path. The scaffolding (`RecoverableBlock`) exists but is not yet wired to a
  model-callable tool.

## Method

`count_tokens` sweep (claude-sonnet-4-5) on synthetic PNGs at controlled dims;
14,935-row regression on real proxy traffic (`~/.pxpipe/events.jsonl`) for the
unresized slope; pixel-level Hamming matrix over the Spleen 5×8 atlas; and a 24-token
blind read where transcriptions were committed *before* revealing ground truth.

## 1. API resize (the free-fidelity lever)

| dims | px | px/750 | billed | verdict |
|---|---|---|---|---|
| 1072×1072 | 1.15 M | 1532 | 1525 | at cap |
| 1092×1092 | 1.19 M | 1589 | 1525 | CLAMPED |
| 1568×1568 | 2.46 M | 3278 | 1525 | CLAMPED |
| 1928×1928 (old page) | 3.72 M | 4956 | 1525 | CLAMPED (resampled 0.555×) |
| **1568×728 (new page)** | **1.14 M** | **1522** | **1460** | **linear — WYSIWYG** |

Cap is **per-image** (2×1092 in one request billed 3049 ≈ 2×1525). Sub-cap images pass
through unresized (real-traffic slope 733 px/tok, ≈ the documented 750).

**Cost nuance (not free):** the encoder caps at ~1.15 MP/image regardless, so per-image
cost is ~unchanged, but the new page holds 28,080 chars vs the old 92,160 → ~3.3× more
images for the same corpus. The old "16× vs text" compression was **partly fictional**:
it compressed by discarding pixels at the API boundary as silent blur. True legible rate
is ~5× vs text. The change doesn't add cost — it makes the model pay *visibly* for
legibility it was already being charged for but never received.

## 2. Glyph confusability (Spleen 5×8, 94 printable ASCII)

45 of 94 chars have a nearest neighbor at Hamming ≤ 3 px (of 40). Worst:
`,~;` `.~:` `H~K` at d=1; `0~O` `3~8` `5~S` `6~8` `8~B` `U~u` `V~v` `W~w` `X~x` at d=2.
`H~K` at d=1 is a font defect (glyph-surgery candidate). Downscaling 0.555× (old page)
collapses many d=2 pairs toward d=0 — indistinguishable.

## 3. Blind read accuracy (crisp 5×8, 24 tokens)

**15/24 = 63% exact-match.** By class: camel 6/8, num 6/8, **hex 3/8 (38%)**.

Miss taxonomy — 100% predicted by the matrix:
- **2/2 camel misses are case-only** (`tokenLedgerShard`→`tokenledgerShard`): the S/s
  class. This is the exact error that opened the session (`extractFactSheetTokens`
  misread as `extractFactsheetTokens`).
- **7/9 total misses are hex/num single- or double-glyph substitution**
  (`6↔8`, `5↔3`, `7↔4`) — the d=2 matrix pairs.

Reading harder cannot fix this: 5×8 is at the information floor for these pairs, and the
decoder fills ambiguity with a *confident, plausible* guess, not an "unclear" flag.

## 4. Where the factsheet lands

Of the 9 missed tokens, **7 are tier-0 factsheet shapes** (SHA/number) already emitted
as verbatim text next to the image — so the image misread is irrelevant in production.
The **2 residual** misses are camelCase identifiers, which are *not* a factsheet shape.

This is the empirical case for the factsheet: for sparse precision-critical tokens it
converts a coin-flip-per-glyph read into a 100% text quote, at ~5% of source chars.

## Recommendations

1. **Done — clamp to 1568×728.** Free fidelity; ratio 3.25→1.04; tests green.
2. **Done earlier — ticket-ID factsheet pattern + `×N` counts** (`AUDIT-ZX9`, `CVE-…`).
   Directly fixes the demo failure; validated by the `tick` class here.
3. **Recommended, not yet shipped — camelCase in the factsheet, carefully.** A dense
   code page can contain **>64 distinct** camelCase symbols, so a blind add would flood
   the 64-token budget and be lossy. Scope to ≥2 case-boundaries and let it sit at
   tier-1 (below SHAs/nums) so it can never evict critical tokens. Measure budget impact
   on a real code corpus first.
4. **Recommended — expose the re-fetch path.** `RecoverableBlock` already records
   `rec_<sha>` + original text + provenance for every imaged block. Wiring it to a
   model-callable "rehydrate this region as text" tool is the real answer for
   **dense** exact-recall (code files, large tables) that no fixed-size sidecar can
   hold. This is the "put a glass over it" mechanism, and it's half-built.
5. **Optional — glyph surgery** on `H~K` (d=1 defect) and case-contrast for the S/s
   class. Zero token cost, bounded upside; do it in the same eval harness as (3).

## Verdict on "is the factsheet the way, or should there be a RAG escape?"

Neither alone. The data draws a clean line on token **sparsity**:
- **Sparse** precision (few ids per page): factsheet. Proven — covers 7/9 misses.
- **Dense** precision (every symbol in a dump): exceeds any sidecar budget → re-fetch
  (`RecoverableBlock` → a rehydrate tool). Scaffolded, not yet exposed.

The image carries gist and structure (which survive fine); exactness rides a different
channel chosen by how much of it there is.
