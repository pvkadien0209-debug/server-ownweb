// Import statements
import express from "express";
import cors from "cors";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import googleTTS from "google-tts-api";
import { fileURLToPath } from "url";
// import ffmpeg from "fluent-ffmpeg";
// import Ffmpeg from "fluent-ffmpeg";
// Import local modules
import routerIO from "./router/io.js";
import message from "./router/message.js";
import { RegAnalyze } from "./ulti/reg_analyze.js";
import { RegAnalyzeInPrac } from "./ulti/reg_analyze_inprac.js";
import { GetDataPracInCustom } from "./ulti/get_data_prac_in_custom.js";
import { sendmailDK } from "./ulti/get_homework_and_email.js";
import ttsList from "./router/ttsListtoMp3only.js";
import ttsListTV from "./router/ttsListtoMp3_TV.js";
// Environment variables
import mp3Cut from "./router/ttsListtoCutSilence.js";
// Thêm vào đầu server.js sau các import
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import Ffmpeg from "fluent-ffmpeg";

// Cấu hình ffmpeg path
Ffmpeg.setFfmpegPath(ffmpegInstaller.path);
Ffmpeg.setFfprobePath(ffprobeInstaller.path);

console.log("FFmpeg path:", ffmpegInstaller.path);
console.log("FFprobe path:", ffprobeInstaller.path);

const port = process.env.PORT || 5000;

// Express app initialization
const app = express();
const jsonParser = bodyParser.json();

// Configure CORS
const corsOptions = {
  origin: "*", // Allow all origins, you can restrict this to specific domains
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
  ],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get("/", (req, res) => {
  res.send("Welcome to the server!");
});

app.get("/message", (req, res) => {
  res.send("Hello from the backend!");
});

// Add GET route for /test
app.get("/test", (req, res) => {
  console.log("GET test success", req.query);
  res.json({ message: "Success from GET /test" });
});

app.post("/testpost", (req, res) => {
  console.log("GET test success", req.query);
  res.json({ message: "Success from GET /test" });
});
/**
 * Route handler for analyzing transcript text against command lists
 * Expects JSON body with transcript, CMDlist, and numberTry fields
 */
app.post("/reg-Analyze", jsonParser, (req, res) => {
  try {
    // Validate required request parameters
    const { transcript, CMDlist } = req.body;
    if (!transcript || !CMDlist) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required parameters: transcript and CMDlist are required",
      });
    }
    // Process the request with RegAnalyze
    const analysisResults = RegAnalyze(transcript, CMDlist);
    // Return successful response
    return res.status(200).json({
      success: true,
      message: "Analysis completed successfully",
      data: analysisResults,
    });
  } catch (error) {
    // Handle any unexpected errors
    console.error("Error in /reg-Analyze:", error.message);
    return res.status(500).json({
      success: false,
      message: "Server error processing request",
      error: error.message,
    });
  }
});

app.post("/reg-Analyze-in-prac", jsonParser, (req, res) => {
  try {
    // Validate required request parameters
    const { RegInput, CMDlist, regRate_01 } = req.body;
    if (!RegInput || !CMDlist) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required parameters: transcript and CMDlist are required",
      });
    }
    // Process the request with RegAnalyze
    const analysisResults = RegAnalyzeInPrac(RegInput, CMDlist, regRate_01);
    // Return successful response
    return res.status(200).json({
      success: true,
      message: "Analysis completed successfully",
      data: analysisResults,
    });
  } catch (error) {
    // Handle any unexpected errors
    console.error("Error in /reg-Analyze:", error.message);
    return res.status(500).json({
      success: false,
      message: "Server error processing request",
      error: error.message,
    });
  }
});

app.post(
  "/reg-Analyze-get_data_prac_in_custom-prac",
  jsonParser,
  (req, res) => {
    try {
      // Validate required request parameters
      const {
        data_all,
        index_sets_t_get_pracData,
        filerSets,
        upCode,
        random,
        fsp,
      } = req.body;
      // Process the request with RegAnalyze
      const analysisResults = GetDataPracInCustom(
        data_all,
        index_sets_t_get_pracData,
        filerSets,
        upCode,
        random,
        fsp
      );
      // Return successful response
      return res.status(200).json({
        success: true,
        message: "Analysis completed successfully",
        data: analysisResults,
      });
    } catch (error) {
      // Handle any unexpected errors
      console.error("Error in /reg-Analyze:", error.message);
      return res.status(500).json({
        success: false,
        message: "Server error processing request",
        error: error.message,
      });
    }
  }
);

app.post("/mail-homework", jsonParser, (req, res) => {
  try {
    const { subjectText, contentText, toEmail } = req.body;
    if (!subjectText || !contentText) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: subjectText or contentText",
      });
    }
    // Use default email if toEmail is not provided
    const recipientEmail = toEmail || "dienpham187294@gmail.com";
    sendmailDK(subjectText, contentText, recipientEmail);
    return res.status(200).json({
      success: true,
      message: "Mail sent successfully",
    });
  } catch (error) {
    console.error("Error in /mail-homework:", error.message);
    return res.status(500).json({
      success: false,
      message: "Server error processing request",
      error: error.message,
    });
  }
});

// TTS cache setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.resolve(__dirname, "./tts_cache");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
}

let ttsQueue = [];
let isProcessing = false;

function getCachePath(text) {
  const hash = crypto.createHash("md5").update(text).digest("hex");
  return path.join(CACHE_DIR, `${hash}.mp3`);
}

// async function processQueue() {
//   if (isProcessing || ttsQueue.length === 0) return;
//   isProcessing = true;
//   const { text, res } = ttsQueue.shift();
//   const cachePath = getCachePath(text);
//   try {
//     // Nếu cache tồn tại lúc đang xử lý
//     if (fs.existsSync(cachePath)) {
//       fs.createReadStream(cachePath)
//         .on("open", () => {
//           res.set({
//             "Content-Type": "audio/mpeg",
//             "Content-Disposition": 'inline; filename="speech.mp3"',
//           });
//         })
//         .pipe(res)
//         .on("finish", () => {
//           isProcessing = false;
//           setTimeout(processQueue, 100);
//         });
//       return;
//     }
//     // Chưa có cache, gọi Google TTS
//     const url = googleTTS.getAudioUrl(text, {
//       lang: "en",
//       slow: true,
//     });
//     const audioRes = await fetch(url);
//     const arrayBuffer = await audioRes.arrayBuffer();
//     const buffer = Buffer.from(arrayBuffer);
//     // Lưu file cache
//     fs.writeFileSync(cachePath, buffer);
//     res.set({
//       "Content-Type": "audio/mpeg",
//       "Content-Disposition": 'inline; filename="speech.mp3"',
//     });
//     res.send(buffer);
//   } catch (err) {
//     console.error("TTS error:", err);

//     res.status(500).send("TTS failed");
//   } finally {
//     isProcessing = false;
//     setTimeout(processQueue, 500); // tránh spam
//   }
// }

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
  const url = googleTTS.getAudioUrl(text, {
    lang: "en",
    slow: true,
  });
  const audioRes = await fetch(url);
  const arrayBuffer = await audioRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Hàm ghép nhiều audio buffer thành một (chỉ nối buffer đơn giản)
async function mergeAudioBuffers(audioBuffers) {
  if (audioBuffers.length === 1) {
    return audioBuffers[0];
  }

  // Nối các buffer lại với nhau đơn giản
  // Lưu ý: Đây là cách nối đơn giản, có thể không hoàn hảo về mặt audio
  return Buffer.concat(audioBuffers);
}

async function processQueue() {
  if (isProcessing || ttsQueue.length === 0) return;
  isProcessing = true;
  const { text, res } = ttsQueue.shift();
  const cachePath = getCachePath(text);

  try {
    // Nếu cache tồn tại lúc đang xử lý
    if (fs.existsSync(cachePath)) {
      fs.createReadStream(cachePath)
        .on("open", () => {
          res.set({
            "Content-Type": "audio/mpeg",
            "Content-Disposition": 'inline; filename="speech.mp3"',
          });
        })
        .pipe(res)
        .on("finish", () => {
          isProcessing = false;
          setTimeout(processQueue, 100);
        });
      return;
    }

    let finalBuffer;

    // Kiểm tra độ dài text
    if (text.length > 200) {
      // Tách text thành các chunk
      const textChunks = splitText(text, 200);
      const audioBuffers = [];

      // Tạo audio buffer cho từng chunk
      for (let i = 0; i < textChunks.length; i++) {
        const chunkBuffer = await createAudioBuffer(textChunks[i]);
        audioBuffers.push(chunkBuffer);
      }

      // Ghép các buffer lại
      finalBuffer = await mergeAudioBuffers(audioBuffers);
    } else {
      // Text ngắn, xử lý bình thường
      finalBuffer = await createAudioBuffer(text);
    }

    // Lưu vào cache
    fs.writeFileSync(cachePath, finalBuffer);

    // Trả về buffer
    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Disposition": 'inline; filename="speech.mp3"',
    });
    res.send(finalBuffer);
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).send("TTS failed");
  } finally {
    isProcessing = false;
    setTimeout(processQueue, 500); // tránh spam
  }
}
app.post("/tts", (req, res) => {
  const text = req.body.text?.trim();
  if (!text) return res.status(400).send("Missing text");
  const cachePath = getCachePath(text);
  // Trả cache nếu có
  if (fs.existsSync(cachePath)) {
    return fs
      .createReadStream(cachePath)
      .on("open", () => {
        res.set({
          "Content-Type": "audio/mpeg",
          "Content-Disposition": 'inline; filename="speech.mp3"',
        });
      })
      .pipe(res);
  }
  // Thêm vào queue xử lý
  ttsQueue.push({ text, res });
  processQueue();
});

app.get("/test-ffmpeg", async (req, res) => {
  try {
    Ffmpeg.getAvailableFormats((err, formats) => {
      if (err) {
        res.json({ success: false, error: err.message });
      } else {
        res.json({
          success: true,
          ffmpegPath: ffmpegInstaller.path,
          formatCount: Object.keys(formats).length,
        });
      }
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});
// Create the server
const server = http.createServer(app);

// Setup Socket.IO
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Pass the io instance to the router modules
routerIO(io);
message(io);
app.use("/", ttsList(jsonParser, Ffmpeg)); // ✅ ĐÚNG
app.use("/", ttsListTV(jsonParser)); // ✅ ĐÚNG
app.use("/", mp3Cut(jsonParser, Ffmpeg)); // ✅ ĐÚNG

// Start the server
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Available routes:`);
  console.log(`- GET / - Welcome message`);
  console.log(`- GET /message - Backend message`);
  console.log(`- GET /test - Test endpoint (GET)`);
  console.log(`- POST /test - Test endpoint (POST)`);
});
