(function installAbortSignalCompat(global) {
  var AbortSignalCtor = global.AbortSignal;
  var AbortControllerCtor = global.AbortController;

  if (typeof AbortSignalCtor !== "function" || typeof AbortControllerCtor !== "function") return;

  function defineStatic(name, value) {
    if (typeof AbortSignalCtor[name] === "function") return;
    try {
      Object.defineProperty(AbortSignalCtor, name, {
        configurable: true,
        writable: true,
        value: value,
      });
    } catch (_error) {
      AbortSignalCtor[name] = value;
    }
  }

  defineStatic("timeout", function timeout(milliseconds) {
    var controller = new AbortControllerCtor();
    var delay = Number(milliseconds);
    if (!Number.isFinite(delay) || delay < 0) {
      throw new TypeError("AbortSignal.timeout requires a non-negative finite delay");
    }

    var timer = global.setTimeout(function abortAfterTimeout() {
      controller.abort();
    }, delay);
    controller.signal.addEventListener("abort", function clearAbortTimer() {
      global.clearTimeout(timer);
    }, { once: true });
    return controller.signal;
  });

  defineStatic("any", function any(signals) {
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
      try {
        controller.abort(signal.reason);
      } catch (_error) {
        controller.abort();
      }
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
})(globalThis);
