import structuredClonePolyfill from "@ungap/structured-clone";

(function installLegacyWebKitCompat(global) {
  var installed = [];

  function defineValue(target, name, value) {
    if (typeof target[name] === "function") return false;
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value: value,
      });
    } catch (_error) {
      try {
        target[name] = value;
      } catch (_assignmentError) {
        return false;
      }
    }
    if (typeof target[name] !== "function") return false;
    installed.push(name);
    return true;
  }

  function toIntegerOrInfinity(value) {
    var number = Number(value);
    if (number !== number || number === 0) return 0;
    if (number === Infinity || number === -Infinity) return number;
    return number < 0 ? Math.ceil(number) : Math.floor(number);
  }

  function toLength(value) {
    var length = toIntegerOrInfinity(value);
    if (length <= 0) return 0;
    return Math.min(length, Number.MAX_SAFE_INTEGER);
  }

  function at(index) {
    if (this == null) throw new TypeError("at called on null or undefined");
    var object = Object(this);
    var length = toLength(object.length);
    var relativeIndex = toIntegerOrInfinity(index);
    var actualIndex = relativeIndex >= 0 ? relativeIndex : length + relativeIndex;
    return actualIndex < 0 || actualIndex >= length ? undefined : object[actualIndex];
  }

  defineValue(Object, "hasOwn", function hasOwn(object, property) {
    if (object == null) throw new TypeError("Object.hasOwn called on null or undefined");
    return Object.prototype.hasOwnProperty.call(Object(object), property);
  });
  defineValue(Array.prototype, "at", at);
  defineValue(String.prototype, "at", at);
  defineValue(Array.prototype, "findLast", function findLast(predicate, thisArg) {
    if (this == null) throw new TypeError("findLast called on null or undefined");
    if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
    var object = Object(this);
    for (var index = toLength(object.length) - 1; index >= 0; index -= 1) {
      var value = object[index];
      if (predicate.call(thisArg, value, index, object)) return value;
    }
    return undefined;
  });
  defineValue(Array.prototype, "findLastIndex", function findLastIndex(predicate, thisArg) {
    if (this == null) throw new TypeError("findLastIndex called on null or undefined");
    if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
    var object = Object(this);
    for (var index = toLength(object.length) - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, object[index], index, object)) return index;
    }
    return -1;
  });

  if (typeof global.structuredClone !== "function") {
    defineValue(global, "structuredClone", structuredClonePolyfill);
  }

  if (global.crypto && typeof global.crypto.getRandomValues === "function") {
    defineValue(global.crypto, "randomUUID", function randomUUID() {
      var bytes = global.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = bytes[6] & 15 | 64;
      bytes[8] = bytes[8] & 63 | 128;
      var hex = [];
      for (var index = 0; index < bytes.length; index += 1) {
        hex.push(bytes[index].toString(16).padStart(2, "0"));
      }
      return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" +
        hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-" +
        hex.slice(10).join("");
    });
  }

  var AbortSignalCtor = global.AbortSignal;
  var AbortControllerCtor = global.AbortController;
  if (typeof AbortSignalCtor === "function" && typeof AbortControllerCtor === "function") {
    var abortReasons = new WeakMap();
    var originalAbort = AbortControllerCtor.prototype.abort;
    var reasonDescriptor = Object.getOwnPropertyDescriptor(AbortSignalCtor.prototype, "reason");

    if (!reasonDescriptor || typeof reasonDescriptor.get !== "function") {
      try {
        Object.defineProperty(AbortSignalCtor.prototype, "reason", {
          configurable: true,
          get: function reason() {
            if (!this.aborted) return undefined;
            return abortReasons.has(this) ? abortReasons.get(this) : new DOMException("This operation was aborted", "AbortError");
          },
        });
        AbortControllerCtor.prototype.abort = function abort(reason) {
          abortReasons.set(this.signal, reason === undefined ? new DOMException("This operation was aborted", "AbortError") : reason);
          return originalAbort.call(this);
        };
        installed.push("AbortSignal.reason");
      } catch (_error) {}
    }

    defineValue(AbortSignalCtor.prototype, "throwIfAborted", function throwIfAborted() {
      if (this.aborted) throw this.reason;
    });
    defineValue(AbortSignalCtor, "timeout", function timeout(milliseconds) {
      var controller = new AbortControllerCtor();
      var delay = Number(milliseconds);
      if (!Number.isFinite(delay) || delay < 0) {
        throw new TypeError("AbortSignal.timeout requires a non-negative finite delay");
      }
      var timer = global.setTimeout(function abortAfterTimeout() {
        controller.abort(new DOMException("The operation timed out", "TimeoutError"));
      }, delay);
      controller.signal.addEventListener("abort", function clearAbortTimer() {
        global.clearTimeout(timer);
      }, { once: true });
      return controller.signal;
    });
    defineValue(AbortSignalCtor, "any", function any(signals) {
      var inputs = Array.from(signals);
      var controller = new AbortControllerCtor();
      var listeners = [];

      function cleanup() {
        for (var index = 0; index < listeners.length; index += 1) {
          listeners[index][0].removeEventListener("abort", listeners[index][1]);
        }
        listeners = [];
      }

      function forwardAbort(signal) {
        cleanup();
        controller.abort(signal.reason);
      }

      for (var index = 0; index < inputs.length; index += 1) {
        var signal = inputs[index];
        if (!(signal instanceof AbortSignalCtor)) {
          cleanup();
          throw new TypeError("AbortSignal.any accepts only AbortSignal instances");
        }
        if (signal.aborted) {
          forwardAbort(signal);
          return controller.signal;
        }
        var listener = forwardAbort.bind(null, signal);
        listeners.push([signal, listener]);
        signal.addEventListener("abort", listener, { once: true });
      }
      return controller.signal;
    });
  }

  var errors = global.__DSH_DESKTOP_ERRORS__;
  if (!Array.isArray(errors)) {
    errors = [];
    global.__DSH_DESKTOP_ERRORS__ = errors;
  }

  function truncate(value, limit) {
    var text;
    try {
      text = String(value == null ? "" : value);
    } catch (_error) {
      text = "[unprintable]";
    }
    return text.length > limit ? text.slice(0, limit) + "..." : text;
  }

  function record(kind, error, fallbackMessage) {
    var isError = error && typeof error === "object";
    errors.push({
      timestamp: new Date().toISOString(),
      kind: kind,
      name: truncate(isError && error.name ? error.name : kind, 120),
      message: truncate(isError && error.message ? error.message : fallbackMessage || error, 2000),
      stack: truncate(isError && error.stack ? error.stack : "", 8000),
    });
    if (errors.length > 50) errors.splice(0, errors.length - 50);
  }

  if (typeof global.addEventListener === "function" && !global.__DSH_DESKTOP_ERROR_CAPTURE__) {
    global.__DSH_DESKTOP_ERROR_CAPTURE__ = true;
    global.addEventListener("error", function onError(event) {
      record("error", event.error, event.message);
    });
    global.addEventListener("unhandledrejection", function onUnhandledRejection(event) {
      record("unhandledrejection", event.reason, "Unhandled promise rejection");
    });
  }
  if (installed.length > 0) record("compat", null, "installed: " + installed.join(", "));
})(globalThis);
