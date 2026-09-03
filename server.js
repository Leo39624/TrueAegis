// ============================================================
// TRUEAEGIS AI - MAIN SERVER
// Production Backend
// ============================================================

require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const { GoogleGenAI } = require("@google/genai");
const { OAuth2Client } = require("google-auth-library");

// Authentication routes
const authRoutes = require("./routes/auth");

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// ============================================================
// CONFIGURATION
// ============================================================

const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-3.6-flash";

const GOOGLE_CLOUD_LOCATION =
    process.env.GOOGLE_CLOUD_LOCATION ||
    "global";

const BASE_URL =
    process.env.BASE_URL ||
    `http://localhost:${PORT}`;

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
    cors({
        origin: true,
        credentials: true
    })
);

app.use(
    express.json({
        limit: "25mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "25mb"
    })
);

// ============================================================
// STATIC FILES
// ============================================================

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

// ============================================================
// DATABASE
// ============================================================

mongoose.set(
    "strictQuery",
    true
);

async function connectMongoDB() {
    const uri =
        process.env.MONGODB_URI;

    if (!uri) {
        console.error(
            "❌ MONGODB_URI is missing."
        );
        return;
    }

    try {
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS:
                10000
        });

        console.log(
            "✅ MongoDB Connected"
        );
    }
    catch (error) {
        console.error(
            "❌ MongoDB Connection Error:",
            error.message
        );
    }
}

// ============================================================
// GEMINI
// ============================================================

let geminiClient = null;

function initializeGemini() {
    const apiKey =
        process.env.GEMINI_API_KEY;

    if (!apiKey) {
        console.warn(
            "⚠️ GEMINI_API_KEY is not configured."
        );
        return;
    }

    try {
        geminiClient =
            new GoogleGenAI({
                apiKey
            });

        console.log(
            "🤖 Gemini: Developer API mode enabled"
        );
    }
    catch (error) {
        console.error(
            "❌ Gemini initialization failed:",
            error.message
        );
    }
}

// ============================================================
// GEMINI GENERATION HELPER
// ============================================================

async function callGemini(
    contents,
    options = {}
) {
    if (!geminiClient) {
        throw new Error(
            "Gemini is not configured on the server."
        );
    }

    const response =
        await geminiClient.models.generateContent(
            {
                model:
                    options.model ||
                    GEMINI_MODEL,

                contents,

                config: {
                    temperature:
                        options.temperature ??
                        0.2,

                    maxOutputTokens:
                        options.maxOutputTokens ??
                        1200
                }
            }
        );

    const text =
        response?.text ||
        response?.candidates?.[0]
            ?.content?.parts
            ?.map(
                part =>
                    part.text || ""
            )
            .join("") ||
        "";

    if (!text.trim()) {
        throw new Error(
            "Gemini returned an empty response."
        );
    }

    return text;
}

// ============================================================
// PERPLEXITY HELPER
// ============================================================

async function callPerplexity(
    messages,
    options = {}
) {
    const apiKey =
        process.env.PERPLEXITY_API_KEY;

    if (!apiKey) {
        throw new Error(
            "PERPLEXITY_API_KEY is missing."
        );
    }

    const maxAttempts =
        options.retries ?? 2;

    let lastError = null;

    for (
        let attempt = 0;
        attempt <= maxAttempts;
        attempt++
    ) {
        try {
            const response =
                await fetch(
                    "https://api.perplexity.ai/chat/completions",
                    {
                        method:
                            "POST",

                        headers: {
                            "Authorization":
                                `Bearer ${apiKey}`,

                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                model:
                                    options.model ||
                                    "sonar",

                                messages,

                                temperature:
                                    options.temperature ??
                                    0.2,

                                max_tokens:
                                    options.max_tokens ??
                                    1200
                            })
                    }
                );

            const data =
                await response.json();

            if (!response.ok) {
                const error =
                    new Error(
                        data?.error?.message ||
                        "Perplexity API request failed."
                    );

                error.status =
                    response.status;

                error.providerData =
                    data;

                const temporary =
                    [
                        429,
                        500,
                        502,
                        503,
                        504
                    ].includes(
                        response.status
                    );

                if (
                    temporary &&
                    attempt < maxAttempts
                ) {
                    const delay =
                        500 *
                        Math.pow(
                            2,
                            attempt
                        );

                    console.warn(
                        `⚠️ Perplexity temporary error ${response.status}. ` +
                        `Retrying in ${delay}ms...`
                    );

                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                delay
                            )
                    );

                    continue;
                }

                throw error;
            }

            const reply =
                data
                    ?.choices?.[0]
                    ?.message
                    ?.content ||
                "";

            if (!reply.trim()) {
                throw new Error(
                    "Perplexity returned an empty response."
                );
            }

            return reply;
        }
        catch (error) {
            lastError =
                error;

            const temporary =
                [
                    429,
                    500,
                    502,
                    503,
                    504
                ].includes(
                    error?.status
                );

            if (
                temporary &&
                attempt < maxAttempts
            ) {
                const delay =
                    500 *
                    Math.pow(
                        2,
                        attempt
                    );

                console.warn(
                    `⚠️ Perplexity request failed. ` +
                    `Retrying in ${delay}ms...`
                );

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            delay
                        )
                );

                continue;
            }

            throw error;
        }
    }

    throw (
        lastError ||
        new Error(
            "Perplexity request failed."
        )
    );
}

// ============================================================
// AUTH ROUTES
// ============================================================

app.use(
    "/api/auth",
    authRoutes
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
    "/api/health",
    async (req, res) => {
        res.json({
            success: true,

            status:
                "TRUEAEGIS ONLINE",

            server:
                "running",

            database:
                mongoose.connection
                    .readyState === 1
                    ? "connected"
                    : "disconnected",

            ai: {
                gemini:
                    !!geminiClient,

                perplexity:
                    !!process.env
                        .PERPLEXITY_API_KEY,

                geminiMode:
                    "gemini-api",

                geminiModel:
                    GEMINI_MODEL
            },

            timestamp:
                new Date().toISOString()
        });
    }
);

// ============================================================
// ROOT
// ============================================================

app.get(
    "/",
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                "public",
                "index.html"
            )
        );
    }
);

// ============================================================
// AI CHATBOT - AEGIS
// ============================================================

app.post(
    "/api/ai-chat",
    async (req, res) => {
        try {
            const {
                message,
                messages,
                history
            } = req.body;

            if (
                !message &&
                !messages &&
                !history
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Please provide a message."
                });
            }

            let chatMessages = [];

            if (
                Array.isArray(messages)
            ) {
                chatMessages =
                    messages;
            }
            else if (
                Array.isArray(history)
            ) {
                chatMessages =
                    history;
            }
            else {
                chatMessages = [
                    {
                        role:
                            "user",

                        content:
                            String(
                                message
                            )
                    }
                ];
            }

            chatMessages =
                chatMessages
                    .filter(
                        item =>
                            item &&
                            item.content
                    )
                    .slice(-20);

            const systemMessage = {
                role:
                    "system",

                content:
                    `You are Aegis, the AI assistant inside TrueAegis.

TrueAegis is a Digital Trust Intelligence Platform designed to help users investigate potentially manipulated media, verify content, analyze news, and understand digital evidence.

Your job is to be:
- helpful
- calm
- accurate
- curious
- professional
- easy to understand

Important rules:
1. Never claim that AI analysis is absolute proof.
2. Clearly distinguish evidence, indicators, uncertainty, and conclusions.
3. When discussing potentially manipulated media, explain that AI detection can produce false positives and false negatives.
4. Encourage users to verify important claims using independent evidence.
5. Do not invent sources, evidence, statistics, or investigation results.
6. If you do not know something, say so.
7. Keep answers concise unless the user asks for detail.
8. Do not present speculation as fact.
9. For safety-sensitive topics, give responsible general information.
10. You are an AI assistant, not a forensic laboratory or legal authority.

When useful, structure answers using:
- Assessment
- Evidence
- Limitations
- Recommended verification steps`
            };

            const perplexityMessages = [
                systemMessage,
                ...chatMessages
            ];

            // =================================================
            // PRIMARY: PERPLEXITY
            // FALLBACK: GEMINI
            // =================================================

            let reply;
            let provider =
                "perplexity";

            try {
                reply =
                    await callPerplexity(
                        perplexityMessages,
                        {
                            model:
                                "sonar",

                            temperature:
                                0.25,

                            max_tokens:
                                1400,

                            retries:
                                1
                        }
                    );
            }
            catch (
                perplexityError
            ) {
                console.warn(
                    "⚠️ Aegis Perplexity unavailable. " +
                    "Trying Gemini fallback..."
                );

                if (!geminiClient) {
                    throw perplexityError;
                }

                const geminiContents =
                    perplexityMessages
                        .filter(
                            item =>
                                item?.role &&
                                item?.content
                        )
                        .map(
                            item => ({
                                role:
                                    item.role ===
                                    "assistant"
                                        ? "model"
                                        : "user",

                                parts: [
                                    {
                                        text:
                                            String(
                                                item.content
                                            )
                                    }
                                ]
                            })
                        );

                reply =
                    await callGemini(
                        geminiContents,
                        {
                            temperature:
                                0.25,

                            maxOutputTokens:
                                1400
                        }
                    );

                provider =
                    "gemini-fallback";
            }

            return res.json({
                success:
                    true,

                reply,

                provider
            });
        }
        catch (error) {
            console.error(
                "❌ Aegis chatbot error:",
                error.message
            );

            const status =
                error.status ||
                500;

            let userMessage =
                "Aegis is temporarily unavailable. Please try again in a moment.";

            if (
                status === 429
            ) {
                userMessage =
                    "Aegis is receiving too many requests right now. Please try again shortly.";
            }
            else if (
                status === 503 ||
                status === 502 ||
                status === 504
            ) {
                userMessage =
                    "Aegis AI is temporarily busy. Please try again in a moment.";
            }
            else if (
                status === 401 ||
                status === 403
            ) {
                userMessage =
                    "Aegis AI credentials need attention on the server.";
            }

            return res.status(
                status
            ).json({
                success:
                    false,

                message:
                    userMessage
            });
        }
    }
);

// ============================================================
// MEDIA ANALYSIS
// ============================================================

app.post(
    "/api/media-analysis",
    async (req, res) => {
        try {
            if (!geminiClient) {
                return res.status(503).json({
                    success: false,

                    message:
                        "Media analysis AI is not configured on the server."
                });
            }

            const {
                image,
                media,
                mimeType,
                filename
            } = req.body;

            const inputData =
                image ||
                media;

            if (!inputData) {
                return res.status(400).json({
                    success: false,

                    message:
                        "No media was provided."
                });
            }

            let base64Data =
                String(
                    inputData
                );

            if (
                base64Data.includes(
                    ","
                )
            ) {
                base64Data =
                    base64Data.split(
                        ","
                    )[1];
            }

            const detectedMime =
                mimeType ||
                "image/jpeg";

            const prompt =
                `You are TrueAegis Forensic Lens, an AI-assisted media analysis system.

Analyze the supplied media for indicators that may suggest manipulation, synthetic generation, editing, compositing, or other anomalies.

IMPORTANT:
Your output is an AI assessment, NOT definitive proof that media is authentic or fake.

Do not make absolute claims.

Return a professional structured forensic report using EXACTLY these sections:

SUSPICION LEVEL:
Give one:
LOW
MEDIUM
HIGH
UNCERTAIN

OVERALL ASSESSMENT:
Give a concise assessment and explain that it is an AI-assisted assessment rather than definitive proof.

EVIDENCE:
List the observable indicators that influenced the assessment.
Focus on visible or technically inferable evidence.
Do not invent hidden metadata or facts that cannot be observed.

LIMITATIONS:
Explain important limitations of analyzing this media, including uncertainty, compression, resolution, missing metadata, or inability to verify source history where relevant.

VERIFICATION STEPS:
Give practical ways a user could independently verify the media, such as checking the original source, reverse-searching, comparing with trusted sources, checking metadata when available, or obtaining the original file.

CONFIDENCE:
Give a qualitative confidence level:
LOW
MEDIUM
HIGH

Remember:
- AI detection can make mistakes.
- A suspicious indicator does not automatically mean manipulation.
- Lack of suspicious indicators does not prove authenticity.
- Never claim laboratory-grade forensic certainty.`;

            const response =
                await geminiClient.models.generateContent(
                    {
                        model:
                            GEMINI_MODEL,

                        contents: [
                            {
                                role:
                                    "user",

                                parts: [
                                    {
                                        inlineData: {
                                            mimeType:
                                                detectedMime,

                                            data:
                                                base64Data
                                        }
                                    },

                                    {
                                        text:
                                            prompt
                                    }
                                ]
                            }
                        ],

                        config: {
                            temperature:
                                0.15,

                            maxOutputTokens:
                                1800
                        }
                    }
                );

            const report =
                response?.text ||
                response?.candidates?.[0]
                    ?.content?.parts
                    ?.map(
                        part =>
                            part.text ||
                            ""
                    )
                    .join("") ||
                "";

            if (!report.trim()) {
                return res.status(502).json({
                    success: false,

                    message:
                        "The AI returned an empty forensic assessment."
                });
            }

            return res.json({
                success:
                    true,

                report,

                filename:
                    filename ||
                    null,

                assessmentType:
                    "AI-assisted media assessment",

                disclaimer:
                    "This assessment is not definitive proof of authenticity or manipulation."
            });
        }
        catch (error) {
            console.error(
                "❌ Media analysis error:",
                error.message
            );

            return res.status(
                error.status ||
                500
            ).json({
                success: false,

                message:
                    "Media analysis is temporarily unavailable. Please try again."
            });
        }
    }
);

// ============================================================
// CONTENT VERIFICATION
// ============================================================

app.post(
    "/api/content-verification",
    async (req, res) => {
        try {
            const {
                content,
                url,
                claim
            } = req.body;

            const text =
                content ||
                claim ||
                url;

            if (!text) {
                return res.status(400).json({
                    success: false,

                    message:
                        "Please provide content, a claim, or a URL."
                });
            }

            if (!geminiClient) {
                return res.status(503).json({
                    success: false,

                    message:
                        "Content verification AI is not configured."
                });
            }

            const prompt =
                `You are TrueAegis Content Verification AI.

Assess the following content:

${String(text)}

Provide:

ASSESSMENT:
A concise evaluation.

EVIDENCE:
What supports or weakens the claim.

LIMITATIONS:
What cannot be established from the supplied information.

VERIFICATION STEPS:
Specific independent checks the user should perform.

IMPORTANT:
This is an AI-assisted assessment, not definitive proof.
Do not invent sources or facts.
If the provided content is insufficient, explicitly say so.`;

            const reply =
                await callGemini(
                    [
                        {
                            role:
                                "user",

                            parts: [
                                {
                                    text:
                                        prompt
                                }
                            ]
                        }
                    ],
                    {
                        temperature:
                            0.2,

                        maxOutputTokens:
                            1600
                    }
                );

            return res.json({
                success:
                    true,

                reply,

                disclaimer:
                    "AI-assisted assessment — not definitive proof."
            });
        }
        catch (error) {
            console.error(
                "❌ Content verification error:",
                error.message
            );

            return res.status(500).json({
                success: false,

                message:
                    "Content verification is temporarily unavailable."
            });
        }
    }
);

// ============================================================
// NEWS ANALYSIS
// ============================================================

app.post(
    "/api/news-analysis",
    async (req, res) => {
        try {
            const {
                query,
                content
            } = req.body;

            const input =
                query ||
                content;

            if (!input) {
                return res.status(400).json({
                    success: false,

                    message:
                        "Please provide a news topic or article."
                });
            }

            const messages = [
                {
                    role:
                        "system",

                    content:
                        `You are TrueAegis Signal Desk, an AI news analysis assistant.

Analyze news claims carefully.

Never treat an AI-generated assessment as definitive proof.
Separate:
- Claim
- Evidence
- Context
- Uncertainty
- Verification steps

Do not invent citations or sources.`
                },

                {
                    role:
                        "user",

                    content:
                        String(input)
                }
            ];

            let reply;
            let provider =
                "perplexity";

            try {
                reply =
                    await callPerplexity(
                        messages,
                        {
                            model:
                                "sonar",

                            temperature:
                                0.15,

                            max_tokens:
                                1800,

                            retries:
                                1
                        }
                    );
            }
            catch (
                perplexityError
            ) {
                console.warn(
                    "⚠️ News Perplexity unavailable. " +
                    "Trying Gemini fallback..."
                );

                if (!geminiClient) {
                    throw perplexityError;
                }

                const geminiContents =
                    messages.map(
                        item => ({
                            role:
                                item.role ===
                                "assistant"
                                    ? "model"
                                    : "user",

                            parts: [
                                {
                                    text:
                                        item.content
                                }
                            ]
                        })
                    );

                reply =
                    await callGemini(
                        geminiContents,
                        {
                            temperature:
                                0.15,

                            maxOutputTokens:
                                1800
                        }
                    );

                provider =
                    "gemini-fallback";
            }

            return res.json({
                success:
                    true,

                reply,

                provider
            });
        }
        catch (error) {
            console.error(
                "❌ News analysis error:",
                error.message
            );

            return res.status(
                error.status ||
                500
            ).json({
                success: false,

                message:
                    "News analysis is temporarily unavailable. Please try again."
            });
        }
    }
);

// ============================================================
// GOOGLE LOGIN
// ============================================================

const googleClientId =
    process.env.GOOGLE_CLIENT_ID;

const googleClientSecret =
    process.env.GOOGLE_CLIENT_SECRET;

const googleRedirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    `${BASE_URL}/api/auth/google/callback`;

let googleOAuthClient =
    null;

if (
    googleClientId &&
    googleClientSecret
) {
    googleOAuthClient =
        new OAuth2Client(
            googleClientId,
            googleClientSecret,
            googleRedirectUri
        );

    console.log(
        "🔐 Google OAuth configured."
    );
}
else {
    console.warn(
        "⚠️ Google Login is not configured on the server."
    );
}

// ============================================================
// GOOGLE AUTH START
// ============================================================

app.get(
    "/api/auth/google",
    (req, res) => {
        if (!googleOAuthClient) {
            return res.status(503).json({
                success: false,

                message:
                    "Google Login is not configured on the server."
            });
        }

        const authorizationUrl =
            googleOAuthClient.generateAuthUrl(
                {
                    access_type:
                        "offline",

                    scope: [
                        "openid",
                        "email",
                        "profile"
                    ],

                    prompt:
                        "select_account"
                }
            );

        res.redirect(
            authorizationUrl
        );
    }
);

// ============================================================
// GOOGLE AUTH CALLBACK
// ============================================================

app.get(
    "/api/auth/google/callback",
    async (req, res) => {
        try {
            if (!googleOAuthClient) {
                return res.status(503).send(
                    "Google Login is not configured on the server."
                );
            }

            const {
                code
            } = req.query;

            if (!code) {
                return res.status(400).send(
                    "Missing Google authorization code."
                );
            }

            const {
                tokens
            } =
                await googleOAuthClient.getToken(
                    code
                );

            googleOAuthClient.setCredentials(
                tokens
            );

            const ticket =
                await googleOAuthClient.verifyIdToken(
                    {
                        idToken:
                            tokens.id_token,

                        audience:
                            googleClientId
                    }
                );

            const payload =
                ticket.getPayload();

            if (!payload) {
                return res.status(401).send(
                    "Unable to verify Google account."
                );
            }

            const email =
                payload.email;

            const name =
                payload.name ||
                payload.email;

            // ------------------------------------------------
            // Find/create user through auth model if available
            // ------------------------------------------------

            try {
                const User =
                    mongoose.model(
                        "User"
                    );

                let user =
                    await User.findOne({
                        email
                    });

                if (!user) {
                    user =
                        await User.create({
                            fullName:
                                name,

                            email,

                            password:
                                crypto
                                    .randomBytes(
                                        32
                                    )
                                    .toString(
                                        "hex"
                                    )
                        });
                }

                console.log(
                    `✅ Google login: ${email}`
                );
            }
            catch (
                userError
            ) {
                console.warn(
                    "⚠️ Google user database operation:",
                    userError.message
                );
            }

            return res.redirect(
                "/dashboard.html"
            );
        }
        catch (error) {
            console.error(
                "❌ Google OAuth error:",
                error.message
            );

            return res.status(500).send(
                "Google authentication failed. Please try again."
            );
        }
    }
);

// ============================================================
// API STATUS
// ============================================================

app.get(
    "/api/status",
    (req, res) => {
        res.json({
            success:
                true,

            platform:
                "TrueAegis AI",

            status:
                "operational",

            services: {
                authentication:
                    true,

                mongodb:
                    mongoose.connection
                        .readyState ===
                    1,

                gemini:
                    !!geminiClient,

                perplexity:
                    !!process.env
                        .PERPLEXITY_API_KEY,

                mediaAnalysis:
                    !!geminiClient,

                contentVerification:
                    !!geminiClient,

                newsAnalysis:
                    !!(
                        geminiClient ||
                        process.env
                            .PERPLEXITY_API_KEY
                    )
            },

            timestamp:
                new Date().toISOString()
        });
    }
);

// ============================================================
// 404 API HANDLER
// ============================================================

app.use(
    "/api",
    (req, res) => {
        res.status(404).json({
            success:
                false,

            message:
                "API endpoint not found."
        });
    }
);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        console.error(
            "❌ Unhandled server error:",
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
            error.status ||
            500
        ).json({
            success:
                false,

            message:
                "An unexpected server error occurred."
        });
    }
);

// ============================================================
// START SERVER
// ============================================================

async function startServer() {
    await connectMongoDB();

    initializeGemini();

    app.listen(
        PORT,
        HOST,
        () => {
            console.log(
                "============================================================"
            );

            console.log(
                "🛡️ TRUEAEGIS AI SERVER"
            );

            console.log(
                "============================================================"
            );

            console.log(
                `🚀 Server running on port ${PORT}`
            );

            console.log(
                `🌐 Base URL: ${BASE_URL}`
            );

            console.log(
                `🤖 Gemini Model: ${GEMINI_MODEL}`
            );

            console.log(
                `🔎 Perplexity: ${
                    process.env.PERPLEXITY_API_KEY
                        ? "configured"
                        : "not configured"
                }`
            );

            console.log(
                `🔐 Google OAuth: ${
                    googleOAuthClient
                        ? "configured"
                        : "not configured"
                }`
            );

            console.log(
                "============================================================"
            );
        }
    );
}

startServer();

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

process.on(
    "SIGTERM",
    async () => {
        console.log(
            "🛑 SIGTERM received. Shutting down..."
        );

        try {
            await mongoose.connection.close();

            console.log(
                "✅ MongoDB connection closed."
            );
        }
        catch (error) {
            console.error(
                "❌ Shutdown error:",
                error.message
            );
        }

        process.exit(
            0
        );
    }
);

process.on(
    "SIGINT",
    async () => {
        console.log(
            "🛑 SIGINT received. Shutting down..."
        );

        try {
            await mongoose.connection.close();

            console.log(
                "✅ MongoDB connection closed."
            );
        }
        catch (error) {
            console.error(
                "❌ Shutdown error:",
                error.message
            );
        }

        process.exit(
            0
        );
    }
);