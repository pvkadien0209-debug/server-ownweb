const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const googleTTS = require("google-tts-api");
const ffmpeg = require("fluent-ffmpeg");

// ── DEFAULTS_vi / DEFAULTS_en = BỘ THAM SỐ CHUẨN (baseline) theo từng ngôn ngữ ──
// Quy ước: speedRate = 1.0, pitchShift = 1.0, volume = 1.0 LUÔN là mức "CHUẨN"
// (= giữ nguyên, không chỉnh gì cả — atempo=1, asetrate tỉ lệ 1:1, gain x1).
// Muốn nhanh/chậm, cao/thấp giọng, to/nhỏ hơn thì chỉnh TỪ mốc 1.0 lên hoặc xuống
// (ví dụ 1.1 = nhanh hơn 10%, 0.9 = chậm hơn 10%), KHÔNG đặt sẵn lệch khỏi 1.0
// trong DEFAULTS để tránh tự động làm méo/biến đổi giọng khi không ai yêu cầu.
// Đây là giá trị áp dụng cho bất kỳ tham số nào KHÔNG được truyền (hoặc truyền
// sai/không hợp lệ) trong item. Nếu item có truyền giá trị hợp lệ, giá trị đó
// vẫn được ưu tiên dùng (xem mergeParams).
const DEFAULTS_vi = {
  speedRate: 1.0, // atempo: 0.5 – 2.0   (1.0 = chuẩn, không đổi tốc độ)
  pitchShift: 1.0, // pitch multiplier: 0.5 – 2.0  (1.0 = chuẩn, không đổi cao độ)
  volume: 1.0, // linear gain: 0.1 – 5.0   (1.0 = chuẩn, không đổi âm lượng)
  slow: false, // Google TTS slow reading
  lang: "vi",
};

const DEFAULTS_en = {
  speedRate: 1.0, // 1.0 = chuẩn, không đổi tốc độ
  pitchShift: 1.0, // 1.0 = chuẩn, không đổi cao độ
  volume: 1.0, // 1.0 = chuẩn, không đổi âm lượng
  slow: true, // Google TTS slow reading
  lang: "en",
};

const TTS_DIR = path.resolve(__dirname, "./ttsListTV");
const TEMP_DIR = path.resolve(__dirname, "./temp_tts");
if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

// Không có lang truyền vào (hoặc null/rỗng) → mặc định (chuẩn) "vi"
function detectLang(raw, fallback = "vi") {
  const lang = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!lang) return fallback;
  return lang === "vi" ? "vi" : "en";
}

function getDefaultsByLang(lang) {
  return lang === "en" ? DEFAULTS_en : DEFAULTS_vi;
}

function clamp(val, min, max) {
  if (val === undefined || val === null || val === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : Math.min(max, Math.max(min, n));
}

/**
 * Gộp tham số theo đúng 2 mức ưu tiên, với DEFAULTS_vi / DEFAULTS_en làm CHUẨN:
 *   1) item (object riêng của từng dòng: {code, lang, speedRate, volume, pitchShift, slow})
 *      → override khi có giá trị hợp lệ.
 *   2) DEFAULTS_vi / DEFAULTS_en (tuỳ theo lang cuối cùng được xác định) → CHUẨN / baseline,
 *      luôn được dùng khi item không truyền giá trị hợp lệ cho tham số đó.
 * Nếu item không có lang hoặc lang = null/rỗng → mặc định (chuẩn) "vi".
 */
function mergeParams(item = {}) {
  const lang = detectLang(item.lang, "vi");
  const STANDARD = getDefaultsByLang(lang); // bộ tham số chuẩn áp dụng cho lang này
  const pickNumber = (key, min, max) => {
    const override = clamp(item[key], min, max);
    return override !== null ? override : STANDARD[key];
  };
  const slow = typeof item.slow === "boolean" ? item.slow : STANDARD.slow;
  return {
    lang,
    speedRate: pickNumber("speedRate", 0.5, 2.0),
    pitchShift: pickNumber("pitchShift", 0.5, 2.0),
    volume: pickNumber("volume", 0.1, 5.0),
    slow,
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

// Coi là "1.0 / chuẩn" nếu rất gần 1 (tránh lỗi số thực kiểu 0.999999999)
function isUnity(n) {
  return Math.abs(n - 1) < 1e-6;
}

// Dò sample rate THẬT của file audio gốc (Google TTS) bằng ffprobe, thay vì
// đoán cứng 44100 — đoán sai base rate là nguyên nhân chính khiến asetrate
// làm méo/lệch tốc độ-cao độ ngay cả khi pitchShift=1.0. Fallback 24000Hz nếu
// không dò được (mức Google Translate TTS thường trả về).
function getNativeSampleRate(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve(24000);
      const audioStream = (data.streams || []).find(
        (s) => s.codec_type === "audio",
      );
      const rate = audioStream && parseInt(audioStream.sample_rate, 10);
      resolve(Number.isFinite(rate) && rate > 0 ? rate : 24000);
    });
  });
}

/**
 * Áp filter tốc độ/cao độ/âm lượng.
 * QUAN TRỌNG: nếu speedRate, pitchShift, volume đều = 1.0 (mức CHUẨN) →
 * KHÔNG chạy qua ffmpeg/re-encode gì cả, copy thẳng file gốc từ Google để
 * đảm bảo âm thanh giống 100% bản gốc, không bị méo do xử lý thừa.
 * Chỉ khi có tham số lệch khỏi 1.0 mới thực sự chạy filter tương ứng, và khi
 * đó dùng sample rate THẬT của file (ffprobe) làm gốc cho asetrate để tránh
 * lệch tốc độ/cao độ ngoài ý muốn.
 */
async function applyAudioFilters(
  inputBuffer,
  outputPath,
  { speedRate, pitchShift, volume },
) {
  const tempIn = path.join(TEMP_DIR, `tmp_${Date.now()}.mp3`);
  try {
    fs.writeFileSync(tempIn, inputBuffer);

    if (isUnity(speedRate) && isUnity(pitchShift) && isUnity(volume)) {
      console.log(
        "  → Chuẩn 1.0/1.0/1.0: giữ nguyên audio gốc, không qua ffmpeg",
      );
      fs.copyFileSync(tempIn, outputPath);
      return;
    }

    const nativeRate = await getNativeSampleRate(tempIn);
    const filters = [];
    if (!isUnity(pitchShift)) {
      filters.push(`asetrate=${nativeRate}*${(1 / pitchShift).toFixed(6)}`);
      filters.push(`aresample=${nativeRate}`);
    }
    if (!isUnity(speedRate)) filters.push(...buildTempoFilters(speedRate));
    if (!isUnity(volume)) filters.push(`volume=${volume}`);
    if (volume > 2) filters.push("alimiter=limit=0.95:attack=5:release=50");
    console.log(
      `  → Filters (native=${nativeRate}Hz): ${filters.join(", ") || "(none)"}`,
    );

    await new Promise((resolve, reject) => {
      ffmpeg(tempIn)
        .audioFilters(filters)
        .format("mp3")
        .audioCodec("libmp3lame")
        .audioBitrate("128k")
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });
  } finally {
    tryUnlink(tempIn);
  }
}

function tryUnlink(p) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

/**
 * item: { code, text, lang?, speedRate?, pitchShift?, volume?, slow? }
 * Chỉ 2 mức ưu tiên: item (override) → DEFAULTS_vi/DEFAULTS_en (CHUẨN, theo lang,
 * mặc định "vi" nếu thiếu/null).
 */
async function processTextToMp3(item) {
  const filePath = path.join(TTS_DIR, `${item.code}.mp3`);
  const params = mergeParams(item);
  console.log(
    `🎵 [${item.code}] lang=${params.lang} speed=${params.speedRate} pitch=${params.pitchShift} vol=${params.volume} slow=${params.slow}`,
  );
  const raw = await buildRawBuffer(item.text, params.lang, params.slow);
  await applyAudioFilters(raw, filePath, params);
  const size = fs.statSync(filePath).size;
  console.log(`  ✅ ${item.code}.mp3 (${(size / 1024).toFixed(1)} KB)`);
  return { filePath, params };
}

// ── Routes ───────────────────────────────────────────────────────────────────
module.exports = (jsonParser) => {
  /**
   * POST /ttslistTV/generate
   * Body: {
   *   code       : string   (required)
   *   text       : string   (required)
   *   lang?      : "vi"|"en"      – ưu tiên cao nhất (per-item); không có/null → "vi"
   *   speedRate? : 0.5 – 2.0       (không truyền / truyền sai → dùng giá trị CHUẨN)
   *   pitchShift?: 0.5 – 2.0       (không truyền / truyền sai → dùng giá trị CHUẨN)
   *   volume?    : 0.1 – 5.0       (không truyền / truyền sai → dùng giá trị CHUẨN)
   *   slow?      : boolean         (không truyền → dùng giá trị CHUẨN)
   * }
   * Nếu không truyền speedRate/pitchShift/volume/slow → dùng DEFAULTS_vi hoặc DEFAULTS_en
   * (bộ tham số CHUẨN) tuỳ theo lang được chọn.
   */
  router.post("/ttslistTV/generate", jsonParser, async (req, res) => {
    const { text, code, lang, speedRate, pitchShift, volume, slow } = req.body;
    if (!text || !code)
      return res
        .status(400)
        .json({ success: false, message: "Missing: text, code" });
    const item = { text, code, lang, speedRate, pitchShift, volume, slow };
    try {
      const { filePath, params } = await processTextToMp3(item);
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

  // ── Batch (legacy – đọc ttsListTV.json) ───────────────────────────────────
  const textList = (() => {
    try {
      return require("./ttsListTV.json");
    } catch (_) {
      return [];
    }
  })();

  /**
   * POST /ttslistTV
   * Mỗi phần tử trong ttsListTV.json tự khai báo (nếu muốn override):
   *   { code, text, lang?, speedRate?, pitchShift?, volume?, slow? }
   * Chỉ 2 mức ưu tiên: item (override) > DEFAULTS_vi/DEFAULTS_en (CHUẨN, theo lang,
   * mặc định "vi" nếu thiếu/null).
   */
  router.post("/ttslistTV", jsonParser, async (req, res) => {
    console.log(`🎵 Batch: ${textList.length} items`);
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
        const { filePath, params } = await processTextToMp3(item);
        results.push({
          success: true,
          code: item.code,
          size: fs.statSync(filePath).size,
          params,
        });
      } catch (e) {
        results.push({ success: false, code: item.code, error: e.message });
      }
      if (i < textList.length - 1) await new Promise((r) => setTimeout(r, 500));
    }
    const ok = results.filter((r) => r.success);
    res.json({
      success: true,
      defaults: { vi: DEFAULTS_vi, en: DEFAULTS_en },
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
      defaults: { vi: DEFAULTS_vi, en: DEFAULTS_en },
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
