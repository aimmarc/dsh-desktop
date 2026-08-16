// dsh-desktop runtime launcher.
//
// The shell spawns:  node launch.js web --port <port>
// This file resolves the real dsh CLI inside the bundled node_modules and
// hands control over to it, keeping the standard node_modules layout intact
// (dsh resolves its own assets — frontend dist, agent presets, worker
// scripts — through import.meta.url / createRequire, so bundling into a
// single file is deliberately avoided).
//
// process.argv arrives as [node, launch.js, web, --port, 3080, ...]; dsh's
// bin.js reads process.argv.slice(2), so arguments pass through untouched.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

// The dsh CLI entry. `require.resolve` walks node_modules upward from this
// file's directory (resources/runtime/), matching the packaged layout.
const binPath = require.resolve("@deepseek-ai/dsh/lib/bin.js");

// bin.js is ESM ("type": "module" in the dsh package); dynamic import hands
// control to its self-executing dispatch.
await import(pathToFileURL(binPath).href);
