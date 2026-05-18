//! Headless transform: read a request body from file (or stdin), run it through
//! the Rust transform() with default Claude Code settings, write the transformed
//! body + info JSON to disk for offline diffing against Python's transform.
//!
//! Run: cargo run --release --example transform_only -- <body.json> <out_dir>
//!
//! Produces:
//!   <out_dir>/body_out.json     — transformed body bytes (the JSON forwarded upstream)
//!   <out_dir>/info.json         — TransformInfo struct (dims, expected_image_tokens, etc.)
//!
//! Settings mirror bin/cli.js defaults: compress=true, all sub-flags on,
//! min_chars=2000, font_size=5pt. No env-var overrides.

use std::path::PathBuf;

use pixelpipe::font::AtlasFont;
use pixelpipe::transform::{transform, TransformConfig};
use dashmap::DashMap;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let body_path: PathBuf = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: transform_only <body.json> <out_dir>"))?
        .into();
    let out_dir: PathBuf = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: transform_only <body.json> <out_dir>"))?
        .into();

    std::fs::create_dir_all(&out_dir)?;

    let body = std::fs::read(&body_path)?;
    let font = AtlasFont::load(5.0)?;
    let render_cache = DashMap::new();
    let cfg = TransformConfig {
        compress: true,
        compress_tools: true,
        compress_schemas: true,
        compress_reminders: true,
        compress_tool_results: true,
        min_chars: 2000,
        font: &font,
        render_cache: &render_cache,
    };

    let (body_out, info) = transform(&body, &cfg);

    std::fs::write(out_dir.join("body_out.json"), &body_out)?;
    std::fs::write(
        out_dir.join("info.json"),
        serde_json::to_vec_pretty(&info)?,
    )?;

    eprintln!(
        "rust transform: in={}B  out={}B  compressed={}  imgs={}  dims={:?}",
        body.len(),
        body_out.len(),
        info.compressed,
        info.images,
        info.dims,
    );
    Ok(())
}
