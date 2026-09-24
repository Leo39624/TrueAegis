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
  createUserContent
} = require("@google/genai");

const authRoutes = require("./routes/auth");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "development";

const MONGODB_URI = process.env.MONGODB_URI || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash";

const PERPLEXITY_API_KEY =
  process.env.PERPLEXITY_API_KEY || "";

const PERPLEXITY_MODEL =
  process.env.PERPLEXITY_MODEL ||
  "sonar";

const GROQ_API_KEY =
  process.env.GROQ_API_KEY || "";

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  "qwen/qwen3-32b";

const REQUEST_TIMEOUT_MS =
  Number(process.env.REQUEST_TIMEOUT_MS) ||
  90000;

const MEDIA_TIMEOUT_MS =
  Number(process.env.MEDIA_TIMEOUT_MS) ||
  150000;

const VIDEO_PROCESS_TIMEOUT_MS =
  Number(process.env.VIDEO_PROCESS_TIMEOUT_MS) ||
  240000;

const VIDEO_POLL_INTERVAL_MS =
  Number(process.env.VIDEO_POLL_INTERVAL_MS) ||
  4000;

const MAX_MEDIA_BYTES =
  Number(process.env.MAX_MEDIA_BYTES) ||
  18 * 1024 * 1024;

const PUBLIC_DIR =
  path.join(__dirname, "public");

let gemini = null;

if (GEMINI_API_KEY) {
  try {
    gemini = new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    });

    console.log("[AI] Gemini initialized");
  } catch (error) {
    console.error(
      "[AI] Gemini initialization failed:",
      error.message
    );
  }
} else {
  console.warn("[AI] GEMINI_API_KEY missing");
}

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With"
    ]
  })
);

app.use(
  express.json({
    limit: "50mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb"
  })
);

app.use(cookieParser());

function safeString(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value)
    .replace(/\u0000/g, "")
    .trim();
}

function safeDisplay(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value)
      .replace(/\u0000/g, "")
      .trim();
  }

  if (Array.isArray(value)) {
    return value
      .map(item => safeDisplay(item))
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value === "object") {
    const preferred =
      value.summary ??
      value.description ??
      value.message ??
      value.text ??
      value.value ??
      value.label ??
      value.title;

    if (preferred !== undefined) {
      return safeDisplay(preferred, fallback);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

function cleanBase64(value) {
  return String(value || "")
    .replace(/^data:[^,]+,/, "")
    .replace(/\s/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
}

function stripCodeFences(value) {
  return safeString(value)
    .replace(
      /^```(?:json|javascript|js|text)?\s*/i,
      ""
    )
    .replace(/\s*```$/i, "")
    .trim();
}

function safeJsonParse(value) {
  const text = stripCodeFences(value);

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (
      start !== -1 &&
      end > start
    ) {
      try {
        return JSON.parse(
          text.slice(start, end + 1)
        );
      } catch {}
    }

    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(
      bytes /
      (1024 * 1024)
    ).toFixed(1)} MB`;
  }

  return `${(
    bytes /
    (1024 * 1024 * 1024)
  ).toFixed(1)} GB`;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeout = REQUEST_TIMEOUT_MS
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (
      error?.name === "AbortError"
    ) {
      const timeoutError = new Error(
        `Request timed out after ${timeout}ms`
      );

      timeoutError.code = 408;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout(
  promise,
  timeout
) {
  let timer;

  const timeoutPromise =
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Operation timed out after ${timeout}ms`
        );

        error.code = 408;

        reject(error);
      }, timeout);
    });

  try {
    return await Promise.race([
      promise,
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function extractGeminiText(response) {
  if (!response) {
    return "";
  }

  if (
    typeof response.text === "string"
  ) {
    return response.text.trim();
  }

  if (
    typeof response.text === "function"
  ) {
    try {
      const text = response.text();

      if (
        typeof text === "string"
      ) {
        return text.trim();
      }
    } catch {}
  }

  const candidates =
    response.candidates ||
    response.response?.candidates ||
    [];

  for (const candidate of candidates) {
    const parts =
      candidate?.content?.parts ||
      [];

    const text = parts
      .map(part => part?.text || "")
      .join("")
      .trim();

    if (text) {
      return text;
    }
  }

  return "";
}

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
    await withTimeout(
      gemini.models.generateContent({
        model:
          options.model ||
          GEMINI_MODEL,
        contents,
        config: {
          temperature:
            options.temperature ?? 0.2,
          maxOutputTokens:
            options.maxOutputTokens || 1800
        }
      }),
      options.timeout ||
        REQUEST_TIMEOUT_MS
    );

  const text =
    extractGeminiText(response);

  if (!text) {
    throw new Error(
      "Gemini returned an empty response."
    );
  }

  return text;
}

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
            "application/json"
        },
        body: JSON.stringify({
          model:
            options.model ||
            PERPLEXITY_MODEL,
          messages,
          temperature:
            options.temperature ?? 0.2,
          max_tokens:
            options.maxTokens || 1800
        })
      },
      options.timeout ||
        REQUEST_TIMEOUT_MS
    );

  const raw = await response.text();

  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message ||
      `Perplexity returned HTTP ${response.status}.`
    );

    error.status =
      response.status;

    throw error;
  }

  const text =
    body?.choices?.[0]?.message?.content;

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    throw new Error(
      "Perplexity returned an empty response."
    );
  }

  return text.trim();
}

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
            "application/json"
        },
        body: JSON.stringify({
          model:
            options.model ||
            GROQ_MODEL,
          messages,
          temperature:
            options.temperature ?? 0.2,
          max_tokens:
            options.maxTokens || 1800
        })
      },
      options.timeout ||
        REQUEST_TIMEOUT_MS
    );

  const raw = await response.text();

  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message ||
      `Groq returned HTTP ${response.status}.`
    );

    error.status =
      response.status;

    throw error;
  }

  const text =
    body?.choices?.[0]?.message?.content;

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    throw new Error(
      "Groq returned an empty response."
    );
  }

  return text.trim();
}

async function callGroqVision(
  imageBase64,
  mimeType,
  messages,
  options = {}
) {
  if (!GROQ_API_KEY) {
    throw new Error(
      "Groq API is not configured."
    );
  }

  const clean =
    cleanBase64(imageBase64);

  const userMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          messages?.[1]?.content ||
          messages?.[0]?.content ||
          "Analyze this image for signs of manipulation."
      },
      {
        type: "image_url",
        image_url: {
          url:
            `data:${mimeType};base64,${clean}`
        }
      }
    ]
  };

  const response =
    await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${GROQ_API_KEY}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          model:
            options.model ||
            GROQ_MODEL,
          messages: [
            {
              role: "system",
              content:
                messages?.[0]?.role ===
                "system"
                  ? messages[0].content
                  : "Analyze the supplied media carefully and return a structured forensic assessment."
            },
            userMessage
          ],
          temperature:
            options.temperature ?? 0.15,
          max_tokens:
            options.maxTokens || 1800
        })
      },
      options.timeout ||
        MEDIA_TIMEOUT_MS
    );

  const raw = await response.text();

  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message ||
      `Groq vision returned HTTP ${response.status}.`
    );

    error.status =
      response.status;

    throw error;
  }

  const text =
    body?.choices?.[0]?.message?.content;

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    throw new Error(
      "Groq vision returned an empty response."
    );
  }

  return text.trim();
}

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

function inferMimeType(filename) {
  const ext =
    path
      .extname(
        safeString(filename)
      )
      .toLowerCase();

  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska"
  };

  return (
    map[ext] ||
    "application/octet-stream"
  );
}

function bufferFromValue(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (
    value instanceof Uint8Array
  ) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    try {
      return Buffer.from(
        cleanBase64(value),
        "base64"
      );
    } catch {
      return null;
    }
  }

  return null;
}

function mediaBufferFromRequest(req) {
  const body = req.body || {};

  const possibleValues = [
    body.buffer,
    body.data,
    body.base64,
    body.file,
    body.media
  ];

  for (
    const value of possibleValues
  ) {
    const buffer =
      bufferFromValue(value);

    if (
      buffer &&
      buffer.length
    ) {
      return buffer;
    }
  }

  return null;
}

function mediaTypeFromRequest(req) {
  const body = req.body || {};

  return (
    safeString(
      body.mimeType ||
      body.type ||
      body.mimetype
    ) ||
    inferMimeType(
      body.filename ||
      body.name ||
      ""
    )
  );
}

function detectImageSignature(buffer) {
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
          0x0a
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
    buffer.length >= 6 &&
    (
      buffer
        .subarray(0, 6)
        .toString("ascii") ===
      "GIF87a" ||
      buffer
        .subarray(0, 6)
        .toString("ascii") ===
      "GIF89a"
    )
  ) {
    return "gif";
  }

  if (
    buffer.length >= 12 &&
    buffer
      .subarray(0, 4)
      .toString("ascii") ===
      "RIFF" &&
    buffer
      .subarray(8, 12)
      .toString("ascii") ===
      "WEBP"
  ) {
    return "webp";
  }

  return "unknown";
}

function validateMediaSignature(
  buffer,
  mimeType
) {
  const signature =
    detectImageSignature(buffer);

  if (!isImageMime(mimeType)) {
    return {
      ok: true,
      signature: "video"
    };
  }

  const expected = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp"
  }[mimeType];

  if (
    signature === "unknown"
  ) {
    return {
      ok: true,
      signature,
      warning:
        "The image signature could not be identified."
    };
  }

  if (
    expected &&
    signature !== expected
  ) {
    return {
      ok: false,
      signature,
      error:
        "The uploaded file does not match its declared image type."
    };
  }

  return {
    ok: true,
    signature
  };
}

function localImageSignals(
  buffer,
  signature
) {
  const size =
    buffer?.length || 0;

  return {
    byteSize: size,
    readableSize:
      formatBytes(size),
    signature:
      signature || "unknown",
    suspiciousExtensionMismatch:
      false,
    notes: [
      "Local checks are supporting signals only.",
      "They do not establish whether an image is authentic or manipulated."
    ]
  };
}

function localVideoSignals(
  buffer,
  filename
) {
  const size =
    buffer?.length || 0;

  return {
    byteSize: size,
    readableSize:
      formatBytes(size),
    filename:
      safeString(filename),
    notes: [
      "The server performed basic file-level checks.",
      "Visual authenticity requires AI media analysis."
    ]
  };
}

const FORENSIC_SYSTEM =
  `You are TrueAegis forensic analysis AI.

Analyze supplied media carefully.

Your job is to identify observable indicators that may be consistent with:
- manipulation
- synthetic generation
- editing
- recompression
- inconsistent lighting
- inconsistent shadows
- visual artifacts
- unusual text
- face inconsistencies
- metadata or structural anomalies when actually available

Important:
An AI assessment is NOT definitive proof.

Never say that a file is definitely fake or definitely authentic unless the evidence genuinely establishes that conclusion, which ordinary visual analysis normally cannot.

Return JSON only with this structure:

{
  "verdict": "Likely Authentic | Possibly Manipulated | Likely Manipulated | Inconclusive",
  "suspicionLevel": "Low | Medium | High | Unknown",
  "confidence": 0,
  "summary": "",
  "evidence": [],
  "limitations": [],
  "verificationSteps": [],
  "technicalSignals": []
}`;

function normalizeReport(
  value,
  provider = "unknown"
) {
  let data =
    typeof value === "string"
      ? safeJsonParse(value)
      : value;

  if (!data) {
    data = {
      verdict:
        "Inconclusive",
      suspicionLevel:
        "Unknown",
      confidence: 0,
      summary:
        safeDisplay(
          value,
          "No structured analysis was returned."
        ),
      evidence: [],
      limitations: [],
      verificationSteps: [],
      technicalSignals: []
    };
  }

  const confidence =
    Number(data.confidence);

  return {
    verdict:
      safeString(
        data.verdict,
        "Inconclusive"
      ),
    suspicionLevel:
      safeString(
        data.suspicionLevel,
        "Unknown"
      ),
    confidence:
      Number.isFinite(confidence)
        ? Math.max(
            0,
            Math.min(100, confidence)
          )
        : 0,
    summary:
      safeDisplay(
        data.summary,
        "No summary was returned."
      ),
    evidence:
      Array.isArray(data.evidence)
        ? data.evidence
            .map(item =>
              safeDisplay(item)
            )
            .filter(Boolean)
            .slice(0, 20)
        : [],
    limitations:
      Array.isArray(
        data.limitations
      )
        ? data.limitations
            .map(item =>
              safeDisplay(item)
            )
            .filter(Boolean)
            .slice(0, 20)
        : [],
    verificationSteps:
      Array.isArray(
        data.verificationSteps
      )
        ? data.verificationSteps
            .map(item =>
              safeDisplay(item)
            )
            .filter(Boolean)
            .slice(0, 20)
        : [],
    technicalSignals:
      Array.isArray(
        data.technicalSignals
      )
        ? data.technicalSignals
            .map(item =>
              safeDisplay(item)
            )
            .filter(Boolean)
            .slice(0, 20)
        : [],
    provider
  };
}

async function analyzeImageWithGemini(
  buffer,
  mimeType,
  filename
) {
  if (!gemini) {
    throw new Error(
      "Gemini is not configured."
    );
  }

  const base64 =
    buffer.toString("base64");

  const prompt =
    `${FORENSIC_SYSTEM}

Filename:
${safeString(
      filename,
      "uploaded-image"
    )}

Analyze this image.

Pay particular attention to:
- faces
- edges
- lighting
- shadows
- reflections
- repeated textures
- impossible geometry
- text
- object boundaries
- signs of generative artifacts
- signs of editing or compositing

Return JSON only.`;

  const response =
    await withTimeout(
      gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt
              },
              {
                inlineData: {
                  mimeType,
                  data: base64
                }
              }
            ]
          }
        ],
        config: {
          temperature: 0.1,
          maxOutputTokens: 2200
        }
      }),
      MEDIA_TIMEOUT_MS
    );

  const text =
    extractGeminiText(response);

  if (!text) {
    throw new Error(
      "Gemini returned no image analysis."
    );
  }

  return normalizeReport(
    text,
    "gemini"
  );
}

async function analyzeVideoWithGemini(
  buffer,
  mimeType,
  filename
) {
  if (!gemini) {
    throw new Error(
      "Gemini is not configured."
    );
  }

  const tempDir =
    await fs.promises.mkdtemp(
      path.join(
        os.tmpdir(),
        "trueaegis-"
      )
    );

  const safeName =
    path.basename(
      filename ||
      `video-${Date.now()}`
    );

  const tempPath =
    path.join(
      tempDir,
      safeName
    );

  try {
    await fs.promises.writeFile(
      tempPath,
      buffer
    );

    console.log(
      `[MEDIA] Uploading video ${formatBytes(
        buffer.length
      )}`
    );

    const uploaded =
      await withTimeout(
        gemini.files.upload({
          file: tempPath,
          config: {
            mimeType
          }
        }),
        VIDEO_PROCESS_TIMEOUT_MS
      );

    if (!uploaded?.name) {
      throw new Error(
        "Gemini video upload failed."
      );
    }

    let file =
      uploaded;

    const start =
      Date.now();

    while (
      file?.state?.name ===
        "PROCESSING" &&
      Date.now() - start <
        VIDEO_PROCESS_TIMEOUT_MS
    ) {
      await sleep(
        VIDEO_POLL_INTERVAL_MS
      );

      file =
        await gemini.files.get({
          name: uploaded.name
        });

      console.log(
        `[MEDIA] Video state: ${
          file?.state?.name ||
          "unknown"
        }`
      );
    }

    if (
      file?.state?.name !==
      "ACTIVE"
    ) {
      throw new Error(
        `Gemini video processing failed or timed out: ${
          file?.state?.name ||
          "unknown"
        }`
      );
    }

    const prompt =
      `${FORENSIC_SYSTEM}

Filename:
${safeString(
        filename,
        "uploaded-video"
      )}

Analyze this video for potential manipulation.

Consider:
- temporal consistency
- facial consistency
- object boundaries
- lighting
- shadows
- motion
- frame-to-frame artifacts
- audio/visual synchronization if available
- unnatural transitions
- generative artifacts
- editing/compositing indicators

Do not treat compression alone as proof of manipulation.

Return JSON only.`;

    const response =
      await withTimeout(
        gemini.models.generateContent({
          model: GEMINI_MODEL,
          contents: [
            createUserContent([
              {
                text: prompt
              },
              createPartFromUri(
                file.uri,
                file.mimeType ||
                  mimeType
              )
            ])
          ],
          config: {
            temperature: 0.1,
            maxOutputTokens: 2400
          }
        }),
        VIDEO_PROCESS_TIMEOUT_MS
      );

    const text =
      extractGeminiText(response);

    if (!text) {
      throw new Error(
        "Gemini returned no video analysis."
      );
    }

    return normalizeReport(
      text,
      "gemini"
    );
  } finally {
    try {
      await fs.promises.rm(
        tempDir,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}
  }
}

async function analyzeMediaWithPerplexity(
  mimeType,
  filename,
  localSignals,
  context = ""
) {
  const mediaKind =
    isVideoMime(mimeType)
      ? "video"
      : "image";

  const prompt =
    `${FORENSIC_SYSTEM}

A direct visual inspection by Perplexity is not being assumed here.

Instead, review the available evidence and provide a cautious secondary assessment.

Media type:
${mediaKind}

Filename:
${safeString(
      filename,
      "unknown"
    )}

Local signals:
${JSON.stringify(
      localSignals,
      null,
      2
    )}

Additional evidence:
${safeString(
      context,
      "None"
    )}

Explain what can and cannot be concluded from these signals.

Return JSON only.`;

  const result =
    await callPerplexity(
      [
        {
          role: "system",
          content:
            FORENSIC_SYSTEM
        },
        {
          role: "user",
          content: prompt
        }
      ],
      {
        temperature: 0.1,
        maxTokens: 1800,
        timeout:
          MEDIA_TIMEOUT_MS
      }
    );

  return normalizeReport(
    result,
    "perplexity"
  );
}

async function analyzeImageWithFallbacks(
  buffer,
  mimeType,
  filename,
  localSignals
) {
  const failures = [];

  try {
    const report =
      await analyzeImageWithGemini(
        buffer,
        mimeType,
        filename
      );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "gemini",
      error: error.message
    });

    console.warn(
      "[MEDIA] Gemini image failed:",
      error.message
    );
  }

  try {
    const report =
      await analyzeMediaWithPerplexity(
        mimeType,
        filename,
        localSignals
      );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "perplexity",
      error: error.message
    });

    console.warn(
      "[MEDIA] Perplexity image fallback failed:",
      error.message
    );
  }

  try {
    const prompt =
      `${FORENSIC_SYSTEM}

Analyze this image visually.

Filename:
${safeString(
        filename,
        "uploaded-image"
      )}

Local signals:
${JSON.stringify(
        localSignals,
        null,
        2
      )}

Return JSON only.`;

    const result =
      await callGroqVision(
        buffer.toString("base64"),
        mimeType,
        [
          {
            role: "system",
            content:
              FORENSIC_SYSTEM
          },
          {
            role: "user",
            content: prompt
          }
        ],
        {
          temperature: 0.1,
          maxTokens: 2200,
          timeout:
            MEDIA_TIMEOUT_MS
        }
      );

    return {
      report:
        normalizeReport(
          result,
          "groq"
        ),
      failures
    };
  } catch (error) {
    failures.push({
      provider: "groq",
      error: error.message
    });

    throw Object.assign(
      new Error(
        "All image analysis providers failed."
      ),
      {
        failures
      }
    );
  }
}

async function analyzeVideoWithFallbacks(
  buffer,
  mimeType,
  filename,
  localSignals
) {
  const failures = [];

  try {
    const report =
      await analyzeVideoWithGemini(
        buffer,
        mimeType,
        filename
      );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "gemini",
      error: error.message
    });

    console.warn(
      "[MEDIA] Gemini video failed:",
      error.message
    );
  }

  try {
    const report =
      await analyzeMediaWithPerplexity(
        mimeType,
        filename,
        localSignals,
        "The primary video-analysis provider was unavailable. No unsupported claim of direct video inspection should be made."
      );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "perplexity",
      error: error.message
    });

    console.warn(
      "[MEDIA] Perplexity video fallback failed:",
      error.message
    );
  }

  try {
    if (
      buffer.length >
      MAX_MEDIA_BYTES
    ) {
      throw new Error(
        "Video is too large for the emergency fallback."
      );
    }

    const report =
      await analyzeMediaWithPerplexity(
        mimeType,
        filename,
        localSignals,
        "All direct visual providers were unavailable. The available evidence is insufficient for a reliable visual verdict."
      );

    report.provider =
      "groq-fallback-unavailable";

    report.verdict =
      "Inconclusive";

    report.suspicionLevel =
      "Unknown";

    report.confidence = 0;

    report.limitations.push(
      "The final visual fallback could not inspect the complete video."
    );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "groq",
      error: error.message
    });

    throw Object.assign(
      new Error(
        "All video analysis providers failed."
      ),
      {
        failures
      }
    );
  }
}require("dotenv").config();

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
  createUserContent
} = require("@google/genai");

const authRoutes = require("./routes/auth");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "development";

const MONGODB_URI = process.env.MONGODB_URI || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash";

const PERPLEXITY_API_KEY =
  process.env.PERPLEXITY_API_KEY || "";

const PERPLEXITY_MODEL =
  process.env.PERPLEXITY_MODEL ||
  "sonar";

const GROQ_API_KEY =
  process.env.GROQ_API_KEY || "";

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  "qwen/qwen3-32b";

const REQUEST_TIMEOUT_MS =
  Number(process.env.REQUEST_TIMEOUT_MS) ||
  90000;

const MEDIA_TIMEOUT_MS =
  Number(process.env.MEDIA_TIMEOUT_MS) ||
  150000;

const VIDEO_PROCESS_TIMEOUT_MS =
  Number(process.env.VIDEO_PROCESS_TIMEOUT_MS) ||
  240000;

const VIDEO_POLL_INTERVAL_MS =
  Number(process.env.VIDEO_POLL_INTERVAL_MS) ||
  4000;

const MAX_MEDIA_BYTES =
  Number(process.env.MAX_MEDIA_BYTES) ||
  18 * 1024 * 1024;

const PUBLIC_DIR =
  path.join(__dirname, "public");

let gemini = null;

if (GEMINI_API_KEY) {
  try {
    gemini = new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    });

    console.log("[AI] Gemini initialized");
  } catch (error) {
    console.error(
      "[AI] Gemini initialization failed:",
      error.message
    );
  }
} else {
  console.warn("[AI] GEMINI_API_KEY missing");
}

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With"
    ]
  })
);

app.use(
  express.json({
    limit: "50mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb"
  })
);

app.use(cookieParser());

function safeString(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value)
    .replace(/\u0000/g, "")
    .trim();
}

function safeDisplay(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value)
      .replace(/\u0000/g, "")
      .trim();
  }

  if (Array.isArray(value)) {
    return value
      .map(item => safeDisplay(item))
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value === "object") {
    const preferred =
      value.summary ??
      value.description ??
      value.message ??
      value.text ??
      value.value ??
      value.label ??
      value.title;

    if (preferred !== undefined) {
      return safeDisplay(preferred, fallback);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

function cleanBase64(value) {
  return String(value || "")
    .replace(/^data:[^,]+,/, "")
    .replace(/\s/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
}

function stripCodeFences(value) {
  return safeString(value)
    .replace(
      /^```(?:json|javascript|js|text)?\s*/i,
      ""
    )
    .replace(/\s*```$/i, "")
    .trim();
}

function safeJsonParse(value) {
  const text = stripCodeFences(value);

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (
      start !== -1 &&
      end > start
    ) {
      try {
        return JSON.parse(
          text.slice(start, end + 1)
        );
      } catch {}
    }

    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(
      bytes /
      (1024 * 1024)
    ).toFixed(1)} MB`;
  }

  return `${(
    bytes /
    (1024 * 1024 * 1024)
  ).toFixed(1)} GB`;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeout = REQUEST_TIMEOUT_MS
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (
      error?.name === "AbortError"
    ) {
      const timeoutError = new Error(
        `Request timed out after ${timeout}ms`
      );

      timeoutError.code = 408;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout(
  promise,
  timeout
) {
  let timer;

  const timeoutPromise =
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Operation timed out after ${timeout}ms`
        );

        error.code = 408;

        reject(error);
      }, timeout);
    });

  try {
    return await Promise.race([
      promise,
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function extractGeminiText(response) {
  if (!response) {
    return "";
  }

  if (
    typeof response.text === "string"
  ) {
    return response.text.trim();
  }

  if (
    typeof response.text === "function"
  ) {
    try {
      const text = response.text();

      if (
        typeof text === "string"
      ) {
        return text.trim();
      }
    } catch {}
  }

  const candidates =
    response.candidates ||
    response.response?.candidates ||
    [];

  for (const candidate of candidates) {
    const parts =
      candidate?.content?.parts ||
      [];

    const text = parts
      .map(part => part?.text || "")
      .join("")
      .trim();

    if (text) {
      return text;
    }
  }

  return "";
}

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
    await withTimeout(
      gemini.models.generateContent({
        model:
          options.model ||
          GEMINI_MODEL,
        contents,
        config: {
          temperature:
            options.temperature ?? 0.2,
          maxOutputTokens:
            options.maxOutputTokens || 1800
        }
      }),
      options.timeout ||
        REQUEST_TIMEOUT_MS
    );

  const text =
    extractGeminiText(response);

  if (!text) {
    throw new Error(
      "Gemini returned an empty response."
    );
  }

  return text;
}

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
            "application/json"
        },
        body: JSON.stringify({
          model:
            options.model ||
            PERPLEXITY_MODEL,
          messages,
          temperature:
            options.temperature ?? 0.2,
          max_tokens:
            options.maxTokens || 1800
        })
      },
      options.timeout ||
        REQUEST_TIMEOUT_MS
    );

  const raw = await response.text();

  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message ||
      `Perplexity returned HTTP ${response.status}.`
    );

    error.status =
      response.status;

    throw error;
  }

  const text =
    body?.choices?.[0]?.message?.content;

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    throw new Error(
      "Perplexity returned an empty response."
    );
  }

  return text.trim();
}

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
            "application/json"
        },
        body: JSON.stringify({
          model:
            options.model ||
            GROQ_MODEL,
          messages,
          temperature:
            options.temperature ?? 0.2,
          max_tokens:
            options.maxTokens || 1800
        })
      },
      options.timeout ||
        REQUEST_TIMEOUT_MS
    );

  const raw = await response.text();

  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message ||
      `Groq returned HTTP ${response.status}.`
    );

    error.status =
      response.status;

    throw error;
  }

  const text =
    body?.choices?.[0]?.message?.content;

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    throw new Error(
      "Groq returned an empty response."
    );
  }

  return text.trim();
}

async function callGroqVision(
  imageBase64,
  mimeType,
  messages,
  options = {}
) {
  if (!GROQ_API_KEY) {
    throw new Error(
      "Groq API is not configured."
    );
  }

  const clean =
    cleanBase64(imageBase64);

  const userMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          messages?.[1]?.content ||
          messages?.[0]?.content ||
          "Analyze this image for signs of manipulation."
      },
      {
        type: "image_url",
        image_url: {
          url:
            `data:${mimeType};base64,${clean}`
        }
      }
    ]
  };

  const response =
    await fetchWithTimeout(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${GROQ_API_KEY}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          model:
            options.model ||
            GROQ_MODEL,
          messages: [
            {
              role: "system",
              content:
                messages?.[0]?.role ===
                "system"
                  ? messages[0].content
                  : "Analyze the supplied media carefully and return a structured forensic assessment."
            },
            userMessage
          ],
          temperature:
            options.temperature ?? 0.15,
          max_tokens:
            options.maxTokens || 1800
        })
      },
      options.timeout ||
        MEDIA_TIMEOUT_MS
    );

  const raw = await response.text();

  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message ||
      `Groq vision returned HTTP ${response.status}.`
    );

    error.status =
      response.status;

    throw error;
  }

  const text =
    body?.choices?.[0]?.message?.content;

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    throw new Error(
      "Groq vision returned an empty response."
    );
  }

  return text.trim();
}

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

function inferMimeType(filename) {
  const ext =
    path
      .extname(
        safeString(filename)
      )
      .toLowerCase();

  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska"
  };

  return (
    map[ext] ||
    "application/octet-stream"
  );
}

function bufferFromValue(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (
    value instanceof Uint8Array
  ) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    try {
      return Buffer.from(
        cleanBase64(value),
        "base64"
      );
    } catch {
      return null;
    }
  }

  return null;
}

function mediaBufferFromRequest(req) {
  const body = req.body || {};

  const possibleValues = [
    body.buffer,
    body.data,
    body.base64,
    body.file,
    body.media
  ];

  for (
    const value of possibleValues
  ) {
    const buffer =
      bufferFromValue(value);

    if (
      buffer &&
      buffer.length
    ) {
      return buffer;
    }
  }

  return null;
}

function mediaTypeFromRequest(req) {
  const body = req.body || {};

  return (
    safeString(
      body.mimeType ||
      body.type ||
      body.mimetype
    ) ||
    inferMimeType(
      body.filename ||
      body.name ||
      ""
    )
  );
}

function detectImageSignature(buffer) {
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
          0x0a
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
    buffer.length >= 6 &&
    (
      buffer
        .subarray(0, 6)
        .toString("ascii") ===
      "GIF87a" ||
      buffer
        .subarray(0, 6)
        .toString("ascii") ===
      "GIF89a"
    )
  ) {
    return "gif";
  }

  if (
    buffer.length >= 12 &&
    buffer
      .subarray(0, 4)
      .toString("ascii") ===
      "RIFF" &&
    buffer
      .subarray(8, 12)
      .toString("ascii") ===
      "WEBP"
  ) {
    return "webp";
  }

  return "unknown";
}

function validateMediaSignature(
  buffer,
  mimeType
) {
  const signature =
    detectImageSignature(buffer);

  if (!isImageMime(mimeType)) {
    return {
      ok: true,
      signature: "video"
    };
  }

  const expected = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp"
  }[mimeType];

  if (
    signature === "unknown"
  ) {
    return {
      ok: true,
      signature,
      warning:
        "The image signature could not be identified."
    };
  }

  if (
    expected &&
    signature !== expected
  ) {
    return {
      ok: false,
      signature,
      error:
        "The uploaded file does not match its declared image type."
    };
  }

  return {
    ok: true,
    signature
  };
}

function localImageSignals(
  buffer,
  signature
) {
  const size =
    buffer?.length || 0;

  return {
    byteSize: size,
    readableSize:
      formatBytes(size),
    signature:
      signature || "unknown",
    suspiciousExtensionMismatch:
      false,
    notes: [
      "Local checks are supporting signals only.",
      "They do not establish whether an image is authentic or manipulated."
    ]
  };
}

function localVideoSignals(
  buffer,
  filename
) {
  const size =
    buffer?.length || 0;

  return {
    byteSize: size,
    readableSize:
      formatBytes(size),
    filename:
      safeString(filename),
    notes: [
      "The server performed basic file-level checks.",
      "Visual authenticity requires AI media analysis."
    ]
  };
}

const FORENSIC_SYSTEM =
  `You are TrueAegis forensic analysis AI.

Analyze supplied media carefully.

Your job is to identify observable indicators that may be consistent with:
- manipulation
- synthetic generation
- editing
- recompression
- inconsistent lighting
- inconsistent shadows
- visual artifacts
- unusual text
- face inconsistencies
- metadata or structural anomalies when actually available

Important:
An AI assessment is NOT definitive proof.

Never say that a file is definitely fake or definitely authentic unless the evidence genuinely establishes that conclusion, which ordinary visual analysis normally cannot.

Return JSON only with this structure:

{
  "verdict": "Likely Authentic | Possibly Manipulated | Likely Manipulated | Inconclusive",
  "suspicionLevel": "Low | Medium | High | Unknown",
  "confidence": 0,
  "summary": "",
  "evidence": [],
  "limitations": [],
  "verificationSteps": [],
  "technicalSignals": []
}`;

function normalizeReport(
  value,
  provider = "unknown"
) {
  let data =
    typeof value === "string"
      ? safeJsonParse(value)
      : value;

  if (!data) {
    data = {
      verdict:
        "Inconclusive",
      suspicionLevel:
        "Unknown",
      confidence: 0,
      summary:
        safeDisplay(
          value,
          "No structured analysis was returned."
        ),
      evidence: [],
      limitations: [],
      verificationSteps: [],
      technicalSignals: []
    };
  }

  const confidence =
    Number(data.confidence);

  return {
    verdict:
      safeString(
        data.verdict,
        "Inconclusive"
      ),
    suspicionLevel:
      safeString(
        data.suspicionLevel,
        "Unknown"
      ),
    confidence:
      Number.isFinite(confidence)
        ? Math.max(
            0,
            Math.min(100, confidence)
          )
        : 0,
    summary:
      safeDisplay(
        data.summary,
        "No summary was returned."
      ),
    evidence:
      Array.isArray(data.evidence)
        ? data.evidence
            .map(item =>
              safeDisplay(item)
            )
            .filter(Boolean)
            .slice(0, 20)
        : [],
    limitations:
      Array.isArray(
        data.limitations
      )
        ? data.limitations
            .map(item =>
              safeDisplay(item)
            )
            .filter(Boolean)
            .slice(0, 20)
        : [],
    verificationSteps:
      Array.isArray(
        data.verificationSteps
      )
        ? data.verificationSteps
            .map(item =>
              safeDisplay(item)
            )
            .filter(Boolean)
            .slice(0, 20)
        : [],
    technicalSignals:
      Array.isArray(
        data.technicalSignals
      )
        ? data.technicalSignals
            .map(item =>
              safeDisplay(item)
            )
            .filter(Boolean)
            .slice(0, 20)
        : [],
    provider
  };
}

async function analyzeImageWithGemini(
  buffer,
  mimeType,
  filename
) {
  if (!gemini) {
    throw new Error(
      "Gemini is not configured."
    );
  }

  const base64 =
    buffer.toString("base64");

  const prompt =
    `${FORENSIC_SYSTEM}

Filename:
${safeString(
      filename,
      "uploaded-image"
    )}

Analyze this image.

Pay particular attention to:
- faces
- edges
- lighting
- shadows
- reflections
- repeated textures
- impossible geometry
- text
- object boundaries
- signs of generative artifacts
- signs of editing or compositing

Return JSON only.`;

  const response =
    await withTimeout(
      gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt
              },
              {
                inlineData: {
                  mimeType,
                  data: base64
                }
              }
            ]
          }
        ],
        config: {
          temperature: 0.1,
          maxOutputTokens: 2200
        }
      }),
      MEDIA_TIMEOUT_MS
    );

  const text =
    extractGeminiText(response);

  if (!text) {
    throw new Error(
      "Gemini returned no image analysis."
    );
  }

  return normalizeReport(
    text,
    "gemini"
  );
}

async function analyzeVideoWithGemini(
  buffer,
  mimeType,
  filename
) {
  if (!gemini) {
    throw new Error(
      "Gemini is not configured."
    );
  }

  const tempDir =
    await fs.promises.mkdtemp(
      path.join(
        os.tmpdir(),
        "trueaegis-"
      )
    );

  const safeName =
    path.basename(
      filename ||
      `video-${Date.now()}`
    );

  const tempPath =
    path.join(
      tempDir,
      safeName
    );

  try {
    await fs.promises.writeFile(
      tempPath,
      buffer
    );

    console.log(
      `[MEDIA] Uploading video ${formatBytes(
        buffer.length
      )}`
    );

    const uploaded =
      await withTimeout(
        gemini.files.upload({
          file: tempPath,
          config: {
            mimeType
          }
        }),
        VIDEO_PROCESS_TIMEOUT_MS
      );

    if (!uploaded?.name) {
      throw new Error(
        "Gemini video upload failed."
      );
    }

    let file =
      uploaded;

    const start =
      Date.now();

    while (
      file?.state?.name ===
        "PROCESSING" &&
      Date.now() - start <
        VIDEO_PROCESS_TIMEOUT_MS
    ) {
      await sleep(
        VIDEO_POLL_INTERVAL_MS
      );

      file =
        await gemini.files.get({
          name: uploaded.name
        });

      console.log(
        `[MEDIA] Video state: ${
          file?.state?.name ||
          "unknown"
        }`
      );
    }

    if (
      file?.state?.name !==
      "ACTIVE"
    ) {
      throw new Error(
        `Gemini video processing failed or timed out: ${
          file?.state?.name ||
          "unknown"
        }`
      );
    }

    const prompt =
      `${FORENSIC_SYSTEM}

Filename:
${safeString(
        filename,
        "uploaded-video"
      )}

Analyze this video for potential manipulation.

Consider:
- temporal consistency
- facial consistency
- object boundaries
- lighting
- shadows
- motion
- frame-to-frame artifacts
- audio/visual synchronization if available
- unnatural transitions
- generative artifacts
- editing/compositing indicators

Do not treat compression alone as proof of manipulation.

Return JSON only.`;

    const response =
      await withTimeout(
        gemini.models.generateContent({
          model: GEMINI_MODEL,
          contents: [
            createUserContent([
              {
                text: prompt
              },
              createPartFromUri(
                file.uri,
                file.mimeType ||
                  mimeType
              )
            ])
          ],
          config: {
            temperature: 0.1,
            maxOutputTokens: 2400
          }
        }),
        VIDEO_PROCESS_TIMEOUT_MS
      );

    const text =
      extractGeminiText(response);

    if (!text) {
      throw new Error(
        "Gemini returned no video analysis."
      );
    }

    return normalizeReport(
      text,
      "gemini"
    );
  } finally {
    try {
      await fs.promises.rm(
        tempDir,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}
  }
}

async function analyzeMediaWithPerplexity(
  mimeType,
  filename,
  localSignals,
  context = ""
) {
  const mediaKind =
    isVideoMime(mimeType)
      ? "video"
      : "image";

  const prompt =
    `${FORENSIC_SYSTEM}

A direct visual inspection by Perplexity is not being assumed here.

Instead, review the available evidence and provide a cautious secondary assessment.

Media type:
${mediaKind}

Filename:
${safeString(
      filename,
      "unknown"
    )}

Local signals:
${JSON.stringify(
      localSignals,
      null,
      2
    )}

Additional evidence:
${safeString(
      context,
      "None"
    )}

Explain what can and cannot be concluded from these signals.

Return JSON only.`;

  const result =
    await callPerplexity(
      [
        {
          role: "system",
          content:
            FORENSIC_SYSTEM
        },
        {
          role: "user",
          content: prompt
        }
      ],
      {
        temperature: 0.1,
        maxTokens: 1800,
        timeout:
          MEDIA_TIMEOUT_MS
      }
    );

  return normalizeReport(
    result,
    "perplexity"
  );
}

async function analyzeImageWithFallbacks(
  buffer,
  mimeType,
  filename,
  localSignals
) {
  const failures = [];

  try {
    const report =
      await analyzeImageWithGemini(
        buffer,
        mimeType,
        filename
      );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "gemini",
      error: error.message
    });

    console.warn(
      "[MEDIA] Gemini image failed:",
      error.message
    );
  }

  try {
    const report =
      await analyzeMediaWithPerplexity(
        mimeType,
        filename,
        localSignals
      );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "perplexity",
      error: error.message
    });

    console.warn(
      "[MEDIA] Perplexity image fallback failed:",
      error.message
    );
  }

  try {
    const prompt =
      `${FORENSIC_SYSTEM}

Analyze this image visually.

Filename:
${safeString(
        filename,
        "uploaded-image"
      )}

Local signals:
${JSON.stringify(
        localSignals,
        null,
        2
      )}

Return JSON only.`;

    const result =
      await callGroqVision(
        buffer.toString("base64"),
        mimeType,
        [
          {
            role: "system",
            content:
              FORENSIC_SYSTEM
          },
          {
            role: "user",
            content: prompt
          }
        ],
        {
          temperature: 0.1,
          maxTokens: 2200,
          timeout:
            MEDIA_TIMEOUT_MS
        }
      );

    return {
      report:
        normalizeReport(
          result,
          "groq"
        ),
      failures
    };
  } catch (error) {
    failures.push({
      provider: "groq",
      error: error.message
    });

    throw Object.assign(
      new Error(
        "All image analysis providers failed."
      ),
      {
        failures
      }
    );
  }
}

async function analyzeVideoWithFallbacks(
  buffer,
  mimeType,
  filename,
  localSignals
) {
  const failures = [];

  try {
    const report =
      await analyzeVideoWithGemini(
        buffer,
        mimeType,
        filename
      );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "gemini",
      error: error.message
    });

    console.warn(
      "[MEDIA] Gemini video failed:",
      error.message
    );
  }

  try {
    const report =
      await analyzeMediaWithPerplexity(
        mimeType,
        filename,
        localSignals,
        "The primary video-analysis provider was unavailable. No unsupported claim of direct video inspection should be made."
      );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "perplexity",
      error: error.message
    });

    console.warn(
      "[MEDIA] Perplexity video fallback failed:",
      error.message
    );
  }

  try {
    if (
      buffer.length >
      MAX_MEDIA_BYTES
    ) {
      throw new Error(
        "Video is too large for the emergency fallback."
      );
    }

    const report =
      await analyzeMediaWithPerplexity(
        mimeType,
        filename,
        localSignals,
        "All direct visual providers were unavailable. The available evidence is insufficient for a reliable visual verdict."
      );

    report.provider =
      "groq-fallback-unavailable";

    report.verdict =
      "Inconclusive";

    report.suspicionLevel =
      "Unknown";

    report.confidence = 0;

    report.limitations.push(
      "The final visual fallback could not inspect the complete video."
    );

    return {
      report,
      failures
    };
  } catch (error) {
    failures.push({
      provider: "groq",
      error: error.message
    });

    throw Object.assign(
      new Error(
        "All video analysis providers failed."
      ),
      {
        failures
      }
    );
  }
}