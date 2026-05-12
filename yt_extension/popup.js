const $ = (id) => document.getElementById(id);

function setStatus(msg, ok) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + (ok === true ? "ok" : ok === false ? "err" : "");
}

chrome.storage.local.get(["endpoint", "enabled"], (cfg) => {
  if (cfg.endpoint) $("endpoint").value = cfg.endpoint;
  $("enabled").checked = cfg.enabled !== false;
});

$("enabled").addEventListener("change", () => {
  chrome.storage.local.set({ enabled: $("enabled").checked });
});

$("endpoint").addEventListener("change", () => {
  chrome.storage.local.set({ endpoint: $("endpoint").value });
});

$("ping").addEventListener("click", async () => {
  const url = new URL($("endpoint").value);
  url.pathname = "/health";
  setStatus("pinging...");
  try {
    const r = await fetch(url.toString());
    setStatus("ping: " + r.status, r.ok);
  } catch (e) {
    setStatus("ping failed: " + e.message, false);
  }
});

$("test").addEventListener("click", async () => {
  setStatus("printing test...");
  try {
    const r = await fetch($("endpoint").value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test from extension popup",
        channel: "yt-printer",
        playlist: "Diagnostics",
        elapsed: "0:30",
        duration: "2:00",
        thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      }),
    });
    setStatus("printer: " + r.status, r.ok);
  } catch (e) {
    setStatus("failed: " + e.message, false);
  }
});
