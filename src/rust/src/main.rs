//! pixelpipe — token-saving proxy for Claude Code.
//!
//! Architecture mirrors the proven Python prototype:
//!   1. Accept HTTP from Claude Code on a local port.
//!   2. For POST /v1/messages: parse JSON body, replace the bulky system
//!      prompt + tool descriptions + tool schemas + <system-reminder> blocks
//!      with a single rendered PNG image. Stub the original fields.
//!   3. Forward the modified request to api.anthropic.com untouched-otherwise.
//!   4. Return the response unchanged. Log effective-token math.
//!
//! Single static binary, no Python dependency.

use clap::Parser;
use std::sync::Arc;

mod proxy;
mod stats;
mod transform;
mod render;
mod font;

#[derive(Parser, Debug, Clone)]
#[command(name = "pixelpipe", version, about, long_about = None)]
struct Args {
    /// Port to listen on
    #[arg(short, long, default_value_t = 47821)]
    port: u16,

    /// Disable ALL compression (pure passthrough — for benchmarking)
    #[arg(long)]
    no_compress: bool,

    /// Don't compress tool descriptions
    #[arg(long)]
    no_tools: bool,

    /// Don't compress tool input_schemas (saves the most)
    #[arg(long)]
    no_schemas: bool,

    /// Don't compress <system-reminder> blocks
    #[arg(long)]
    no_reminders: bool,

    /// Don't compress large tool_result content
    #[arg(long)]
    no_tool_results: bool,

    /// Font size for rendering (5pt is verified OCR floor)
    #[arg(long, default_value_t = 5.0)]
    font_size: f32,

    /// Minimum chars before triggering compression
    #[arg(long, default_value_t = 2000)]
    min_chars: usize,

    /// Upstream URL (default: https://api.anthropic.com)
    #[arg(long, default_value = "https://api.anthropic.com")]
    upstream: String,
}

#[derive(Clone)]
pub struct AppState {
    pub args: Arc<Args>,
    pub client: reqwest::Client,
    pub render_cache: Arc<dashmap::DashMap<[u8; 32], Vec<render::Png>>>,
    pub stats: Arc<stats::Stats>,
    pub font: Arc<font::AtlasFont>,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("pixelpipe=info,info")),
        )
        .with_target(false)
        .init();

    let port = args.port;
    let compress = !args.no_compress;
    let font_size = args.font_size;

    let state = AppState {
        args: Arc::new(args),
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()?,
        render_cache: Arc::new(dashmap::DashMap::new()),
        stats: Arc::new(stats::Stats::default()),
        font: Arc::new(font::AtlasFont::load(font_size)?),
    };

    println!("pixelpipe v{} starting", env!("CARGO_PKG_VERSION"));
    println!("  port:          {}", port);
    println!("  compression:   {}", if compress { "ON" } else { "OFF (passthrough)" });
    if compress {
        println!("    font:        JetBrains Mono {}pt", font_size);
    }
    println!();
    println!("  Point Claude Code at: ANTHROPIC_BASE_URL=http://127.0.0.1:{}", port);
    println!("  Live stats:           curl http://127.0.0.1:{}/proxy-stats", port);
    println!();

    proxy::serve(port, state).await
}

// Submodules declared inline at top of file
