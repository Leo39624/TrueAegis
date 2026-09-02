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
    "https://trueaegis.onrender.com";

const publicPath =
    path.join(__dirname, "public");

// ============================================================
// GOOGLE OAUTH CONFIGURATION
// ============================================================

const GOOGLE_CLIENT_ID =
    process.env.GOOGLE_CLIENT_ID;

const GOOGLE_CLIENT_SECRET =
    process.env.GOOGLE_CLIENT_SECRET;

const GOOGLE_REDIRECT_URI =
    process.env.GOOGLE_REDIRECT_URI ||
    `${BASE_URL}/api/auth/google/callback`;

const googleOAuthClient =
    GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
        ? new OAuth2Client(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI
        )
        : null;

// Temporary OAuth state storage.
// In production, this should ideally be stored in a
// server-side session/Redis store for multi-instance deployments.
const googleOAuthStates = new Map();

const GOOGLE_STATE_TTL = 10 * 60 * 1000;

// ============================================================
// MIDDLEWARE
// ============================================================

app.disable("x-powered-by");

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
// REQUEST LOGGER
// ============================================================

app.use((req, res, next) => {

    console.log(
        `${new Date().toISOString()} | ${req.method} ${req.originalUrl}`
    );

    next();
});

// ============================================================
// STATIC FRONTEND
// ============================================================

app.use(
    express.static(publicPath, {
        extensions: ["html"],
        maxAge: "1h"
    })
);

// ============================================================
// ROBOTS.TXT
// ============================================================

app.get(
    "/robots.txt",
    (req, res) => {

        res.type("text/plain");

        res.send(
            `User-agent: *
Allow: /
Sitemap: ${BASE_URL}/sitemap.xml
`
        );
    }
);

// ============================================================
// SITEMAP.XML
// ============================================================

app.get(
    "/sitemap.xml",
    (req, res) => {

        res.type("application/xml");

        res.send(
            `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

<url>
<loc>${BASE_URL}/</loc>
</url>

<url>
<loc>${BASE_URL}/dragon.html</loc>
</url>

</urlset>`
        );
    }
);

// ============================================================
// GEMINI CONFIGURATION
// ============================================================

let geminiClient = null;
let geminiMode = "disabled";

function initializeGemini() {

    /*
        MODE 1
        --------------------------------------------------------
        Gemini Developer API

        Uses:
            GEMINI_API_KEY

        The API key remains on the server.
    */

    if (
        process.env.GEMINI_API_KEY &&
        process.env.GEMINI_API_KEY.trim()
    ) {

        try {

            geminiClient =
                new GoogleGenAI({
                    apiKey:
                        process.env.GEMINI_API_KEY.trim()
                });

            geminiMode =
                "gemini-api";

            console.log(
                "🤖 Gemini: Developer API mode enabled"
            );

            return;

        }
        catch (error) {

            console.error(
                "❌ Failed to initialize Gemini API client:",
                error.message
            );
        }
    }

    /*
        MODE 2
        --------------------------------------------------------
        Google Cloud Vertex AI
    */

    if (
        process.env.GOOGLE_CLOUD_PROJECT &&
        process.env.GOOGLE_CLOUD_PROJECT.trim()
    ) {

        try {

            geminiClient =
                new GoogleGenAI({

                    vertexai:
                        true,

                    project:
                        process.env.GOOGLE_CLOUD_PROJECT.trim(),

                    location:
                        GOOGLE_CLOUD_LOCATION
                });

            geminiMode =
                "vertex-ai";

            console.log(
                "☁️ Gemini: Vertex AI mode enabled"
            );

            return;

        }
        catch (error) {

            console.error(
                "❌ Failed to initialize Vertex AI client:",
                error.message
            );
        }
    }

    console.warn(
        "⚠️ Gemini is not configured."
    );
}

// Initialize Gemini
initializeGemini();

// ============================================================
// GEMINI HELPER
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

    const model =
        options.model ||
        GEMINI_MODEL;

    try {

        const response =
            await geminiClient.models.generateContent({

                model,

                contents,

                config: {

                    temperature:
                        options.temperature ??
                        0.2,

                    maxOutputTokens:
                        options.maxOutputTokens ??
                        1400
                }
            });

        const text =
            response?.text ||
            "";

        if (!text.trim()) {

            throw new Error(
                "Gemini returned an empty response."
            );
        }

        return text;
    }

    catch (error) {

        console.error(
            "❌ GEMINI REQUEST FAILED"
        );

        console.error(
            "Mode:",
            geminiMode
        );

        console.error(
            "Model:",
            model
        );

        console.error(
            "Message:",
            error.message
        );

        const message =
            String(
                error.message ||
                ""
            );

        if (
            message.includes(
                "ACCESS_TOKEN_TYPE_UNSUPPORTED"
            ) ||
            message.includes(
                "Expected OAuth 2 access token"
            ) ||
            message.includes(
                "invalid authentication credentials"
            )
        ) {

            const authError =
                new Error(
                    "Gemini authentication was rejected by Google. " +
                    "Configure valid Gemini API or Vertex AI credentials."
                );

            authError.status =
                401;

            authError.code =
                "GEMINI_AUTH_REJECTED";

            throw authError;
        }

        throw error;
    }
}

// ============================================================
// GOOGLE LOGIN
// ============================================================

function createGoogleState() {

    return crypto.randomBytes(32).toString("hex");
}

// ------------------------------------------------------------
// START GOOGLE LOGIN
// ------------------------------------------------------------

app.get(
    "/api/auth/google",
    (req, res) => {

        if (!googleOAuthClient) {

            return res.redirect(
                "/?google=error&message=" +
                encodeURIComponent(
                    "Google Login is not configured on the server."
                )
            );
        }

        const state =
            createGoogleState();

        googleOAuthStates.set(
            state,
            {
                createdAt:
                    Date.now()
            }
        );

        const authorizationUrl =
            googleOAuthClient.generateAuthUrl({

                access_type:
                    "online",

                scope: [
                    "openid",
                    "email",
                    "profile"
                ],

                state,

                prompt:
                    "select_account"
            });

        res.redirect(
            authorizationUrl
        );
    }
);

// ------------------------------------------------------------
// GOOGLE CALLBACK
// ------------------------------------------------------------

app.get(
    "/api/auth/google/callback",
    async (req, res) => {

        try {

            if (!googleOAuthClient) {

                return res.redirect(
                    "/?google=error&message=" +
                    encodeURIComponent(
                        "Google Login is not configured."
                    )
                );
            }

            const {
                code,
                state,
                error
            } = req.query;

            if (error) {

                return res.redirect(
                    "/?google=error&message=" +
                    encodeURIComponent(
                        "Google Login was cancelled."
                    )
                );
            }

            if (!code || !state) {

                return res.redirect(
                    "/?google=error&message=" +
                    encodeURIComponent(
                        "Invalid Google authentication response."
                    )
                );
            }

            // ------------------------------------------------
            // VERIFY STATE
            // ------------------------------------------------

            const stateRecord =
                googleOAuthStates.get(
                    state
                );

            googleOAuthStates.delete(
                state
            );

            if (!stateRecord) {

                return res.redirect(
                    "/?google=error&message=" +
                    encodeURIComponent(
                        "Google authentication session expired."
                    )
                );
            }

            if (
                Date.now() -
                stateRecord.createdAt >
                GOOGLE_STATE_TTL
            ) {

                return res.redirect(
                    "/?google=error&message=" +
                    encodeURIComponent(
                        "Google authentication session expired."
                    )
                );
            }

            // ------------------------------------------------
            // EXCHANGE AUTHORIZATION CODE
            // ------------------------------------------------

            const {
                tokens
            } =
                await googleOAuthClient.getToken(
                    code
                );

            if (!tokens.id_token) {

                return res.redirect(
                    "/?google=error&message=" +
                    encodeURIComponent(
                        "Google did not return a valid identity token."
                    )
                );
            }

            // ------------------------------------------------
            // VERIFY GOOGLE ID TOKEN
            // ------------------------------------------------

            const ticket =
                await googleOAuthClient.verifyIdToken({

                    idToken:
                        tokens.id_token,

                    audience:
                        GOOGLE_CLIENT_ID
                });

            const payload =
                ticket.getPayload();

            if (!payload) {

                throw new Error(
                    "Google identity information was unavailable."
                );
            }

            const googleId =
                payload.sub;

            const email =
                payload.email
                    ?.trim()
                    .toLowerCase();

            const emailVerified =
                payload.email_verified;

            const name =
                payload.name ||
                payload.given_name ||
                "TrueAegis User";

            const picture =
                payload.picture ||
                "";

            if (!googleId || !email) {

                throw new Error(
                    "Google account information is incomplete."
                );
            }

            if (!emailVerified) {

                throw new Error(
                    "Your Google email address is not verified."
                );
            }

            // ------------------------------------------------
            // FIND USER MODEL
            // ------------------------------------------------

            /*
                Your existing authentication system owns the
                User model.

                We try to load it from the existing auth route
                module if it is exported.
            */

            let User = null;

            try {

                if (
                    authRoutes &&
                    authRoutes.User
                ) {

                    User =
                        authRoutes.User;
                }

            }
            catch (error) {

                console.error(
                    "Could not access User model:",
                    error.message
                );
            }

            /*
                If the model is not exported by routes/auth,
                Google login cannot safely modify the existing
                user database automatically.
            */

            if (!User) {

                return res.redirect(
                    "/?google=error&message=" +
                    encodeURIComponent(
                        "Google Login backend is not connected to the existing User model yet."
                    )
                );
            }

            // ------------------------------------------------
            // FIND EXISTING USER
            // ------------------------------------------------

            let user =
                await User.findOne({
                    $or: [
                        {
                            googleId:
                                googleId
                        },
                        {
                            email:
                                email
                        }
                    ]
                });

            // ------------------------------------------------
            // CREATE USER IF NECESSARY
            // ------------------------------------------------

            if (!user) {

                user =
                    await User.create({

                        fullName:
                            name,

                        name:
                            name,

                        email:
                            email,

                        googleId:
                            googleId,

                        profilePicture:
                            picture,

                        emailVerified:
                            true,

                        authProvider:
                            "google"
                    });

                console.log(
                    `✅ New Google user created: ${email}`
                );
            }

            else {

                // ------------------------------------------------
                // LINK GOOGLE ACCOUNT TO EXISTING USER
                // ------------------------------------------------

                let changed =
                    false;

                if (
                    !user.googleId
                ) {

                    user.googleId =
                        googleId;

                    changed =
                        true;
                }

                if (
                    !user.emailVerified
                ) {

                    user.emailVerified =
                        true;

                    changed =
                        true;
                }

                if (
                    picture &&
                    !user.profilePicture
                ) {

                    user.profilePicture =
                        picture;

                    changed =
                        true;
                }

                if (
                    !user.authProvider
                ) {

                    user.authProvider =
                        "google";

                    changed =
                        true;
                }

                if (changed) {

                    await user.save();
                }
            }

            // ------------------------------------------------
            // CREATE APPLICATION JWT
            // ------------------------------------------------

            const jwt =
                require("jsonwebtoken");

            if (
                !process.env.JWT_SECRET
            ) {

                throw new Error(
                    "JWT_SECRET is not configured."
                );
            }

            const token =
                jwt.sign(
                    {
                        id:
                            user._id.toString(),

                        userId:
                            user._id.toString(),

                        email:
                            user.email
                    },

                    process.env.JWT_SECRET,

                    {
                        expiresIn:
                            "7d"
                    }
                );

            // ------------------------------------------------
            // SECURE COOKIE
            // ------------------------------------------------

            res.cookie(
                "trueaegis_token",
                token,
                {
                    httpOnly:
                        true,

                    secure:
                        process.env.NODE_ENV ===
                        "production",

                    sameSite:
                        "lax",

                    maxAge:
                        7 *
                        24 *
                        60 *
                        60 *
                        1000,

                    path:
                        "/"
                }
            );

            console.log(
                `✅ Google Login successful: ${email}`
            );

            // ------------------------------------------------
            // RETURN TO FRONTEND
            // ------------------------------------------------

            return res.redirect(
                "/?google=success"
            );
        }

        catch (error) {

            console.error(
                "❌ GOOGLE LOGIN ERROR:",
                error
            );

            return res.redirect(
                "/?google=error&message=" +
                encodeURIComponent(
                    "Google Login failed. Please try again."
                )
            );
        }
    }
);

// ============================================================
// GOOGLE STATE CLEANUP
// ============================================================

setInterval(
    () => {

        const now =
            Date.now();

        for (
            const [
                state,
                record
            ]
            of googleOAuthStates
        ) {

            if (
                now -
                record.createdAt >
                GOOGLE_STATE_TTL
            ) {

                googleOAuthStates.delete(
                    state
                );
            }
        }

    },
    5 * 60 * 1000
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
    "/api/health",
    (req, res) => {

        res.json({

            success:
                true,

            message:
                "TrueAegis API is running",

            server:
                "online",

            mongodb:
                mongoose.connection.readyState === 1
                    ? "connected"
                    : "disconnected",

            ai: {

                perplexity:
                    Boolean(
                        process.env.PERPLEXITY_API_KEY
                    ),

                gemini:
                    Boolean(
                        geminiClient
                    ),

                geminiMode:
                    geminiMode,

                geminiModel:
                    GEMINI_MODEL
            },

            googleLogin:
                Boolean(
                    googleOAuthClient
                ),

            time:
                new Date().toISOString()
        });
    }
);

// ============================================================
// AUTHENTICATION ROUTES
// ============================================================

app.use(
    "/api/auth",
    authRoutes
);

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

        throw error;
    }

    const text =
        data
            ?.choices?.[0]
            ?.message
            ?.content ||
        "";

    if (!text.trim()) {

        throw new Error(
            "Perplexity returned an empty response."
        );
    }

    return text;
}

// ============================================================
// GEMINI CHATBOT
// ============================================================

app.post(
    "/api/chat",
    async (req, res) => {

        try {

            const {
                message,
                history = []
            } = req.body;

            if (!message) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Message is required."
                });
            }

            const contents = [];

            for (
                const item
                of history
            ) {

                if (
                    item?.role &&
                    item?.content
                ) {

                    contents.push({

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
                    });
                }
            }

            contents.push({

                role:
                    "user",

                parts: [
                    {
                        text:
                            String(
                                message
                            )
                    }
                ]
            });

            const reply =
                await callGemini(
                    contents,
                    {
                        temperature:
                            0.3,

                        maxOutputTokens:
                            1400
                    }
                );

            return res.json({

                success:
                    true,

                reply
            });
        }

        catch (error) {

            console.error(
                "CHAT ERROR:",
                error
            );

            return res.status(
                error.status || 500
            ).json({

                success:
                    false,

                message:
                    error.message ||
                    "AI chatbot request failed."
            });
        }
    }
);

// ============================================================
// PERPLEXITY NEWS ANALYSIS
// ============================================================

app.post(
    "/api/news-analysis",
    async (req, res) => {

        try {

            const {
                query,
                text
            } = req.body;

            const input =
                query ||
                text;

            if (!input) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "News query or text is required."
                });
            }

            const result =
                await callPerplexity(
                    [
                        {
                            role:
                                "system",

                            content:
                                "You are TrueAegis News Intelligence. Analyze news claims carefully. Separate verified facts, uncertain claims, conflicting reports, and missing context. Do not invent sources."
                        },

                        {
                            role:
                                "user",

                            content:
                                String(
                                    input
                                )
                        }
                    ],
                    {
                        model:
                            "sonar",

                        temperature:
                            0.1,

                        max_tokens:
                            1600
                    }
                );

            return res.json({

                success:
                    true,

                analysis:
                    result
            });
        }

        catch (error) {

            console.error(
                "NEWS ANALYSIS ERROR:",
                error
            );

            return res.status(
                error.status || 500
            ).json({

                success:
                    false,

                message:
                    error.message ||
                    "News analysis failed."
            });
        }
    }
);

// ============================================================
// CONTENT ANALYSIS
// ============================================================

app.post(
    "/api/content-analysis",
    async (req, res) => {

        try {

            const {
                content,
                text
            } = req.body;

            const input =
                content ||
                text;

            if (!input) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Content is required."
                });
            }

            const analysis =
                await callGemini(
                    [
                        {
                            role:
                                "user",

                            parts: [
                                {
                                    text:
                                        `You are TrueAegis AI, a digital trust analysis system.

Analyze the following content for:
1. factual reliability
2. suspicious or misleading claims
3. unsupported statements
4. important missing context
5. confidence level

Do not claim certainty when the available information is insufficient.

CONTENT:

${String(input)}`
                                }
                            ]
                        }
                    ],
                    {
                        temperature:
                            0.15,

                        maxOutputTokens:
                            1800
                    }
                );

            return res.json({

                success:
                    true,

                analysis
            });
        }

        catch (error) {

            console.error(
                "CONTENT ANALYSIS ERROR:",
                error
            );

            return res.status(
                error.status || 500
            ).json({

                success:
                    false,

                message:
                    error.message ||
                    "Content analysis failed."
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

            const {
                data,
                mimeType,
                fileName
            } = req.body;

            if (!data) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Media data is required."
                });
            }

            if (!mimeType) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Media MIME type is required."
                });
            }

            if (
                !(
                    mimeType.startsWith(
                        "image/"
                    ) ||
                    mimeType.startsWith(
                        "video/"
                    )
                )
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Unsupported media type."
                });
            }

            /*
                Remove a possible data URL prefix.
            */

            const cleanData =
                String(data)
                    .replace(
                        /^data:[^;]+;base64,/,
                        ""
                    );

            const analysisPrompt =
                `
You are TrueAegis AI, a digital media authenticity analysis assistant.

Analyze this uploaded media for signs that may indicate:
- AI generation
- digital manipulation
- editing
- compositing
- unusual visual artifacts
- inconsistencies
- suspicious metadata if available
- other authenticity concerns

IMPORTANT:
Do not claim that visual analysis alone can prove whether something is
definitively real or fake.

Return:
1. Overall assessment
2. Suspicion level
3. Evidence observed
4. Limitations
5. Recommended next verification steps

Filename:
${fileName || "uploaded-media"}
`;

            const result =
                await callGemini(
                    [
                        {
                            role:
                                "user",

                            parts: [
                                {
                                    text:
                                        analysisPrompt
                                },

                                {
                                    inlineData: {

                                        mimeType:
                                            mimeType,

                                        data:
                                            cleanData
                                    }
                                }
                            ]
                        }
                    ],
                    {
                        temperature:
                            0.1,

                        maxOutputTokens:
                            2200
                    }
                );

            return res.json({

                success:
                    true,

                analysis:
                    result
            });
        }

        catch (error) {

            console.error(
                "MEDIA ANALYSIS ERROR:",
                error
            );

            return res.status(
                error.status || 500
            ).json({

                success:
                    false,

                message:
                    error.message ||
                    "Media analysis failed."
            });
        }
    }
);

// ============================================================
// PERPLEXITY AEgis CHAT
// ============================================================

app.post(
    "/api/aegis-chat",
    async (req, res) => {

        try {

            const {
                message,
                history = []
            } = req.body;

            if (!message) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Message is required."
                });
            }

            const messages = [

                {
                    role:
                        "system",

                    content:
                        "You are Aegis, the intelligent assistant inside TrueAegis. Give clear, evidence-aware answers. Never invent facts, sources, citations, or verification results."
                }

            ];

            for (
                const item
                of history
            ) {

                if (
                    item?.role &&
                    item?.content
                ) {

                    messages.push({

                        role:
                            item.role ===
                            "assistant"
                                ? "assistant"
                                : "user",

                        content:
                            String(
                                item.content
                            )
                    });
                }
            }

            messages.push({

                role:
                    "user",

                content:
                    String(
                        message
                    )
            });

            const reply =
                await callPerplexity(
                    messages,
                    {
                        model:
                            "sonar",

                        temperature:
                            0.25,

                        max_tokens:
                            1400
                    }
                );

            return res.json({

                success:
                    true,

                reply
            });
        }

        catch (error) {

            console.error(
                "AEGIS CHAT ERROR:",
                error
            );

            return res.status(
                error.status || 500
            ).json({

                success:
                    false,

                message:
                    error.message ||
                    "Aegis chatbot failed."
            });
        }
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
// GENERAL ERROR HANDLER
// ============================================================

app.use(
    (error, req, res, next) => {

        console.error(
            "UNHANDLED SERVER ERROR:",
            error
        );

        if (res.headersSent) {

            return next(
                error
            );
        }

        res.status(
            error.status || 500
        ).json({

            success:
                false,

            message:
                "An unexpected server error occurred."
        });
    }
);

// ============================================================
// MONGODB CONNECTION
// ============================================================

async function connectMongoDB() {

    const mongoURI =
        process.env.MONGODB_URI;

    if (!mongoURI) {

        console.error(
            "❌ MONGODB_URI is missing."
        );

        return;
    }

    try {

        await mongoose.connect(
            mongoURI,
            {
                serverSelectionTimeoutMS:
                    15000
            }
        );

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
// START SERVER
// ============================================================

async function startServer() {

    await connectMongoDB();

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
                `🤖 Gemini mode: ${geminiMode}`
            );

            console.log(
                `🔎 Perplexity: ${
                    process.env.PERPLEXITY_API_KEY
                        ? "enabled"
                        : "disabled"
                }`
            );

            console.log(
                `🔐 Google Login: ${
                    googleOAuthClient
                        ? "enabled"
                        : "disabled"
                }`
            );

            console.log(
                `🐉 Dragon: ${BASE_URL}/dragon.html`
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
            "SIGTERM received. Shutting down..."
        );

        await mongoose.connection.close();

        process.exit(
            0
        );
    }
);

process.on(
    "SIGINT",
    async () => {

        console.log(
            "SIGINT received. Shutting down..."
        );

        await mongoose.connection.close();

        process.exit(
            0
        );
    }
);