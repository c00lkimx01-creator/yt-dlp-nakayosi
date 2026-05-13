import express from "express";
import compression from "compression";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  next();
});
app.use(
  express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true })
);

// =========================================================
// Invidious instances
// =========================================================
const INV_INSTANCES = (process.env.INVIDIOUS_INSTANCES ||
  [
    "https://id.420129.xyz",
    "https://invidious.f5.si",
    "https://iv.ggtyler.dev",
    "https://nyc1.iv.ggtyler.dev",
    "https://cal1.iv.ggtyler.dev",
    "https://pol1.iv.ggtyler.dev",
    "https://invidious.nerdvpn.de",
    "https://inv1.nadeko.net",
    "https://inv2.nadeko.net",
    "https://inv3.nadeko.net",
    "https://inv4.nadeko.net",
    "https://yewtu.be",
    "https://invidious.privacyredirect.com",
    "https://invidious.private.coffee",
    "https://invidious.perennialte.ch",
    "https://invidious.reallyaweso.me",
    "https://iv.datura.network",
    "https://iv.duti.dev",
    "https://iv.melmac.space",
    "https://iv.nboeck.de",
    "https://yt.omada.cafe",
    "https://invidious.einfachzocken.eu",
    "https://invidious.tiekoetter.com",
    "https://invidious.jing.rocks",
    "https://invidious.materialio.us",
    "https://invidious.lunivers.trade",
    "https://iteroni.com",
    "https://invidious.0011.lt",
    "https://invidious.projectsegfau.lt",
    "https://invidious.fdn.fr",
    "https://invidious.protokolla.fi"
  ].join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function extractGooglevideoUrls(text) {
  if (!text || typeof text !== "string") return [];
  const re = /https?:\/\/[^\s"'<>]*googlevideo\.com\/[^\s"'<>]+/g;
  const found = text.match(re) || [];
  return Array.from(new Set(found));
}

async function fetchManifestUrls(url, timeout = 6000) {
  try {
    const r = await fetchWithTimeout(url, timeout);
    if (!r.ok) return [];
    const text = await r.text();
    return extractGooglevideoUrls(text);
  } catch { return []; }
}

// mimeType / itag から kind を判定: "muxed" | "video" | "audio"
function classifyFormat(f, fallbackLabel) {
  const mime = (f.type || f.mimeType || "").toLowerCase();
  const hasV = mime.startsWith("video/");
  const hasA = mime.startsWith("audio/") || !!f.audioQuality || !!f.audioSampleRate;
  // muxed (formatStreams) は audio+video 同梱
  if (fallbackLabel === "muxed") return "muxed";
  if (mime.startsWith("video/") && /codecs=.*(mp4a|opus|ac-3|vorbis)/.test(mime)) return "muxed";
  if (hasV && !hasA) return "video";
  if (hasA && !hasV) return "audio";
  if (hasV && hasA) return "muxed";
  // フォールバック: itag 既知の音声 itag
  const audioItags = new Set([139, 140, 141, 171, 249, 250, 251, 256, 258, 327, 338]);
  if (audioItags.has(Number(f.itag))) return "audio";
  return fallbackLabel || "unknown";
}

async function tryInvidious(videoId, perTimeout = 6000) {
  return await new Promise((resolve) => {
    let remaining = INV_INSTANCES.length;
    let lastErr = "";
    let settled = false;
    if (remaining === 0) return resolve({ ok: false, err: "no instances" });

    INV_INSTANCES.forEach((base) => {
      const url = `${base.replace(/\/+$/, "")}/api/v1/videos/${encodeURIComponent(
        videoId
      )}?fields=hlsUrl,dashUrl,formatStreams,adaptiveFormats`;
      fetchWithTimeout(url, perTimeout)
        .then(async (r) => {
          if (!r.ok) throw new Error(`${base} -> ${r.status}`);
          const text = await r.text();
          let j;
          try { j = JSON.parse(text); }
          catch { throw new Error(`${base} -> non-JSON`); }

          const urls = [];
          const manifests = [];

          const pushFmts = (arr, fallbackLabel) => {
            if (!Array.isArray(arr)) return;
            for (const f of arr) {
              if (!f || !f.url || !/googlevideo\.com/.test(f.url)) continue;
              const kind = classifyFormat(f, fallbackLabel);
              const mime = (f.type || f.mimeType || "").split(";")[0];
              urls.push({
                url: f.url,
                kind, // muxed | video | audio
                type: kind,
                mime,
                itag: f.itag,
                container: f.container,
                quality: f.qualityLabel || f.quality || f.resolution,
                audioQuality: f.audioQuality,
                bitrate: parseInt(f.bitrate || 0) || undefined,
              });
            }
          };
          pushFmts(j.formatStreams, "muxed");
          pushFmts(j.adaptiveFormats, "adaptive");

          if (j.hlsUrl) manifests.push({ url: j.hlsUrl, type: "hls" });
          if (j.dashUrl) manifests.push({ url: j.dashUrl, type: "dash" });

          // sort: highest bitrate first
          urls.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

          if (urls.length || manifests.length) {
            if (settled) return;
            settled = true;
            return resolve({ ok: true, urls, manifests, source: base });
          }
          throw new Error(`${base} -> empty`);
        })
        .catch((e) => {
          lastErr = String(e?.message || e);
        })
        .finally(() => {
          remaining -= 1;
          if (remaining === 0 && !settled) resolve({ ok: false, err: lastErr || "all failed" });
        });
    });
  });
}

// =========================================================
// Cookie 自動取得（yt-dlp フォールバック用）
// =========================================================
const MANUAL_COOKIE = path.join(__dirname, "cookie.txt");
const AUTO_COOKIE = path.join(os.tmpdir(), "yt_auto_cookies.txt");
let cookiePath = null;
let cookieExpires = 0;
const COOKIE_TTL_MS = 30 * 60 * 1000;

function writeNetscapeCookies(setCookieHeaders, file) {
  const lines = ["# Netscape HTTP Cookie File", "# Auto-generated"];
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180;
  for (const raw of setCookieHeaders) {
    const parts = raw.split(";").map((s) => s.trim());
    const [nameVal, ...attrs] = parts;
    const eq = nameVal.indexOf("=");
    if (eq < 0) continue;
    const name = nameVal.slice(0, eq);
    const value = nameVal.slice(eq + 1);
    let domain = ".youtube.com";
    let cookiePathAttr = "/";
    for (const a of attrs) {
      const [k, v] = a.split("=");
      if (!k) continue;
      if (k.toLowerCase() === "domain" && v)
        domain = v.startsWith(".") ? v : "." + v;
      if (k.toLowerCase() === "path" && v) cookiePathAttr = v;
    }
    lines.push(
      [domain, "TRUE", cookiePathAttr, "FALSE", expires, name, value].join("\t")
    );
  }
  lines.push([".youtube.com", "TRUE", "/", "FALSE", expires, "CONSENT", "YES+1"].join("\t"));
  lines.push([".youtube.com", "TRUE", "/", "FALSE", expires, "SOCS", "CAI"].join("\t"));
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

async function refreshCookies() {
  if (fs.existsSync(MANUAL_COOKIE)) {
    cookiePath = MANUAL_COOKIE;
    cookieExpires = Date.now() + COOKIE_TTL_MS;
    return cookiePath;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch("https://www.youtube.com/", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    let setCookies = [];
    if (typeof r.headers.getSetCookie === "function") setCookies = r.headers.getSetCookie();
    else {
      const raw = r.headers.get("set-cookie");
      if (raw) setCookies = raw.split(/,(?=[^;]+=)/);
    }
    writeNetscapeCookies(setCookies, AUTO_COOKIE);
    cookiePath = AUTO_COOKIE;
    cookieExpires = Date.now() + COOKIE_TTL_MS;
    return cookiePath;
  } catch {
    try {
      writeNetscapeCookies([], AUTO_COOKIE);
      cookiePath = AUTO_COOKIE;
      cookieExpires = Date.now() + COOKIE_TTL_MS;
    } catch {}
    return cookiePath;
  }
}

async function ensureCookies() {
  if (cookiePath && Date.now() < cookieExpires && fs.existsSync(cookiePath)) {
    return cookiePath;
  }
  return await refreshCookies();
}

refreshCookies().catch(() => {});

// =========================================================
// キャッシュ & in-flight
// =========================================================
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const getCache = (id) => {
  const v = cache.get(id);
  if (!v) return null;
  if (Date.now() > v.expires) { cache.delete(id); return null; }
  return v;
};
const setCache = (id, payload) =>
  cache.set(id, { ...payload, expires: Date.now() + CACHE_TTL_MS });
const inflight = new Map();

// =========================================================
// yt-dlp（muxed best + bestaudio を両方取得）
// =========================================================
function tryYtDlp(args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let yt;
    try { yt = spawn("yt-dlp", args); }
    catch (e) { return resolve({ ok: false, err: String(e?.message || e) }); }
    let out = "", err = "", settled = false;
    const done = (v) => { if (settled) return; settled = true; try { yt.kill("SIGKILL"); } catch {} resolve(v); };
    const timer = setTimeout(() => done({ ok: false, err: "timeout" }), timeoutMs);
    yt.stdout.on("data", (d) => (out += d.toString()));
    yt.stderr.on("data", (d) => (err += d.toString()));
    yt.on("error", (e) => { clearTimeout(timer); done({ ok: false, err: String(e?.message || e) }); });
    yt.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.trim().split("\n").map(s => s.trim()).filter(Boolean);
      if (code === 0 && lines.length && /^https?:\/\//.test(lines[0])) {
        done({ ok: true, urls: lines });
      } else {
        done({ ok: false, err: err.trim().slice(0, 300) || `exit ${code}` });
      }
    });
  });
}

async function ytDlpManifest(videoId) {
  await ensureCookies();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const baseArgs = (client) => {
    const a = [
      "-g", "--no-warnings", "--no-playlist",
      "--socket-timeout", "8",
      "--user-agent",
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
      "--extractor-args", `youtube:player_client=${client}`,
    ];
    if (cookiePath && fs.existsSync(cookiePath)) a.unshift("--cookies", cookiePath);
    return a;
  };

  // muxed (audio+video 同梱) 優先 + フォールバックで bestvideo+bestaudio (2URL)
  const tasks = [
    tryYtDlp([...baseArgs("ios"), "-f", "best[acodec!=none][vcodec!=none]/best", url], 12000),
    tryYtDlp([...baseArgs("android"), "-f", "best[acodec!=none][vcodec!=none]/best", url], 12000),
    tryYtDlp([...baseArgs("web_safari"), "-f", "best[protocol^=m3u8]/best", url], 12000),
    tryYtDlp([...baseArgs("ios"), "-f", "bestvideo+bestaudio/best", url], 14000),
  ];

  return await new Promise((resolve) => {
    let remaining = tasks.length;
    let lastErr = "";
    let settled = false;
    tasks.forEach((p) =>
      p.then(async (r) => {
        if (settled) return;
        if (r.ok) {
          settled = true;
          const out = { urls: [], manifests: [], source: "yt-dlp" };
          // 1本目=video(またはmuxed)、2本目があれば audio
          const [first, second] = r.urls;
          const isManifest = (u) => u.includes(".m3u8") || u.includes(".mpd");

          if (isManifest(first)) {
            out.manifests.push({ url: first, type: first.includes(".m3u8") ? "hls" : "dash" });
            const extracted = await fetchManifestUrls(first, 6000);
            for (const u of extracted) out.urls.push({ url: u, kind: "from-manifest", type: "from-manifest" });
          } else if (second) {
            // 2URL = video-only + audio-only
            out.urls.push({ url: first, kind: "video", type: "video" });
            out.urls.push({ url: second, kind: "audio", type: "audio" });
          } else {
            // 1URL = muxed (audio+video 同梱)
            out.urls.push({ url: first, kind: "muxed", type: "muxed" });
          }
          return resolve({ ok: true, ...out });
        }
        lastErr = r.err || lastErr;
      }).finally(() => {
        remaining -= 1;
        if (remaining === 0 && !settled) resolve({ ok: false, err: lastErr || "yt-dlp failed" });
      })
    );
  });
}

// =========================================================
// 統合
// =========================================================
async function getStream(videoId) {
  const invP = tryInvidious(videoId, 6000);
  const ytP = new Promise((resolve) => setTimeout(() => resolve(ytDlpManifest(videoId)), 1500))
    .then((p) => p);

  const inv = await invP;
  if (inv.ok) return inv;
  const yt = await ytP;
  if (yt.ok) return yt;
  refreshCookies().catch(() => {});
  return { ok: false, err: inv.err || yt.err || "unknown" };
}

// =========================================================
// API
// =========================================================
app.get("/api/video/:id", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!/^[\w-]{6,20}$/.test(id)) {
    return res.status(200).json({ id, urls: [], manifests: [], error: "invalid id" });
  }
  try {
    const cached = getCache(id);
    if (cached) return res.status(200).json({ id, ...cached, cached: true });

    let p = inflight.get(id);
    if (!p) {
      p = getStream(id).finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    const r = await p;
    if (r.ok) {
      const payload = { urls: r.urls || [], manifests: r.manifests || [], source: r.source };
      setCache(id, payload);
      return res.status(200).json({ id, ...payload });
    }
    return res.status(200).json({ id, urls: [], manifests: [], error: r.err || "failed" });
  } catch (e) {
    return res.status(200).json({ id, urls: [], manifests: [], error: String(e?.message || e) });
  }
});

app.get("/healthz", (_req, res) =>
  res.status(200).json({
    ok: true,
    cookie: cookiePath ? path.basename(cookiePath) : null,
    invidious: INV_INSTANCES.length,
  })
);

process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

app.listen(PORT, () => console.log(`listening on ${PORT}`));
