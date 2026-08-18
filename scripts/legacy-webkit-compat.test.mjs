import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: [fileURLToPath(new URL("./legacy-webkit-compat.js", import.meta.url))],
  bundle: true,
  format: "iife",
  legalComments: "none",
  minify: true,
  target: "safari15",
  write: false,
});
const source = buildResult.outputFiles[0].text;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packedIndex = path.join(
  root,
  "src-tauri",
  "resources",
  "runtime",
  "node_modules",
  "@deepseek-ai",
  "dsh-web-frontend",
  "dist",
  "index.html",
);
if (existsSync(packedIndex)) {
  const html = readFileSync(packedIndex, "utf8");
  const match = html.match(/<script data-dsh-desktop-legacy-webkit>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, "packed Harness HTML must contain the compatibility bundle");
  assert.equal(match[1].trim(), source.trim(), "packed compatibility bundle must match the tested source");
  assert.ok(match.index < html.indexOf('<script type="module"'), "compatibility bundle must precede the module entry");
}

class TestAbortSignal {
  constructor() {
    this.aborted = false;
    this.listeners = new Set();
  }

  addEventListener(type, listener) {
    if (type === "abort") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "abort") this.listeners.delete(listener);
  }
}

class TestAbortController {
  constructor() {
    this.signal = new TestAbortSignal();
  }

  abort() {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    for (const listener of [...this.signal.listeners]) listener.call(this.signal);
  }
}

function install({ preserveNative = false } = {}) {
  const listeners = new Map();
  const context = vm.createContext({
    AbortController: TestAbortController,
    AbortSignal: TestAbortSignal,
    DOMException,
    Uint8Array,
    WeakMap,
    clearTimeout,
    crypto: {
      getRandomValues(bytes) {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    },
    setTimeout,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  });
  context.listeners = listeners;
  if (!preserveNative) {
    vm.runInContext(`
      delete Object.hasOwn;
      delete Array.prototype.at;
      delete String.prototype.at;
      delete Array.prototype.findLast;
      delete Array.prototype.findLastIndex;
      delete globalThis.structuredClone;
    `, context);
  } else {
    context.AbortSignal.timeout = () => "native-timeout";
    context.AbortSignal.any = () => "native-any";
    context.crypto.randomUUID = () => "native-random-uuid";
  }
  vm.runInContext(source, context);
  return context;
}

const context = install();
assert.equal(vm.runInContext(`Object.hasOwn({ value: 1 }, "value")`, context), true);
assert.equal(vm.runInContext(`["first", "last"].at(-1)`, context), "last");
assert.equal(vm.runInContext(`"abc".at(-1)`, context), "c");
assert.equal(vm.runInContext(`[1, 2, 3, 4].findLast(value => value % 2 === 0)`, context), 4);
assert.equal(vm.runInContext(`[1, 2, 3, 4].findLastIndex(value => value % 2 === 1)`, context), 2);
assert.equal(vm.runInContext(`structuredClone({ nested: new Map([["key", 7]]) }).nested.get("key")`, context), 7);
assert.match(context.crypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);

assert.equal(typeof context.AbortSignal.timeout, "function");
assert.equal(typeof context.AbortSignal.any, "function");
assert.equal(typeof context.AbortSignal.prototype.throwIfAborted, "function");
const timeoutSignal = context.AbortSignal.timeout(5);
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(timeoutSignal.aborted, true);
assert.equal(timeoutSignal.reason.name, "TimeoutError");

const first = new context.AbortController();
const second = new context.AbortController();
const combined = context.AbortSignal.any([first.signal, second.signal]);
second.abort("second");
assert.equal(combined.aborted, true);
assert.equal(combined.reason, "second");
assert.throws(() => combined.throwIfAborted(), (error) => error === "second");

context.listeners.get("unhandledrejection")({ reason: new Error("rpc failed") });
assert.equal(context.__DSH_DESKTOP_ERRORS__.at(-1).message, "rpc failed");

const nativeContext = install({ preserveNative: true });
assert.equal(nativeContext.AbortSignal.timeout(), "native-timeout");
assert.equal(nativeContext.AbortSignal.any(), "native-any");
assert.equal(nativeContext.crypto.randomUUID(), "native-random-uuid");

console.log("legacy WebKit compatibility tests passed");
