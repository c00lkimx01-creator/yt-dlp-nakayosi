// ============= Updated server.js (robust取得版) =============
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

// ============================================================
// 設定
// ============================================================
const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_IOS =
  "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5 like Mac OS X)";

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
    "https://invidious.protokolla.fi",
  ].join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PIPED_INSTANCES = (process.env.PIPED_INSTANCES ||
  [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.tokhmi.xyz",
    "https://pipedapi.moomoo.me",
    "https://pipedapi.syncpundit.io",
    "https://api-piped.mha.fi",
    "https://piped-api.garudalinux.org",
    "https://pipedapi.rivo.lol",
    "https://pipedapi.aeong.one",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.privacydev.net",
    "https://api.piped.yt",
    "https://pipedapi.adminforge.de",
  ].join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ============================================================
// 共通ユーティリティ
// ============================================================
function fetchWithTimeout(url, ms = 8000, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() =>
    clearTimeout(t)
  );
}

async function fetchManifestText(url, timeout = 8000) {
  try {
    const r = await fetchWithTimeout(url, timeout, {
      headers: { "User-Agent": UA_DESKTOP },
    });
    if (!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  }
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
      try {
        abs = new URL(next, masterUrl).toString();
      } catch {}
      variants.push({
        url: abs,
        height: resMatch ? parseInt(resMatch[2], 10) : 0,
        width: resMatch ? parseInt(resMatch[1], 10) : 0,
        bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
      });
    }
  }
  if (!variants.length) return null;
  const exact = variants.find((v) => v.height === 1080);
  if (exact) return exact;
  const under = variants
    .filter((v) => v.height && v.height <= 1080)
    .sort((a, b) => b.height - a.height);
  if (under.length) return under[0];
  return variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

// ============================================================
// Cookie 管理
// ============================================================
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
  lines.push(
    [".youtube.com", "TRUE", "/", "FALSE", expires, "CONSENT", "YES+1"].join(
      "\t"
    )
  );
  lines.push(
    [".youtube.com", "TRUE", "/", "FALSE", expires, "SOCS", "CAI"].join("\t")
  );
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

async function refreshCookies() {
  if (fs.existsSync(MANUAL_COOKIE)) {
    cookiePath = MANUAL_COOKIE;
    cookieExpires = Date.now() + COOKIE_TTL_MS;
    return cookiePath;
  }
  try {
    const r = await fetchWithTimeout("https://www.youtube.com/", 8000, {
      headers: {
        "User-Agent": UA_DESKTOP,
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    let setCookies = [];
    if (typeof r.headers.getSetCookie === "function")
      setCookies = r.headers.getSetCookie();
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

async function ensureCookies(force = false) {
  if (
    !force &&
    cookiePath &&
    Date.now() < cookieExpires &&
    fs.existsSync(cookiePath)
  )
    return cookiePath;
  return await refreshCookies();
}
refreshCookies().catch(() => {});

// ============================================================
// yt-dlp 実行
// ============================================================
function runYtDlp(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let yt;
    try {
      yt = spawn("yt-dlp", args);
    } catch (e) {
      return resolve({ ok: false, err: String(e?.message || e) });
    }
    let out = "",
      err = "",
      settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        yt.kill("SIGKILL");
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(
      () => done({ ok: false, err: "timeout", stderr: err }),
      timeoutMs
    );
    yt.stdout.on("data", (d) => (out += d.toString()));
    yt.stderr.on("data", (d) => (err += d.toString()));
    yt.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, err: String(e?.message || e) });
    });
    yt.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: out,
        stderr: err,
      });
    });
  });
}

function baseYtArgs(client) {
  const a = [
    "--no-warnings",
    "--no-playlist",
    "--no-check-certificate",
    "--socket-timeout",
    "10",
    "--retries",
    "3",
    "--force-ipv4",
    "--user-agent",
    client === "ios" ? UA_IOS : UA_DESKTOP,
    "--extractor-args",
    `youtube:player_client=${client}`,
  ];
  if (cookiePath && fs.existsSync(cookiePath)) a.unshift("--cookies", cookiePath);
  return a;
}

function isAuthError(stderr) {
  const s = String(stderr || "").toLowerCase();
  return (
    s.includes("sign in") ||
    s.includes("login required") ||
    s.includes("confirm your age") ||
    s.includes("http error 403") ||
    s.includes("http error 401") ||
    s.includes("nsig extraction failed")
  );
}

// yt-dlp -J で JSON 取得 (リトライ付き)
async function ytDlpFullInfo(videoId) {
  await ensureCookies();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  // 複数 client を試す
  const clients = [
    "ios",
    "android",
    "web_safari",
    "web",
    "mweb",
    "tv_embedded",
  ];
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const c of clients) {
      const r = await runYtDlp(
        [...baseYtArgs(c), "-J", "--skip-download", url],
        20000
      );
      if (r.ok && r.stdout) {
        try {
          const j = JSON.parse(r.stdout);
          if (j && Array.isArray(j.formats) && j.formats.length) return j;
        } catch {}
      }
      lastErr = r.stderr || r.err || "";
      if (isAuthError(lastErr) && attempt === 0) {
        await ensureCookies(true);
        break; // re-loop with refreshed cookies
      }
    }
  }
  return null;
}

// HLS マスターURL を yt-dlp で取得
async function ytDlpHlsMaster(videoId) {
  await ensureCookies();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  // ios / web_safari は HLS を返しやすい
  const clients = ["ios", "web_safari", "android", "mweb"];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const c of clients) {
      // -g で URL のみ
      const r = await runYtDlp(
        [
          ...baseYtArgs(c),
          "-g",
          "-f",
          "bestvideo[protocol*=m3u8]/best[protocol*=m3u8]/best",
          url,
        ],
        15000
      );
      if (r.ok) {
        const lines = r.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const cand = lines.find((u) => /\.m3u8(\?|$)/i.test(u));
        if (cand) return cand;
      }
      if (isAuthError(r.stderr) && attempt === 0) {
        await ensureCookies(true);
        break;
      }
    }
  }
  return null;
}

async function ytDlpHls1080p(videoId) {
  const master = await ytDlpHlsMaster(videoId);
  if (!master) return { ok: false, err: "no hls master" };
  const text = await fetchManifestText(master, 8000);
  const variant = pick1080pFromMaster(text, master);
  return {
    ok: true,
    master: { url: master, type: "hls", kind: "hls-master" },
    variant_1080p: variant
      ? { ...variant, type: "hls", kind: "hls-1080p" }
      : null,
  };
}

// ============================================================
// formats を en/ja/m3u8 に分離
// ============================================================
function splitFormatsByLang(info) {
  const en = [];
  const ja = [];
  const m3u8List = [];
  if (!info || !Array.isArray(info.formats)) return { en, ja, m3u8List };

  for (const f of info.formats) {
    if (!f || !f.url) continue;
    const proto = String(f.protocol || "").toLowerCase();
    const isHls = proto.includes("m3u8") || /\.m3u8(\?|$)/i.test(f.url);

    // 言語判定
    const langRaw = (
      f.language ||
      f.audio_language ||
      f.format_note ||
      ""
    ).toString().toLowerCase();
    let langTag = "";
    if (/(^|[^a-z])ja([^a-z]|$)|japan|日本/.test(langRaw)) langTag = "ja";
    else if (/(^|[^a-z])en([^a-z]|$)|english/.test(langRaw)) langTag = "en";

    const hasV = f.vcodec && f.vcodec !== "none";
    const hasA = f.acodec && f.acodec !== "none";
    const kind =
      hasV && hasA ? "muxed" : hasV ? "video" : hasA ? "audio" : "unknown";

    const quality =
      f.format_note ||
      (f.height ? `${f.height}p` : undefined) ||
      f.resolution;

    const entry = {
      url: f.url,
      itag: f.format_id,
      mime: f.ext,
      container: f.container || f.ext,
      quality,
      height: f.height,
      width: f.width,
      bitrate: f.tbr
        ? Math.round(f.tbr * 1000)
        : f.abr
        ? Math.round(f.abr * 1000)
        : undefined,
      vcodec: f.vcodec,
      acodec: f.acodec,
      language: langTag,
      kind,
      type: kind,
    };

    if (isHls) {
      m3u8List.push({ ...entry, type: "hls", kind: "hls" });
      continue;
    }
    if (langTag === "ja") ja.push(entry);
    else if (langTag === "en") en.push(entry);
    else {
      // 言語不明 (映像のみ・音声不明トラック含む) は両方に入れる
      en.push(entry);
      ja.push(entry);
    }
  }

  const sortQ = (a, b) =>
    (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0);
  en.sort(sortQ);
  ja.sort(sortQ);
  return { en, ja, m3u8List };
}

// ============================================================
// Invidious / Piped フォールバック
// ============================================================
function detectLangStr(s) {
  const v = String(s || "").toLowerCase();
  if (/ja|japanese|日本/.test(v)) return "ja";
  if (/en|english/.test(v)) return "en";
  return "";
}

async function tryInvidious(videoId, perTimeout = 7000) {
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
          const j = await r.json();
          const urls = [];
          const urls_m3u8 = [];

          const push = (arr, fallback) => {
            if (!Array.isArray(arr)) return;
            for (const f of arr) {
              if (!f || !f.url) continue;
              const mime = (f.type || "").split(";")[0];
              const hasV = mime.startsWith("video/");
              const hasA = mime.startsWith("audio/") || !!f.audioQuality;
              const kind =
                fallback === "muxed"
                  ? "muxed"
                  : hasV && hasA
                  ? "muxed"
                  : hasV
                  ? "video"
                  : hasA
                  ? "audio"
                  : "unknown";
              urls.push({
                url: f.url,
                kind,
                type: kind,
                mime,
                itag: f.itag,
                container: f.container,
                quality: f.qualityLabel || f.quality || f.resolution,
                bitrate: parseInt(f.bitrate || 0) || undefined,
                language: detectLangStr(
                  f.audioTrack?.id ||
                    f.audioTrack?.displayName ||
                    f.language ||
                    ""
                ),
              });
            }
          };
          push(j.formatStreams, "muxed");
          push(j.adaptiveFormats, "adaptive");

          if (j.hlsUrl)
            urls_m3u8.push({
              url: j.hlsUrl,
              type: "hls",
              kind: "hls-master",
            });

          if (urls.length || urls_m3u8.length) {
            if (settled) return;
            settled = true;
            resolve({ ok: true, urls, urls_m3u8, source: `invidious:${base}` });
          } else throw new Error(`${base} -> empty`);
        })
        .catch((e) => {
          lastErr = String(e?.message || e);
        })
        .finally(() => {
          remaining -= 1;
          if (remaining === 0 && !settled)
            resolve({ ok: false, err: lastErr || "all failed" });
        });
    });
  });
}

async function tryPiped(videoId, perTimeout = 7000) {
  return await new Promise((resolve) => {
    let remaining = PIPED_INSTANCES.length;
    let settled = false;
    let lastErr = "";
    if (remaining === 0) return resolve({ ok: false, err: "no piped" });

    PIPED_INSTANCES.forEach((base) => {
      const url = `${base.replace(/\/+$/, "")}/streams/${encodeURIComponent(
        videoId
      )}`;
      fetchWithTimeout(url, perTimeout)
        .then(async (r) => {
          if (!r.ok) throw new Error(`${base} -> ${r.status}`);
          const j = await r.json();
          const urls = [];
          const urls_m3u8 = [];
          const push = (arr) => {
            if (!Array.isArray(arr)) return;
            for (const f of arr) {
              if (!f || !f.url) continue;
              const isVideo = f.videoOnly === false || f.videoOnly === true;
              const kind = f.videoOnly
                ? "video"
                : isVideo
                ? "muxed"
                : "audio";
              urls.push({
                url: f.url,
                kind,
                type: kind,
                mime: f.mimeType,
                itag: f.itag,
                quality: f.quality,
                bitrate: f.bitrate,
                language: detectLangStr(
                  f.audioTrackId || f.audioTrackName || ""
                ),
              });
            }
          };
          push(j.videoStreams);
          push(j.audioStreams);
          if (j.hls)
            urls_m3u8.push({ url: j.hls, type: "hls", kind: "hls-master" });
          if (urls.length || urls_m3u8.length) {
            if (settled) return;
            settled = true;
            resolve({ ok: true, urls, urls_m3u8, source: `piped:${base}` });
          } else throw new Error(`${base} -> empty`);
        })
        .catch((e) => {
          lastErr = String(e?.message || e);
        })
        .finally(() => {
          remaining -= 1;
          if (remaining === 0 && !settled)
            resolve({ ok: false, err: lastErr || "all failed" });
        });
    });
  });
}

// ============================================================
// payload 構築
// ============================================================
async function buildVideoPayload(videoId) {
  const [hls, info, inv, piped] = await Promise.all([
    ytDlpHls1080p(videoId).catch(() => ({ ok: false })),
    ytDlpFullInfo(videoId).catch(() => null),
    tryInvidious(videoId).catch(() => ({ ok: false })),
    tryPiped(videoId).catch(() => ({ ok: false })),
  ]);

  let en = [],
    ja = [],
    m3u8List = [];

  if (info) {
    const s = splitFormatsByLang(info);
    en = s.en;
    ja = s.ja;
    m3u8List = s.m3u8List;
  }

  const mergeFallback = (src) => {
    if (!src || !src.ok) return;
    if (Array.isArray(src.urls)) {
      for (const u of src.urls) {
        const e = { ...u };
        if (e.language === "ja") ja.push(e);
        else if (e.language === "en") en.push(e);
        else {
          en.push(e);
          ja.push(e);
        }
      }
    }
    if (Array.isArray(src.urls_m3u8)) m3u8List.push(...src.urls_m3u8);
  };
  mergeFallback(inv);
  mergeFallback(piped);

  // m3u8 1080p を最優先で先頭へ
  const m3u8Out = [];
  if (hls.ok) {
    if (hls.variant_1080p) m3u8Out.push(hls.variant_1080p);
    if (hls.master) m3u8Out.push(hls.master);
  }
  for (const m of m3u8List) m3u8Out.push(m);

  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      if (!x || !x.url) return false;
      if (seen.has(x.url)) return false;
      seen.add(x.url);
      return true;
    });
  };

  const sources = [];
  if (info) sources.push("yt-dlp");
  if (hls.ok) sources.push("yt-dlp-hls");
  if (inv?.ok) sources.push(inv.source);
  if (piped?.ok) sources.push(piped.source);

  return {
    "English-ver": dedup(en),
    "japanese-ver": dedup(ja),
    urls_m3u8: dedup(m3u8Out),
    source: sources.join(",") || "none",
  };
}

// ============================================================
// キャッシュ + ルーティング
// ============================================================
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const getCache = (id) => {
  const v = cache.get(id);
  if (!v) return null;
  if (Date.now() > v.expires) {
    cache.delete(id);
    return null;
  }
  return v;
};
const setCache = (id, payload) =>
  cache.set(id, { ...payload, expires: Date.now() + CACHE_TTL_MS });
const inflight = new Map();

function validId(id) {
  return /^[\w-]{6,20}$/.test(id);
}

async function getOrBuild(id) {
  const cached = getCache(id);
  if (cached) return { ...cached, cached: true };
  let p = inflight.get(id);
  if (!p) {
    p = buildVideoPayload(id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  const r = await p;
  // 取得成功した時のみキャッシュ
  if (
    (r["English-ver"] && r["English-ver"].length) ||
    (r["japanese-ver"] && r["japanese-ver"].length) ||
    (r.urls_m3u8 && r.urls_m3u8.length)
  )
    setCache(id, r);
  return r;
}

app.get("/api/video/:id", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!validId(id))
    return res.status(200).json({
      id,
      urls: { "English-ver": [], "japanese-ver": [] },
      urls_m3u8: [],
      error: "invalid id",
    });
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
      id,
      urls: { "English-ver": [], "japanese-ver": [] },
      urls_m3u8: [],
      error: String(e?.message || e),
    });
  }
});

app.get("/api/video/:id/type1", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!validId(id))
    return res.status(200).json({ id, "English-ver": [], error: "invalid id" });
  try {
    const r = await getOrBuild(id);
    return res
      .status(200)
      .json({ id, "English-ver": r["English-ver"] || [], source: r.source });
  } catch (e) {
    return res
      .status(200)
      .json({ id, "English-ver": [], error: String(e?.message || e) });
  }
});

app.get("/api/video/:id/type2", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!validId(id))
    return res
      .status(200)
      .json({ id, "japanese-ver": [], error: "invalid id" });
  try {
    const r = await getOrBuild(id);
    return res
      .status(200)
      .json({ id, "japanese-ver": r["japanese-ver"] || [], source: r.source });
  } catch (e) {
    return res
      .status(200)
      .json({ id, "japanese-ver": [], error: String(e?.message || e) });
  }
});

app.get("/api/video/:id/m3u8", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!validId(id))
    return res.status(200).json({ id, urls_m3u8: [], error: "invalid id" });
  try {
    const r = await getOrBuild(id);
    return res
      .status(200)
      .json({ id, urls_m3u8: r.urls_m3u8 || [], source: r.source });
  } catch (e) {
    return res
      .status(200)
      .json({ id, urls_m3u8: [], error: String(e?.message || e) });
  }
});

app.get("/healthz", (_req, res) =>
  res.status(200).json({
    ok: true,
    cookie: cookiePath ? path.basename(cookiePath) : null,
    invidious: INV_INSTANCES.length,
    piped: PIPED_INSTANCES.length,
  })
);

process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) =>
  console.error("unhandledRejection:", e)
);

app.listen(PORT, () => console.log(`listening on ${PORT}`));
