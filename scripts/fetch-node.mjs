/**
 * fetch-node.mjs — download the Node.js runtime binary for the current
 * platform into src-tauri/resources/node/ (packaged by Tauri as
 * `resources/node`). Only the executable is kept.
 *
 * Usage: node scripts/fetch-node.mjs [version] [--universal]
 *   version    defaults to the Node LTS line used by dsh (22.x).
 *   --universal  macOS only: download BOTH x64 and arm64 node binaries and
 *                `lipo`-merge them into a single universal binary, so one
 *                app bundle runs natively on Intel and Apple Silicon Macs.
 */

import { createWriteStream, mkdirSync, rmSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "resources", "node");
const version = process.argv[2] ?? "v22.23.2";
const UNIVERSAL = process.argv.includes("--universal");

const platform = os.platform(); // win32 | darwin | linux
const arch = os.arch(); // x64 | arm64

function distName(archName) {
  if (platform === "win32") return `node-${version}-win-${archName}`;
  if (platform === "darwin") return `node-${version}-darwin-${archName}`;
  return `node-${version}-linux-${archName}`;
}

function archiveName(archName) {
  const base = distName(archName);
  return platform === "win32" ? `${base}.zip` : `${base}.tar.gz`;
}

const binRel = platform === "win32" ? "node.exe" : "bin/node";

async function download(url, dest) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** Download and extract one arch's node binary; returns its absolute path. */
async function fetchNodeBinary(archName, baseUrl) {
  const archive = path.join(os.tmpdir(), archiveName(archName));
  if (!existsSync(archive)) await download(`${baseUrl}/${archiveName(archName)}`, archive);
  const tmp = path.join(os.tmpdir(), `dsh-node-${archName}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  if (platform === "win32") {
    execSync(`tar -xf "${archive}" -C "${tmp}"`, { stdio: "inherit" });
  } else {
    execSync(`tar -xzf "${archive}" -C "${tmp}"`, { stdio: "inherit" });
  }
  const bin = path.join(tmp, distName(archName), binRel);
  if (!existsSync(bin)) throw new Error(`node binary not found: ${bin}`);
  return bin;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const baseUrl = `https://nodejs.org/dist/${version}`;

  if (platform === "darwin" && UNIVERSAL) {
    // Universal: lipo-merge x64 + arm64 into one node binary.
    const x64 = await fetchNodeBinary("x64", baseUrl);
    const arm64 = await fetchNodeBinary("arm64", baseUrl);
    const out = path.join(outDir, "node");
    execSync(`lipo -create "${x64}" "${arm64}" -output "${out}"`, { stdio: "inherit" });
    chmodSync(out, 0o755);
    rmSync(path.dirname(x64), { recursive: true, force: true });
    rmSync(path.dirname(arm64), { recursive: true, force: true });
    execSync(`lipo -info "${out}"`, { stdio: "inherit" });
    console.log(`universal node runtime ready in ${outDir}`);
    return;
  }

  const bin = await fetchNodeBinary(arch, baseUrl);
  const out = platform === "win32"
    ? path.join(outDir, "node.exe")
    : path.join(outDir, "node");
  copyFileSync(bin, out);
  if (platform !== "win32") chmodSync(out, 0o755);
  rmSync(path.dirname(bin), { recursive: true, force: true });
  console.log(`node runtime ready in ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
