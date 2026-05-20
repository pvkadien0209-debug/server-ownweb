const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const googleTTS = require("google-tts-api");
const ffmpeg = require("fluent-ffmpeg");
const textList = require("./ttsListTV.json");

const speedRate = 1.1;
const pitchShift = 1.4; // Giảm pitch để có giọng nam (0.8-0.9 là phù hợp)
const volume = 2; // ⭐ Tăng âm lượng lên (1.0 = giữ nguyên, 2.0 = gấp đôi, 3.0 = gấp 3)

// Setup thư mục ttsList
const TTS_DIR = path.resolve(__dirname, "./ttsListTV");
const TEMP_DIR = path.resolve(__dirname, "./temp_tts");

if (!fs.existsSync(TTS_DIR)) {
  fs.mkdirSync(TTS_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Hàm tách text thành các đoạn nhỏ hơn 200 ký tự (tối ưu cho tiếng Việt)
function splitText(text, maxLength = 200) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = "";

  // Tách theo câu trước (phù hợp với tiếng Việt)
  const sentences = text.split(/[.!?。；！？]+/).filter((s) => s.trim());

  for (let sentence of sentences) {
    sentence = sentence.trim();
    if (!sentence) continue;

    // Nếu câu hiện tại + câu mới vẫn nhỏ hơn maxLength
    if ((current + sentence + ". ").length <= maxLength) {
      current += sentence + ". ";
    } else {
      // Nếu current không rỗng, push vào chunks
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }

      // Nếu câu đơn lẻ vẫn dài hơn maxLength, tách theo từ
      if (sentence.length > maxLength) {
        const words = sentence.split(" ");
        let wordChunk = "";
        for (let word of words) {
          if ((wordChunk + word + " ").length <= maxLength) {
            wordChunk += word + " ";
          } else {
            if (wordChunk.trim()) {
              chunks.push(wordChunk.trim());
            }
            wordChunk = word + " ";
          }
        }
        if (wordChunk.trim()) {
          current = wordChunk;
        }
      } else {
        current = sentence + ". ";
      }
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// Hàm tạo audio buffer từ text chunk (tối ưu cho tiếng Việt)
async function createAudioBuffer(text) {
  try {
    // Sử dụng 'vi' cho tiếng Việt (chuẩn ISO 639-1)
    const url = googleTTS.getAudioUrl(text, {
      lang: "vi",
      slow: false,
      host: "https://translate.google.com",
    });

    console.log(
      `    → Generating audio for: "${text.substring(0, 50)}${
        text.length > 50 ? "..." : ""
      }"`,
    );

    const audioRes = await fetch(url);
    if (!audioRes.ok) {
      throw new Error(`HTTP error! status: ${audioRes.status}`);
    }

    const arrayBuffer = await audioRes.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("Error creating audio buffer:", error);
    throw error;
  }
}

// Hàm ghép nhiều audio buffer thành một
async function mergeAudioBuffers(audioBuffers) {
  if (audioBuffers.length === 1) {
    return audioBuffers[0];
  }
  // Nối các buffer lại với nhau
  return Buffer.concat(audioBuffers);
}

// Hàm tăng tốc độ audio, thay đổi pitch và TĂNG ÂM LƯỢNG bằng ffmpeg
async function speedUpAudioWithPitch(
  inputBuffer,
  outputPath,
  speedFactor = speedRate,
  pitch = pitchShift,
  volumeBoost = volume, // ⭐ Thêm parameter volume
) {
  return new Promise((resolve, reject) => {
    // Tạo file temp để xử lý
    const tempInputPath = path.join(TEMP_DIR, `temp_${Date.now()}_input.mp3`);

    try {
      // Ghi buffer vào file temp
      fs.writeFileSync(tempInputPath, inputBuffer);

      console.log(
        `    → Processing audio: Speed ${speedFactor}x, Pitch ${pitch}x, Volume ${volumeBoost}x (male voice)`,
      );

      // Sử dụng ffmpeg để tăng tốc độ, thay đổi pitch VÀ TĂNG ÂM LƯỢNG
      const pitchRatio = pitch;
      const sampleRateMultiplier = 1 / pitchRatio;

      // ⭐⭐⭐ Xây dựng chuỗi audio filters với volume boost
      const audioFilters = [
        `asetrate=44100*${sampleRateMultiplier}`, // Thay đổi sample rate để hạ pitch
        `aresample=44100`, // Resample về 44100Hz
        `atempo=${speedFactor}`, // Tăng tốc độ
        `volume=${volumeBoost}`, // ⭐ TĂNG ÂM LƯỢNG
      ];

      // ⭐ Nếu volume > 2, thêm limiter để tránh clipping/méo tiếng
      if (volumeBoost > 2) {
        audioFilters.push(`alimiter=limit=0.95:attack=5:release=50`);
        console.log(`    → Added limiter to prevent clipping (volume > 2x)`);
      }

      ffmpeg(tempInputPath)
        .audioFilters(audioFilters)
        .format("mp3")
        .audioCodec("libmp3lame")
        .audioBitrate("128k")
        .output(outputPath)
        .on("end", () => {
          // Xóa file temp
          try {
            fs.unlinkSync(tempInputPath);
          } catch (e) {
            console.warn("Warning: Could not delete temp file:", e.message);
          }
          console.log(
            `    → Audio processing completed (male voice, ${speedFactor}x speed, ${volumeBoost}x volume)`,
          );
          resolve();
        })
        .on("error", (err) => {
          // Xóa file temp khi có lỗi
          try {
            fs.unlinkSync(tempInputPath);
          } catch (e) {
            console.warn("Warning: Could not delete temp file:", e.message);
          }
          console.error("FFmpeg error:", err.message);
          reject(err);
        })
        .run();
    } catch (error) {
      // Xóa file temp khi có lỗi
      try {
        if (fs.existsSync(tempInputPath)) {
          fs.unlinkSync(tempInputPath);
        }
      } catch (e) {
        console.warn("Warning: Could not delete temp file:", e.message);
      }
      reject(error);
    }
  });
}

// Hàm xử lý một item text thành MP3 với tốc độ tăng cường, giọng nam VÀ ÂM LƯỢNG CAO
async function processTextToMp3(item, index, total) {
  const filePath = path.join(TTS_DIR, `${item.code}.mp3`);

  try {
    console.log(
      `[${index + 1}/${total}] Processing: ${
        item.code
      } - "${item.text.substring(0, 100)}${
        item.text.length > 100 ? "..." : ""
      }"`,
    );

    // Kiểm tra file đã tồn tại
    if (fs.existsSync(filePath)) {
      console.log(`  → File ${item.code}.mp3 exists, overwriting...`);
    }

    let originalBuffer;

    // Kiểm tra độ dài text > 200 thì tách
    if (item.text.length > 200) {
      console.log(`  → Text length ${item.text.length} > 200, splitting...`);

      // Tách text thành các chunk
      const textChunks = splitText(item.text, 200);
      console.log(`  → Split into ${textChunks.length} chunks`);

      const audioBuffers = [];

      // Tạo audio buffer cho từng chunk
      for (let i = 0; i < textChunks.length; i++) {
        console.log(`    → Processing chunk ${i + 1}/${textChunks.length}`);
        const chunkBuffer = await createAudioBuffer(textChunks[i]);
        audioBuffers.push(chunkBuffer);

        // Delay để tránh rate limit
        if (i < textChunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }

      // Ghép các buffer lại
      originalBuffer = await mergeAudioBuffers(audioBuffers);
    } else {
      // Text ngắn, xử lý bình thường
      console.log(
        `  → Text length ${item.text.length} ≤ 200, processing directly`,
      );
      originalBuffer = await createAudioBuffer(item.text);
    }

    // Tăng tốc độ audio, thay đổi pitch VÀ TĂNG ÂM LƯỢNG
    await speedUpAudioWithPitch(
      originalBuffer,
      filePath,
      speedRate,
      pitchShift,
      volume, // ⭐ Truyền volume vào
    );

    // Lấy thông tin file sau khi xử lý
    const finalStats = fs.statSync(filePath);
    console.log(
      `  ✅ Created: ${item.code}.mp3 (${(finalStats.size / 1024).toFixed(
        2,
      )} KB) with ${speedRate}x speed, ${pitchShift}x pitch, ${volume}x volume`,
    );

    return { success: true, code: item.code, size: finalStats.size };
  } catch (error) {
    console.error(`  ❌ Error processing ${item.code}:`, error.message);
    return { success: false, code: item.code, error: error.message };
  }
}

module.exports = (jsonParser) => {
  // API tạo TTS cho tất cả items trong list
  router.post("/ttslistTV", jsonParser, async (req, res) => {
    console.log(
      `🎵 TTS Tiếng Việt processing started (Male voice with ${speedRate}x speed, ${volume}x volume)`,
    );
    console.log(`📝 Total items to process: ${textList.length}`);
    console.log(`🎙️  Voice: Male (pitch: ${pitchShift}x)`);
    console.log(`🔊 Volume: ${volume}x`);

    const results = [];
    const startTime = Date.now();

    try {
      // Xử lý từng item trong textList
      for (let i = 0; i < textList.length; i++) {
        const item = textList[i];

        // Validate item
        if (!item.text || !item.code) {
          console.log(
            `  ⚠️ Skipping invalid item at index ${i}: missing text or code`,
          );
          results.push({
            success: false,
            code: item.code || `item_${i}`,
            error: "Missing text or code",
          });
          continue;
        }

        const result = await processTextToMp3(item, i, textList.length);
        results.push(result);

        // Delay giữa các item để tránh spam API
        if (i < textList.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      // Thống kê kết quả
      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);
      const totalSize = successful.reduce((sum, r) => sum + (r.size || 0), 0);
      const processingTime = Date.now() - startTime;

      console.log("\n📊 TTS Tiếng Việt processing completed!");
      console.log(`✅ Successful: ${successful.length}`);
      console.log(`❌ Failed: ${failed.length}`);
      console.log(
        `📦 Total size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`,
      );
      console.log(
        `⏱️  Processing time: ${(processingTime / 1000).toFixed(2)}s`,
      );
      console.log(
        `🎙️  Voice: Male (pitch ${pitchShift}x, speed ${speedRate}x, volume ${volume}x)`,
      );

      if (failed.length > 0) {
        console.log("\n❌ Failed items:");
        failed.forEach((f) => {
          console.log(`  → ${f.code}: ${f.error}`);
        });
      }

      res.status(200).json({
        success: true,
        message: "TTS Tiếng Việt processing completed with male voice",
        language: "Vietnamese (vi)",
        voice: "male",
        speedFactor: speedRate,
        pitchShift: pitchShift,
        volumeBoost: volume, // ⭐ Thêm volume vào response
        stats: {
          total: textList.length,
          successful: successful.length,
          failed: failed.length,
          totalSize: totalSize,
          processingTime: processingTime,
        },
        results: results,
        files: successful.map((r) => `${r.code}.mp3`),
      });
    } catch (error) {
      console.error("💥 Fatal error during TTS processing:", error);
      res.status(500).json({
        success: false,
        message: "TTS Tiếng Việt processing failed",
        error: error.message,
        results: results,
      });
    }
  });

  // API tạo TTS cho một text cụ thể
  router.post("/ttslistTV/single", jsonParser, async (req, res) => {
    const { text, code } = req.body;

    if (!text || !code) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: text and code",
      });
    }

    try {
      const item = { text, code };
      const result = await processTextToMp3(item, 0, 1);

      if (result.success) {
        res.status(200).json({
          success: true,
          message: "Single TTS file created successfully with male voice",
          language: "Vietnamese (vi)",
          voice: "male",
          speedFactor: speedRate,
          pitchShift: pitchShift,
          volumeBoost: volume, // ⭐ Thêm volume vào response
          result: result,
          file: `${code}.mp3`,
        });
      } else {
        res.status(500).json({
          success: false,
          message: "Failed to create TTS file",
          error: result.error,
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error processing single TTS request",
        error: error.message,
      });
    }
  });

  // API để lấy danh sách textList
  router.get("/ttslistTV", (req, res) => {
    res.status(200).json({
      success: true,
      language: "Vietnamese (vi)",
      voice: "male",
      speedFactor: speedRate,
      pitchShift: pitchShift,
      volumeBoost: volume, // ⭐ Thêm volume vào response
      count: textList.length,
      items: textList,
    });
  });

  // API để lấy danh sách file MP3 đã tạo
  router.get("/ttslistTV/files", (req, res) => {
    try {
      const files = fs
        .readdirSync(TTS_DIR)
        .filter((file) => file.endsWith(".mp3"))
        .map((file) => {
          const filePath = path.join(TTS_DIR, file);
          const stats = fs.statSync(filePath);
          return {
            filename: file,
            code: file.replace(".mp3", ""),
            size: stats.size,
            sizeKB: (stats.size / 1024).toFixed(2),
            created: stats.birthtime,
            modified: stats.mtime,
            voice: "male",
            speedFactor: speedRate,
            pitchShift: pitchShift,
            volumeBoost: volume, // ⭐ Thêm volume vào response
          };
        })
        .sort((a, b) => a.code.localeCompare(b.code));

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);

      res.status(200).json({
        success: true,
        language: "Vietnamese (vi)",
        voice: "male",
        speedFactor: speedRate,
        pitchShift: pitchShift,
        volumeBoost: volume, // ⭐ Thêm volume vào response
        count: files.length,
        files: files,
        totalSize: totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error reading TTS files",
        error: error.message,
      });
    }
  });

  // API để phát file MP3 theo code
  router.get("/ttslistTV/play/:code", (req, res) => {
    const code = req.params.code;
    const filePath = path.join(TTS_DIR, `${code}.mp3`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: `TTS file not found for code: ${code}`,
      });
    }

    try {
      const stats = fs.statSync(filePath);

      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Length": stats.size,
        "Content-Disposition": `inline; filename="${code}.mp3"`,
        "Cache-Control": "public, max-age=3600",
        "X-Speed-Factor": speedRate.toString(),
        "X-Pitch-Shift": pitchShift.toString(),
        "X-Volume-Boost": volume.toString(), // ⭐ Thêm volume vào header
        "X-Voice-Type": "male",
      });

      const readStream = fs.createReadStream(filePath);
      readStream.pipe(res);

      readStream.on("error", (error) => {
        console.error(`Error streaming file ${code}.mp3:`, error);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: "Error streaming audio file",
            error: error.message,
          });
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error accessing audio file",
        error: error.message,
      });
    }
  });

  // API để xóa file MP3 theo code
  router.delete("/ttslistTV/:code", (req, res) => {
    const code = req.params.code;
    const filePath = path.join(TTS_DIR, `${code}.mp3`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: `TTS file not found for code: ${code}`,
      });
    }

    try {
      fs.unlinkSync(filePath);
      res.status(200).json({
        success: true,
        message: `TTS file ${code}.mp3 deleted successfully`,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error deleting TTS file",
        error: error.message,
      });
    }
  });

  return router;
};
