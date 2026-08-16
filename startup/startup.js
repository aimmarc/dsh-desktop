// Startup page logic: asks the shell to start the dsh server, then navigates
// to the harness URL. Shows a retryable error when the server can't start.
//
// IPC access uses `window.__TAURI_INTERNALS__.invoke` — the low-level bridge
// that Tauri 2 ALWAYS injects. The high-level `window.__TAURI__` global
// (withGlobalTauri) is unreliable: it is undefined while top-level scripts
// run (tauri-apps/tauri#12990), so we never depend on it.

const statusEl = document.getElementById("status");
const spinnerEl = document.getElementById("spinner");
const errorEl = document.getElementById("error");
const retryBtn = document.getElementById("retry");

function getInvoke() {
  try {
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {
      return window.__TAURI_INTERNALS__.invoke;
    }
  } catch {}
  try {
    if (window.__TAURI__ && typeof window.__TAURI__.core?.invoke === "function") {
      return window.__TAURI__.core.invoke;
    }
  } catch {}
  return null;
}

function showError(msg) {
  statusEl.hidden = true;
  spinnerEl.hidden = true;
  errorEl.hidden = false;
  retryBtn.hidden = false;
  errorEl.textContent = msg;
}

async function boot() {
  statusEl.hidden = false;
  spinnerEl.hidden = false;
  errorEl.hidden = true;
  retryBtn.hidden = true;

  const invoke = getInvoke();
  if (!invoke) {
    showError(
      "无法连接桌面外壳（IPC 不可用）。请重新安装应用。\n" +
      "IPC bridge unavailable. Please reinstall the app."
    );
    return;
  }

  try {
    const url = await invoke("server_start");
    window.location.replace(url);
  } catch (e) {
    showError(String(e));
  }
}

retryBtn.addEventListener("click", boot);
boot();
