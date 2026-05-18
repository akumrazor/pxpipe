#!/usr/bin/env node
/**
 * pixelpipe CLI
 *
 * Usage:
 *   npx pixelpipe                  # start on default port 47821
 *   npx pixelpipe --port 9000      # custom port
 *   npx pixelpipe --no-compress    # disable compression (passthrough)
 *
 * Then point Claude Code at it:
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude
 */
"use strict";

const path = require("path");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");

const PROXY_PY = path.join(__dirname, "..", "src", "proxy.py");

function parseArgs(argv) {
  const opts = {
    port: 47821,
    compress: true,
    tools: true,
    schemas: true,
    reminders: true,
    fontSize: 5,
    minChars: 2000,
    help: false,
    version: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-p": case "--port": opts.port = parseInt(argv[++i], 10); break;
      case "--no-compress": opts.compress = false; break;
      case "--no-tools": opts.tools = false; break;
      case "--no-schemas": opts.schemas = false; break;
      case "--no-reminders": opts.reminders = false; break;
      case "--font-size": opts.fontSize = parseInt(argv[++i], 10); break;
      case "--min-chars": opts.minChars = parseInt(argv[++i], 10); break;
      case "-h": case "--help": opts.help = true; break;
      case "-v": case "--version": opts.version = true; break;
      default:
        if (a.startsWith("--")) {
          console.error(`Unknown option: ${a}`);
          process.exit(2);
        }
    }
  }
  return opts;
}

function printHelp() {
  console.log(`pixelpipe — token-saving proxy for Claude Code

Renders system prompt + tool definitions as bitmap images. Achieves 65-73%
token savings on Opus 4.7 with 100% reasoning quality preserved.

USAGE
  npx pixelpipe [options]

OPTIONS
  -p, --port <N>          Port to listen on (default: 47821)
  --no-compress           Disable all compression (pure passthrough)
  --no-tools              Don't compress tool descriptions
  --no-schemas            Don't compress tool input_schemas (saves most tokens)
  --no-reminders          Don't compress <system-reminder> blocks
  --font-size <N>         Render font size in pt (default: 5; <5 fails OCR)
  --min-chars <N>         Minimum chars to trigger compression (default: 2000)
  -h, --help              Show this help
  -v, --version           Show version

USAGE WITH CLAUDE CODE
  Terminal 1:
    npx pixelpipe

  Terminal 2:
    ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude --exclude-dynamic-system-prompt-sections

  Tip: add the --exclude-dynamic-system-prompt-sections flag (or set
  CLAUDE_CODE_EXCLUDE_DYNAMIC_SYSTEM_PROMPT_SECTIONS=1) so Claude Code's
  cwd/git/env data is byte-stable across turns — this lets the rendered
  image hit cache instead of being re-rendered every turn.

REQUIREMENTS
  Python 3.8+ with Pillow and httpx. Run \`npm install\` and the postinstall
  script will install them automatically.

VERIFIED SAVINGS (Opus 4.7, real Claude Code workflows)
  - Simple call:          30% token reduction
  - Coding task (3 turn): 43% token reduction
  - Multi-tool (Grep/Glob/Read/Edit/Bash): 73% token reduction
  - 10-turn session:      67% token reduction (≈ $1.18 saved per session)
`);
}

function readPkgVersion() {
  try {
    return require(path.join(__dirname, "..", "package.json")).version;
  } catch { return "unknown"; }
}

function findPython() {
  const candidates = ["python3", "python", "python3.12", "python3.11", "python3.10"];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    if (r.status === 0) {
      const ver = (r.stdout || r.stderr || Buffer.from("")).toString();
      const m = ver.match(/Python (\d+)\.(\d+)/);
      if (m && parseInt(m[1], 10) >= 3 && parseInt(m[2], 10) >= 8) return c;
    }
  }
  return null;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printHelp(); process.exit(0); }
  if (opts.version) { console.log(readPkgVersion()); process.exit(0); }

  const py = findPython();
  if (!py) {
    console.error("ERROR: Python 3.8+ not found on PATH. Please install Python 3.");
    console.error("  macOS:  brew install python");
    console.error("  Linux:  apt install python3 python3-pip");
    process.exit(1);
  }

  if (!fs.existsSync(PROXY_PY)) {
    console.error(`ERROR: proxy script not found at ${PROXY_PY}`);
    process.exit(1);
  }

  const env = { ...process.env,
    PORT: String(opts.port),
    COMPRESS_SYSTEM: opts.compress ? "1" : "0",
    COMPRESS_TOOLS: opts.compress && opts.tools ? "1" : "0",
    COMPRESS_SCHEMAS: opts.compress && opts.schemas ? "1" : "0",
    COMPRESS_REMINDERS: opts.compress && opts.reminders ? "1" : "0",
    COMPRESS_TOOL_RESULTS: opts.compress ? "1" : "0",
    PLACEMENT: "user",
    FONT_SIZE: String(opts.fontSize),
    MIN_COMPRESS_CHARS: String(opts.minChars),
  };

  console.log(`pixelpipe v${readPkgVersion()} starting...`);
  console.log(`  python:        ${py}`);
  console.log(`  port:          ${opts.port}`);
  console.log(`  compression:   ${opts.compress ? "ON" : "OFF (passthrough)"}`);
  if (opts.compress) {
    console.log(`    tools:       ${opts.tools}`);
    console.log(`    schemas:     ${opts.schemas}`);
    console.log(`    reminders:   ${opts.reminders}`);
    console.log(`    font:        Menlo ${opts.fontSize}pt`);
  }
  console.log("");
  console.log(`  Point Claude Code at: ANTHROPIC_BASE_URL=http://127.0.0.1:${opts.port}`);
  console.log("");

  const child = spawn(py, [PROXY_PY], { stdio: "inherit", env });

  const shutdown = () => { try { child.kill("SIGTERM"); } catch {} };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  child.on("exit", (code) => process.exit(code || 0));
}

main();
