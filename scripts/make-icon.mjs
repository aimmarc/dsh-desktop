/**
 * make-icon.mjs — render the DeepSeek Harness whale favicon into a 1024x1024
 * app icon PNG, then regenerate the full Tauri icon set via `tauri icon`.
 *
 * The favicon path is a black whale on transparent. For an app icon we draw
 * it white on the DeepSeek gradient (the same look as the startup logo) so it
 * reads on both light and dark taskbars/title bars.
 *
 * Usage: node scripts/make-icon.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcSvg = path.join(
  root,
  "node_modules",
  "@deepseek-ai",
  "dsh-web-frontend",
  "dist",
  "favicon.svg"
);
const outPng = path.join(root, "src-tauri", "icons", "app-icon.png");

// 1. Read the whale path from the favicon (the single <path d="...">).
const svg = readFileSync(srcSvg, "utf8");
const m = svg.match(/<path[^>]*d="([^"]+)"/);
if (!m) throw new Error("whale path not found in favicon.svg");
const whalePath = m[1];

// 2. Build a 1024x1024 SVG: gradient background + white whale.
//    The favicon's viewBox is 50x50 with ~4px padding; we reuse the same
//    geometry scaled to 1024 and padded to 4% (matching 2/50).
const pad = 1024 * (2 / 50); // ~41px
const scale = (1024 - pad * 2) / 50;
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f8cff"/>
      <stop offset="1" stop-color="#7a5cff"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <g transform="translate(${pad} ${pad}) scale(${scale})">
    <path d="${whalePath}" fill="#ffffff"/>
  </g>
</svg>`;

const tmpSvg = path.join(root, "src-tauri", "icons", "_whale.svg");
writeFileSync(tmpSvg, iconSvg);

// 3. Render via sharp (bundled with dsh deps) — SVG support needs librsvg,
//    which sharp's win32 build includes.
const sharp = require("sharp");
await sharp(tmpSvg).png().toFile(outPng);
console.log("rendered", outPng);

// 4. Regenerate the whole icon set.
execSync(`npx tauri icon "${outPng}"`, { cwd: root, stdio: "inherit" });
console.log("icon set regenerated");
