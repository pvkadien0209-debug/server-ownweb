const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const mp3Code = require("./mp3Cut.json");
module.exports = (jsonParser) => {
  // API tạo TTS cho tất cả items trong list (existing code)

  router.post("/create-tts", jsonParser, async (req, res) => {
    console.log("🎵 Creating TTS");
    // Your existing TTS logic here
  });

  // API cắt audio dựa trên silence detection
  router.post("/split-audio", jsonParser, async (req, res) => {
    console.log("🎵 Split Audio Started");

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
      Date.now().toString()
    );
    fs.mkdirSync(outputDir, { recursive: true });

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
      const segments = [];
      let lastEnd = 0;

      silenceLog.forEach((entry) => {
        if (entry.type === "start") {
          const duration = entry.time - lastEnd;
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

      // Cắt các segments
      const promises = segments.map((seg, i) => {
        const outputPath = path.join(
          outputDir,
          `part_${String(i + 1).padStart(3, "0")}.mp3`
        );

        return new Promise((resolve, reject) => {
          let command = ffmpeg(inputPath).setStartTime(seg.start);

          if (seg.duration) {
            command = command.setDuration(seg.duration);
          }

          command
            .output(outputPath)
            .on("end", () => {
              console.log(`✅ Created: ${path.basename(outputPath)}`);
              resolve(outputPath);
            })
            .on("error", (err) => {
              console.error(
                `❌ Failed to create ${path.basename(outputPath)}:`,
                err
              );
              reject(err);
            })
            .run();
        });
      });

      const files = await Promise.all(promises);

      // Trả về kết quả
      return res.json({
        success: true,
        message: "Split audio completed successfully",
        totalSegments: files.length,
        outputDirectory: outputDir,
        files: files.map((file) => ({
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
