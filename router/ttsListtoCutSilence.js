const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const mp3Code = require("./mp3Cut.json");

// ✨ SPEED RATE: 1 = bình thường, 0.5 = chậm 2x, 2 = nhanh 2x
const speedRate = 1;

// ✨ Giữ lại 0.3s trống phía trước mỗi đoạn cắt
const KEEP_SILENCE_BEFORE = 0.3;

module.exports = (jsonParser) => {
  // API tạo TTS cho tất cả items trong list (existing code)
  router.post("/create-tts", jsonParser, async (req, res) => {
    console.log("🎵 Creating TTS");
    // Your existing TTS logic here
  });

  // API cắt audio dựa trên silence detection
  router.post("/split-audio", jsonParser, async (req, res) => {
    console.log("🎵 Split Audio Started");
    console.log(`⚡ Speed Rate: ${speedRate}x`);
    console.log(`🔇 Keep silence before cut: ${KEEP_SILENCE_BEFORE}s`);

    const inputPath = path.join(process.cwd(), "mp3Test.mp3");
    console.log("CUTTTTTTTTTTTTTTTTTTT");

    // Kiểm tra file tồn tại
    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ error: "mp3Test.mp3 not found" });
    }

    // Tạo thư mục output với timestamp
    const outputDir = path.join(
      process.cwd(),
      "outputs",
      Date.now().toString(),
    );
    fs.mkdirSync(outputDir, { recursive: true });

    // Tạo thư mục tạm cho file chưa apply speed
    const tempDir = path.join(outputDir, "temp");
    fs.mkdirSync(tempDir, { recursive: true });

    const silenceLog = [];

    try {
      // Phân tích silence để tìm điểm cắt
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .audioFilters("silencedetect=noise=-30dB:d=2")
          .format("null")
          .on("stderr", (line) => {
            const matchStart = line.match(/silence_start: (\d+(\.\d+)?)/);
            const matchEnd = line.match(/silence_end: (\d+(\.\d+)?)/);
            if (matchStart) {
              silenceLog.push({
                type: "start",
                time: parseFloat(matchStart[1]),
              });
            }
            if (matchEnd) {
              silenceLog.push({ type: "end", time: parseFloat(matchEnd[1]) });
            }
          })
          .on("end", () => {
            console.log("🔍 Silence detection completed");
            resolve();
          })
          .on("error", (err) => {
            console.error("❌ FFmpeg error during silence detection:", err);
            reject(err);
          })
          .saveToFile("/dev/null");
      });

      // Tạo segments dựa trên silence log
      // ✨ Mỗi segment kết thúc tại silence_start + KEEP_SILENCE_BEFORE
      //    để giữ lại 0.3s trống tự nhiên trước điểm cắt
      const segments = [];
      let lastEnd = 0;

      silenceLog.forEach((entry) => {
        if (entry.type === "start") {
          const cutPoint = entry.time + KEEP_SILENCE_BEFORE;
          const duration = cutPoint - lastEnd;
          if (duration > 0.5) {
            // Chỉ lưu segment > 0.5s
            segments.push({ start: lastEnd, duration });
          }
        }
        if (entry.type === "end") {
          lastEnd = entry.time;
        }
      });

      // Thêm đoạn cuối cùng (từ lastEnd đến hết file)
      if (lastEnd < 1000) {
        // Giả sử file không quá 1000s
        segments.push({ start: lastEnd, duration: null });
      }

      console.log(`📊 Found ${segments.length} segments to split`);

      // KIỂM TRA SỐ LƯỢNG FILE VÀ mp3Code
      console.log(`📋 mp3Code has ${mp3Code.length} elements`);
      if (segments.length === mp3Code.length) {
        console.log("✅ SỐ LƯỢNG FILE ĐÃ ĐỦ");
      } else {
        console.log(
          `❌ SỐ LƯỢNG FILE KHÔNG ĐỦ (Segments: ${segments.length}, mp3Code: ${mp3Code.length})`,
        );
      }

      // ✨ BƯỚC 1: CẮT FILE GỐC (chưa apply speed)
      console.log("📂 Step 1: Cutting original audio...");
      const tempFiles = await Promise.all(
        segments.map((seg, i) => {
          const tempFileName = `temp_${String(i + 1).padStart(3, "0")}.mp3`;
          const tempPath = path.join(tempDir, tempFileName);

          return new Promise((resolve, reject) => {
            let command = ffmpeg(inputPath).setStartTime(seg.start);
            if (seg.duration) {
              command = command.setDuration(seg.duration);
            }
            command
              .output(tempPath)
              .on("end", () => {
                console.log(`✅ Cut: ${tempFileName}`);
                resolve({ index: i, path: tempPath });
              })
              .on("error", (err) => {
                console.error(`❌ Failed to cut ${tempFileName}:`, err);
                reject(err);
              })
              .run();
          });
        }),
      );

      // ✨ TẠO AUDIO FILTER STRING CHO SPEED RATE
      const getAudioFilterString = () => {
        if (speedRate === 1) return null;
        const filters = [];
        let remainingSpeed = speedRate;
        while (remainingSpeed > 2.0) {
          filters.push("atempo=2.0");
          remainingSpeed /= 2.0;
        }
        while (remainingSpeed < 0.5) {
          filters.push("atempo=0.5");
          remainingSpeed /= 0.5;
        }
        if (remainingSpeed !== 1.0) {
          filters.push(`atempo=${remainingSpeed.toFixed(2)}`);
        }
        return filters.length > 0 ? filters.join(",") : null;
      };

      const audioFilterString = getAudioFilterString();

      // ✨ BƯỚC 2: APPLY SPEED CHO TỪNG FILE
      console.log("⚡ Step 2: Applying speed rate...");
      if (audioFilterString) {
        console.log(`🎛️ Audio filter: ${audioFilterString}`);
      }

      const finalFiles = await Promise.all(
        tempFiles.map(({ index, path: tempPath }) => {
          const fileName = mp3Code[index]?.code
            ? `${mp3Code[index].code}.mp3`
            : `part_${String(index + 1).padStart(3, "0")}.mp3`;
          const finalPath = path.join(outputDir, fileName);

          return new Promise((resolve, reject) => {
            let command = ffmpeg(tempPath);

            // Apply speed nếu khác 1
            if (audioFilterString) {
              command = command.audioFilters(audioFilterString);
            }

            command
              .audioCodec("libmp3lame")
              .audioBitrate("192k")
              .output(finalPath)
              .on("end", () => {
                console.log(`✅ Created: ${fileName}`);
                resolve(finalPath);
              })
              .on("error", (err) => {
                console.error(`❌ Failed to create ${fileName}:`, err);
                reject(err);
              })
              .run();
          });
        }),
      );

      // ✨ XÓA THƯ MỤC TEMP
      console.log("🧹 Cleaning up temp files...");
      fs.rmSync(tempDir, { recursive: true, force: true });

      // Trả về kết quả
      return res.json({
        success: true,
        message: "Split audio completed successfully",
        speedRate: speedRate,
        keepSilenceBefore: KEEP_SILENCE_BEFORE,
        audioFilter: audioFilterString,
        totalSegments: finalFiles.length,
        mp3CodeCount: mp3Code.length,
        isMatched: finalFiles.length === mp3Code.length,
        outputDirectory: outputDir,
        files: finalFiles.map((file) => ({
          name: path.basename(file),
          path: file,
          size: fs.existsSync(file) ? fs.statSync(file).size : 0,
        })),
      });
    } catch (error) {
      console.error("❌ Split audio failed:", error);

      // Cleanup output directory on error
      if (fs.existsSync(outputDir)) {
        try {
          fs.rmSync(outputDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.error("❌ Failed to cleanup output directory:", cleanupError);
        }
      }

      return res.status(500).json({
        success: false,
        error: "Failed to split audio",
        details: error.message,
      });
    }
  });

  return router;
};
