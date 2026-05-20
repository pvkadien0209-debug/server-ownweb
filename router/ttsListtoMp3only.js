const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const googleTTS = require("google-tts-api");
const textList = require("./ttsList.json");

// const textList = [
//   { stt: 1, text: "cow", code: "A01" },
//   { stt: 2, text: "hour", code: "A03" },
//   { stt: 3, text: "down", code: "A02" },
//   { stt: 4, text: "loud", code: "A04" },
// ];

// Setup thư mục ttsList
const TTS_DIR = path.resolve(__dirname, "./ttsList");
if (!fs.existsSync(TTS_DIR)) {
  fs.mkdirSync(TTS_DIR, { recursive: true });
}

// Hàm tách text thành các đoạn nhỏ hơn 200 ký tự
function splitText(text, maxLength = 200) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = "";

  // Tách theo câu trước
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim());

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

// Hàm tạo audio buffer từ text chunk
async function createAudioBuffer(text) {
  try {
    const url = googleTTS.getAudioUrl(text, {
      lang: "en",
      slow: true,
    });
    const audioRes = await fetch(url);
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
  // Nối các buffer lại với nhau đơn giản
  return Buffer.concat(audioBuffers);
}

// Hàm xử lý một item text thành MP3
async function processTextToMp3(item, index, total) {
  const filePath = path.join(TTS_DIR, `${item.code}.mp3`);

  try {
    console.log(
      `[${index + 1}/${total}] Processing: ${item.code} - "${item.text}"`
    );

    // Kiểm tra file đã tồn tại - nếu có thì ghi đè
    if (fs.existsSync(filePath)) {
      console.log(`  → File ${item.code}.mp3 exists, overwriting...`);
    }

    let finalBuffer;

    // Kiểm tra độ dài text > 200 thì tách
    if (item.text.length > 200) {
      console.log(`  → Text length ${item.text.length} > 200, splitting...`);

      // Tách text thành các chunk
      const textChunks = splitText(item.text, 200);
      console.log(`  → Split into ${textChunks.length} chunks`);

      const audioBuffers = [];

      // Tạo audio buffer cho từng chunk
      for (let i = 0; i < textChunks.length; i++) {
        console.log(`  → Processing chunk ${i + 1}/${textChunks.length}`);
        const chunkBuffer = await createAudioBuffer(textChunks[i]);
        audioBuffers.push(chunkBuffer);

        // Delay nhỏ giữa các request để tránh rate limit
        if (i < textChunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      // Ghép các buffer lại
      finalBuffer = await mergeAudioBuffers(audioBuffers);
    } else {
      // Text ngắn, xử lý bình thường
      console.log(
        `  → Text length ${item.text.length} ≤ 200, processing directly`
      );
      finalBuffer = await createAudioBuffer(item.text);
    }

    // Tạo file name = e.code + ".mp3" và lưu vào folder /ttsList
    fs.writeFileSync(filePath, finalBuffer);

    console.log(`  ✅ Created: ${item.code}.mp3 (${finalBuffer.length} bytes)`);

    return { success: true, code: item.code, size: finalBuffer.length };
  } catch (error) {
    console.error(`  ❌ Error processing ${item.code}:`, error.message);
    return { success: false, code: item.code, error: error.message };
  }
}

module.exports = (jsonParser) => {
  router.post("/ttslist", jsonParser, async (req, res) => {
    console.log("🎵 TTS List processing started");
    console.log(`📝 Total items to process: ${textList.length}`);

    const results = [];
    const startTime = Date.now();

    try {
      // Xử lý từng item trong textList
      for (let i = 0; i < textList.length; i++) {
        const item = textList[i];

        // Console tiến độ
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

      console.log("\n📊 Processing completed!");
      console.log(`✅ Successful: ${successful.length}`);
      console.log(`❌ Failed: ${failed.length}`);
      console.log(`📦 Total size: ${(totalSize / 1024).toFixed(2)} KB`);
      console.log(
        `⏱️  Processing time: ${(processingTime / 1000).toFixed(2)}s`
      );

      if (failed.length > 0) {
        console.log("\n❌ Failed items:");
        failed.forEach((f) => {
          console.log(`  → ${f.code}: ${f.error}`);
        });
      }

      res.status(200).json({
        success: true,
        message: "TTS processing completed",
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
      console.error("💥 Fatal error during processing:", error);

      res.status(500).json({
        success: false,
        message: "TTS processing failed",
        error: error.message,
        results: results,
      });
    }
  });

  // API để lấy danh sách textList
  router.get("/ttslist", (req, res) => {
    res.status(200).json({
      success: true,
      count: textList.length,
      items: textList,
    });
  });

  // API để lấy danh sách file MP3 đã tạo
  router.get("/ttslist/files", (req, res) => {
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
            created: stats.birthtime,
            modified: stats.mtime,
          };
        });

      res.status(200).json({
        success: true,
        count: files.length,
        files: files,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
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
  router.get("/ttslist/play/:code", (req, res) => {
    const code = req.params.code;
    const filePath = path.join(TTS_DIR, `${code}.mp3`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: `TTS file not found for code: ${code}`,
      });
    }

    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `inline; filename="${code}.mp3"`,
    });

    fs.createReadStream(filePath).pipe(res);
  });

  return router;
};
