#!/usr/bin/env node
/**
 * Postinstall: verify Python 3.8+ and install Pillow + httpx (the only deps).
 * Idempotent — safe to run on reinstall.
 */
"use strict";
const { spawnSync } = require("child_process");

function findPython() {
  const candidates = ["python3", "python", "python3.12", "python3.11", "python3.10", "python3.9", "python3.8"];
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

function hasModule(py, mod) {
  const r = spawnSync(py, ["-c", `import ${mod}`], { stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0;
}

const py = findPython();
if (!py) {
  console.warn("\n[pixelpipe] WARNING: Python 3.8+ not found.");
  console.warn("  Install Python 3 (https://www.python.org/downloads/) then run:");
  console.warn("    python3 -m pip install Pillow httpx");
  console.warn("  Otherwise the proxy will fail to start.\n");
  process.exit(0); // don't break npm install
}

const need = [];
if (!hasModule(py, "PIL")) need.push("Pillow");
if (!hasModule(py, "httpx")) need.push("httpx");
if (need.length === 0) {
  console.log("[pixelpipe] Python deps already installed.");
  process.exit(0);
}

console.log(`[pixelpipe] Installing Python deps: ${need.join(", ")}`);
const args = ["-m", "pip", "install", "--quiet", "--user", ...need];
const r = spawnSync(py, args, { stdio: "inherit" });
if (r.status !== 0) {
  console.warn("\n[pixelpipe] WARNING: failed to auto-install Python deps.");
  console.warn(`  Please run manually:  ${py} -m pip install ${need.join(" ")}`);
}
