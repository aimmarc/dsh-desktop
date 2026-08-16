// Startup page i18n: zh-CN / en, chosen from the browser locale. The dsh
// web UI itself follows the system locale through its own locale plugin; this
// shell page only localizes its own loading/error/retry UI.
const I18N = {
  zh: {
    title: "DeepSeek Harness",
    starting: "正在启动本地服务…",
    retry: "重试",
    hint: "首次启动可能需要一点时间，请稍候",
  },
  en: {
    title: "DeepSeek Harness",
    starting: "Starting local service…",
    retry: "Retry",
    hint: "First launch may take a moment, please wait",
  },
};

const lang = (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
const t = I18N[lang];

document.title = t.title;
document.querySelector("h1").textContent = t.title;
document.querySelector("#status").textContent = t.starting;
document.querySelector("#retry").textContent = t.retry;
document.querySelector(".hint").textContent = t.hint;

// The shell's Rust-side error strings are localized there too; if a future
// build returns an i18n key we could map it here. For now errors pass
// through as-is.
