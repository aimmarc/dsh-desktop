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
const UNIVERSAL = process.argv.includes("--universal");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcModules = path.join(root, "node_modules");
const runtimeDir = path.join(root, "src-tauri", "resources", "runtime");
const destModules = path.join(runtimeDir, "node_modules");

// Platform key(s) to keep. Normal: exactly the current platform. Universal
// (macOS only): keep BOTH darwin-x64 and darwin-arm64 native binaries so the
// universal app bundle runs natively on Intel and Apple Silicon.
const platformKeys = UNIVERSAL && process.platform === "darwin"
  ? ["darwin-x64", "darwin-arm64"]
  : [`${os.platform()}-${os.arch()}`];
const platKeysUnderscore = platformKeys.map((k) => k.replace("-", "_")); // koffi uses darwin_arm64

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
    // node-pty: keep only the target platform(s) prebuilds; drop PDBs + docs.
    match: (p) => p === "node-pty",
    trim: (pkgDir) => {
      const pre = path.join(pkgDir, "prebuilds");
      if (existsSync(pre)) {
        for (const plat of readdirSync(pre)) {
          if (!platformKeys.includes(plat)) rmSync(path.join(pre, plat), { recursive: true, force: true });
        }
      }
      dropSymbols(pkgDir);
    },
  },
  {
    // @img/sharp-<platform> and @img/sharp-libvips-<platform>: keep only the
    // target platform package(s). Name forms: `sharp-darwin-x64` and
    // `sharp-libvips-darwin-x64`.
    match: (p) => p.startsWith("@img/sharp-"),
    keepOnly: (pkgName) => {
      const tail = pkgName.slice("@img/sharp-".length); // e.g. "libvips-darwin-arm64"
      const plat = tail.startsWith("libvips-") ? tail.slice("libvips-".length) : tail;
      return platformKeys.includes(plat);
    },
  },
  {
    // koffi: platform dirs inside the package (win32_x64, darwin_arm64, ...).
    match: (p) => p === "koffi",
    trim: (pkgDir) => {
      for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.includes("_") && !platKeysUnderscore.includes(entry.name)) {
          rmSync(path.join(pkgDir, entry.name), { recursive: true, force: true });
        }
      }
      dropSymbols(pkgDir);
    },
  },
  {
    // node-addon-require-builtin-<platform>: keep only target platform(s).
    // The platform package appends "-msvc" on Windows (…-win32-x64-msvc).
    match: (p) => p.startsWith("node-addon-require-builtin-"),
    keepOnly: (pkgName) => {
      const expected = platformKeys.map((k) => `node-addon-require-builtin-${k}${process.platform === "win32" ? "-msvc" : ""}`);
      return expected.includes(pkgName);
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

console.log(`[pack] platform=${platformKeys.join("+")} minify=${MINIFY} universal=${UNIVERSAL}`);
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

// 1b. Universal (macOS) fix-up: npm only installs platform packages matching
//     the build machine (CI runs arm64), so the x64 sharp platform packages
//     never land in node_modules. Download and inject the missing platform
//     packages straight from the npm registry (bypassing npm's os/cpu gate).
if (UNIVERSAL && process.platform === "darwin") {
  const { execSync } = await import("node:child_process");
  const registry = process.env.npm_config_registry ?? "https://registry.npmjs.org";
  const sharpPkg = JSON.parse(readFileSync(path.join(srcModules, "sharp", "package.json"), "utf8"));
  const optional = sharpPkg.optionalDependencies ?? {};
  const wanted = ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"];
  for (const name of wanted) {
    if (existsSync(path.join(destModules, name))) continue; // already present
    const version = optional[name];
    if (!version) {
      console.log(`[pack] universal: ${name} not declared by sharp, skipping`);
      continue;
    }
    // Resolve the exact version. sharp pins these in optionalDependencies
    // (e.g. "0.35.3"), so prefer the literal key; if it is a range, fall back
    // to semver-latest matching the range.
    const manifestUrl = `${registry}/${name.replace("/", "%2F")}`;
    const res = await fetch(manifestUrl, { headers: { accept: "application/vnd.npm.install-v1+json" } });
    if (!res.ok) throw new Error(`[pack] universal: cannot fetch manifest for ${name}: HTTP ${res.status}`);
    const manifest = await res.json();
    const versions = manifest.versions ?? {};
    const exact = versions[version];
    const matched = exact ? version : Object.keys(versions).filter((v) => v.startsWith(version.replace(/^[\^~]/, ""))).sort().pop();
    if (!matched || !versions[matched]) throw new Error(`[pack] universal: no version for ${name}@${version}`);
    const tarball = versions[matched].dist?.tarball;
    if (!tarball) throw new Error(`[pack] universal: no tarball for ${name}@${matched}`);
    console.log(`[pack] universal: fetching ${name}@${matched}`);
    const tarRes = await fetch(tarball);
    if (!tarRes.ok) throw new Error(`[pack] universal: download failed ${tarball}: HTTP ${tarRes.status}`);
    const buf = Buffer.from(await tarRes.arrayBuffer());
    const tmpTar = path.join(os.tmpdir(), `${name.replace("/", "-")}.tgz`);
    writeFileSync(tmpTar, buf);
    const tmpDir = path.join(os.tmpdir(), `univ-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    execSync(`tar -xzf "${tmpTar}" -C "${tmpDir}"`, { stdio: "inherit" });
    const pkgSrc = path.join(tmpDir, "package");
    const pkgDest = path.join(destModules, name);
    mkdirSync(path.dirname(pkgDest), { recursive: true });
    cpSync(pkgSrc, pkgDest, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpTar, { force: true });
    console.log(`[pack] universal: injected ${name}`);
  }
}

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
