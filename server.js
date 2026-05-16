// ============= Updated server.js =============
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
  return Array.from(new Set(text.match(re) || []));
}

function extractM3u8Urls(text) {
  if (!text || typeof text !== "string") return [];
  const re = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g;
  return Array.from(new Set(text.match(re) || []));
}

async function fetchManifestText(url, timeout = 6000) {
  try {
    const r = await fetchWithTimeout(url, timeout);
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
}

async function fetchManifestUrls(url, timeout = 6000) {
  const text = await fetchManifestText(url, timeout);
  return { gv: extractGooglevideoUrls(text), m3u8: extractM3u8Urls(text), text };
}

// HLS master playlist から 1080p variant を抽出
function pick1080pFromMaster(masterText, masterUrl) {
  if (!masterText) return null;
  const lines = masterText.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-STREAM-INF")) {
      const resMatch = l.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bwMatch = l.match(/BANDWIDTH=(\d+)/i);
      const next = (lines[i + 1] || "").trim();
      if (!next || next.startsWith("#")) continue;
      let abs = next;
      try { abs = new URL(next, masterUrl).toString(); } catch {}
      variants.push({
        url: abs,
        height: resMatch ? parseInt(resMatch[2], 10) : 0,
        width: resMatch ? parseInt(resMatch[1], 10) : 0,
        bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
      });
    }
  }
  if (!variants.length) return null;
  // exact 1080 優先 → なければ最も近い(<=1080優先)
  const exact = variants.find((v) => v.height === 1080);
  if (exact) return exact;
  const under = variants.filter((v) => v.height && v.height <= 1080).sort((a, b) => b.height - a.height);
  if (under.length) return under[0];
  return variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

function classifyFormat(f, fallbackLabel) {
  const mime = (f.type || f.mimeType || "").toLowerCase();
  const hasV = mime.startsWith("video/");
  const hasA = mime.startsWith("audio/") || !!f.audioQuality || !!f.audioSampleRate;
  if (fallbackLabel === "muxed") return "muxed";
  if (mime.startsWith("video/") && /codecs=.*(mp4a|opus|ac-3|vorbis)/.test(mime)) return "muxed";
  if (hasV && !hasA) return "video";
  if (hasA && !hasV) return "audio";
  if (hasV && hasA) return "muxed";
  const audioItags = new Set([139, 140, 141, 171, 249, 250, 251, 256, 258, 327, 338]);
  if (audioItags.has(Number(f.itag))) return "audio";
  return fallbackLabel || "unknown";
}

// 言語判定: ja/en に分類
function detectLang(f) {
  const cand =
    f.language ||
    f.lang ||
    f.audioTrack?.id ||
    f.audioTrack?.displayName ||
    f.audioTrackId ||
    "";
  const s = String(cand).toLowerCase();
  if (/ja|japanese|日本/.test(s)) return "ja";
  if (/en|english/.test(s)) return "en";
  return "";
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
          const urls_m3u8 = [];

          const pushFmts = (arr, fallbackLabel) => {
            if (!Array.isArray(arr)) return;
            for (const f of arr) {
              if (!f || !f.url || !/googlevideo\.com/.test(f.url)) continue;
              const kind = classifyFormat(f, fallbackLabel);
              const mime = (f.type || f.mimeType || "").split(";")[0];
              urls.push({
                url: f.url,
                kind,
                type: kind,
                mime,
                itag: f.itag,
                container: f.container,
                quality: f.qualityLabel || f.quality || f.resolution,
                audioQuality: f.audioQuality,
                bitrate: parseInt(f.bitrate || 0) || undefined,
                language: detectLang(f),
              });
            }
          };
          pushFmts(j.formatStreams, "muxed");
          pushFmts(j.adaptiveFormats, "adaptive");

          if (j.hlsUrl) urls_m3u8.push({ url: j.hlsUrl, type: "hls", kind: "hls-master" });
          if (j.dashUrl) manifests.push({ url: j.dashUrl, type: "dash" });

          urls.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

          if (urls.length || manifests.length || urls_m3u8.length) {
            if (settled) return;
            settled = true;
            return resolve({ ok: true, urls, manifests, urls_m3u8, source: base });
          }
          throw new Error(`${base} -> empty`);
        })
        .catch((e) => { lastErr = String(e?.message || e); })
        .finally(() => {
          remaining -= 1;
          if (remaining === 0 && !settled) resolve({ ok: false, err: lastErr || "all failed" });
        });
    });
  });
}

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
      if (k.toLowerCase() === "domain" && v) domain = v.startsWith(".") ? v : "." + v;
      if (k.toLowerCase() === "path" && v) cookiePathAttr = v;
    }
    lines.push([domain, "TRUE", cookiePathAttr, "FALSE", expires, name, value].join("\t"));
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
  if (cookiePath && Date.now() < cookieExpires && fs.existsSync(cookiePath)) return cookiePath;
  return await refreshCookies();
}
refreshCookies().catch(() => {});

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const getCache = (id) => {
  const v = cache.get(id);
  if (!v) return null;
  if (Date.now() > v.expires) { cache.delete(id); return null; }
  return v;
};
const setCache = (id, payload) => cache.set(id, { ...payload, expires: Date.now() + CACHE_TTL_MS });
const inflight = new Map();

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
      const lines = out.trim().split("\n").map((s) => s.trim()).filter(Boolean);
      if (code === 0 && lines.length && /^https?:\/\//.test(lines[0])) done({ ok: true, urls: lines });
      else done({ ok: false, err: err.trim().slice(0, 300) || `exit ${code}` });
    });
  });
}

// yt-dlp で JSON を取得して formats を分解
function tryYtDlpJson(args, timeoutMs = 15000) {
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
      try {
        const j = JSON.parse(out);
        done({ ok: true, json: j });
      } catch {
        done({ ok: false, err: err.trim().slice(0, 300) || `exit ${code}` });
      }
    });
  });
}

function baseYtArgs(client) {
  const a = [
    "--no-warnings", "--no-playlist",
    "--socket-timeout", "8",
    "--user-agent",
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
    "--extractor-args", `youtube:player_client=${client}`,
  ];
  if (cookiePath && fs.existsSync(cookiePath)) a.unshift("--cookies", cookiePath);
  return a;
}

// yt-dlp -J で全フォーマット取得 → 言語別/HLS分離
async function ytDlpFullInfo(videoId) {
  await ensureCookies();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const clients = ["ios", "android", "web_safari", "web"];
  for (const c of clients) {
    const r = await tryYtDlpJson([...baseYtArgs(c), "-J", url], 15000);
    if (r.ok && r.json && Array.isArray(r.json.formats)) return r.json;
  }
  return null;
}

// info.formats から非HLSをen/ja別に整理
function splitFormatsByLang(info) {
  const en = [];
  const ja = [];
  const m3u8List = [];
  if (!info || !Array.isArray(info.formats)) return { en, ja, m3u8List };

  for (const f of info.formats) {
    if (!f || !f.url) continue;
    const proto = String(f.protocol || "").toLowerCase();
    const isHls = proto.includes("m3u8") || /\.m3u8(\?|$)/i.test(f.url);
    const lang = (f.language || f.audio_language || "").toString().toLowerCase();
    const langTag = /ja/.test(lang) ? "ja" : /en/.test(lang) ? "en" : "";
    const entry = {
      url: f.url,
      itag: f.format_id,
      mime: f.ext,
      container: f.container || f.ext,
      quality: f.format_note || f.height ? `${f.height || ""}p`.replace("undefinedp", "") : undefined,
      height: f.height,
      width: f.width,
      bitrate: f.tbr ? Math.round(f.tbr * 1000) : (f.abr ? Math.round(f.abr * 1000) : undefined),
      vcodec: f.vcodec,
      acodec: f.acodec,
      language: langTag,
      kind: (f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none")
        ? "muxed"
        : (f.vcodec && f.vcodec !== "none" ? "video" : (f.acodec && f.acodec !== "none" ? "audio" : "unknown")),
    };
    entry.type = entry.kind;

    if (isHls) {
      m3u8List.push({ ...entry, type: "hls", kind: "hls" });
      continue;
    }
    if (langTag === "ja") ja.push(entry);
    else if (langTag === "en") en.push(entry);
    else {
      // 言語不明な動画 / 音声不要トラックは両方に入れる(汎用)
      en.push(entry);
      ja.push(entry);
    }
  }

  const sortQ = (a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0);
  en.sort(sortQ);
  ja.sort(sortQ);
  return { en, ja, m3u8List };
}

// HLS マスター取得 → 1080p variant のみ返す
async function ytDlpHls1080p(videoId) {
  await ensureCookies();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const clients = ["web_safari", "ios", "android"];
  let master = null;

  for (const c of clients) {
    const r = await tryYtDlp(
      ["-g", ...baseYtArgs(c), "-f", "best[protocol^=m3u8]/best", url],
      12000
    );
    if (r.ok) {
      const cand = r.urls.find((u) => /\.m3u8(\?|$)/i.test(u));
      if (cand) { master = cand; break; }
    }
  }
  if (!master) return { ok: false, err: "no hls master" };

  const { text } = await fetchManifestUrls(master, 7000);
  const variant = pick1080pFromMaster(text, master);
  const result = {
    ok: true,
    master: { url: master, type: "hls", kind: "hls-master" },
    variant_1080p: variant ? { ...variant, type: "hls", kind: "hls-1080p" } : null,
  };
  return result;
}

async function buildVideoPayload(videoId) {
  // 並行で HLS と JSON 情報を取得
  const [hls, info, inv] = await Promise.all([
    ytDlpHls1080p(videoId).catch(() => ({ ok: false })),
    ytDlpFullInfo(videoId).catch(() => null),
    tryInvidious(videoId, 6000).catch(() => ({ ok: false })),
  ]);

  let en = [], ja = [], m3u8List = [];

  if (info) {
    const s = splitFormatsByLang(info);
    en = s.en; ja = s.ja; m3u8List = s.m3u8List;
  }

  // Invidious からも補完
  if (inv && inv.ok) {
    if (Array.isArray(inv.urls)) {
      for (const u of inv.urls) {
        const e = { ...u };
        if (e.language === "ja") ja.push(e);
        else if (e.language === "en") en.push(e);
        else { en.push(e); ja.push(e); }
      }
    }
    if (Array.isArray(inv.urls_m3u8)) m3u8List.push(...inv.urls_m3u8);
  }

  // HLS 1080p を最優先で先頭へ
  const m3u8Out = [];
  if (hls.ok) {
    if (hls.variant_1080p) m3u8Out.push(hls.variant_1080p);
    if (hls.master) m3u8Out.push(hls.master);
  }
  for (const m of m3u8List) {
    if (!m3u8Out.find((x) => x.url === m.url)) m3u8Out.push(m);
  }

  // 重複削除
  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      if (!x || !x.url) return false;
      if (seen.has(x.url)) return false;
      seen.add(x.url);
      return true;
    });
  };

  return {
    "English-ver": dedup(en),
    "japanese-ver": dedup(ja),
    urls_m3u8: dedup(m3u8Out),
    source: info ? "yt-dlp+invidious" : (inv?.source || "unknown"),
  };
}

function validId(id) { return /^[\w-]{6,20}$/.test(id); }

async function getOrBuild(id) {
  const cached = getCache(id);
  if (cached) return { ...cached, cached: true };
  let p = inflight.get(id);
  if (!p) {
    p = buildVideoPayload(id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  const r = await p;
  setCache(id, r);
  return r;
}

// メイン: 全部入り。urls の下に English-ver / japanese-ver を表示
app.get("/api/video/:id", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!validId(id)) {
    return res.status(200).json({
      id, urls: { "English-ver": [], "japanese-ver": [] }, urls_m3u8: [], error: "invalid id",
    });
  }
  try {
    const r = await getOrBuild(id);
    return res.status(200).json({
      id,
      urls: {
        "English-ver": r["English-ver"] || [],
        "japanese-ver": r["japanese-ver"] || [],
      },
      urls_m3u8: r.urls_m3u8 || [],
      source: r.source,
      cached: !!r.cached,
    });
  } catch (e) {
    return res.status(200).json({
      id, urls: { "English-ver": [], "japanese-ver": [] }, urls_m3u8: [],
      error: String(e?.message || e),
    });
  }
});

// type1 = 英語のみ
app.get("/api/video/:id/type1", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!validId(id)) return res.status(200).json({ id, "English-ver": [], error: "invalid id" });
  try {
    const r = await getOrBuild(id);
    return res.status(200).json({ id, "English-ver": r["English-ver"] || [], source: r.source });
  } catch (e) {
    return res.status(200).json({ id, "English-ver": [], error: String(e?.message || e) });
  }
});

// type2 = 日本語のみ
app.get("/api/video/:id/type2", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!validId(id)) return res.status(200).json({ id, "japanese-ver": [], error: "invalid id" });
  try {
    const r = await getOrBuild(id);
    return res.status(200).json({ id, "japanese-ver": r["japanese-ver"] || [], source: r.source });
  } catch (e) {
    return res.status(200).json({ id, "japanese-ver": [], error: String(e?.message || e) });
  }
});

// m3u8 のみ (1080p優先)
app.get("/api/video/:id/m3u8", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!validId(id)) return res.status(200).json({ id, urls_m3u8: [], error: "invalid id" });
  try {
    const r = await getOrBuild(id);
    return res.status(200).json({ id, urls_m3u8: r.urls_m3u8 || [], source: r.source });
  } catch (e) {
    return res.status(200).json({ id, urls_m3u8: [], error: String(e?.message || e) });
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
