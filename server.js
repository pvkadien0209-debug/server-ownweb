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
import { connectMongo, closeMongo, getCollection } from "./ulti/mongodb.js";
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
        fsp,
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
  },
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

// ============================================
// TTS: cache 2 tầng (đĩa cục bộ -> MongoDB) + Google TTS
// ============================================
// Tầng 1 (đĩa cục bộ): nhanh nhất vì không qua mạng, nhưng bị xoá sạch mỗi khi
// host reset filesystem (gói hosting giá rẻ).
// Tầng 2 (MongoDB): bền vững qua các lần reset đĩa, tốc độ đọc/ghi vẫn rất
// nhanh (một document nhỏ theo _id, không phải quét/aggregate) nên gần như
// không ảnh hưởng thời gian phản hồi so với việc phải gọi lại Google TTS.
// Tầng 3: chưa có ở đâu cả thì mới thật sự gọi Google TTS để tạo mới.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.resolve(__dirname, "./tts_cache");
const TTS_MAX_CHUNK_LENGTH = 200; // giới hạn ký tự/lần gọi của google-tts-api
const TTS_MONGO_COLLECTION = "tts_audio_cache";

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
}

let ttsQueue = [];
let isProcessing = false;

function setAudioHeaders(res) {
  res.set({
    "Content-Type": "audio/mpeg",
    "Content-Disposition": 'inline; filename="speech.mp3"',
  });
}

function streamAudioFile(res, filePath) {
  setAudioHeaders(res);
  fs.createReadStream(filePath).pipe(res);
}

function sendAudioBuffer(res, buffer) {
  setAudioHeaders(res);
  res.send(buffer);
}

function getCacheHash(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

function getDiskCachePath(hash) {
  return path.join(CACHE_DIR, `${hash}.mp3`);
}

function writeDiskCache(hash, buffer) {
  try {
    fs.writeFileSync(getDiskCachePath(hash), buffer);
  } catch (err) {
    console.error("⚠️ Không thể ghi TTS cache ra đĩa:", err.message);
  }
}

// BSON Binary -> Buffer (driver có thể trả về Binary thay vì Buffer thuần)
function toNodeBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value?.buffer) return Buffer.from(value.buffer);
  return Buffer.from(value);
}

async function readMongoCache(hash) {
  try {
    const doc = await getCollection(TTS_MONGO_COLLECTION).findOne(
      { _id: hash },
      { projection: { audio: 1 } },
    );
    return doc ? toNodeBuffer(doc.audio) : null;
  } catch (err) {
    // MongoDB chỉ là cache bền vững phụ — lỗi ở đây không được làm hỏng luồng TTS chính
    console.warn("⚠️ Không đọc được TTS cache từ MongoDB:", err.message);
    return null;
  }
}

// Fire-and-forget: không await ở nơi gọi để không làm chậm response
function writeMongoCache(hash, buffer, text) {
  try {
    getCollection(TTS_MONGO_COLLECTION)
      .updateOne(
        { _id: hash },
        {
          $set: {
            audio: buffer,
            textLength: text.length,
            lastAccessedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      )
      .catch((err) => {
        console.warn("⚠️ Không ghi được TTS cache vào MongoDB:", err.message);
      });
  } catch (err) {
    console.warn("⚠️ Không ghi được TTS cache vào MongoDB:", err.message);
  }
}

// Hàm tách text thành các đoạn nhỏ hơn maxLength ký tự (theo câu, rồi theo từ)
function splitText(text, maxLength = TTS_MAX_CHUNK_LENGTH) {
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

// Hàm tạo audio buffer từ một chunk text (1 lần gọi Google TTS)
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

// Sinh audio mới hoàn toàn qua Google TTS (được gọi khi cả 2 tầng cache đều miss)
async function generateAudioBuffer(text) {
  if (text.length <= TTS_MAX_CHUNK_LENGTH) {
    return createAudioBuffer(text);
  }
  const chunks = splitText(text, TTS_MAX_CHUNK_LENGTH);
  // Gọi song song thay vì tuần tự: văn bản càng dài (càng nhiều chunk) thì
  // càng lợi thời gian, đúng lúc text > 200 ký tự cần cải thiện tốc độ nhất.
  // Thứ tự chunks[] vẫn được giữ nguyên khi ghép vì Promise.all trả về mảng
  // kết quả đúng theo thứ tự input.
  const audioBuffers = await Promise.all(chunks.map(createAudioBuffer));
  return mergeAudioBuffers(audioBuffers);
}

// Xử lý hàng đợi: chỉ những request THỰC SỰ cần gọi Google TTS mới vào đây,
// cache-hit (đĩa hoặc MongoDB) được trả thẳng ở route, không phải xếp hàng.
async function processQueue() {
  if (isProcessing || ttsQueue.length === 0) return;
  isProcessing = true;
  const { text, res } = ttsQueue.shift();
  const hash = getCacheHash(text);

  try {
    const buffer = await generateAudioBuffer(text);
    writeDiskCache(hash, buffer);
    writeMongoCache(hash, buffer, text);
    sendAudioBuffer(res, buffer);
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).send("TTS failed");
  } finally {
    isProcessing = false;
    setTimeout(processQueue, 500); // tránh spam Google TTS
  }
}

app.post("/tts", async (req, res) => {
  const text = req.body.text?.trim();
  if (!text) return res.status(400).send("Missing text");

  const hash = getCacheHash(text);

  // Tầng 1: cache trên đĩa — trả ngay, không qua hàng đợi
  const diskPath = getDiskCachePath(hash);
  if (fs.existsSync(diskPath)) {
    streamAudioFile(res, diskPath);
    // Tự "chữa lành" MongoDB nếu record này chưa có (ví dụ tạo trước khi có Mongo)
    writeMongoCache(hash, fs.readFileSync(diskPath), text);
    return;
  }

  // Tầng 2: cache trên MongoDB — trả ngay, không cần gọi lại Google TTS
  const mongoBuffer = await readMongoCache(hash);
  if (mongoBuffer) {
    writeDiskCache(hash, mongoBuffer); // đổ lại đĩa để lần sau nhanh hơn nữa
    sendAudioBuffer(res, mongoBuffer);
    return;
  }

  // Tầng 3: chưa có cache ở đâu — xếp hàng để tạo mới qua Google TTS
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

// Start the server (chỉ 1 nơi duy nhất gọi listen)
// Luôn listen trước, không đợi Mongo connect thành công
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Available routes:`);
  console.log(`- GET / - Welcome message`);
  console.log(`- GET /message - Backend message`);
  console.log(`- GET /test - Test endpoint (GET)`);
  console.log(`- POST /test - Test endpoint (POST)`);
});

// Kết nối Mongo song song, không chặn server, không crash nếu lỗi
connectMongo()
  .then(() => {
    console.log("✅ MongoDB connected");
  })
  .catch((err) => {
    console.error(
      "⚠️ Không thể kết nối MongoDB (server vẫn chạy, sẽ dùng chế độ offline/thiếu DB):",
      err.message,
    );
  });
