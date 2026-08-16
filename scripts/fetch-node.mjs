/**
 * fetch-node.mjs — download the Node.js runtime binary for the current
 * platform into src-tauri/resources/node/ (packaged by Tauri as
 * `resources/node`). Only the executable is kept.
 *
 * Usage: node scripts/fetch-node.mjs [version]
 *   version defaults to the Node LTS line used by dsh (22.x).
 */

import { createWriteStream, mkdirSync, rmSync, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "resources", "node");
const version = process.argv[2] ?? "v22.23.2";

const platform = os.platform(); // win32 | darwin | linux
const arch = os.arch(); // x64 | arm64

function distName() {
  if (platform === "win32") return `node-${version}-win-${arch}`;
  if (platform === "darwin") return `node-${version}-darwin-${arch}`;
  return `node-${version}-linux-${arch}`;
}

function archiveName() {
  const base = distName();
  return platform === "win32" ? `${base}.zip` : `${base}.tar.gz`;
}

const binRel = platform === "win32" ? "node.exe" : "bin/node";

async function download(url, dest) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const archive = path.join(os.tmpdir(), archiveName());
  const baseUrl = `https://nodejs.org/dist/${version}`;

  if (platform === "win32") {
    if (!existsSync(archive)) await download(`${baseUrl}/${archiveName()}`, archive);
    // Extract only node.exe from the zip without a zip dependency:
    // use PowerShell's Expand-Archive via a subprocess is heavy; instead use
    // the built-in `tar` (bsdtar) that ships with Windows 10+.
    const { execSync } = await import("node:child_process");
    const tmp = path.join(os.tmpdir(), `dsh-node-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    execSync(`tar -xf "${archive}" -C "${tmp}"`, { stdio: "inherit" });
    const exe = path.join(tmp, distName(), "node.exe");
    if (!existsSync(exe)) throw new Error(`node.exe not found in archive: ${exe}`);
    // Copy to resources/node/node.exe
    const { copyFileSync } = await import("node:fs");
    copyFileSync(exe, path.join(outDir, "node.exe"));
    rmSync(tmp, { recursive: true, force: true });
  } else {
    if (!existsSync(archive)) await download(`${baseUrl}/${archiveName()}`, archive);
    const { execSync } = await import("node:child_process");
    const tmp = path.join(os.tmpdir(), `dsh-node-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    execSync(`tar -xzf "${archive}" -C "${tmp}"`, { stdio: "inherit" });
    const bin = path.join(tmp, distName(), binRel);
    if (!existsSync(bin)) throw new Error(`node binary not found: ${bin}`);
    const { copyFileSync, chmodSync } = await import("node:fs");
    copyFileSync(bin, path.join(outDir, platform === "darwin" ? "node" : "node"));
    chmodSync(path.join(outDir, "node"), 0o755);
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`node runtime ready in ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
