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

const { OAuth2Client } = require("google-auth-library");

const authRoutes = require("./routes/auth");

/* ============================================================
   CONFIGURATION
============================================================ */

const app = express();

const PORT =
  Number(process.env.PORT) || 3000;

const HOST =
  process.env.HOST || "0.0.0.0";

const NODE_ENV =
  process.env.NODE_ENV || "development";

const MONGODB_URI =
  process.env.MONGODB_URI || "";

const JWT_SECRET =
  process.env.JWT_SECRET || "";

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || "";

const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || "";

const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  `${process.env.BASE_URL || `http://localhost:${PORT}`}/api/auth/google/callback`;

/* ============================================================
   AI CONFIGURATION

   REQUIRED PROVIDER ORDER:

   TEXT:
   Perplexity -> Gemini -> Groq

   MEDIA:
   Gemini -> Groq
============================================================ */

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.6-flash";

const PERPLEXITY_API_KEY =
  process.env.PERPLEXITY_API_KEY ||
  "";

const PERPLEXITY_MODEL =
  process.env.PERPLEXITY_MODEL ||
  "sonar";

const GROQ_API_KEY =
  process.env.GROQ_API_KEY ||
  "";

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  "meta-llama/llama-4-scout-17b-16e-instruct";

const GROQ_MAX_OUTPUT_TOKENS =
  Number(
    process.env.GROQ_MAX_OUTPUT_TOKENS
  ) || 1800;

const REQUEST_TIMEOUT_MS =
  Number(
    process.env.REQUEST_TIMEOUT_MS
  ) || 90000;

const MEDIA_TIMEOUT_MS =
  Number(
    process.env.MEDIA_TIMEOUT_MS
  ) || 120000;

const MAX_MEDIA_BYTES =
  Number(
    process.env.MAX_MEDIA_BYTES
  ) || 18 * 1024 * 1024;

const VIDEO_PROCESS_TIMEOUT_MS =
  Number(
    process.env.VIDEO_PROCESS_TIMEOUT_MS
  ) || 210000;

const VIDEO_POLL_INTERVAL_MS =
  Number(
    process.env.VIDEO_POLL_INTERVAL_MS
  ) || 3000;

const PUBLIC_DIR =
  path.join(__dirname, "public");

/* ============================================================
   GEMINI INITIALIZATION
============================================================ */

let gemini = null;

if (GEMINI_API_KEY) {
  try {
    gemini = new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
    });

    console.log(
      "[TrueAegis] Gemini initialized."
    );
  } catch (error) {
    console.error(
      "[TrueAegis] Gemini initialization failed:",
      error.message
    );

    gemini = null;
  }
} else {
  console.warn(
    "[TrueAegis] GEMINI_API_KEY is missing."
  );
}

/* ============================================================
   EXPRESS CONFIGURATION
============================================================ */

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
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
    ],
  })
);

app.use(
  express.json({
    limit: "50mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  })
);

app.use(cookieParser());

/* ============================================================
   BASIC HELPERS
============================================================ */

function safeString(
  value,
  fallback = ""
) {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value).trim();
}

function cleanText(value) {
  return safeString(value)
    .replace(/\u0000/g, "")
    .trim();
}

function cleanBase64(value) {
  return String(value || "")
    .replace(/^data:[^,]+,/, "")
    .replace(/\s/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
}

function stripCodeFences(value) {
  let text = safeString(value);

  text = text.replace(
    /^```(?:json|javascript|js|text)?\s*/i,
    ""
  );

  text = text.replace(
    /\s*```$/i,
    ""
  );

  return text.trim();
}

function safeJsonParse(value) {
  const text =
    stripCodeFences(value);

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(
      bytes / 1024
    ).toFixed(1)} KB`;
  }

  if (
    bytes <
    1024 * 1024 * 1024
  ) {
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

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function providerError(
  provider,
  error
) {
  return {
    provider,
    message:
      error?.message ||
      "Unknown provider error",
    status:
      error?.status ||
      error?.code ||
      undefined,
  };
}

/* ============================================================
   TIMEOUT HELPERS
============================================================ */

async function fetchWithTimeout(
  url,
  options = {},
  timeout =
    REQUEST_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeout
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal,
      }
    );
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      const timeoutError =
        new Error(
          `Request timed out after ${timeout}ms.`
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
    new Promise(
      (_, reject) => {
        timer = setTimeout(() => {
          const error =
            new Error(
              `Operation timed out after ${timeout}ms.`
            );

          error.code = 408;

          reject(error);
        }, timeout);
      }
    );

  try {
    return await Promise.race([
      promise,
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   GEMINI RESPONSE EXTRACTION
============================================================ */

function extractGeminiText(
  response
) {
  if (!response) {
    return "";
  }

  if (
    typeof response.text ===
    "string"
  ) {
    return response.text.trim();
  }

  if (
    typeof response.text ===
    "function"
  ) {
    try {
      const value =
        response.text();

      if (
        typeof value ===
        "string"
      ) {
        return value.trim();
      }
    } catch {}
  }

  const candidates =
    response.candidates ||
    response.response
      ?.candidates ||
    [];

  for (
    const candidate of candidates
  ) {
    const parts =
      candidate?.content
        ?.parts ||
      [];

    const text =
      parts
        .map(
          (part) =>
            part?.text || ""
        )
        .join("")
        .trim();

    if (text) {
      return text;
    }
  }

  return "";
}

/* ============================================================
   GEMINI TEXT CALL

   Gemini is NEVER called before Perplexity
   for normal text routes.

   This helper only performs the Gemini request
   when the route explicitly reaches Gemini.
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

  const model =
    options.model ||
    GEMINI_MODEL;

  const temperature =
    options.temperature ??
    0.2;

  const maxOutputTokens =
    options.maxOutputTokens ||
    1800;

  const timeout =
    options.timeout ||
    REQUEST_TIMEOUT_MS;

  const response =
    await withTimeout(
      gemini.models.generateContent(
        {
          model,
          contents,
          config: {
            temperature,
            maxOutputTokens,
          },
        }
      ),
      timeout
    );

  return response;
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
            options.temperature ??
            0.2,

          max_tokens:
            options.maxTokens ||
            1600,
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
          `Perplexity returned HTTP ${response.status}.`
      );

    error.status =
      response.status;

    error.providerBody =
      body;

    throw error;
  }

  const content =
    body?.choices?.[0]
      ?.message?.content;

  if (
    typeof content !==
    "string" ||
    !content.trim()
  ) {
    throw new Error(
      "Perplexity returned an empty response."
    );
  }

  return content.trim();
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

  const content =
    body?.choices?.[0]
      ?.message?.content;

  if (
    typeof content !==
    "string" ||
    !content.trim()
  ) {
    throw new Error(
      "Groq returned an empty response."
    );
  }

  return content.trim();
}

/* ============================================================
   GROQ VISION
============================================================ */

async function callGroqVision(
  base64,
  mimeType,
  prompt,
  options = {}
) {
  if (!GROQ_API_KEY) {
    throw new Error(
      "Groq API is not configured."
    );
  }

  const imageData =
    `data:${mimeType};base64,${cleanBase64(
      base64
    )}`;

  return callGroq(
    [
      {
        role: "system",
        content:
          "You are a careful digital-media forensic assistant. Your assessment is not definitive proof.",
      },

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
              url: imageData,
            },
          },
        ],
      },
    ],

    {
      ...options,

      maxTokens:
        options.maxTokens ||
        GROQ_MAX_OUTPUT_TOKENS,
    }
  );
}

/* ============================================================
   MEDIA FORENSIC PROMPT
============================================================ */

const MEDIA_FORENSIC_PROMPT = `
You are the TrueAegis Media Forensic Analysis AI.

Analyze the supplied image or video for possible indicators
of manipulation, synthetic generation, editing, compositing,
or other authenticity concerns.

Do NOT claim certainty.

Your report must include:

1. Suspicion level:
   LOW / MEDIUM / HIGH / INCONCLUSIVE

2. Assessment:
   A concise explanation of what the media appears to show
   and why it received that assessment.

3. Evidence:
   Specific observable indicators.

4. AI-generation indicators:
   Possible signs of synthetic generation.

5. Authenticity signals:
   Features that appear consistent with genuine media.

6. Limitations:
   What cannot be established from this analysis.

7. Verification steps:
   Practical ways the user can independently verify the media.

Important:
- Do not invent metadata.
- Do not invent provenance.
- Do not claim an image or video is definitely fake.
- Do not claim an image or video is definitely authentic.
- AI analysis is an assessment, not definitive proof.
`;

/* ============================================================
   NORMALIZE FORENSIC REPORT
============================================================ */

function normalizeReport(
  value
) {
  let parsed = value;

  if (
    typeof parsed ===
    "string"
  ) {
    parsed =
      safeJsonParse(parsed);

    if (!parsed) {
      return {
        suspicion:
          "INCONCLUSIVE",

        assessment:
          stripCodeFences(value),

        evidence: [],

        aiGenerationIndicators:
          [],

        authenticitySignals:
          [],

        limitations: [
          "The AI response was returned as unstructured text.",
        ],

        verificationSteps: [
          "Compare the media with its original source.",
          "Check provenance and metadata when available.",
          "Use independent verification sources.",
        ],
      };
    }
  }

  if (
    !parsed ||
    typeof parsed !==
      "object"
  ) {
    return {
      suspicion:
        "INCONCLUSIVE",

      assessment:
        "No structured forensic report was returned.",

      evidence: [],

      aiGenerationIndicators:
        [],

      authenticitySignals:
        [],

      limitations: [
        "The AI response could not be converted into a structured report.",
      ],

      verificationSteps: [
        "Retry the analysis.",
      ],
    };
  }

  const suspicion =
    safeString(
      parsed.suspicion ||
        parsed.suspicionLevel ||
        parsed.level ||
        "INCONCLUSIVE"
    ).toUpperCase();

  const allowed = [
    "LOW",
    "MEDIUM",
    "HIGH",
    "INCONCLUSIVE",
  ];

  return {
    suspicion:
      allowed.includes(
        suspicion
      )
        ? suspicion
        : "INCONCLUSIVE",

    assessment:
      safeString(
        parsed.assessment ||
          parsed.analysis ||
          parsed.summary ||
          "No assessment was returned."
      ),

    evidence:
      Array.isArray(
        parsed.evidence
      )
        ? parsed.evidence
        : [],

    aiGenerationIndicators:
      Array.isArray(
        parsed.aiGenerationIndicators
      )
        ? parsed.aiGenerationIndicators
        : Array.isArray(
            parsed.aiIndicators
          )
        ? parsed.aiIndicators
        : [],

    authenticitySignals:
      Array.isArray(
        parsed.authenticitySignals
      )
        ? parsed.authenticitySignals
        : [],

    limitations:
      Array.isArray(
        parsed.limitations
      )
        ? parsed.limitations
        : [],

    verificationSteps:
      Array.isArray(
        parsed.verificationSteps
      )
        ? parsed.verificationSteps
        : [],
  };
}

/* ============================================================
   IMAGE SIGNATURE
============================================================ */

function getImageSignature(
  buffer
) {
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
      .toString("ascii") ===
      "RIFF" &&
    buffer
      .subarray(8, 12)
      .toString("ascii") ===
      "WEBP"
  ) {
    return "webp";
  }

  if (
    buffer.length >= 6
  ) {
    const header =
      buffer
        .subarray(0, 6)
        .toString("ascii");

    if (
      header === "GIF87a" ||
      header === "GIF89a"
    ) {
      return "gif";
    }
  }

  return "unknown";
}

/* ============================================================
   LOCAL IMAGE SIGNALS
============================================================ */

function localImageSignals(
  buffer
) {
  const evidence = [];
  const authenticitySignals =
    [];

  const signature =
    getImageSignature(
      buffer
    );

  if (
    signature !==
    "unknown"
  ) {
    evidence.push(
      `Detected image container signature: ${signature}.`
    );
  }

  evidence.push(
    `File size: ${formatBytes(
      buffer.length
    )}.`
  );

  authenticitySignals.push(
    "File-level inspection completed."
  );

  return {
    evidence,
    authenticitySignals,
  };
}

/* ============================================================
   LOCAL VIDEO SIGNALS
============================================================ */

function localVideoSignals(
  buffer,
  filename
) {
  const evidence = [];
  const authenticitySignals =
    [];

  evidence.push(
    `Filename: ${filename}.`
  );

  evidence.push(
    `File size: ${formatBytes(
      buffer.length
    )}.`
  );

  const extension =
    path.extname(
      filename
    ).toLowerCase();

  if (extension) {
    evidence.push(
      `File extension: ${extension}.`
    );
  }

  authenticitySignals.push(
    "File-level inspection completed."
  );

  return {
    evidence,
    authenticitySignals,
  };
}

/* ============================================================
   IMAGE GEMINI ANALYSIS
============================================================ */

async function analyzeImageWithGemini(
  base64,
  mimeType
) {
  if (!gemini) {
    throw new Error(
      "Gemini is not configured."
    );
  }

  const prompt = `
${MEDIA_FORENSIC_PROMPT}

Return ONLY valid JSON with this structure:

{
  "suspicion": "LOW | MEDIUM | HIGH | INCONCLUSIVE",
  "assessment": "string",
  "evidence": ["string"],
  "aiGenerationIndicators": ["string"],
  "authenticitySignals": ["string"],
  "limitations": ["string"],
  "verificationSteps": ["string"]
}
`;

  const response =
    await callGemini(
      [
        {
          role: "user",

          parts: [
            {
              text: prompt,
            },

            {
              inlineData: {
                mimeType,
                data:
                  cleanBase64(
                    base64
                  ),
              },
            },
          ],
        },
      ],

      {
        temperature: 0.1,
        maxOutputTokens:
          2200,
        timeout:
          MEDIA_TIMEOUT_MS,
      }
    );

  const text =
    extractGeminiText(
      response
    );

  if (!text) {
    throw new Error(
      "Gemini returned no image analysis."
    );
  }

  return text;
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
      "Gemini is not configured."
    );
  }

  const tempDir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "trueaegis-video-"
      )
    );

  const safeFilename =
    path.basename(
      filename || "video"
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

    if (
      !uploadedFile?.name
    ) {
      throw new Error(
        "Gemini did not return an uploaded file name."
      );
    }

    console.log(
      `[MEDIA] Gemini video uploaded: ${uploadedFile.name}`
    );

    const start =
      Date.now();

    while (true) {
      const file =
        await gemini.files.get({
          name:
            uploadedFile.name,
        });

      const state =
        file?.state?.toString?.() ||
        file?.state;

      console.log(
        `[MEDIA] Gemini video state: ${
          state || "unknown"
        }`
      );

      if (
        state === "ACTIVE" ||
        state ===
          "FileState.ACTIVE"
      ) {
        uploadedFile =
          file;

        break;
      }

      if (
        state === "FAILED" ||
        state ===
          "FileState.FAILED"
      ) {
        throw new Error(
          "Gemini failed to process the video."
        );
      }

      if (
        Date.now() - start >
        VIDEO_PROCESS_TIMEOUT_MS
      ) {
        const error =
          new Error(
            "Gemini video processing timed out."
          );

        error.code = 408;

        throw error;
      }

      await sleep(
        VIDEO_POLL_INTERVAL_MS
      );
    }

    const videoPart =
      createPartFromUri(
        uploadedFile.uri,
        uploadedFile.mimeType ||
          mimeType
      );

    const prompt = `
${MEDIA_FORENSIC_PROMPT}

This is video media.

Pay attention to:
- temporal consistency
- frame-to-frame artifacts
- facial consistency
- object motion
- lighting consistency
- shadows
- reflections
- lip synchronization
- unnatural transitions
- editing/compositing indicators

Return ONLY valid JSON with this structure:

{
  "suspicion": "LOW | MEDIUM | HIGH | INCONCLUSIVE",
  "assessment": "string",
  "evidence": ["string"],
  "aiGenerationIndicators": ["string"],
  "authenticitySignals": ["string"],
  "limitations": ["string"],
  "verificationSteps": ["string"]
}
`;

    const response =
      await callGemini(
        [
          {
            role: "user",

            parts: [
              {
                text: prompt,
              },

              videoPart,
            ],
          },
        ],

        {
          temperature: 0.1,
          maxOutputTokens:
            2200,
          timeout:
            MEDIA_TIMEOUT_MS,
        }
      );

    const text =
      extractGeminiText(
        response
      );

    if (!text) {
      throw new Error(
        "Gemini returned no video analysis."
      );
    }

    return text;
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
   AI STATUS
============================================================ */

function getAIStatus() {
  return {
    gemini:
      Boolean(gemini),

    geminiModel:
      GEMINI_MODEL,

    perplexity:
      Boolean(
        PERPLEXITY_API_KEY
      ),

    perplexityModel:
      PERPLEXITY_MODEL,

    groq:
      Boolean(
        GROQ_API_KEY
      ),

    groqModel:
      GROQ_MODEL,
  };
}

/* ============================================================
   GENERIC TEXT AI HELPER

   IMPORTANT ORDER:

   Perplexity
      ↓
   Gemini
      ↓
   Groq
============================================================ */

async function generateAIResponse(
  prompt,
  options = {}
) {
  const cleanPrompt =
    cleanText(prompt);

  if (!cleanPrompt) {
    throw new Error(
      "AI prompt is empty."
    );
  }

  /* ==========================================================
     1. PERPLEXITY PRIMARY
  ========================================================== */

  try {
    if (
      PERPLEXITY_API_KEY
    ) {
      const reply =
        await callPerplexity(
          [
            {
              role:
                "system",

              content:
                options.system ||
                "You are the TrueAegis AI assistant. Give careful, useful answers and never present AI assessments as definitive proof.",
            },

            {
              role:
                "user",

              content:
                cleanPrompt,
            },
          ],

          {
            temperature:
              options.temperature ??
              0.2,

            maxTokens:
              options.maxTokens ||
              1600,

            timeout:
              options.timeout ||
              REQUEST_TIMEOUT_MS,
          }
        );

      if (reply) {
        return {
          reply,
          provider:
            "perplexity",
        };
      }
    }
  } catch (error) {
    console.warn(
      "[AI] Perplexity failed:",
      providerError(
        "perplexity",
        error
      )
    );
  }

  /* ==========================================================
     2. GEMINI FALLBACK
  ========================================================== */

  try {
    if (gemini) {
      const response =
        await callGemini(
          [
            {
              role:
                "user",

              parts: [
                {
                  text:
                    `${
                      options.system ||
                      "You are the TrueAegis AI assistant."
                    }\n\n${cleanPrompt}`,
                },
              ],
            },
          ],

          {
            temperature:
              options.temperature ??
              0.2,

            maxOutputTokens:
              options.maxTokens ||
              1800,

            timeout:
              options.timeout ||
              REQUEST_TIMEOUT_MS,
          }
        );

      const reply =
        extractGeminiText(
          response
        );

      if (reply) {
        return {
          reply,
          provider:
            "gemini-fallback",
        };
      }
    }
  } catch (error) {
    console.warn(
      "[AI] Gemini fallback failed:",
      providerError(
        "gemini",
        error
      )
    );
  }

  /* ==========================================================
     3. GROQ FINAL FALLBACK
  ========================================================== */

  try {
    if (
      GROQ_API_KEY
    ) {
      const reply =
        await callGroq(
          [
            {
              role:
                "system",

              content:
                options.system ||
                "You are the TrueAegis AI assistant. Give careful, useful answers and do not claim certainty without evidence.",
            },

            {
              role:
                "user",

              content:
                cleanPrompt,
            },
          ],

          {
            temperature:
              options.temperature ??
              0.2,

            maxTokens:
              options.maxTokens ||
              GROQ_MAX_OUTPUT_TOKENS,

            timeout:
              options.timeout ||
              REQUEST_TIMEOUT_MS,
          }
        );

      if (reply) {
        return {
          reply,
          provider:
            "groq-fallback",
        };
      }
    }
  } catch (error) {
    console.warn(
      "[AI] Groq fallback failed:",
      providerError(
        "groq",
        error
      )
    );
  }

  throw new Error(
    "All configured AI providers failed."
  );
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
  (req, res) => {
    res.json({
      success: true,

      status:
        "ok",

      service:
        "TrueAegis",

      timestamp:
        new Date().toISOString(),

      node:
        process.version,

      environment:
        NODE_ENV,

      mongo:
        mongoose.connection
          .readyState === 1,

      gemini:
        Boolean(gemini),

      geminiModel:
        GEMINI_MODEL,

      perplexity:
        Boolean(
          PERPLEXITY_API_KEY
        ),

      perplexityModel:
        PERPLEXITY_MODEL,

      groq:
        Boolean(
          GROQ_API_KEY
        ),

      groqModel:
        GROQ_MODEL,

      googleLogin:
        Boolean(
          GOOGLE_CLIENT_ID
        ),

      fallbackOrder: {
        text:
          "Perplexity -> Gemini -> Groq",

        media:
          "Gemini -> Groq",
      },
    });
  }
);

/* ============================================================
   AI CHAT
============================================================ */

app.post(
  "/api/ai-chat",
  async (req, res) => {
    const message =
      cleanText(
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

    try {
      const result =
        await generateAIResponse(
          message,
          {
            system:
              systemPrompt,

            temperature:
              0.2,

            maxTokens:
              1600,
          }
        );

      return res.json({
        success: true,

        reply:
          result.reply,

        provider:
          result.provider,
      });
    } catch (error) {
      console.error(
        "[AI CHAT] All providers failed:",
        error
      );

      return res.status(503).json({
        success: false,

        error:
          "All AI providers are temporarily unavailable. Please try again.",
      });
    }
  }
);

/* ============================================================
   CONTENT / CLAIM VERIFICATION
============================================================ */

app.post(
  "/api/content-verification",
  async (req, res) => {
    const mode =
      cleanText(
        req.body?.mode ||
          "content"
      ).toLowerCase();

    /*
      VIDEO MODE IS HANDLED SEPARATELY IN PART 2.
    */

    if (
      mode === "video"
    ) {
      return handleVideoVerification(
        req,
        res
      );
    }

    const content =
      cleanText(
        req.body?.content ||
          req.body?.claim ||
          req.body?.text ||
          req.body?.query
      );

    if (!content) {
      return res.status(400).json({
        success: false,
        error:
          "Please provide content or a claim to verify.",
      });
    }

    const prompt = `
You are TrueAegis Content Verification AI.

Your job is to examine claims, statements, and information.

This is NOT media/deepfake detection.

Analyze the following content carefully.

Identify:
- the main factual claims
- what appears supported, unsupported, or uncertain
- potentially misleading wording
- missing context
- what evidence would be useful
- practical independent verification steps

Important:
- Do not invent sources.
- Do not invent evidence.
- Clearly distinguish claims from established information.
- AI analysis is an assessment, not definitive proof.

Content to verify:

${content}

${cleanText(
  req.body?.instruction
)}
`;

    try {
      const result =
        await generateAIResponse(
          prompt,
          {
            system:
              "You are a careful content-verification assistant. Do not claim certainty without evidence.",

            temperature:
              0.15,

            maxTokens:
              1800,
          }
        );

      return res.json({
        success: true,

        mode:
          "content",

        provider:
          result.provider,

        analysis:
          result.reply,

        reply:
          result.reply,

        citations: [],
      });
    } catch (error) {
      console.error(
        "[CONTENT] All providers failed:",
        error
      );

      return res.status(503).json({
        success: false,

        error:
          "Content verification is temporarily unavailable.",
      });
    }
  }
);

/* ============================================================
   NEWS ANALYSIS
============================================================ */

app.post(
  "/api/news-analysis",
  async (req, res) => {
    const query =
      cleanText(
        req.body?.query ||
          req.body?.content ||
          req.body?.text
      );

    if (!query) {
      return res.status(400).json({
        success: false,

        error:
          "Please provide a news topic, headline, or claim.",
      });
    }

    const prompt = `
You are the TrueAegis News Analysis assistant.

Analyze this news-related query:

${query}

Provide:

1. What the claim appears to be saying.
2. Important context.
3. What should be verified.
4. Potential warning signs.
5. A reminder that AI analysis is not definitive proof.

Do not invent sources or facts.
`;

    try {
      const result =
        await generateAIResponse(
          prompt,
          {
            system:
              "You are a careful news-analysis assistant. Distinguish verified information from uncertainty. Never invent citations.",

            temperature:
              0.15,

            maxTokens:
              1800,
          }
        );

      return res.json({
        success: true,

        provider:
          result.provider,

        analysis:
          result.reply,

        reply:
          result.reply,

        citations: [],
      });
    } catch (error) {
      console.error(
        "[NEWS] All providers failed:",
        error
      );

      return res.status(503).json({
        success: false,

        error:
          "News analysis is temporarily unavailable.",
      });
    }
  }
);

/* ============================================================
   VIDEO VERIFICATION
============================================================ */

async function handleVideoVerification(
  req,
  res
) {
  let tempDir = null;

  try {
    const rawVideo =
      req.body?.video ||
      req.body?.media ||
      req.body?.data;

    const filename =
      safeString(
        req.body?.filename ||
          "verification-video.mp4"
      );

    const mimeType =
      safeString(
        req.body?.mimeType ||
          "video/mp4"
      )
        .split(";")[0]
        .trim()
        .toLowerCase();

    if (!rawVideo) {
      return res.status(400).json({
        success: false,
        error:
          "No video was provided.",
      });
    }

    const base64 =
      cleanBase64(
        rawVideo
      );

    if (!base64) {
      return res.status(400).json({
        success: false,
        error:
          "The supplied video data is empty.",
      });
    }

    let buffer;

    try {
      buffer =
        Buffer.from(
          base64,
          "base64"
        );
    } catch {
      return res.status(400).json({
        success: false,
        error:
          "The supplied video data is invalid.",
      });
    }

    if (!buffer.length) {
      return res.status(400).json({
        success: false,
        error:
          "The supplied video is empty.",
      });
    }

    if (
      buffer.length >
      MAX_MEDIA_BYTES
    ) {
      return res.status(413).json({
        success: false,
        error:
          `Video is too large. Maximum supported size is ${formatBytes(
            MAX_MEDIA_BYTES
          )}.`,
      });
    }

    if (
      !mimeType.startsWith(
        "video/"
      )
    ) {
      return res.status(415).json({
        success: false,
        error:
          `Unsupported video type: ${mimeType}`,
      });
    }

    const prompt = `
You are the TrueAegis Video Verification AI.

This mode is NOT deepfake detection.

Analyze the claims, statements, events, and information
contained in the supplied video.

Determine:
- what claims are being made
- which claims appear supported or unsupported
- what information is uncertain
- potentially misleading statements
- missing context
- what should be independently verified

Do not invent facts, sources, or evidence.

Important:
This is an AI assessment and is not definitive proof.

Return ONLY valid JSON:

{
  "status": "SUPPORTED | MIXED | UNSUPPORTED | UNCERTAIN",
  "summary": "string",
  "claims": [
    {
      "claim": "string",
      "assessment": "SUPPORTED | MIXED | UNSUPPORTED | UNCERTAIN",
      "reason": "string"
    }
  ],
  "evidence": ["string"],
  "limitations": ["string"],
  "verificationSteps": ["string"]
}
`;

    /* ========================================================
       GEMINI PRIMARY
    ======================================================== */

    try {
      if (gemini) {
        tempDir =
          fs.mkdtempSync(
            path.join(
              os.tmpdir(),
              "trueaegis-video-verification-"
            )
          );

        const safeFilename =
          path.basename(
            filename
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

        console.log(
          `[VIDEO VERIFY] Uploading ${safeFilename} to Gemini.`
        );

        const uploaded =
          await gemini.files.upload({
            file: tempPath,

            config: {
              mimeType,
            },
          });

        if (
          !uploaded?.name
        ) {
          throw new Error(
            "Gemini did not return a video file reference."
          );
        }

        const startedAt =
          Date.now();

        let activeFile =
          uploaded;

        while (true) {
          const current =
            await gemini.files.get({
              name:
                uploaded.name,
            });

          const state =
            current?.state?.toString?.() ||
            current?.state;

          console.log(
            `[VIDEO VERIFY] Gemini state: ${
              state || "unknown"
            }`
          );

          if (
            state === "ACTIVE" ||
            state ===
              "FileState.ACTIVE"
          ) {
            activeFile =
              current;

            break;
          }

          if (
            state === "FAILED" ||
            state ===
              "FileState.FAILED"
          ) {
            throw new Error(
              "Gemini failed to process the video."
            );
          }

          if (
            Date.now() -
              startedAt >
            VIDEO_PROCESS_TIMEOUT_MS
          ) {
            const timeoutError =
              new Error(
                "Gemini video verification timed out."
              );

            timeoutError.code =
              408;

            throw timeoutError;
          }

          await sleep(
            VIDEO_POLL_INTERVAL_MS
          );
        }

        const videoPart =
          createPartFromUri(
            activeFile.uri,
            activeFile.mimeType ||
              mimeType
          );

        const response =
          await callGemini(
            [
              {
                role:
                  "user",

                parts: [
                  {
                    text:
                      prompt,
                  },

                  videoPart,
                ],
              },
            ],

            {
              temperature:
                0.1,

              maxOutputTokens:
                2200,

              timeout:
                MEDIA_TIMEOUT_MS,
            }
          );

        const text =
          extractGeminiText(
            response
          );

        if (!text) {
          throw new Error(
            "Gemini returned an empty video-verification response."
          );
        }

        const parsed =
          safeJsonParse(
            text
          );

        return res.json({
          success: true,

          mode:
            "video",

          provider:
            "gemini",

          result:
            parsed || {
              status:
                "UNCERTAIN",

              summary:
                stripCodeFences(
                  text
                ),

              claims: [],

              evidence: [],

              limitations: [
                "The response was returned as unstructured text.",
              ],

              verificationSteps: [
                "Check the original source.",
                "Compare the claims with reliable independent sources.",
              ],
            },

          analysis:
            parsed ||
            stripCodeFences(
              text
            ),

          warning:
            "AI assessment — not definitive proof.",
        });
      }
    } catch (error) {
      console.warn(
        "[VIDEO VERIFY] Gemini failed. Activating Groq fallback:",
        providerError(
          "gemini",
          error
        )
      );
    } finally {
      if (tempDir) {
        try {
          fs.rmSync(
            tempDir,
            {
              recursive: true,
              force: true,
            }
          );
        } catch {}

        tempDir =
          null;
      }
    }

    /* ========================================================
       GROQ FALLBACK

       Groq receives a representative image/frame when
       direct Gemini video analysis fails.

       We explicitly identify this as a fallback and do NOT
       pretend Groq performed full temporal video analysis.
    ======================================================== */

    try {
      if (GROQ_API_KEY) {
        const fallbackPrompt = `
You are the TrueAegis Video Verification fallback AI.

The primary video-analysis provider was unavailable.

You are being given a representative visual frame from the
video rather than the complete temporal video stream.

Analyze ONLY what can reasonably be assessed from this frame.

Do NOT claim that you verified the entire video.

Identify:
- visible claims or statements if they are readable
- visible context
- potentially misleading information
- information that requires independent verification

Return ONLY valid JSON:

{
  "status": "SUPPORTED | MIXED | UNSUPPORTED | UNCERTAIN",
  "summary": "string",
  "claims": [
    {
      "claim": "string",
      "assessment": "SUPPORTED | MIXED | UNSUPPORTED | UNCERTAIN",
      "reason": "string"
    }
  ],
  "evidence": ["string"],
  "limitations": [
    "This fallback inspected a representative frame rather than the full video."
  ],
  "verificationSteps": ["string"]
}
`;

        /*
          Without a video-decoding dependency, use the first
          available visual representation only when one was
          supplied by the frontend.
        */

        const frame =
          cleanBase64(
            req.body?.frame ||
              req.body?.thumbnail ||
              req.body?.previewImage ||
              ""
          );

        if (frame) {
          const frameMime =
            safeString(
              req.body?.frameMimeType ||
                "image/jpeg"
            )
              .split(";")[0]
              .trim()
              .toLowerCase();

          const raw =
            await callGroqVision(
              frame,
              frameMime,
              fallbackPrompt,
              {
                maxTokens:
                  2200,

                timeout:
                  MEDIA_TIMEOUT_MS,
              }
            );

          const parsed =
            safeJsonParse(
              raw
            );

          return res.json({
            success: true,

            mode:
              "video",

            provider:
              "groq-fallback",

            fallbackType:
              "representative-frame",

            result:
              parsed || {
                status:
                  "UNCERTAIN",

                summary:
                  stripCodeFences(
                    raw
                  ),

                claims: [],

                evidence: [],

                limitations: [
                  "Groq inspected a representative frame, not the complete video.",
                ],

                verificationSteps: [
                  "Retry when Gemini video analysis is available.",
                  "Check the original video source.",
                  "Verify important claims independently.",
                ],
              },

            analysis:
              parsed ||
              stripCodeFences(
                raw
              ),

            warning:
              "Gemini video analysis failed. Groq analyzed a representative frame only; this is not a complete video verification.",
          });
        }

        /*
          If the frontend did not provide a representative
          frame, do not fake a video analysis.
        */

        return res.status(503).json({
          success: false,

          error:
            "Gemini video verification failed and no representative frame was available for the Groq fallback.",

          provider:
            "groq-fallback-unavailable",
        });
      }
    } catch (error) {
      console.warn(
        "[VIDEO VERIFY] Groq fallback failed:",
        providerError(
          "groq",
          error
        )
      );
    }

    return res.status(503).json({
      success: false,

      error:
        "Video verification is temporarily unavailable. Gemini and Groq could not complete the analysis.",
    });
  } catch (error) {
    console.error(
      "[VIDEO VERIFY] Unexpected error:",
      error
    );

    return res.status(500).json({
      success: false,

      error:
        "Video verification failed unexpectedly.",

      details:
        NODE_ENV ===
        "production"
          ? undefined
          : error.message,
    });
  }
}

/* ============================================================
   MEDIA / DEEPFAKE ANALYSIS
============================================================ */

app.post(
  "/api/media-analysis",
  async (req, res) => {
    try {
      const rawMedia =
        req.body?.image ||
        req.body?.media ||
        req.body?.data;

      const filename =
        safeString(
          req.body?.filename ||
            "uploaded-media"
        );

      let mimeType =
        safeString(
          req.body?.mimeType
        )
          .split(";")[0]
          .trim()
          .toLowerCase();

      if (!rawMedia) {
        return res.status(400).json({
          success: false,

          error:
            "No media was provided.",
        });
      }

      const base64 =
        cleanBase64(
          rawMedia
        );

      if (!base64) {
        return res.status(400).json({
          success: false,

          error:
            "The supplied media data is empty.",
        });
      }

      let buffer;

      try {
        buffer =
          Buffer.from(
            base64,
            "base64"
          );
      } catch {
        return res.status(400).json({
          success: false,

          error:
            "The supplied media data is invalid.",
        });
      }

      if (!buffer.length) {
        return res.status(400).json({
          success: false,

          error:
            "The supplied media file is empty.",
        });
      }

      if (
        buffer.length >
        MAX_MEDIA_BYTES
      ) {
        return res.status(413).json({
          success: false,

          error:
            `Media is too large. Maximum supported size is ${formatBytes(
              MAX_MEDIA_BYTES
            )}.`,
        });
      }

      if (!mimeType) {
        const extension =
          path.extname(
            filename
          ).toLowerCase();

        const mimeMap = {
          ".jpg":
            "image/jpeg",

          ".jpeg":
            "image/jpeg",

          ".png":
            "image/png",

          ".webp":
            "image/webp",

          ".gif":
            "image/gif",

          ".mp4":
            "video/mp4",

          ".webm":
            "video/webm",

          ".mov":
            "video/quicktime",

          ".avi":
            "video/x-msvideo",

          ".mkv":
            "video/x-matroska",
        };

        mimeType =
          mimeMap[
            extension
          ] ||
          "application/octet-stream";
      }

      const isImage =
        mimeType.startsWith(
          "image/"
        );

      const isVideo =
        mimeType.startsWith(
          "video/"
        );

      console.log(
        `[MEDIA] ${filename} | ${mimeType} | ${formatBytes(
          buffer.length
        )}`
      );

      if (
        !isImage &&
        !isVideo
      ) {
        return res.status(415).json({
          success: false,

          error:
            `Unsupported media type: ${mimeType}`,
        });
      }

      /* ========================================================
         IMAGE DEEPFAKE ANALYSIS
      ======================================================== */

      if (isImage) {
        const signature =
          getImageSignature(
            buffer
          );

        if (
          ![
            "png",
            "jpeg",
            "webp",
            "gif",
          ].includes(signature)
        ) {
          return res.status(400).json({
            success: false,

            error:
              "The uploaded file does not appear to be a valid supported image.",
          });
        }

        const localSignals =
          localImageSignals(
            buffer
          );

        /* ------------------------------------------------------
           GEMINI PRIMARY
        ------------------------------------------------------ */

        try {
          if (gemini) {
            console.log(
              "[MEDIA] Gemini Vision primary."
            );

            const rawAnalysis =
              await analyzeImageWithGemini(
                base64,
                mimeType
              );

            const report =
              normalizeReport(
                rawAnalysis
              );

            return res.json({
              success: true,

              type:
                "image",

              filename,

              mimeType,

              provider:
                "gemini",

              report,

              suspicionLevel:
                report.suspicion,

              analysis:
                report.assessment,

              warning:
                "AI assessment — not definitive proof.",
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

        /* ------------------------------------------------------
           GROQ VISION FALLBACK
        ------------------------------------------------------ */

        try {
          if (GROQ_API_KEY) {
            console.log(
              "[MEDIA] Gemini failed. Groq Vision fallback."
            );

            const rawAnalysis =
              await callGroqVision(
                base64,
                mimeType,
                MEDIA_FORENSIC_PROMPT,
                {
                  maxTokens:
                    2200,

                  timeout:
                    MEDIA_TIMEOUT_MS,
                }
              );

            const report =
              normalizeReport(
                rawAnalysis
              );

            return res.json({
              success: true,

              type:
                "image",

              filename,

              mimeType,

              provider:
                "groq-fallback",

              report,

              suspicionLevel:
                report.suspicion,

              analysis:
                report.assessment,

              warning:
                "Gemini was unavailable. Groq provided the fallback AI assessment. This is not definitive proof.",
            });
          }
        } catch (error) {
          console.warn(
            "[MEDIA] Groq Vision failed:",
            providerError(
              "groq",
              error
            )
          );
        }

        /* ------------------------------------------------------
           LOCAL LAST RESORT
        ------------------------------------------------------ */

        const report =
          normalizeReport({
            suspicion:
              "INCONCLUSIVE",

            assessment:
              "The AI media-analysis providers were unavailable. TrueAegis completed a local technical inspection only and cannot determine whether the image is authentic or manipulated.",

            evidence:
              localSignals.evidence,

            aiGenerationIndicators:
              [],

            authenticitySignals:
              localSignals.authenticitySignals,

            limitations: [
              "Local technical inspection cannot reliably determine whether an image was AI-generated or manipulated.",

              "No AI forensic conclusion was available.",
            ],

            verificationSteps: [
              "Retry the AI analysis.",

              "Compare the image against its original source.",

              "Check provenance and metadata when available.",

              "Use independent verification sources.",
            ],
          });

        return res.json({
          success: true,

          type:
            "image",

          filename,

          mimeType,

          provider:
            "local-forensic-fallback",

          report,

          suspicionLevel:
            "INCONCLUSIVE",

          analysis:
            report.assessment,

          warning:
            "AI providers were unavailable. This result is an inconclusive technical inspection, not proof of authenticity or manipulation.",
        });
      }

      /* ========================================================
         VIDEO DEEPFAKE ANALYSIS
      ======================================================== */

      if (isVideo) {
        const localSignals =
          localVideoSignals(
            buffer,
            filename
          );

        /* ------------------------------------------------------
           GEMINI VIDEO PRIMARY
        ------------------------------------------------------ */

        try {
          if (gemini) {
            console.log(
              "[MEDIA] Gemini Video primary."
            );

            const rawAnalysis =
              await analyzeVideoWithGemini(
                buffer,
                mimeType,
                filename
              );

            const report =
              normalizeReport(
                rawAnalysis
              );

            return res.json({
              success: true,

              type:
                "video",

              filename,

              mimeType,

              provider:
                "gemini",

              report,

              suspicionLevel:
                report.suspicion,

              analysis:
                report.assessment,

              warning:
                "AI assessment — not definitive proof.",
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

        /* ------------------------------------------------------
           GROQ FALLBACK
        ------------------------------------------------------ */

        try {
          if (GROQ_API_KEY) {
            const frame =
              cleanBase64(
                req.body?.frame ||
                  req.body?.thumbnail ||
                  req.body?.previewImage ||
                  ""
              );

            if (frame) {
              const frameMime =
                safeString(
                  req.body?.frameMimeType ||
                    "image/jpeg"
                )
                  .split(";")[0]
                  .trim()
                  .toLowerCase();

              console.log(
                "[MEDIA] Gemini failed. Groq representative-frame fallback."
              );

              const fallbackPrompt = `
${MEDIA_FORENSIC_PROMPT}

IMPORTANT:
The primary Gemini video analysis failed.

You are receiving only a representative frame from the
video, not the entire video.

Analyze only what is visible in this frame.

Do not claim that you inspected the complete video.

Return ONLY valid JSON:

{
  "suspicion": "LOW | MEDIUM | HIGH | INCONCLUSIVE",
  "assessment": "string",
  "evidence": ["string"],
  "aiGenerationIndicators": ["string"],
  "authenticitySignals": ["string"],
  "limitations": ["string"],
  "verificationSteps": ["string"]
}
`;

              const rawAnalysis =
                await callGroqVision(
                  frame,
                  frameMime,
                  fallbackPrompt,
                  {
                    maxTokens:
                      2200,

                    timeout:
                      MEDIA_TIMEOUT_MS,
                  }
                );

              const report =
                normalizeReport(
                  rawAnalysis
                );

              return res.json({
                success: true,

                type:
                  "video",

                filename,

                mimeType,

                provider:
                  "groq-fallback",

                fallbackType:
                  "representative-frame",

                report,

                suspicionLevel:
                  report.suspicion,

                analysis:
                  report.assessment,

                warning:
                  "Gemini video analysis failed. Groq analyzed a representative frame only; this is not a complete video analysis.",
              });
            }
          }
        } catch (error) {
          console.warn(
            "[MEDIA] Groq video fallback failed:",
            providerError(
              "groq",
              error
            )
          );
        }

        /* ------------------------------------------------------
           LOCAL FALLBACK
        ------------------------------------------------------ */

        const report =
          normalizeReport({
            suspicion:
              "INCONCLUSIVE",

            assessment:
              "Gemini video analysis was unavailable and no usable representative frame was available for the Groq fallback. TrueAegis completed a local technical inspection only.",

            evidence:
              localSignals.evidence,

            aiGenerationIndicators:
              [],

            authenticitySignals:
              localSignals.authenticitySignals,

            limitations: [
              "Local video inspection cannot establish authenticity.",

              "AI video analysis was unavailable.",

              "No definitive conclusion can be made from file-level information alone.",
            ],

            verificationSteps: [
              "Retry the video analysis.",

              "Compare the video with the original source.",

              "Check provenance and independent reporting.",

              "Review suspicious frames manually.",
            ],
          });

        return res.json({
          success: true,

          type:
            "video",

          filename,

          mimeType,

          provider:
            "local-video-fallback",

          report,

          suspicionLevel:
            "INCONCLUSIVE",

          analysis:
            report.assessment,

          warning:
            "AI video analysis was unavailable. This result is inconclusive and is not proof of authenticity or manipulation.",
        });
      }
    } catch (error) {
      console.error(
        "[MEDIA] Unexpected error:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          "Media analysis failed unexpectedly.",

        details:
          NODE_ENV ===
          "production"
            ? undefined
            : error.message,
      });
    }
  }
);

/* ============================================================
   VERIFY CONTENT — COMPATIBILITY ROUTE
============================================================ */

app.post(
  "/api/verify-content",
  async (req, res) => {
    const content =
      cleanText(
        req.body?.content ||
          req.body?.claim ||
          req.body?.text
      );

    if (!content) {
      return res.status(400).json({
        success: false,

        error:
          "Please provide content to verify.",
      });
    }

    const prompt = `
Verify the following claim or statement
for TrueAegis.

Do not invent sources.

Explain:
- the claim
- what can be established
- uncertainty
- missing context
- verification steps

Claim:

${content}
`;

    try {
      const result =
        await generateAIResponse(
          prompt,
          {
            system:
              "You are the TrueAegis content verification assistant. Be evidence-aware and transparent about uncertainty.",

            temperature:
              0.15,

            maxTokens:
              1800,
          }
        );

      return res.json({
        success: true,

        provider:
          result.provider,

        analysis:
          result.reply,

        reply:
          result.reply,

        citations: [],
      });
    } catch (error) {
      console.error(
        "[VERIFY CONTENT] Provider chain failed:",
        error
      );

      return res.status(503).json({
        success: false,

        error:
          "Content verification is temporarily unavailable.",
      });
    }
  }
);

/* ============================================================
   GENERIC ANALYZE — COMPATIBILITY ROUTE
============================================================ */

app.post(
  "/api/analyze",
  async (req, res) => {
    const prompt =
      cleanText(
        req.body?.prompt ||
          req.body?.query ||
          req.body?.content ||
          req.body?.text
      );

    if (!prompt) {
      return res.status(400).json({
        success: false,

        error:
          "Please provide something to analyze.",
      });
    }

    try {
      const result =
        await generateAIResponse(
          prompt,
          {
            system:
              "You are the TrueAegis analysis assistant. Provide careful, transparent analysis and distinguish uncertainty from established facts.",

            temperature:
              0.2,

            maxTokens:
              1800,
          }
        );

      return res.json({
        success: true,

        provider:
          result.provider,

        analysis:
          result.reply,

        reply:
          result.reply,
      });
    } catch (error) {
      console.error(
        "[ANALYZE] Provider chain failed:",
        error
      );

      return res.status(503).json({
        success: false,

        error:
          "AI analysis is temporarily unavailable.",
      });
    }
  }
);

/* ============================================================
   API ROOT
============================================================ */

app.get(
  "/api",
  (req, res) => {
    res.json({
      success: true,

      service:
        "TrueAegis API",

      status:
        "online",

      version:
        "2.0",

      fallbackOrder: {
        text:
          "Perplexity -> Gemini -> Groq",

        media:
          "Gemini -> Groq",
      },

      endpoints: [
        "/api/health",
        "/api/ai-chat",
        "/api/news-analysis",
        "/api/content-verification",
        "/api/video-verification",
        "/api/media-analysis",
        "/api/verify-content",
        "/api/analyze",
      ],
    });
  }
);

/* ============================================================
   API 404
============================================================ */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      success: false,

      error:
        "API endpoint not found.",

      path:
        req.originalUrl,

      method:
        req.method,
    });
  }
);

/* ============================================================
   STATIC FRONTEND
============================================================ */

app.use(
  express.static(
    PUBLIC_DIR,
    {
      extensions: [
        "html",
      ],

      index:
        "index.html",
    }
  )
);

/* ============================================================
   FRONTEND ROUTES
============================================================ */

const frontendPages = [
  "index.html",
  "login.html",
  "register.html",
  "dashboard.html",
  "services.html",
  "security.html",
  "dragon.html",
];

for (
  const page of frontendPages
) {
  const route =
    page ===
    "index.html"
      ? "/"
      : `/${page.replace(
          ".html",
          ""
        )}`;

  app.get(
    route,
    (req, res) => {
      const filePath =
        path.join(
          PUBLIC_DIR,
          page
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

      return res.status(404).send(
        "Page not found."
      );
    }
  );
}

/* ============================================================
   FRONTEND SPA FALLBACK
============================================================ */

app.use(
  (req, res, next) => {
    if (
      req.method !==
      "GET"
    ) {
      return next();
    }

    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return next();
    }

    const indexPath =
      path.join(
        PUBLIC_DIR,
        "index.html"
      );

    if (
      fs.existsSync(
        indexPath
      )
    ) {
      return res.sendFile(
        indexPath
      );
    }

    return next();
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
      "[SERVER ERROR]",
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res.status(
      Number(
        error?.status ||
          500
      )
    ).json({
      success: false,

      error:
        error?.message ||
        "Internal server error.",
    });
  }
);

/* ============================================================
   MONGODB
============================================================ */

async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn(
      "[MongoDB] MONGODB_URI is missing."
    );

    return false;
  }

  try {
    await mongoose.connect(
      MONGODB_URI,
      {
        serverSelectionTimeoutMS:
          10000,
      }
    );

    console.log(
      "[MongoDB] Connected successfully."
    );

    return true;
  } catch (error) {
    console.error(
      "[MongoDB] Connection failed:",
      error.message
    );

    return false;
  }
}

/* ============================================================
   GOOGLE OAUTH CALLBACK
============================================================ */

let googleClient =
  null;

if (
  GOOGLE_CLIENT_ID &&
  GOOGLE_CLIENT_SECRET
) {
  googleClient =
    new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );
}

app.get(
  "/api/auth/google/callback",
  async (req, res) => {
    if (!googleClient) {
      return res
        .status(503)
        .send(
          "Google Login is not configured."
        );
    }

    const code =
      safeString(
        req.query?.code
      );

    if (!code) {
      return res
        .status(400)
        .send(
          "Missing Google authorization code."
        );
    }

    try {
      const { tokens } =
        await googleClient.getToken(
          code
        );

      googleClient.setCredentials(
        tokens
      );

      const ticket =
        await googleClient.verifyIdToken(
          {
            idToken:
              tokens.id_token,

            audience:
              GOOGLE_CLIENT_ID,
          }
        );

      const payload =
        ticket.getPayload();

      if (!payload) {
        throw new Error(
          "Google did not return a valid user payload."
        );
      }

      const params =
        new URLSearchParams({
          google:
            "success",

          name:
            payload.name ||
            "",

          email:
            payload.email ||
            "",

          picture:
            payload.picture ||
            "",

          sub:
            payload.sub ||
            "",
        });

      return res.redirect(
        `/?${params.toString()}`
      );
    } catch (error) {
      console.error(
        "[GOOGLE] OAuth callback failed:",
        error
      );

      return res.redirect(
        "/?google=error"
      );
    }
  }
);

/* ============================================================
   ROBOTS.TXT
============================================================ */

app.get(
  "/robots.txt",
  (req, res) => {
    res.type(
      "text/plain"
    );

    const base =
      process.env.BASE_URL ||
      `http://localhost:${PORT}`;

    res.send(
      [
        "User-agent: *",
        "Allow: /",
        `Sitemap: ${base}/sitemap.xml`,
      ].join("\n")
    );
  }
);

/* ============================================================
   SITEMAP
============================================================ */

app.get(
  "/sitemap.xml",
  (req, res) => {
    res.type(
      "application/xml"
    );

    const base =
      process.env.BASE_URL ||
      `http://localhost:${PORT}`;

    res.send(`
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/</loc>
  </url>
</urlset>
`);
  }
);

/* ============================================================
   START SERVER
============================================================ */

async function startServer() {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    "           STARTING TRUEAEGIS"
  );
  console.log(
    "=============================================="
  );

  console.log(
    `Environment: ${NODE_ENV}`
  );

  console.log(
    `Port: ${PORT}`
  );

  console.log(
    `Public directory: ${PUBLIC_DIR}`
  );

  console.log(
    `Gemini: ${
      gemini
        ? "configured"
        : "missing"
    }`
  );

  console.log(
    `Gemini model: ${GEMINI_MODEL}`
  );

  console.log(
    `Perplexity: ${
      PERPLEXITY_API_KEY
        ? "configured"
        : "missing"
    }`
  );

  console.log(
    `Perplexity model: ${PERPLEXITY_MODEL}`
  );

  console.log(
    `Groq: ${
      GROQ_API_KEY
        ? "configured"
        : "missing"
    }`
  );

  console.log(
    `Groq model: ${GROQ_MODEL}`
  );

  console.log(
    "Text fallback: Perplexity -> Gemini -> Groq"
  );

  console.log(
    "Media fallback: Gemini -> Groq"
  );

  await connectMongo();

  app.listen(
    PORT,
    HOST,
    () => {
      console.log("");
      console.log(
        "=============================================="
      );
      console.log(
        "        TRUEAEGIS IS RUNNING"
      );
      console.log(
        "=============================================="
      );

      console.log(
        `Local: http://localhost:${PORT}`
      );

      console.log(
        `Health: http://localhost:${PORT}/api/health`
      );

      console.log(
        `Public directory: ${PUBLIC_DIR}`
      );

      console.log(
        "=============================================="
      );
      console.log("");
    }
  );
}

/* ============================================================
   GRACEFUL SHUTDOWN
============================================================ */

async function shutdown(
  signal
) {
  console.log(
    `\nReceived ${signal}. Shutting down...`
  );

  try {
    await mongoose.connection.close();

    console.log(
      "MongoDB connection closed."
    );
  } catch (error) {
    console.error(
      "MongoDB shutdown error:",
      error.message
    );
  }

  process.exit(0);
}

process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);

process.on(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

/* ============================================================
   PROCESS ERROR HANDLERS
============================================================ */

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "Unhandled promise rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

/* ============================================================
   START
============================================================ */

startServer().catch(
  (error) => {
    console.error(
      "Failed to start TrueAegis:",
      error
    );

    process.exit(1);
  }
);