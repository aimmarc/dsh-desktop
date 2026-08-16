/**
 * pack.mjs — assemble the runtime directory that ships inside the app:
 *
 *   src-tauri/resources/runtime/
 *     launch.js                     (launcher, checked in)
 *     node_modules/…                (pruned + platform-trimmed copy of the
 *                                    project's node_modules)
 *
 * Strategy (why not a single esbuild bundle):
 *   dsh resolves its own assets — the frontend dist, agent presets, worker
 *   scripts, package.json versions — through `import.meta.url` and
 *   `createRequire(import.meta.url)`, i.e. against the real on-disk module
 *   layout. A single-file bundle would break every one of those paths, so we
 *   keep the standard node_modules tree and shrink it instead:
 *     1. resolve the production dependency closure from the root
 *        package.json (devDependencies like @tauri-apps/cli and esbuild are
 *        excluded),
 *     2. drop every native binary for platforms other than the current one,
 *     3. drop debug symbols (PDB), source maps, tests, docs, and @types,
 *     4. (optional, --minify) esbuild-minify every .js file in place —
 *        syntax-safe, keeps file paths and export names.
 *
 * Usage: node scripts/pack.mjs [--minify]
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const MINIFY = process.argv.includes("--minify");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcModules = path.join(root, "node_modules");
const runtimeDir = path.join(root, "src-tauri", "resources", "runtime");
const destModules = path.join(runtimeDir, "node_modules");

const platformKey = `${os.platform()}-${os.arch()}`; // e.g. win32-x64
const platKeyUnderscore = platformKey.replace("-", "_"); // koffi uses win32_x64

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function sizeOf(dir) {
  let total = 0;
  for (const f of walk(dir)) {
    try {
      total += statSync(f).size;
    } catch {}
  }
  return total;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/** Delete every PDB / map / exp / ilk in a tree. */
function dropSymbols(dir) {
  for (const f of walk(dir)) {
    if (/\.(pdb|ilk|exp)$/i.test(f) || f.endsWith(".map")) rmSync(f, { force: true });
  }
}

/**
 * Platform prune rules, keyed by package name (exact or prefix match).
 * `keepOnly` deletes the whole package unless it's the current platform's.
 * `trim` runs inside the package directory.
 */
const NATIVE_RULES = [
  {
    // node-pty: keep only current-platform prebuilds; drop PDBs + docs.
    match: (p) => p === "node-pty",
    trim: (pkgDir) => {
      const pre = path.join(pkgDir, "prebuilds");
      if (existsSync(pre)) {
        for (const plat of readdirSync(pre)) {
          if (plat !== platformKey) rmSync(path.join(pre, plat), { recursive: true, force: true });
        }
      }
      dropSymbols(pkgDir);
    },
  },
  {
    // @img/sharp-<platform>: keep only the current platform package.
    match: (p) => p.startsWith("@img/sharp-"),
    keepOnly: (pkgName) => pkgName === `@img/sharp-${platformKey}`,
  },
  {
    // koffi: platform dirs inside the package (win32_x64, darwin_arm64, ...).
    match: (p) => p === "koffi",
    trim: (pkgDir) => {
      for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.includes("_") && entry.name !== platKeyUnderscore) {
          rmSync(path.join(pkgDir, entry.name), { recursive: true, force: true });
        }
      }
      dropSymbols(pkgDir);
    },
  },
  {
    // node-addon-require-builtin-<platform>: keep only current platform.
    match: (p) => p.startsWith("node-addon-require-builtin-"),
    keepOnly: (pkgName) => {
      const expected = `node-addon-require-builtin-${platformKey}${process.platform === "win32" ? "-msvc" : ""}`;
      return pkgName === expected;
    },
  },
  {
    // node-addon-landlock-run: linux-only helper.
    match: (p) => p === "node-addon-landlock-run",
    keepOnly: () => process.platform === "linux",
  },
];

/** Files that are always safe to drop from a shipped runtime. */
const alwaysDrop = (rel) =>
  /(^|[\\/])\.(git|github)[\\/]/.test(rel) ||
  /(^|[\\/])(test|tests|__tests__|fixtures?|benchmarks?|docs)[\\/]/i.test(rel) ||
  /(^|[\\/])@types[\\/]/.test(rel) ||
  /\.(map|pdb|ilk|exp)$/.test(rel) ||
  /(^|[\\/])(README|CHANGELOG|CONTRIBUTING|LICENSE)[^\\/]*$/i.test(rel);

// ---------------------------------------------------------------------------
// production dependency closure
// ---------------------------------------------------------------------------

/** Collect the full production package name set reachable from `pkgNames`. */
function collectProdClosure(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const pkgJson = path.join(srcModules, name, "package.json");
    if (!existsSync(pkgJson)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(pkgJson, "utf8"));
    } catch {
      continue;
    }
    const deps = { ...(manifest.dependencies ?? {}) };
    // peerDependencies are resolved by the consumer; npm hoists them to the
    // tree root, so include them too if present.
    const peers = { ...(manifest.peerDependencies ?? {}) };
    const optional = { ...(manifest.optionalDependencies ?? {}) };
    for (const depName of [...Object.keys(deps), ...Object.keys(peers), ...Object.keys(optional)]) {
      // scoped names contain '/'; plain names don't need the join
      const key = depName.startsWith("@") ? depName : depName;
      if (!seen.has(key)) queue.push(key);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

console.log(`[pack] platform=${platformKey} minify=${MINIFY}`);
console.log(`[pack] source node_modules: ${mb(sizeOf(srcModules))} MB`);

const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const prodRoots = Object.keys(rootManifest.dependencies ?? {});
const prodSet = collectProdClosure(prodRoots);
console.log(`[pack] production closure: ${prodSet.size} packages (from ${prodRoots.join(", ")})`);

rmSync(destModules, { recursive: true, force: true });
mkdirSync(destModules, { recursive: true });

// 1. Copy only production packages (scoped packages individually).
let copied = 0;
let skipped = 0;

const entries = readdirSync(srcModules, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const src = path.join(srcModules, entry.name);

  if (entry.name.startsWith("@")) {
    for (const sub of readdirSync(src, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const pkgName = `${entry.name}/${sub.name}`;
      if (!prodSet.has(pkgName)) {
        skipped++;
        continue;
      }
      const pkgSrc = path.join(src, sub.name);
      if (!existsSync(path.join(pkgSrc, "package.json"))) continue;
      const rule = NATIVE_RULES.find((r) => r.match(pkgName));
      if (rule?.keepOnly && !rule.keepOnly(pkgName)) {
        console.log(`[pack] skip ${pkgName} (other platform)`);
        skipped++;
        continue;
      }
      const pkgDest = path.join(destModules, entry.name, sub.name);
      mkdirSync(path.dirname(pkgDest), { recursive: true });
      cpSync(pkgSrc, pkgDest, { recursive: true, force: true });
      rule?.trim?.(pkgDest);
      copied++;
    }
  } else {
    if (!prodSet.has(entry.name)) {
      skipped++;
      continue;
    }
    const rule = NATIVE_RULES.find((r) => r.match(entry.name));
    if (rule?.keepOnly && !rule.keepOnly(entry.name)) {
      console.log(`[pack] skip ${entry.name} (other platform)`);
      skipped++;
      continue;
    }
    const dest = path.join(destModules, entry.name);
    cpSync(src, dest, { recursive: true, force: true });
    rule?.trim?.(dest);
    copied++;
  }
}
console.log(`[pack] copied ${copied} packages, skipped ${skipped}`);

// 2. always-drop cleanup pass over the copied tree.
let droppedBytes = 0;
for (const f of walk(destModules)) {
  const rel = path.relative(destModules, f);
  if (alwaysDrop(rel)) {
    droppedBytes += statSync(f).size;
    rmSync(f, { force: true });
  }
}

// 3. remove now-empty dirs
function pruneEmpty(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const p = path.join(dir, entry.name);
      pruneEmpty(p);
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
    }
  }
}
pruneEmpty(destModules);

// 4. (optional) minify .js in place — keeps paths, drops whitespace.
//    Only @deepseek-ai packages are minified: they are ESM, so their named
//    exports are unaffected. Third-party packages (npm-published, already
//    minified) are left untouched because esbuild's CJS compression can
//    break Node's cjs-module-lexer static detection of named exports
//    (e.g. @opentelemetry/* `Object.defineProperty(exports, ...)` getters).
if (MINIFY) {
  const { transform } = await import("esbuild");
  let minified = 0;
  for (const f of walk(destModules)) {
    if (!f.endsWith(".js")) continue;
    if (!f.replaceAll("\\", "/").includes("/@deepseek-ai/")) continue;
    const src = readFileSync(f, "utf8");
    try {
      const { code } = await transform(src, { loader: "js", target: "node22", minify: true });
      if (code.length < src.length) {
        writeFileSync(f, code);
        minified++;
      }
    } catch {
      // leave non-minifiable files untouched
    }
  }
  console.log(`[pack] minified ${minified} @deepseek-ai js files`);
}

// 5. Report.
const finalSize = sizeOf(destModules);
console.log(`[pack] pruned+trimmed node_modules: ${mb(finalSize)} MB`);
console.log(`[pack] done -> ${destModules}`);
