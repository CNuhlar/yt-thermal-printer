// YouTube → XP-80 thermal printer content script.
// Detects video changes inside a playlist and POSTs the current track to
// the local yt_printer.py server. To avoid printing the previous track's
// metadata during YouTube's SPA transition, it waits until the DOM has
// actually flipped to the new video (via <ytd-watch-flexy video-id="...">)
// before scraping.

(() => {
  const DEFAULT_ENDPOINT = "http://127.0.0.1:7878/print";
  const URL_POLL_MS = 700;        // how often to look for a URL change
  const META_POLL_MS = 250;       // how often to poll while waiting for DOM
  const META_MAX_ATTEMPTS = 40;   // ~10s budget for DOM to settle
  const POST_SETTLE_MS = 400;     // extra grace after flexy flips
  const REQUIRE_PLAYLIST = true;

  let lastSeenVideoId = null;     // last URL videoId we noticed
  let lastSentVideoId = null;     // last videoId we actually printed
  let endpoint = DEFAULT_ENDPOINT;
  let enabled = true;

  chrome.storage?.local.get(["endpoint", "enabled"], (cfg) => {
    if (cfg.endpoint) endpoint = cfg.endpoint;
    if (typeof cfg.enabled === "boolean") enabled = cfg.enabled;
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

  function textFrom(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }
    return "";
  }

  function watchFlexyVideoId() {
    const flexy = document.querySelector("ytd-watch-flexy");
    return flexy ? flexy.getAttribute("video-id") : null;
  }

  function gather(videoId) {
    const title = textFrom([
      "ytd-watch-metadata h1 yt-formatted-string",
      "h1.ytd-watch-metadata yt-formatted-string",
      "h1.ytd-watch-metadata",
      "h1.title yt-formatted-string",
      "#title h1 yt-formatted-string",
      "ytd-video-primary-info-renderer h1",
    ]) || document.title.replace(/ - YouTube$/, "");

    const channel = textFrom([
      "ytd-channel-name#channel-name a",
      "ytd-channel-name a",
      "#owner #channel-name a",
      "#owner #text a",
      "#upload-info #channel-name a",
    ]);

    const playlist = textFrom([
      "ytd-playlist-panel-renderer #playlist-title",
      "ytd-playlist-panel-renderer h3 a",
      "ytd-playlist-panel-renderer h3",
    ]);

    const video = document.querySelector("video.html5-main-video, video");
    const duration = video ? fmtTime(video.duration) : "0:00";
    const elapsed = video ? fmtTime(video.currentTime) : "0:00";

    const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    return { videoId, title, channel, playlist, duration, elapsed, thumbnail };
  }

  function send(info) {
    console.log("[yt-printer] POST →", info.videoId, info.title);
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(info),
    })
      .then((r) => console.log("[yt-printer] response", r.status))
      .catch((e) => console.warn("[yt-printer] fetch failed:", e));
  }

  function awaitAndSend(targetId, attempts) {
    attempts = attempts || 0;

    // Bail if URL moved on to another video while we waited.
    if (qs("v") !== targetId) {
      console.log("[yt-printer] abort wait, URL changed away from", targetId);
      return;
    }

    // Wait until ytd-watch-flexy[video-id] matches — that's YouTube's
    // signal that the new video's metadata is now wired into the DOM.
    const flexyId = watchFlexyVideoId();
    if (flexyId !== targetId) {
      if (attempts >= META_MAX_ATTEMPTS) {
        console.warn("[yt-printer] gave up waiting for DOM; sending anyway:", targetId);
      } else {
        setTimeout(() => awaitAndSend(targetId, attempts + 1), META_POLL_MS);
        return;
      }
    }

    // Grace for title / channel rendering after the flexy attribute flips.
    setTimeout(() => {
      if (qs("v") !== targetId) return;
      if (lastSentVideoId === targetId) return;
      const info = gather(targetId);
      if (!info.title) return;
      lastSentVideoId = targetId;
      send(info);
    }, POST_SETTLE_MS);
  }

  function check() {
    if (!enabled) return;
    const videoId = qs("v");
    if (!videoId) return;
    if (REQUIRE_PLAYLIST && !qs("list")) return;
    if (videoId === lastSeenVideoId) return;

    lastSeenVideoId = videoId;
    console.log("[yt-printer] new video detected in URL:", videoId);
    awaitAndSend(videoId);
  }

  setInterval(check, URL_POLL_MS);
  document.addEventListener("yt-navigate-finish", check);
  window.addEventListener("yt-page-data-updated", check);

  console.log("[yt-printer] content script loaded; endpoint =", endpoint);
})();
