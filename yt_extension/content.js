// YouTube → XP-80 thermal printer content script.
// Detects video changes inside a playlist and POSTs the current track to the
// local yt_printer.py server. Waits until <ytd-watch-flexy video-id="...">
// matches the URL's v= and the title h1 has rendered, so we never scrape the
// previous track's metadata during YouTube's SPA transition.

(() => {
  const DEFAULT_ENDPOINT = "http://127.0.0.1:7878/print";
  const URL_POLL_MS = 600;
  const META_POLL_MS = 250;
  const META_MAX_ATTEMPTS = 60;   // ~15s budget for DOM to settle
  const REQUIRE_PLAYLIST = true;

  let lastSentVideoId = null;
  const inFlight = new Set();
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
    const strictTitle = textFrom([
      "ytd-watch-metadata h1 yt-formatted-string",
      "h1.ytd-watch-metadata yt-formatted-string",
      "h1.ytd-watch-metadata",
      "h1.title yt-formatted-string",
      "#title h1 yt-formatted-string",
      "ytd-video-primary-info-renderer h1",
    ]);

    const title = strictTitle || document.title.replace(/ - YouTube$/, "");

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

    return {
      videoId, title, channel, playlist, duration, elapsed, thumbnail,
      _strictTitle: !!strictTitle,
    };
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

    // Bail if URL moved on while we were waiting.
    if (qs("v") !== targetId) {
      inFlight.delete(targetId);
      console.log("[yt-printer] abort, URL moved away from", targetId);
      return;
    }

    // Already printed this one in a previous round.
    if (lastSentVideoId === targetId) {
      inFlight.delete(targetId);
      return;
    }

    const flexyMatches = watchFlexyVideoId() === targetId;
    const info = gather(targetId);
    const ready = flexyMatches && info._strictTitle;

    if (!ready) {
      if (attempts >= META_MAX_ATTEMPTS) {
        console.warn(
          "[yt-printer] gave up waiting after",
          attempts, "attempts, sending best-effort:", targetId,
        );
        // fall through to send whatever we have
      } else {
        setTimeout(() => awaitAndSend(targetId, attempts + 1), META_POLL_MS);
        return;
      }
    }

    if (!info.title) info.title = "Unknown title";
    lastSentVideoId = targetId;
    inFlight.delete(targetId);
    send(info);
  }

  function check() {
    if (!enabled) return;
    const videoId = qs("v");
    if (!videoId) return;
    if (REQUIRE_PLAYLIST && !qs("list")) return;
    if (videoId === lastSentVideoId) return;
    if (inFlight.has(videoId)) return;

    inFlight.add(videoId);
    console.log("[yt-printer] new video detected:", videoId);
    awaitAndSend(videoId);
  }

  // Poll the URL for changes (covers cases where YouTube's SPA events miss).
  setInterval(check, URL_POLL_MS);

  // Hook YouTube's SPA navigation events for instant reaction.
  document.addEventListener("yt-navigate-finish", check);
  window.addEventListener("yt-page-data-updated", check);

  // Also watch ytd-watch-flexy's video-id attribute directly — this flips
  // exactly when YouTube finishes binding a new video's metadata, which is
  // earlier than navigate-finish in some cases.
  function startFlexyObserver(attempts) {
    attempts = attempts || 0;
    const flexy = document.querySelector("ytd-watch-flexy");
    if (!flexy) {
      if (attempts < 20) setTimeout(() => startFlexyObserver(attempts + 1), 500);
      return;
    }
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "video-id") {
          check();
        }
      }
    });
    obs.observe(flexy, { attributes: true, attributeFilter: ["video-id"] });
    console.log("[yt-printer] mutation observer attached to ytd-watch-flexy");
  }
  startFlexyObserver();

  console.log("[yt-printer] content script loaded; endpoint =", endpoint);
})();
