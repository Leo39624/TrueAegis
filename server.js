require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const os = require("os");

const {
  GoogleGenAI,
  createPartFromUri,
} = require("@google/genai");

const authRoutes = require("./routes/auth");

const app = express();

/* ============================================================
   CONFIGURATION
============================================================ */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const BASE_URL = String(
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`
).replace(/\/+$/, "");

const MONGODB_URI = process.env.MONGODB_URI;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

const GEMINI_LOCATION =
  process.env.GEMINI_LOCATION || "global";

const PERPLEXITY_API_KEY =
  process.env.PERPLEXITY_API_KEY;

const PERPLEXITY_MODEL =
  process.env.PERPLEXITY_MODEL || "sonar";

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

const GROQ_MODEL =
  process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

const GROQ_MAX_OUTPUT_TOKENS =
  Number(process.env.GROQ_MAX_OUTPUT_TOKENS || 900);

const JWT_SECRET =
  process.env.JWT_SECRET || "change-this-secret";

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID;

const MAX_MEDIA_BYTES =
  Number(process.env.MAX_MEDIA_BYTES || 20 * 1024 * 1024);

const REQUEST_TIMEOUT_MS =
  Number(process.env.AI_TIMEOUT_MS || 90000);

const VIDEO_PROCESS_TIMEOUT_MS =
  Number(process.env.VIDEO_PROCESS_TIMEOUT_MS || 60000);

/* ============================================================
   BASIC APP SETUP
============================================================ */

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(cookieParser());

/* ============================================================
   HELPERS
============================================================ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function cleanBase64(value) {
  if (!value) return "";

  let data = String(value).trim();

  if (data.startsWith("data:")) {
    const commaIndex = data.indexOf(",");

    if (commaIndex !== -1) {
      data = data.slice(commaIndex + 1);
    }
  }

  return data
    .replace(/\s/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
}

function estimateBase64Bytes(base64) {
  if (!base64) return 0;

  const padding =
    base64.endsWith("==")
      ? 2
      : base64.endsWith("=")
      ? 1
      : 0;

  return Math.floor(
    (base64.length * 3) / 4
  ) - padding;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.floor(
    Math.log(bytes) / Math.log(1024)
  );

  return `${(
    bytes / Math.pow(1024, index)
  ).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function providerError(provider, error) {
  const message =
    error?.message ||
    error?.error?.message ||
    String(error);

  const status =
    error?.status ||
    error?.statusCode ||
    error?.code ||
    500;

  return {
    provider,
    status,
    message,
  };
}

function isTemporaryAIError(error) {
  const status = Number(
    error?.status ||
      error?.statusCode ||
      error?.code ||
      0
  );

  const message =
    String(error?.message || "").toLowerCase();

  if (
    [408, 429, 500, 502, 503, 504].includes(status)
  ) {
    return true;
  }

  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("temporarily unavailable") ||
    message.includes("high demand") ||
    message.includes("econnreset") ||
    message.includes("socket")
  );
}

/* ============================================================
   FETCH WITH TIMEOUT
============================================================ */

async function fetchWithTimeout(
  url,
  options = {},
  timeout = REQUEST_TIMEOUT_MS
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   JSON PARSING
============================================================ */

function parsePossibleJSON(text) {
  if (!text) return null;

  if (typeof text === "object") {
    return text;
  }

  let cleaned = String(text).trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (
    firstBrace !== -1 &&
    lastBrace > firstBrace
  ) {
    try {
      return JSON.parse(
        cleaned.slice(firstBrace, lastBrace + 1)
      );
    } catch {}
  }

  return null;
}

/* ============================================================
   REPORT NORMALIZATION
============================================================ */

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    if (!value) return [];

    if (typeof value === "string") {
      return value
        .split(/\n|•|;/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 10);
    }

    return [String(value)];
  }

  return value
    .map((item) => {
      if (
        typeof item === "string"
      ) {
        return item.trim();
      }

      if (
        item &&
        typeof item === "object"
      ) {
        return (
          item.description ||
          item.signal ||
          item.reason ||
          item.detail ||
          JSON.stringify(item)
        );
      }

      return String(item);
    })
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeSuspicion(value) {
  const normalized =
    safeString(value)
      .toUpperCase()
      .replace(/[^A-Z]/g, "");

  if (normalized === "LOW") {
    return "LOW";
  }

  if (normalized === "MEDIUM") {
    return "MEDIUM";
  }

  if (normalized === "HIGH") {
    return "HIGH";
  }

  return "INCONCLUSIVE";
}

function normalizeReport(raw, fallbackText = "") {
  const parsed =
    typeof raw === "object"
      ? raw
      : parsePossibleJSON(raw);

  if (!parsed) {
    return {
      suspicion: "INCONCLUSIVE",
      assessment:
        fallbackText ||
        "The AI provider did not return a structured forensic assessment.",
      evidence: [],
      aiGenerationIndicators: [],
      authenticitySignals: [],
      limitations: [
        "The analysis provider did not return a structured report.",
        "No authenticity conclusion can be established from this result.",
      ],
      verificationSteps: [
        "Retry the analysis.",
        "Compare the media with the original source.",
        "Check provenance and independent sources.",
      ],
    };
  }

  return {
    suspicion: normalizeSuspicion(
      parsed.suspicion ||
        parsed.suspicionLevel ||
        parsed.risk
    ),

    assessment:
      safeString(
        parsed.assessment ||
          parsed.overallAssessment ||
          parsed.summary ||
          parsed.conclusion
      ) ||
      "No detailed assessment was returned.",

    evidence: normalizeArray(
      parsed.evidence ||
        parsed.evidenceObserved ||
        parsed.signals
    ),

    aiGenerationIndicators:
      normalizeArray(
        parsed.aiGenerationIndicators ||
          parsed.aiIndicators ||
          parsed.generationIndicators
      ),

    authenticitySignals:
      normalizeArray(
        parsed.authenticitySignals ||
          parsed.authenticity
      ),

    limitations: normalizeArray(
      parsed.limitations ||
        parsed.caveats
    ),

    verificationSteps: normalizeArray(
      parsed.verificationSteps ||
        parsed.verification ||
        parsed.nextSteps
    ),
  };
}

/* ============================================================
   LOCAL IMAGE FORENSIC SIGNALS
============================================================ */

function getImageSignature(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return "unknown";
  }

  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(
        Buffer.from([
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
        ])
      )
  ) {
    return "png";
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "jpeg";
  }

  if (
    buffer.length >= 12 &&
    buffer
      .subarray(0, 4)
      .toString() === "RIFF" &&
    buffer
      .subarray(8, 12)
      .toString() === "WEBP"
  ) {
    return "webp";
  }

  if (
    buffer.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(
      buffer.subarray(0, 6).toString()
    )
  ) {
    return "gif";
  }

  return "unknown";
}

function getPNGDimensions(buffer) {
  if (
    getImageSignature(buffer) !== "png" ||
    buffer.length < 24
  ) {
    return null;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function getJPEGDimensions(buffer) {
  if (
    getImageSignature(buffer) !== "jpeg"
  ) {
    return null;
  }

  let offset = 2;

  while (
    offset + 9 <
    buffer.length
  ) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker =
      buffer[offset + 1];

    offset += 2;

    if (
      marker === 0xd8 ||
      marker === 0xd9
    ) {
      continue;
    }

    if (
      offset + 2 >
      buffer.length
    ) {
      break;
    }

    const segmentLength =
      buffer.readUInt16BE(offset);

    if (
      segmentLength < 2 ||
      offset + segmentLength >
        buffer.length
    ) {
      break;
    }

    const isSOF =
      (marker >= 0xc0 &&
        marker <= 0xc3) ||
      (marker >= 0xc5 &&
        marker <= 0xc7) ||
      (marker >= 0xc9 &&
        marker <= 0xcb) ||
      (marker >= 0xcd &&
        marker <= 0xcf);

    if (isSOF) {
      return {
        height:
          buffer.readUInt16BE(
            offset + 3
          ),
        width:
          buffer.readUInt16BE(
            offset + 5
          ),
      };
    }

    offset += segmentLength;
  }

  return null;
}

function getImageDimensions(buffer) {
  return (
    getPNGDimensions(buffer) ||
    getJPEGDimensions(buffer) ||
    null
  );
}

function getLocalImageSignals(
  buffer,
  mimeType,
  filename
) {
  const signals = [];

  const signature =
    getImageSignature(buffer);

  const dimensions =
    getImageDimensions(buffer);

  if (signature !== "unknown") {
    signals.push(
      `Detected file signature: ${signature}.`
    );
  } else {
    signals.push(
      "The uploaded image signature could not be identified locally."
    );
  }

  if (dimensions) {
    signals.push(
      `Image dimensions: ${dimensions.width} × ${dimensions.height}.`
    );
  }

  if (mimeType) {
    signals.push(
      `Declared MIME type: ${mimeType}.`
    );
  }

  if (filename) {
    signals.push(
      `Filename: ${path.basename(filename)}.`
    );
  }

  signals.push(
    `File size: ${formatBytes(buffer.length)}.`
  );

  return signals;
}

/* ============================================================
   AI CLIENT
============================================================ */

let gemini = null;

if (GEMINI_API_KEY) {
  gemini = new GoogleGenAI({
    apiKey: GEMINI_API_KEY,
  });
}

/* ============================================================
   GEMINI HELPERS
============================================================ */

async function callGemini(
  contents,
  options = {}
) {
  if (!gemini) {
    throw new Error(
      "Gemini API is not configured."
    );
  }

  const response =
    await gemini.models.generateContent({
      model:
        options.model ||
        GEMINI_MODEL,

      contents,

      config: {
        temperature:
          options.temperature ??
          0.2,

        maxOutputTokens:
          options.maxOutputTokens ||
          1600,

        ...(GEMINI_LOCATION
          ? {
              location:
                GEMINI_LOCATION,
            }
          : {}),
      },
    });

  return response;
}

function extractGeminiText(response) {
  if (!response) return "";

  if (
    typeof response.text === "string"
  ) {
    return response.text.trim();
  }

  if (
    typeof response.text === "function"
  ) {
    try {
      return String(
        response.text()
      ).trim();
    } catch {}
  }

  const candidates =
    response.candidates;

  if (
    Array.isArray(candidates)
  ) {
    for (const candidate of candidates) {
      const parts =
        candidate?.content?.parts;

      if (!Array.isArray(parts)) {
        continue;
      }

      const text =
        parts
          .map((part) =>
            typeof part?.text === "string"
              ? part.text
              : ""
          )
          .filter(Boolean)
          .join("\n")
          .trim();

      if (text) {
        return text;
      }
    }
  }

  return "";
}

/* ============================================================
   GROQ
============================================================ */

async function callGroq(
  messages,
  options = {}
) {
  if (!GROQ_API_KEY) {
    throw new Error(
      "Groq API is not configured."
    );
  }

  const response =
    await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${GROQ_API_KEY}`,
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          model:
            options.model ||
            GROQ_MODEL,

          messages,

          temperature:
            options.temperature ??
            0.2,

          max_tokens:
            options.maxTokens ||
            GROQ_MAX_OUTPUT_TOKENS,
        }),
      },
      options.timeout ||
        REQUEST_TIMEOUT_MS
    );

  const bodyText =
    await response.text();

  let body;

  try {
    body =
      JSON.parse(bodyText);
  } catch {
    body = {
      raw: bodyText,
    };
  }

  if (!response.ok) {
    const error =
      new Error(
        body?.error?.message ||
          `Groq returned HTTP ${response.status}.`
      );

    error.status =
      response.status;

    error.providerBody =
      body;

    throw error;
  }

  return (
    body?.choices?.[0]?.message?.content ||
    ""
  ).trim();
}

async function callGroqVision(
  base64,
  mimeType,
  prompt,
  options = {}
) {
  return callGroq(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
            },
          },
        ],
      },
    ],
    options
  );
}

/* ============================================================
   FORENSIC PROMPTS
============================================================ */

const MEDIA_FORENSIC_PROMPT = `
You are TrueAegis Media Forensics AI.

Analyze the supplied image or video for potential signs of manipulation,
synthetic generation, editing, compositing, or other authenticity concerns.

This is an AI assessment, NOT definitive proof.

Return valid JSON only using this structure:

{
  "suspicion": "LOW | MEDIUM | HIGH | INCONCLUSIVE",
  "assessment": "concise overall assessment",
  "evidence": [
    "specific observable signal"
  ],
  "aiGenerationIndicators": [
    "possible synthetic-generation indicator"
  ],
  "authenticitySignals": [
    "signal that may support authenticity"
  ],
  "limitations": [
    "important limitation"
  ],
  "verificationSteps": [
    "practical independent verification step"
  ]
}

Rules:
- Do not claim certainty.
- Do not invent hidden metadata.
- Do not claim to have searched the internet unless an actual search tool was used.
- Distinguish visible observations from interpretations.
- If evidence is insufficient, use INCONCLUSIVE.
- Be technically specific but understandable.
`;

/* ============================================================
   MIME HELPERS
============================================================ */

function isImageMime(mimeType) {
  return /^image\//i.test(
    safeString(mimeType)
  );
}

function isVideoMime(mimeType) {
  return /^video\//i.test(
    safeString(mimeType)
  );
}

function normalizeMimeType(
  mimeType,
  filename = ""
) {
  const declared =
    safeString(mimeType)
      .toLowerCase();

  if (declared) {
    return declared;
  }

  const ext =
    path
      .extname(filename)
      .toLowerCase();

  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
  };

  return (
    map[ext] ||
    "application/octet-stream"
  );
}

/* ============================================================
   REQUEST MEDIA EXTRACTION
============================================================ */

function getMediaPayload(body) {
  const media =
    body?.media ||
    body?.file ||
    body?.upload ||
    {};

  const base64 =
    cleanBase64(
      body?.base64 ||
        body?.data ||
        media?.base64 ||
        media?.data ||
        body?.fileData
    );

  const mimeType =
    normalizeMimeType(
      body?.mimeType ||
        body?.type ||
        media?.mimeType ||
        media?.type,
      body?.filename ||
        media?.filename ||
        body?.name ||
        ""
    );

  const filename =
    safeString(
      body?.filename ||
        media?.filename ||
        body?.name ||
        "uploaded-media"
    );

  return {
    base64,
    mimeType,
    filename,
  };
}

function validateMediaPayload(
  base64,
  mimeType
) {
  if (!base64) {
    return {
      valid: false,
      error:
        "No media was provided.",
    };
  }

  const estimatedBytes =
    estimateBase64Bytes(
      base64
    );

  if (
    estimatedBytes <= 0
  ) {
    return {
      valid: false,
      error:
        "The uploaded media data is invalid or empty.",
    };
  }

  if (
    estimatedBytes >
    MAX_MEDIA_BYTES
  ) {
    return {
      valid: false,
      error:
        `Media exceeds the maximum allowed size of ${formatBytes(
          MAX_MEDIA_BYTES
        )}.`,
    };
  }

  if (
    !isImageMime(mimeType) &&
    !isVideoMime(mimeType)
  ) {
    return {
      valid: false,
      error:
        "Unsupported media type. Please upload an image or video.",
    };
  }

  return {
    valid: true,
    estimatedBytes,
  };
}

/* ============================================================
   GEMINI IMAGE ANALYSIS
============================================================ */

async function analyzeImageWithGemini(
  base64,
  mimeType
) {
  if (!gemini) {
    throw new Error(
      "Gemini API is not configured."
    );
  }

  const response =
    await callGemini(
      [
        {
          role: "user",
          parts: [
            {
              text:
                MEDIA_FORENSIC_PROMPT,
            },
            {
              inlineData: {
                mimeType,
                data: base64,
              },
            },
          ],
        },
      ],
      {
        temperature: 0.1,
        maxOutputTokens: 1800,
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

  return extractGeminiText(response);
}

/* ============================================================
   GEMINI VIDEO ANALYSIS
============================================================ */

async function analyzeVideoWithGemini(
  buffer,
  mimeType,
  filename
) {
  if (!gemini) {
    throw new Error(
      "Gemini API is not configured."
    );
  }

  const tempDir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "trueaegis-"
      )
    );

  const safeFilename =
    path.basename(
      filename || "uploaded-video"
    );

  const tempPath =
    path.join(
      tempDir,
      safeFilename
    );

  fs.writeFileSync(
    tempPath,
    buffer
  );

  let uploadedFile = null;

  try {
    console.log(
      `[MEDIA] Uploading video to Gemini Files API: ${safeFilename}`
    );

    uploadedFile =
      await gemini.files.upload({
        file: tempPath,
        config: {
          mimeType,
        },
      });

    if (!uploadedFile?.name) {
      throw new Error(
        "Gemini did not return an uploaded file name."
      );
    }

    console.log(
      `[MEDIA] Gemini video file uploaded: ${uploadedFile.name}`
    );

    const processingStart =
      Date.now();

    while (true) {
      const file =
        await gemini.files.get({
          name: uploadedFile.name,
        });

      const state =
        file?.state?.toString?.() ||
        file?.state;

      console.log(
        `[MEDIA] Gemini video state: ${state || "unknown"}`
      );

      if (
        state === "ACTIVE" ||
        state === "FileState.ACTIVE"
      ) {
        uploadedFile = file;
        break;
      }

      if (
        state === "FAILED" ||
        state === "FileState.FAILED"
      ) {
        throw new Error(
          "Gemini failed to process the video."
        );
      }

      if (
        Date.now() -
          processingStart >
        VIDEO_PROCESS_TIMEOUT_MS
      ) {
        const timeoutError =
          new Error(
            "Gemini video processing timed out."
          );

        timeoutError.code = 408;

        throw timeoutError;
      }

      await sleep(2000);
    }

    const videoPart =
      createPartFromUri(
        uploadedFile.uri,
        uploadedFile.mimeType ||
          mimeType
      );

    const response =
      await callGemini(
        [
          {
            role: "user",
            parts: [
              {
                text:
                  MEDIA_FORENSIC_PROMPT +
                  `\n\nThis is video media. Consider frame-to-frame consistency, temporal artifacts, object motion, lighting consistency, facial consistency, and editing indicators.`,
              },
              videoPart,
            ],
          },
        ],
        {
          temperature: 0.1,
          maxOutputTokens: 1800,
          timeout: 90000,
        }
      );

    return extractGeminiText(response);
  } finally {
    try {
      fs.rmSync(
        tempDir,
        {
          recursive: true,
          force: true,
        }
      );
    } catch {}
  }
}

/* ============================================================
   PERPLEXITY
============================================================ */

async function callPerplexity(
  messages,
  options = {}
) {
  if (!PERPLEXITY_API_KEY) {
    throw new Error(
      "Perplexity API is not configured."
    );
  }

  const response =
    await fetchWithTimeout(
      "https://api.perplexity.ai/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${PERPLEXITY_API_KEY}`,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          model:
            PERPLEXITY_MODEL,
          messages,
          temperature:
            options.temperature ?? 0.2,
          max_tokens:
            options.maxTokens || 1400,
        }),
      },
      options.timeout ||
        REQUEST_TIMEOUT_MS
    );

  const bodyText =
    await response.text();

  let body;

  try {
    body = JSON.parse(bodyText);
  } catch {
    body = {
      raw: bodyText,
    };
  }

  if (!response.ok) {
    const error =
      new Error(
        body?.error?.message ||
          `Perplexity returned HTTP ${response.status}.`
      );

    error.status =
      response.status;

    error.providerBody =
      body;

    throw error;
  }

  return (
    body?.choices?.[0]?.message?.content ||
    ""
  ).trim();
}

/* ============================================================
   AI CHAT
============================================================ */

app.post(
  "/api/ai-chat",
  async (req, res) => {
    const message =
      safeString(
        req.body?.message ||
          req.body?.query ||
          req.body?.prompt
      );

    if (!message) {
      return res.status(400).json({
        success: false,
        error:
          "Please enter a message.",
      });
    }

    console.log(
      `[AI CHAT] Incoming query: ${message.slice(
        0,
        120
      )}`
    );

    const systemPrompt = `
You are Aegis, the AI assistant inside TrueAegis.

TrueAegis is a Digital Trust Intelligence Platform.

Help users understand:
- manipulated media
- deepfakes
- misinformation
- source verification
- news credibility
- digital trust
- AI safety
- cybersecurity concepts at a safe educational level

Be concise, clear, and useful.

Never present an AI assessment as absolute proof.

If the user asks about unrelated topics, answer normally when appropriate.
`;

    /* PRIMARY: PERPLEXITY */
    try {
      if (PERPLEXITY_API_KEY) {
        const reply =
          await callPerplexity([
            {
              role: "system",
              content:
                systemPrompt,
            },
            {
              role: "user",
              content: message,
            },
          ]);

        if (reply) {
          console.log(
            "[AI CHAT] Provider: Perplexity"
          );

          return res.json({
            success: true,
            reply,
            provider: "perplexity",
          });
        }
      }
    } catch (error) {
      console.warn(
        "[AI CHAT] Perplexity failed:",
        providerError(
          "perplexity",
          error
        )
      );
    }

    /* SECONDARY: GEMINI */
    try {
      if (gemini) {
        const response =
          await callGemini([
            {
              role: "user",
              parts: [
                {
                  text:
                    `${systemPrompt}\n\nUser: ${message}`,
                },
              ],
            },
          ]);

        const reply =
          extractGeminiText(
            response
          );

        if (reply) {
          console.log(
            "[AI CHAT] Provider: Gemini fallback"
          );

          return res.json({
            success: true,
            reply,
            provider:
              "gemini-fallback",
          });
        }
      }
    } catch (error) {
      console.warn(
        "[AI CHAT] Gemini failed:",
        providerError(
          "gemini",
          error
        )
      );
    }

    /* FINAL FALLBACK: GROQ — only after Perplexity and Gemini fail */
    try {
      if (GROQ_API_KEY) {
        const reply = await callGroq([
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ]);

        if (reply) {
          console.log("[AI CHAT] Provider: Groq fallback");
          return res.json({
            success: true,
            reply,
            provider: "groq-fallback",
          });
        }
      }
    } catch (error) {
      console.warn(
        "[AI CHAT] Groq fallback failed:",
        providerError("groq", error)
      );
    }

    return res.status(503).json({
      success: false,
      error:
        "All AI providers are temporarily unavailable. Please try again.",
    });
  }
);

/* ============================================================
   CONTENT VERIFICATION
============================================================ */

app.post(
  "/api/content-verification",
  async (req, res) => {
    const mode = safeString(req.body?.mode || "content").toLowerCase();

    /* ==========================================================
       CONTENT / CLAIM VERIFICATION
       ========================================================== */
    if (mode !== "video") {
      const content = safeString(
        req.body?.content ||
          req.body?.claim ||
          req.body?.text ||
          req.body?.query
      );

      if (!content) {
        return res.status(400).json({
          success: false,
          error: "Please provide content or a claim to verify.",
        });
      }

      const prompt = `
You are TrueAegis Content Verification AI.

Your job is to examine claims, statements, and information — NOT to perform media/deepfake detection.

Analyze the following content carefully.

Do not automatically assume it is true or false.

Identify:
- the main factual claims
- what appears supported, unsupported, or uncertain
- potentially misleading wording
- missing context
- what evidence would be useful
- practical independent verification steps

Important:
- Do not invent sources, evidence, or facts.
- Clearly distinguish the claim from what is actually established.
- AI analysis is an assessment, not definitive proof.

Content to verify:
${content}

${safeString(req.body?.instruction)}
`;

      try {
        if (gemini) {
          const response = await callGemini([
            {
              role: "user",
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ]);

          const text =
            extractGeminiText(response);

          if (text) {
            return res.json({
              success: true,
              result: text,
              provider: "gemini",
            });
          }
        }
      } catch (error) {
        console.warn(
          "[CONTENT VERIFICATION] Gemini failed:",
          providerError("gemini", error)
        );
      }

      try {
        if (PERPLEXITY_API_KEY) {
          const result =
            await callPerplexity([
              {
                role: "system",
                content:
                  "You are TrueAegis Content Verification AI. Provide careful, source-aware analysis. Do not invent facts or sources.",
              },
              {
                role: "user",
                content: prompt,
              },
            ]);

          if (result) {
            return res.json({
              success: true,
              result,
              provider:
                "perplexity",
            });
          }
        }
      } catch (error) {
        console.warn(
          "[CONTENT VERIFICATION] Perplexity failed:",
          providerError(
            "perplexity",
            error
          )
        );
      }

      try {
        if (GROQ_API_KEY) {
          const result =
            await callGroq([
              {
                role: "system",
                content:
                  "You are TrueAegis Content Verification AI. Provide careful, source-aware analysis. Do not invent facts or sources.",
              },
              {
                role: "user",
                content: prompt,
              },
            ]);

          if (result) {
            return res.json({
              success: true,
              result,
              provider:
                "groq",
            });
          }
        }
      } catch (error) {
        console.warn(
          "[CONTENT VERIFICATION] Groq failed:",
          providerError(
            "groq",
            error
          )
        );
      }

      return res.status(503).json({
        success: false,
        error:
          "All verification AI providers are temporarily unavailable.",
      });
    }

    /* ==========================================================
       VIDEO CLAIM / CONTEXT VERIFICATION
       ========================================================== */

    const videoContext =
      safeString(
        req.body?.content ||
          req.body?.claim ||
          req.body?.text ||
          req.body?.query
      );

    if (!videoContext) {
      return res.status(400).json({
        success: false,
        error:
          "Please provide the video context or claim to verify.",
      });
    }

    const videoPrompt = `
You are TrueAegis Video Context Verification AI.

Analyze the provided description or claim associated with a video.

Do not perform deepfake detection here.

Instead assess:
- factual claims
- missing context
- potentially misleading statements
- what would need independent verification
- practical verification steps

Do not invent sources or evidence.

AI analysis is an assessment, not definitive proof.

Video context / claim:
${videoContext}
`;

    try {
      if (gemini) {
        const response =
          await callGemini([
            {
              role: "user",
              parts: [
                {
                  text:
                    videoPrompt,
                },
              ],
            },
          ]);

        const result =
          extractGeminiText(
            response
          );

        if (result) {
          return res.json({
            success: true,
            result,
            provider:
              "gemini",
          });
        }
      }
    } catch (error) {
      console.warn(
        "[VIDEO CONTENT VERIFICATION] Gemini failed:",
        providerError(
          "gemini",
          error
        )
      );
    }

    try {
      if (PERPLEXITY_API_KEY) {
        const result =
          await callPerplexity([
            {
              role: "system",
              content:
                "You are TrueAegis Video Context Verification AI. Do not invent facts or sources.",
            },
            {
              role: "user",
              content:
                videoPrompt,
            },
          ]);

        if (result) {
          return res.json({
            success: true,
            result,
            provider:
              "perplexity",
          });
        }
      }
    } catch (error) {
      console.warn(
        "[VIDEO CONTENT VERIFICATION] Perplexity failed:",
        providerError(
          "perplexity",
          error
        )
      );
    }

    try {
      if (GROQ_API_KEY) {
        const result =
          await callGroq([
            {
              role: "system",
              content:
                "You are TrueAegis Video Context Verification AI. Do not invent facts or sources.",
            },
            {
              role: "user",
              content:
                videoPrompt,
            },
          ]);

        if (result) {
          return res.json({
            success: true,
            result,
            provider:
              "groq",
          });
        }
      }
    } catch (error) {
      console.warn(
        "[VIDEO CONTENT VERIFICATION] Groq failed:",
        providerError(
          "groq",
          error
        )
      );
    }

    return res.status(503).json({
      success: false,
      error:
        "All verification AI providers are temporarily unavailable.",
    });
  }
);

/* ============================================================
   NEWS ANALYSIS
============================================================ */

app.post(
  "/api/news-analysis",
  async (req, res) => {
    const query =
      safeString(
        req.body?.query ||
          req.body?.topic ||
          req.body?.headline ||
          req.body?.content
      );

    if (!query) {
      return res.status(400).json({
        success: false,
        error:
          "Please enter a news topic, headline, or claim.",
      });
    }

    const prompt = `
You are the TrueAegis News Analysis AI.

Analyze the user's news topic or claim.

Important:
- Do not invent articles, sources, events, dates, quotes, or facts.
- Clearly distinguish known information from uncertainty.
- If you cannot independently verify a claim, say so.
- Do not present AI output as definitive proof.
- Give practical steps for checking the claim using reputable independent sources.

Analyze:
${query}

Return a concise but useful analysis with:
1. Main claim/topic
2. What can be established
3. Important context
4. Uncertainty or limitations
5. Verification steps
`;

    /* PRIMARY: PERPLEXITY */
    try {
      if (PERPLEXITY_API_KEY) {
        const result =
          await callPerplexity([
            {
              role: "system",
              content:
                "You are TrueAegis News Analysis AI. Be factual, careful, and transparent about uncertainty.",
            },
            {
              role: "user",
              content:
                prompt,
            },
          ]);

        if (result) {
          return res.json({
            success: true,
            analysis: result,
            result,
            provider:
              "perplexity",
          });
        }
      }
    } catch (error) {
      console.warn(
        "[NEWS] Perplexity failed:",
        providerError(
          "perplexity",
          error
        )
      );
    }

    /* SECONDARY: GEMINI */
    try {
      if (gemini) {
        const response =
          await callGemini([
            {
              role: "user",
              parts: [
                {
                  text:
                    prompt,
                },
              ],
            },
          ]);

        const result =
          extractGeminiText(
            response
          );

        if (result) {
          return res.json({
            success: true,
            analysis: result,
            result,
            provider:
              "gemini",
          });
        }
      }
    } catch (error) {
      console.warn(
        "[NEWS] Gemini failed:",
        providerError(
          "gemini",
          error
        )
      );
    }

    /* FINAL FALLBACK: GROQ */
    try {
      if (GROQ_API_KEY) {
        const result =
          await callGroq([
            {
              role: "system",
              content:
                "You are TrueAegis News Analysis AI. Be factual, careful, and transparent about uncertainty.",
            },
            {
              role: "user",
              content:
                prompt,
            },
          ]);

        if (result) {
          return res.json({
            success: true,
            analysis: result,
            result,
            provider:
              "groq",
          });
        }
      }
    } catch (error) {
      console.warn(
        "[NEWS] Groq failed:",
        providerError(
          "groq",
          error
        )
      );
    }

    return res.status(503).json({
      success: false,
      error:
        "No analysis was returned because all AI providers are temporarily unavailable.",
    });
  }
);

/* ============================================================
   MEDIA ANALYSIS
============================================================ */

app.post(
  "/api/media-analysis",
  async (req, res) => {
    try {
      const {
        base64,
        mimeType,
        filename,
      } = getMediaPayload(req.body);

      const validation =
        validateMediaPayload(
          base64,
          mimeType
        );

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error:
            validation.error,
        });
      }

      const buffer =
        Buffer.from(
          base64,
          "base64"
        );

      if (!buffer.length) {
        return res.status(400).json({
          success: false,
          error:
            "The uploaded media could not be decoded.",
        });
      }

      const actualSignature =
        isImageMime(mimeType)
          ? getImageSignature(buffer)
          : "video";

      console.log(
        `[MEDIA] Received ${filename} | ${mimeType} | ${formatBytes(
          buffer.length
        )} | signature=${actualSignature}`
      );

      const localSignals =
        isImageMime(mimeType)
          ? getLocalImageSignals(
              buffer,
              mimeType,
              filename
            )
          : [
              `Declared MIME type: ${mimeType}.`,
              `Filename: ${path.basename(filename)}.`,
              `File size: ${formatBytes(buffer.length)}.`,
            ];

      /* ======================================================
         IMAGE ANALYSIS
      ====================================================== */

      if (isImageMime(mimeType)) {
        /* PRIMARY: GEMINI */
        try {
          if (gemini) {
            const raw =
              await analyzeImageWithGemini(
                base64,
                mimeType
              );

            const report =
              normalizeReport(
                raw
              );

            report.evidence =
              [
                ...localSignals,
                ...report.evidence,
              ].slice(0, 10);

            return res.json({
              success: true,
              report,
              analysis: report,
              provider:
                "gemini",
              mediaType:
                "image",
            });
          }
        } catch (error) {
          console.warn(
            "[MEDIA] Gemini image analysis failed:",
            providerError(
              "gemini",
              error
            )
          );
        }

        /* SECONDARY: PERPLEXITY */
        try {
          if (PERPLEXITY_API_KEY) {
            const result =
              await callPerplexity([
                {
                  role: "system",
                  content:
                    "You are a careful digital-media verification assistant. Do not claim certainty from visual analysis alone.",
                },
                {
                  role: "user",
                  content:
                    `${MEDIA_FORENSIC_PROMPT}\n\nLocal signals:\n${localSignals.join(
                      "\n"
                    )}\n\nThe uploaded image could not be analyzed by the primary vision provider. Provide a cautious assessment based only on the supplied local signals and explain the limitation.`,
                },
              ]);

            if (result) {
              const report =
                normalizeReport(
                  result
                );

              report.evidence =
                [
                  ...localSignals,
                  ...report.evidence,
                ].slice(0, 10);

              return res.json({
                success: true,
                report,
                analysis:
                  report,
                provider:
                  "perplexity-fallback",
                mediaType:
                  "image",
              });
            }
          }
        } catch (error) {
          console.warn(
            "[MEDIA] Perplexity image fallback failed:",
            providerError(
              "perplexity",
              error
            )
          );
        }

        /* FINAL: GROQ VISION */
        try {
          if (GROQ_API_KEY) {
            const result =
              await callGroqVision(
                base64,
                mimeType,
                `${MEDIA_FORENSIC_PROMPT}\n\nLocal signals:\n${localSignals.join(
                  "\n"
                )}`,
                {
                  maxTokens: 1800,
                  timeout:
                    REQUEST_TIMEOUT_MS,
                }
              );

            if (result) {
              const report =
                normalizeReport(
                  result
                );

              report.evidence =
                [
                  ...localSignals,
                  ...report.evidence,
                ].slice(0, 10);

              return res.json({
                success: true,
                report,
                analysis:
                  report,
                provider:
                  "groq-vision-fallback",
                mediaType:
                  "image",
              });
            }
          }
        } catch (error) {
          console.warn(
            "[MEDIA] Groq Vision fallback failed:",
            providerError(
              "groq",
              error
            )
          );
        }

        return res.status(503).json({
          success: false,
          error:
            "All image analysis providers are temporarily unavailable.",
          localSignals,
        });
      }

      /* ======================================================
         VIDEO ANALYSIS
      ====================================================== */

      if (isVideoMime(mimeType)) {
        try {
          if (gemini) {
            const raw =
              await analyzeVideoWithGemini(
                buffer,
                mimeType,
                filename
              );

            const report =
              normalizeReport(
                raw
              );

            report.evidence =
              [
                ...localSignals,
                ...report.evidence,
              ].slice(0, 10);

            return res.json({
              success: true,
              report,
              analysis:
                report,
              provider:
                "gemini",
              mediaType:
                "video",
            });
          }
        } catch (error) {
          console.warn(
            "[MEDIA] Gemini video analysis failed:",
            providerError(
              "gemini",
              error
            )
          );
        }

        /* PERPLEXITY FALLBACK */
        try {
          if (PERPLEXITY_API_KEY) {
            const result =
              await callPerplexity([
                {
                  role: "system",
                  content:
                    "You are a careful digital-media verification assistant. Do not claim certainty from unavailable visual evidence.",
                },
                {
                  role: "user",
                  content:
                    `${MEDIA_FORENSIC_PROMPT}\n\nThe uploaded video could not be processed by the primary video-analysis provider. The following file information is available:\n${localSignals.join(
                      "\n"
                    )}\n\nProvide a cautious assessment and clearly explain the limitation.`,
                },
              ]);

            if (result) {
              const report =
                normalizeReport(
                  result
                );

              report.evidence =
                [
                  ...localSignals,
                  ...report.evidence,
                ].slice(0, 10);

              return res.json({
                success: true,
                report,
                analysis:
                  report,
                provider:
                  "perplexity-fallback",
                mediaType:
                  "video",
              });
            }
          }
        } catch (error) {
          console.warn(
            "[MEDIA] Perplexity video fallback failed:",
            providerError(
              "perplexity",
              error
            )
          );
        }

        return res.status(503).json({
          success: false,
          error:
            "Video analysis is temporarily unavailable. Please try again.",
          localSignals,
        });
      }

      return res.status(400).json({
        success: false,
        error:
          "Unsupported media type.",
      });
    } catch (error) {
      console.error(
        "[MEDIA] Unexpected error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "An unexpected error occurred during media analysis.",
      });
    }
  }
);

/* ============================================================
   VIDEO VERIFICATION ALIAS
============================================================ */

app.post(
  "/api/video-verification",
  async (req, res) => {
    try {
      const body = {
        ...req.body,
      };

      if (
        !body.mimeType &&
        body.type
      ) {
        body.mimeType =
          body.type;
      }

      req.body = body;

      return app._router.handle(
        {
          ...req,
          url: "/api/media-analysis",
          originalUrl:
            "/api/media-analysis",
          method: "POST",
        },
        res,
        () => {
          if (!res.headersSent) {
            res.status(404).json({
              success: false,
              error:
                "Media analysis endpoint not found.",
            });
          }
        }
      );
    } catch (error) {
      console.error(
        "[VIDEO VERIFICATION] Error:",
        error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          error:
            "Video verification failed.",
        });
      }
    }
  }
);

/* ============================================================
   GENERIC ANALYZE ALIAS
============================================================ */

app.post(
  "/api/analyze",
  async (req, res) => {
    try {
      const {
        base64,
        mimeType,
        filename,
      } = getMediaPayload(req.body);

      if (
        base64 &&
        (
          isImageMime(mimeType) ||
          isVideoMime(mimeType)
        )
      ) {
        const validation =
          validateMediaPayload(
            base64,
            mimeType
          );

        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            error:
              validation.error,
          });
        }

        const buffer =
          Buffer.from(
            base64,
            "base64"
          );

        if (
          isImageMime(mimeType) &&
          gemini
        ) {
          try {
            const raw =
              await analyzeImageWithGemini(
                base64,
                mimeType
              );

            const report =
              normalizeReport(
                raw
              );

            return res.json({
              success: true,
              report,
              analysis:
                report,
              provider:
                "gemini",
              mediaType:
                "image",
            });
          } catch {}
        }

        if (
          isVideoMime(mimeType) &&
          gemini
        ) {
          try {
            const raw =
              await analyzeVideoWithGemini(
                buffer,
                mimeType,
                filename
              );

            const report =
              normalizeReport(
                raw
              );

            return res.json({
              success: true,
              report,
              analysis:
                report,
              provider:
                "gemini",
              mediaType:
                "video",
            });
          } catch {}
        }
      }

      const text =
        safeString(
          req.body?.text ||
            req.body?.content ||
            req.body?.query ||
            req.body?.prompt
        );

      if (!text) {
        return res.status(400).json({
          success: false,
          error:
            "Please provide text or media to analyze.",
        });
      }

      const result =
        await generateTextAI(
          text
        );

      return res.json({
        success: true,
        result,
      });
    } catch (error) {
      console.error(
        "[ANALYZE] Error:",
        error
      );

      return res.status(503).json({
        success: false,
        error:
          "Analysis is temporarily unavailable.",
      });
    }
  }
);

/* ============================================================
   TEXT AI HELPERS
============================================================ */

async function generateTextAI(
  prompt,
  options = {}
) {
  const errors = [];

  /* PERPLEXITY */
  try {
    if (PERPLEXITY_API_KEY) {
      const result =
        await callPerplexity(
          [
            {
              role: "system",
              content:
                "You are a careful AI assistant inside TrueAegis. Do not invent facts or sources.",
            },
            {
              role: "user",
              content:
                prompt,
            },
          ],
          options
        );

      if (result) {
        return {
          text: result,
          provider:
            "perplexity",
        };
      }
    }
  } catch (error) {
    errors.push(
      providerError(
        "perplexity",
        error
      )
    );
  }

  /* GEMINI */
  try {
    if (gemini) {
      const response =
        await callGemini(
          [
            {
              role: "user",
              parts: [
                {
                  text:
                    prompt,
                },
              ],
            },
          ],
          options
        );

      const result =
        extractGeminiText(
          response
        );

      if (result) {
        return {
          text: result,
          provider:
            "gemini",
        };
      }
    }
  } catch (error) {
    errors.push(
      providerError(
        "gemini",
        error
      )
    );
  }

  /* GROQ */
  try {
    if (GROQ_API_KEY) {
      const result =
        await callGroq(
          [
            {
              role: "system",
              content:
                "You are a careful AI assistant inside TrueAegis. Do not invent facts or sources.",
            },
            {
              role: "user",
              content:
                prompt,
            },
          ],
          options
        );

      if (result) {
        return {
          text: result,
          provider:
            "groq",
        };
      }
    }
  } catch (error) {
    errors.push(
      providerError(
        "groq",
        error
      )
    );
  }

  const error =
    new Error(
      "All text AI providers failed."
    );

  error.providers =
    errors;

  throw error;
}

async function generateChatAI(
  messages,
  options = {}
) {
  const errors = [];

  /* PERPLEXITY */
  try {
    if (PERPLEXITY_API_KEY) {
      const result =
        await callPerplexity(
          messages,
          options
        );

      if (result) {
        return {
          text: result,
          provider:
            "perplexity",
        };
      }
    }
  } catch (error) {
    errors.push(
      providerError(
        "perplexity",
        error
      )
    );
  }

  /* GEMINI */
  try {
    if (gemini) {
      const converted =
        messages.map(
          (message) => ({
            role:
              message.role ===
              "assistant"
                ? "model"
                : "user",
            parts: [
              {
                text:
                  safeString(
                    message.content
                  ),
              },
            ],
          })
        );

      const response =
        await callGemini(
          converted,
          options
        );

      const result =
        extractGeminiText(
          response
        );

      if (result) {
        return {
          text: result,
          provider:
            "gemini",
        };
      }
    }
  } catch (error) {
    errors.push(
      providerError(
        "gemini",
        error
      )
    );
  }

  /* GROQ */
  try {
    if (GROQ_API_KEY) {
      const result =
        await callGroq(
          messages,
          options
        );

      if (result) {
        return {
          text: result,
          provider:
            "groq",
        };
      }
    }
  } catch (error) {
    errors.push(
      providerError(
        "groq",
        error
      )
    );
  }

  const error =
    new Error(
      "All chat AI providers failed."
    );

  error.providers =
    errors;

  throw error;
}

/* ============================================================
   REQUEST TEXT / MESSAGE HELPERS
============================================================ */

function getRequestText(req) {
  return safeString(
    req.body?.message ||
      req.body?.text ||
      req.body?.content ||
      req.body?.query ||
      req.body?.prompt
  );
}

function getMessages(req) {
  if (
    Array.isArray(
      req.body?.messages
    )
  ) {
    return req.body.messages
      .map((message) => ({
        role:
          message?.role ===
          "assistant"
            ? "assistant"
            : "user",
        content:
          safeString(
            message?.content
          ),
      }))
      .filter(
        (message) =>
          message.content
      );
  }

  const text =
    getRequestText(req);

  if (!text) {
    return [];
  }

  return [
    {
      role: "user",
      content: text,
    },
  ];
}

/* ============================================================
   AUTH ROUTES
============================================================ */

app.use(
  "/api/auth",
  authRoutes
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
  "/api/health",
  async (req, res) => {
    const mongoState =
      mongoose.connection.readyState;

    return res.json({
      success: true,
      status: "ok",
      service:
        "TrueAegis",
      environment:
        process.env.NODE_ENV ||
        "development",
      timestamp:
        new Date().toISOString(),
      uptime:
        process.uptime(),
      node:
        process.version,
      mongo:
        mongoState === 1
          ? "connected"
          : mongoState === 2
          ? "connecting"
          : "disconnected",
      ai: {
        gemini:
          Boolean(
            GEMINI_API_KEY
          ),
        perplexity:
          Boolean(
            PERPLEXITY_API_KEY
          ),
        groq:
          Boolean(
            GROQ_API_KEY
          ),
        geminiModel:
          GEMINI_MODEL,
        perplexityModel:
          PERPLEXITY_MODEL,
        groqModel:
          GROQ_MODEL,
      },
      config: {
        maxMediaBytes:
          MAX_MEDIA_BYTES,
        requestTimeoutMs:
          REQUEST_TIMEOUT_MS,
        videoProcessTimeoutMs:
          VIDEO_PROCESS_TIMEOUT_MS,
        baseUrl:
          BASE_URL,
      },
    });
  }
);

/* ============================================================
   API INFORMATION
============================================================ */

app.get(
  "/api",
  (req, res) => {
    res.json({
      success: true,
      name:
        "TrueAegis API",
      version:
        "1.0.0",
      description:
        "Digital Trust Intelligence Platform API.",
      endpoints: [
        "/api/health",
        "/api/auth",
        "/api/ai-chat",
        "/api/content-verification",
        "/api/news-analysis",
        "/api/media-analysis",
        "/api/video-verification",
        "/api/analyze",
      ],
    });
  }
);

/* ============================================================
   ROBOTS.TXT
============================================================ */

app.get(
  "/robots.txt",
  (req, res) => {
    res
      .type("text/plain")
      .send(
        [
          "User-agent: *",
          "Allow: /",
          "",
          `Sitemap: ${BASE_URL}/sitemap.xml`,
        ].join("\n")
      );
  }
);

/* ============================================================
   SITEMAP.XML
============================================================ */

app.get(
  "/sitemap.xml",
  (req, res) => {
    const pages = [
      "",
      "/services",
      "/security",
      "/dragon",
    ];

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      pages
        .map(
          (page) =>
            `<url><loc>${BASE_URL}${page}</loc></url>`
        )
        .join("") +
      `</urlset>`;

    res
      .type("application/xml")
      .send(xml);
  }
);

/* ============================================================
   STATIC FRONTEND
============================================================ */

const publicDir =
  path.join(
    __dirname,
    "public"
  );

console.log(
  `[STATIC] Public directory: ${publicDir}`
);

app.use(
  express.static(
    publicDir,
    {
      extensions: [
        "html",
      ],
      index:
        "index.html",
      maxAge:
        process.env.NODE_ENV ===
        "production"
          ? "1d"
          : 0,
    }
  )
);

/* ============================================================
   FRONTEND PAGE ROUTES
============================================================ */

const frontendPages = {
  "/":
    "index.html",

  "/login":
    "login.html",

  "/register":
    "register.html",

  "/dashboard":
    "dashboard.html",

  "/services":
    "services.html",

  "/security":
    "security.html",

  "/dragon":
    "dragon.html",
};

for (
  const [
    route,
    file
  ] of Object.entries(
    frontendPages
  )
) {
  app.get(
    route,
    (req, res, next) => {
      const filePath =
        path.join(
          publicDir,
          file
        );

      if (
        fs.existsSync(
          filePath
        )
      ) {
        return res.sendFile(
          filePath
        );
      }

      next();
    }
  );
}

/* ============================================================
   SPA FALLBACK
============================================================ */

app.get(
  "/{*splat}",
  (req, res, next) => {
    if (
      req.path.startsWith("/api/")
    ) {
      return next();
    }

    const indexPath =
      path.join(
        publicDir,
        "index.html"
      );

    if (
      fs.existsSync(indexPath)
    ) {
      return res.sendFile(indexPath);
    }

    next();
  }
);
/* ============================================================
   404 HANDLER
============================================================ */

app.use(
  (req, res) => {
    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return res.status(404).json({
        success: false,
        error:
          "API endpoint not found.",
      });
    }

    res.status(404).send(
      "Page not found."
    );
  }
);

/* ============================================================
   GLOBAL ERROR HANDLER
============================================================ */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "[GLOBAL ERROR]",
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    const status =
      Number(
        error?.status ||
          error?.statusCode ||
          500
      );

    res.status(
      status >= 400 &&
      status < 600
        ? status
        : 500
    ).json({
      success: false,
      error:
        process.env.NODE_ENV ===
        "production"
          ? "An internal server error occurred."
          : safeString(
              error?.message,
              "An internal server error occurred."
            ),
    });
  }
);

/* ============================================================
   DATABASE + SERVER START
============================================================ */

let server = null;

async function startServer() {
  if (!MONGODB_URI) {
    console.warn(
      "[MONGO] MONGODB_URI is not configured. Starting without MongoDB."
    );
  } else {
    try {
      await mongoose.connect(
        MONGODB_URI,
        {
          serverSelectionTimeoutMS:
            10000,
        }
      );

      console.log(
        "[MONGO] Connected successfully."
      );
    } catch (error) {
      console.error(
        "[MONGO] Initial connection failed:",
        error
      );

      if (
        process.env.NODE_ENV ===
        "production"
      ) {
        throw error;
      }
    }
  }

  server =
    app.listen(
      PORT,
      HOST,
      () => {
        console.log(
          `[SERVER] TrueAegis running on ${BASE_URL}`
        );

        console.log(
          `[SERVER] Environment: ${
            process.env.NODE_ENV ||
            "development"
          }`
        );

        console.log(
          `[SERVER] Node: ${process.version}`
        );

        console.log(
          `[SERVER] Gemini: ${
            GEMINI_API_KEY
              ? "configured"
              : "not configured"
          }`
        );

        console.log(
          `[SERVER] Perplexity: ${
            PERPLEXITY_API_KEY
              ? "configured"
              : "not configured"
          }`
        );

        console.log(
          `[SERVER] Groq: ${
            GROQ_API_KEY
              ? "configured"
              : "not configured"
          }`
        );
      }
    );
}

async function shutdown(
  signal
) {
  console.log(
    `[SERVER] Received ${signal}. Shutting down...`
  );

  if (server) {
    await new Promise(
      (resolve) =>
        server.close(
          resolve
        )
    );
  }

  try {
    await mongoose.connection.close();
  } catch {}

  process.exit(0);
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[PROCESS] Unhandled rejection:",
      reason
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[PROCESS] Uncaught exception:",
      error
    );
  }
);

startServer().catch(
  (error) => {
    console.error(
      "[SERVER] Fatal startup error:",
      error
    );

    process.exit(1);
  }
);

module.exports = app;