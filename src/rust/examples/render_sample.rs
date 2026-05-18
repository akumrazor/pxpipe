//! Render a sample text → PNG so we can visually inspect + OCR-test.
//! Run: cargo run --example render_sample -- <output.png> [size]

use pixelpipe::font::AtlasFont;
use pixelpipe::render::render_chunks;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let out = args.next().unwrap_or_else(|| "/tmp/rust_sample.png".to_string());
    let size: f32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(5.0);

    let font = AtlasFont::load(size)?;
    println!("cell: {}x{}", font.cell_w, font.cell_h);

    let sample = "def fibonacci(n):\n    if n <= 1: return n\n    return fibonacci(n-1) + fibonacci(n-2)\nprint(fibonacci(10))";

    let pngs = render_chunks(&font, sample);
    println!("images: {}, dims: {:?}", pngs.len(), pngs.iter().map(|p| (p.width, p.height)).collect::<Vec<_>>());

    std::fs::write(&out, &pngs[0].bytes)?;
    println!("wrote {} ({} bytes)", out, pngs[0].bytes.len());
    Ok(())
}
