//! Diff harness companion: read a JSON spec {name: text, ...}, render each via
//! the Rust pipeline, write PNGs to <out_dir>/<name>_<idx>.png, then emit
//! <out_dir>/manifest.json mapping name -> [filenames].
//!
//! Run: cargo run --release --example diff_render -- <spec.json> <out_dir>

use std::collections::BTreeMap;
use std::path::PathBuf;

use pixelpipe::font::AtlasFont;
use pixelpipe::render::render_chunks;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let spec_path: PathBuf = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: diff_render <spec.json> <out_dir>"))?
        .into();
    let out_dir: PathBuf = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: diff_render <spec.json> <out_dir>"))?
        .into();

    let spec_bytes = std::fs::read(&spec_path)?;
    let spec: BTreeMap<String, String> = serde_json::from_slice(&spec_bytes)?;

    let font = AtlasFont::load(5.0)?;

    let mut manifest: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (name, text) in &spec {
        let pngs = render_chunks(&font, text);
        let mut filenames = Vec::with_capacity(pngs.len());
        for (i, png) in pngs.iter().enumerate() {
            let fname = format!("{name}_{i}.png");
            std::fs::write(out_dir.join(&fname), &png.bytes)?;
            filenames.push(fname);
        }
        manifest.insert(name.clone(), filenames);
    }

    std::fs::write(
        out_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;

    eprintln!("rendered {} samples", spec.len());
    Ok(())
}
