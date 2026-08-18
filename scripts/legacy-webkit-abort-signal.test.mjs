import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./legacy-webkit-abort-signal.js", import.meta.url), "utf8");

class TestAbortSignal {
  constructor() {
    this.aborted = false;
    this.reason = undefined;
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

  abort(reason) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason;
    for (const listener of [...this.signal.listeners]) listener.call(this.signal);
  }
}

function install() {
  const context = vm.createContext({
    AbortController: TestAbortController,
    AbortSignal: TestAbortSignal,
    clearTimeout,
    setTimeout,
  });
  vm.runInContext(source, context);
  return context;
}

const context = install();
assert.equal(typeof context.AbortSignal.timeout, "function");
assert.equal(typeof context.AbortSignal.any, "function");

const timeoutSignal = context.AbortSignal.timeout(5);
assert.equal(timeoutSignal.aborted, false);
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(timeoutSignal.aborted, true);

const first = new context.AbortController();
const second = new context.AbortController();
const combined = context.AbortSignal.any([first.signal, second.signal]);
second.abort("second");
assert.equal(combined.aborted, true);
assert.equal(combined.reason, "second");

const alreadyAborted = new context.AbortController();
alreadyAborted.abort("early");
const immediate = context.AbortSignal.any([alreadyAborted.signal]);
assert.equal(immediate.aborted, true);
assert.equal(immediate.reason, "early");

const nativeTimeout = () => "native-timeout";
const nativeAny = () => "native-any";
const nativeContext = vm.createContext({
  AbortController: TestAbortController,
  AbortSignal: class extends TestAbortSignal {},
  clearTimeout,
  setTimeout,
});
nativeContext.AbortSignal.timeout = nativeTimeout;
nativeContext.AbortSignal.any = nativeAny;
vm.runInContext(source, nativeContext);
assert.equal(nativeContext.AbortSignal.timeout, nativeTimeout);
assert.equal(nativeContext.AbortSignal.any, nativeAny);

console.log("legacy WebKit AbortSignal compatibility tests passed");
