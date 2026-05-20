import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import googleTTS from "google-tts-api";
import { fileURLToPath } from "url";

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Setup directories
const BUFFER_DIR = path.resolve(__dirname, "./buffer");
const TEMP_DIR = path.resolve(__dirname, "./temp");

[BUFFER_DIR, TEMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Audio format detection and analysis
function detectAudioFormat(buffer) {
  if (buffer.length < 4) return "webm";

  // WebM: EBML header 0x1A45DFA3
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return "webm";
  }

  // MP4: 'ftyp' at offset 4
  if (
    buffer.length >= 8 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return "mp4";
  }

  // WAV: 'RIFF' header
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46
  ) {
    return "wav";
  }

  // MP3: ID3 or MPEG sync
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) {
    return "mp3";
  }

  return "webm"; // Default
}

function analyzeBuffer(buffer) {
  const nonZeroCount = buffer.filter((b) => b !== 0).length;
  const nonZeroPercent = ((nonZeroCount / buffer.length) * 100).toFixed(2);
  const format = detectAudioFormat(buffer);
  const firstBytes = Array.from(buffer.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

  return {
    size: buffer.length,
    nonZeroBytes: nonZeroCount,
    nonZeroPercent: parseFloat(nonZeroPercent),
    format,
    firstBytesHex: firstBytes,
    isValid: nonZeroCount > buffer.length * 0.1 && buffer.length > 1000,
    warnings: [],
  };
}

function getContentType(format) {
  const types = {
    webm: "audio/webm",
    mp4: "audio/mp4",
    wav: "audio/wav",
    mp3: "audio/mpeg",
  };
  return types[format] || "audio/webm";
}

function generateFilename(text, format = "mp3") {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const textSlug = text
    .substring(0, 30)
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  return `${timestamp}_${textSlug}_${randomSuffix}.${format}`;
}

// Text processing utilities
function splitText(text, maxLength = 200) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = "";
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim());

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
        let wordChunk = "";
        for (let word of words) {
          if ((wordChunk + word + " ").length <= maxLength) {
            wordChunk += word + " ";
          } else {
            if (wordChunk.trim()) chunks.push(wordChunk.trim());
            wordChunk = word + " ";
          }
        }
        if (wordChunk.trim()) current = wordChunk;
      } else {
        current = sentence + ". ";
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

async function createAudioBuffer(text) {
  const url = googleTTS.getAudioUrl(text, { lang: "en", slow: true });
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function mergeAudioBuffers(buffers) {
  return buffers.length === 1 ? buffers[0] : Buffer.concat(buffers);
}

// Main router export function
export default function (jsonParser, Ffmpeg) {
  // Enhanced Ffmpeg checking
  async function checkFfmpeg() {
    console.log("Checking Ffmpeg availability...");

    // Method 1: Check if fluent-Ffmpeg module is available
    if (!Ffmpeg) {
      console.log("fluent-Ffmpeg module not available");
      return {
        available: false,
        method: "module",
        error: "fluent-Ffmpeg not provided as parameter",
      };
    }

    // Method 2: Try fluent-Ffmpeg's built-in check
    try {
      const result = await new Promise((resolve) => {
        Ffmpeg.getAvailableFormats((err, formats) => {
          if (err) {
            resolve({
              available: false,
              method: "formats",
              error: err.message,
            });
          } else {
            resolve({
              available: true,
              method: "formats",
              formats: Object.keys(formats).length,
            });
          }
        });
      });

      if (result.available) {
        console.log(
          `Ffmpeg available via fluent-Ffmpeg (${result.formats} formats)`
        );
        return result;
      }
    } catch (error) {
      console.log("fluent-Ffmpeg formats check failed:", error.message);
    }

    // Method 3: Direct command line check
    try {
      const result = await new Promise((resolve) => {
        const ffmpegProcess = spawn("ffmpeg", ["-version"]);

        ffmpegProcess.on("error", (error) => {
          resolve({
            available: false,
            method: "command",
            error: error.message,
          });
        });

        ffmpegProcess.on("close", (code) => {
          if (code === 0) {
            resolve({ available: true, method: "command" });
          } else {
            resolve({
              available: false,
              method: "command",
              error: `Exit code: ${code}`,
            });
          }
        });

        // Timeout after 5 seconds
        setTimeout(() => {
          ffmpegProcess.kill();
          resolve({ available: false, method: "command", error: "Timeout" });
        }, 5000);
      });

      console.log("Command line Ffmpeg check:", result);
      return result;
    } catch (error) {
      console.log("Command line check failed:", error.message);
      return { available: false, method: "command", error: error.message };
    }
  }

  // Enhanced conversion function
  async function convertToMp3(inputBuffer, inputFormat) {
    console.log(`Starting conversion: ${inputFormat} -> MP3`);
    const ffmpegCheck = await checkFfmpeg();

    if (!ffmpegCheck.available) {
      return {
        success: false,
        error: `Ffmpeg not available: ${ffmpegCheck.error}`,
        method: ffmpegCheck.method,
      };
    }

    const tempInput = path.join(TEMP_DIR, `input_${Date.now()}.${inputFormat}`);
    const tempOutput = path.join(TEMP_DIR, `output_${Date.now()}.mp3`);

    try {
      fs.writeFileSync(tempInput, inputBuffer);
      console.log(`Wrote temp input file: ${tempInput}`);

      return new Promise((resolve) => {
        const command = Ffmpeg(tempInput)
          .audioCodec("libmp3lame")
          .audioBitrate(128)
          .audioFrequency(44100)
          .audioChannels(2)
          .format("mp3")
          .on("start", (commandLine) => {
            console.log("Ffmpeg command:", commandLine);
          })
          .on("progress", (progress) => {
            console.log("Processing:", progress.percent + "% done");
          })
          .on("end", () => {
            console.log("Ffmpeg conversion completed");
            try {
              if (!fs.existsSync(tempOutput)) {
                throw new Error("Output file was not created");
              }

              const mp3Buffer = fs.readFileSync(tempOutput);
              console.log(
                `Conversion successful: ${inputBuffer.length} -> ${mp3Buffer.length} bytes`
              );

              // Clean up temp files
              if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
              if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);

              resolve({
                success: true,
                buffer: mp3Buffer,
                originalSize: inputBuffer.length,
                convertedSize: mp3Buffer.length,
              });
            } catch (error) {
              console.error("Error reading output file:", error.message);
              resolve({ success: false, error: error.message });
            }
          })
          .on("error", (error) => {
            console.error("Ffmpeg error:", error.message);
            // Clean up temp files
            if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
            if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
            resolve({ success: false, error: error.message });
          });

        // Save to output file
        command.save(tempOutput);
      });
    } catch (error) {
      console.error("Conversion setup error:", error.message);
      return { success: false, error: error.message };
    }
  }

  // Ffmpeg status endpoint
  router.get("/ffmpeg/status", async (req, res) => {
    const status = await checkFfmpeg();
    res.json({
      success: true,
      ffmpeg: status,
    });
  });

  // Buffer upload with conversion
  router.post("/buffer", jsonParser, async (req, res) => {
    const startTime = Date.now();
    console.log("Buffer upload request received");

    try {
      const { buffer, text, metadata } = req.body;

      if (!buffer || !Array.isArray(buffer)) {
        return res.status(400).json({
          success: false,
          message: "Buffer is required and must be an array",
        });
      }

      if (!text || typeof text !== "string") {
        return res.status(400).json({
          success: false,
          message: "Text is required and must be a string",
        });
      }

      const audioBuffer = Buffer.from(buffer);
      const analysis = analyzeBuffer(audioBuffer);

      console.log(
        `Processing buffer: ${audioBuffer.length} bytes, format: ${analysis.format}`
      );

      if (!analysis.isValid) {
        console.warn("Buffer validation failed - proceeding anyway");
      }

      let finalBuffer = audioBuffer;
      let finalFormat = analysis.format;
      let conversionResult = null;

      // Convert to MP3 if not already MP3
      if (analysis.format !== "mp3") {
        console.log(`Converting ${analysis.format} to MP3...`);
        conversionResult = await convertToMp3(audioBuffer, analysis.format);

        if (conversionResult.success) {
          finalBuffer = conversionResult.buffer;
          finalFormat = "mp3";
          console.log(
            `Conversion successful: ${conversionResult.originalSize} -> ${conversionResult.convertedSize} bytes`
          );
        } else {
          console.warn(`Conversion failed: ${conversionResult.error}`);
        }
      }

      const filename = generateFilename(text, finalFormat);
      const filePath = path.join(BUFFER_DIR, filename);

      fs.writeFileSync(filePath, finalBuffer);

      const fileStats = fs.statSync(filePath);

      const response = {
        success: true,
        message: "Buffer processed successfully",
        filename,
        filePath: `/buffer/${filename}`,
        fileSize: fileStats.size,
        originalFormat: analysis.format,
        finalFormat,
        wasConverted: conversionResult?.success || false,
        processingTime: Date.now() - startTime,
        playUrl: `/api/buffer/play/${filename.replace(`.${finalFormat}`, "")}`,
        analysis: {
          size: analysis.size,
          nonZeroPercent: analysis.nonZeroPercent,
          isValid: analysis.isValid,
        },
        conversionResult,
      };

      console.log(`Upload completed: ${filename} (${finalFormat})`);
      res.json(response);
    } catch (error) {
      console.error("Buffer upload error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to process buffer upload",
        error: error.message,
      });
    }
  });

  // Play buffer file
  router.get("/buffer/play/:filename", (req, res) => {
    const filename = req.params.filename;
    const formats = ["mp3", "webm", "mp4", "wav"];
    let filePath = null;
    let actualFilename = null;
    let format = null;

    // Try exact filename first
    if (filename.includes(".")) {
      const testPath = path.join(BUFFER_DIR, filename);
      if (fs.existsSync(testPath)) {
        filePath = testPath;
        actualFilename = filename;
        format = filename.split(".").pop();
      }
    } else {
      // Try each extension
      for (const ext of formats) {
        const testFilename = `${filename}.${ext}`;
        const testPath = path.join(BUFFER_DIR, testFilename);
        if (fs.existsSync(testPath)) {
          filePath = testPath;
          actualFilename = testFilename;
          format = ext;
          break;
        }
      }
    }

    if (!filePath) {
      return res.status(404).json({
        success: false,
        message: `Audio file not found: ${filename}`,
      });
    }

    const contentType = getContentType(format);
    const fileStats = fs.statSync(filePath);

    res.set({
      "Content-Type": contentType,
      "Content-Length": fileStats.size.toString(),
      "Content-Disposition": `inline; filename="${actualFilename}"`,
    });

    fs.createReadStream(filePath).pipe(res);
  });

  // List buffer files
  router.get("/buffer/list", (req, res) => {
    try {
      const formats = ["mp3", "webm", "mp4", "wav"];
      const files = fs
        .readdirSync(BUFFER_DIR)
        .filter((file) => formats.some((ext) => file.endsWith(`.${ext}`)))
        .map((file) => {
          const filePath = path.join(BUFFER_DIR, file);
          const stats = fs.statSync(filePath);
          const format = file.split(".").pop();
          return {
            filename: file,
            format,
            size: stats.size,
            created: stats.birthtime,
            playUrl: `/api/buffer/play/${file.replace(`.${format}`, "")}`,
          };
        })
        .sort((a, b) => new Date(b.created) - new Date(a.created));

      res.json({
        success: true,
        count: files.length,
        files,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error reading buffer files",
        error: error.message,
      });
    }
  });

  // Delete buffer file
  router.delete("/buffer/:filename", (req, res) => {
    const filename = req.params.filename;
    const formats = ["mp3", "webm", "mp4", "wav"];
    let filePath = null;

    if (filename.includes(".")) {
      const testPath = path.join(BUFFER_DIR, filename);
      if (fs.existsSync(testPath)) filePath = testPath;
    } else {
      for (const ext of formats) {
        const testPath = path.join(BUFFER_DIR, `${filename}.${ext}`);
        if (fs.existsSync(testPath)) {
          filePath = testPath;
          break;
        }
      }
    }

    if (!filePath) {
      return res.status(404).json({
        success: false,
        message: `File not found: ${filename}`,
      });
    }

    try {
      const stats = fs.statSync(filePath);
      fs.unlinkSync(filePath);
      res.json({
        success: true,
        message: "File deleted successfully",
        deletedSize: stats.size,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Failed to delete file",
        error: error.message,
      });
    }
  });

  return router;
}
