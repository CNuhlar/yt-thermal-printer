// YouTube → XP-80 thermal printer content script.
// Watches the watch page for video changes inside a playlist and POSTs to
// the local yt_printer.py server.

(() => {
  const DEFAULT_ENDPOINT = "http://127.0.0.1:7878/print";
  const POLL_MS = 1000;
  const SETTLE_MS = 1500;    // wait for SPA to load metadata
  const REQUIRE_PLAYLIST = true;

  let lastVideoId = null;
  let pendingTimer = null;
  let endpoint = DEFAULT_ENDPOINT;
  let enabled = true;

  // Read settings (popup can change these)
  chrome.storage?.local.get(["endpoint", "enabled", "requirePlaylist"], (cfg) => {
    if (cfg.endpoint) endpoint = cfg.endpoint;
    if (typeof cfg.enabled === "boolean") enabled = cfg.enabled;
    // requirePlaylist read on demand below
  });

  chrome.storage?.onChanged?.addListener((changes) => {
    if (changes.endpoint) endpoint = changes.endpoint.newValue || DEFAULT_ENDPOINT;
    if (changes.enabled) enabled = !!changes.enabled.newValue;
  });

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function text(selectorList) {
    for (const sel of selectorList) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }
    return "";
  }

  function gather() {
    const videoId = qs("v");
    if (!videoId) return null;

    const playlistId = qs("list");
    if (REQUIRE_PLAYLIST && !playlistId) return null;

    const title = text([
      "h1.ytd-watch-metadata yt-formatted-string",
      "h1.ytd-watch-metadata",
      "h1.title yt-formatted-string",
      "#title h1 yt-formatted-string",
      "ytd-video-primary-info-renderer h1",
    ]) || document.title.replace(/ - YouTube$/, "");

    const channel = text([
      "ytd-channel-name#channel-name a",
      "ytd-channel-name a",
      "#owner #channel-name a",
      "#owner #text a",
      "#upload-info #channel-name a",
    ]);

    const playlist = text([
      "ytd-playlist-panel-renderer #playlist-title",
      "ytd-playlist-panel-renderer h3 a",
      "ytd-playlist-panel-renderer h3",
      ".ytd-playlist-panel-renderer.title",
    ]);

    const video = document.querySelector("video.html5-main-video, video");
    const duration = video ? fmtTime(video.duration) : "0:00";
    const elapsed = video ? fmtTime(video.currentTime) : "0:00";

    const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    return { videoId, title, channel, playlist, duration, elapsed, thumbnail };
  }

  function send(info) {
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(info),
    })
      .then((r) => console.log("[yt-printer]", r.status, info.title))
      .catch((e) => console.warn("[yt-printer] failed:", e));
  }

  function check() {
    if (!enabled) return;
    const info = gather();
    if (!info) return;
    if (info.videoId === lastVideoId) return;
    if (!info.title) return; // wait for metadata to load

    lastVideoId = info.videoId;

    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      const fresh = gather();
      if (!fresh) return;
      if (fresh.videoId === lastVideoId) send(fresh);
    }, SETTLE_MS);
  }

  setInterval(check, POLL_MS);
  document.addEventListener("yt-navigate-finish", check);
  window.addEventListener("yt-page-data-updated", check);

  console.log("[yt-printer] content script loaded; endpoint =", endpoint);
})();
