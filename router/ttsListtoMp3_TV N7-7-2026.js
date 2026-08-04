const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const googleTTS = require("google-tts-api");
const ffmpeg = require("fluent-ffmpeg");

// ── Defaults (overridable per request) ───────────────────────────────────────
const DEFAULTS_vi = {
  speedRate: 1.1, // atempo: 0.5 – 2.0
  pitchShift: 1.4, // pitch multiplier: 0.5 – 2.0  (>1 = higher, <1 = lower)
  volume: 2.0, // linear gain: 0.1 – 5.0
  slow: false, // Google TTS slow reading
  lang: "vi", // "vi" | "en"
};

const DEFAULTS_en = {
  speedRate: 0.8, // atempo: 0.5 – 2.0
  pitchShift: 1, // pitch multiplier: 0.5 – 2.0  (>1 = higher, <1 = lower)
  volume: 1.0, // linear gain: 0.1 – 5.0
  slow: true, // Google TTS slow reading
  lang: "vi", // "vi" | "en"
};
const TTS_DIR = path.resolve(__dirname, "./ttsListTV");
const TEMP_DIR = path.resolve(__dirname, "./temp_tts");
if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectLang(raw, fallback = "vi") {
  if (!raw) return fallback;
  return /^en$/i.test(String(raw).trim()) ? "en" : "vi";
}

function clamp(val, min, max) {
  const n = parseFloat(val);
  return isNaN(n) ? null : Math.min(max, Math.max(min, n));
}

function resolveParams(body) {
  return {
    speedRate: clamp(body.speedRate, 0.5, 2.0) ?? DEFAULTS.speedRate,
    pitchShift: clamp(body.pitchShift, 0.5, 2.0) ?? DEFAULTS.pitchShift,
    volume: clamp(body.volume, 0.1, 5.0) ?? DEFAULTS.volume,
    slow: typeof body.slow === "boolean" ? body.slow : DEFAULTS.slow,
    lang: detectLang(body.lang, DEFAULTS.lang),
  };
}

function splitText(text, maxLength = 200) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let current = "";
  const sentences = text.split(/[.!?。；！？]+/).filter((s) => s.trim());
  for (let sentence of sentences) {
    sentence = sentence.trim();
    if (!sentence) continue;
    if ((current + sentence + ". ").length <= maxLength) {
      current += sentence + ". ";
    } else {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
      if (sentence.length > maxLength) {
        const words = sentence.split(" ");
        let wc = "";
        for (const w of words) {
          if ((wc + w + " ").length <= maxLength) {
            wc += w + " ";
          } else {
            if (wc.trim()) chunks.push(wc.trim());
            wc = w + " ";
          }
        }
        if (wc.trim()) current = wc;
      } else {
        current = sentence + ". ";
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

async function createAudioBuffer(text, lang, slow) {
  const url = googleTTS.getAudioUrl(text, {
    lang,
    slow,
    host: "https://translate.google.com",
  });
  console.log(
    `    → TTS [${lang}${slow ? " slow" : ""}]: "${text.substring(0, 60)}${text.length > 60 ? "..." : ""}"`,
  );
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function buildRawBuffer(text, lang, slow) {
  if (text.length <= 200) return createAudioBuffer(text, lang, slow);
  const chunks = splitText(text, 200);
  console.log(`  → Split into ${chunks.length} chunks`);
  const bufs = [];
  for (let i = 0; i < chunks.length; i++) {
    bufs.push(await createAudioBuffer(chunks[i], lang, slow));
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
  return Buffer.concat(bufs);
}

/** Chain atempo filters – each must be in [0.5, 2.0] */
function buildTempoFilters(speed) {
  const out = [];
  let r = speed;
  while (r > 2.0) {
    out.push("atempo=2.0");
    r /= 2.0;
  }
  while (r < 0.5) {
    out.push("atempo=0.5");
    r /= 0.5;
  }
  out.push(`atempo=${r.toFixed(4)}`);
  return out;
}

async function applyAudioFilters(
  inputBuffer,
  outputPath,
  { speedRate, pitchShift, volume },
) {
  return new Promise((resolve, reject) => {
    const tempIn = path.join(TEMP_DIR, `tmp_${Date.now()}.mp3`);
    try {
      fs.writeFileSync(tempIn, inputBuffer);
      const filters = [
        `asetrate=44100*${(1 / pitchShift).toFixed(6)}`,
        "aresample=44100",
        ...buildTempoFilters(speedRate),
        `volume=${volume}`,
      ];
      if (volume > 2) filters.push("alimiter=limit=0.95:attack=5:release=50");
      console.log(`  → Filters: ${filters.join(", ")}`);

      ffmpeg(tempIn)
        .audioFilters(filters)
        .format("mp3")
        .audioCodec("libmp3lame")
        .audioBitrate("128k")
        .output(outputPath)
        .on("end", () => {
          tryUnlink(tempIn);
          resolve();
        })
        .on("error", (e) => {
          tryUnlink(tempIn);
          reject(e);
        })
        .run();
    } catch (e) {
      tryUnlink(tempIn);
      reject(e);
    }
  });
}

function tryUnlink(p) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

async function processTextToMp3(item, params) {
  const filePath = path.join(TTS_DIR, `${item.code}.mp3`);
  // item-level lang overrides global params.lang
  const lang = detectLang(item.lang, params.lang);
  console.log(
    `🎵 [${item.code}] lang=${lang} speed=${params.speedRate} pitch=${params.pitchShift} vol=${params.volume} slow=${params.slow}`,
  );

  const raw = await buildRawBuffer(item.text, lang, params.slow);
  await applyAudioFilters(raw, filePath, params);

  const size = fs.statSync(filePath).size;
  console.log(`  ✅ ${item.code}.mp3 (${(size / 1024).toFixed(1)} KB)`);
  return filePath;
}

// ── Routes ───────────────────────────────────────────────────────────────────

module.exports = (jsonParser) => {
  /**
   * POST /ttslistTV/generate
   * Body: {
   *   code      : string   (required)
   *   text      : string   (required)
   *   lang?     : "vi"|"en"           – per-item, overrides global param
   *   speedRate?  : 0.5 – 2.0         – playback speed
   *   pitchShift? : 0.5 – 2.0         – pitch multiplier
   *   volume?     : 0.1 – 5.0         – linear gain
   *   slow?       : boolean            – Google TTS slow mode
   * }
   * Response: mp3 binary → auto-download on client
   */
  router.post("/ttslistTV/generate", jsonParser, async (req, res) => {
    const { text, code, lang: itemLang } = req.body;
    if (!text || !code)
      return res
        .status(400)
        .json({ success: false, message: "Missing: text, code" });

    const params = resolveParams(req.body);
    // item-level lang takes final priority
    if (itemLang) params.lang = detectLang(itemLang, params.lang);

    try {
      const filePath = await processTextToMp3(
        { text, code, lang: itemLang },
        params,
      );
      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Disposition": `attachment; filename="${code}.mp3"`,
        "X-Code": code,
        "X-Lang": params.lang,
        "X-Speed": String(params.speedRate),
        "X-Pitch": String(params.pitchShift),
        "X-Volume": String(params.volume),
        "X-Slow": String(params.slow),
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error(`❌ ${code}:`, err.message);
      if (!res.headersSent)
        res.status(500).json({ success: false, code, error: err.message });
    }
  });

  // ── Batch (legacy – reads ttsListTV.json) ─────────────────────────────────
  const textList = (() => {
    try {
      return require("./ttsListTV.json");
    } catch (_) {
      return [];
    }
  })();

  router.post("/ttslistTV", jsonParser, async (req, res) => {
    const params = resolveParams(req.body);
    console.log(`🎵 Batch: ${textList.length} items | params:`, params);
    const results = [];
    const t0 = Date.now();
    for (let i = 0; i < textList.length; i++) {
      const item = textList[i];
      if (!item.text || !item.code) {
        results.push({
          success: false,
          code: item.code || `item_${i}`,
          error: "Missing text/code",
        });
        continue;
      }
      try {
        const fp = await processTextToMp3(item, params);
        results.push({
          success: true,
          code: item.code,
          size: fs.statSync(fp).size,
        });
      } catch (e) {
        results.push({ success: false, code: item.code, error: e.message });
      }
      if (i < textList.length - 1) await new Promise((r) => setTimeout(r, 500));
    }
    const ok = results.filter((r) => r.success);
    res.json({
      success: true,
      params,
      stats: {
        total: textList.length,
        successful: ok.length,
        failed: results.length - ok.length,
        ms: Date.now() - t0,
      },
      results,
    });
  });

  router.get("/ttslistTV", (_, res) =>
    res.json({
      success: true,
      defaults: DEFAULTS,
      count: textList.length,
      items: textList,
    }),
  );
  router.get("/ttslistTV/files", (_, res) => {
    try {
      const files = fs
        .readdirSync(TTS_DIR)
        .filter((f) => f.endsWith(".mp3"))
        .map((f) => {
          const s = fs.statSync(path.join(TTS_DIR, f));
          return {
            filename: f,
            code: f.replace(".mp3", ""),
            sizeKB: (s.size / 1024).toFixed(2),
            modified: s.mtime,
          };
        })
        .sort((a, b) => a.code.localeCompare(b.code));
      res.json({ success: true, count: files.length, files });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
  router.get("/ttslistTV/play/:code", (req, res) => {
    const fp = path.join(TTS_DIR, `${req.params.code}.mp3`);
    if (!fs.existsSync(fp)) return res.status(404).json({ success: false });
    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `inline; filename="${req.params.code}.mp3"`,
    });
    fs.createReadStream(fp).pipe(res);
  });
  router.delete("/ttslistTV/:code", (req, res) => {
    const fp = path.join(TTS_DIR, `${req.params.code}.mp3`);
    if (!fs.existsSync(fp)) return res.status(404).json({ success: false });
    try {
      fs.unlinkSync(fp);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
};
