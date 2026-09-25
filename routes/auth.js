const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const dns = require("dns");
const { OAuth2Client } = require("google-auth-library");
const User = require("../modules/user");

const router = express.Router();

/* ============================================================
   CONFIGURATION
============================================================ */

const OTP_EXPIRY_MS = 5 * 60 * 1000;
const RESET_EXPIRY_MS = 15 * 60 * 1000;

const COOKIE_NAME = "trueaegis_token";

const BASE_URL = String(
    process.env.BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "http://localhost:3000"
).replace(/\/+$/, "");

const GOOGLE_CLIENT_ID =
    process.env.GOOGLE_CLIENT_ID || "";

const GOOGLE_CLIENT_SECRET =
    process.env.GOOGLE_CLIENT_SECRET || "";

const GOOGLE_REDIRECT_URI =
    process.env.GOOGLE_REDIRECT_URI ||
    `${BASE_URL}/api/auth/google/callback`;

const JWT_SECRET =
    process.env.JWT_SECRET || "";

/* ============================================================
   GMAIL SMTP
   Render has previously resolved smtp.gmail.com to IPv6.
   We explicitly force IPv4 DNS resolution.
============================================================ */

const GMAIL_USER =
    process.env.GMAIL_USER || "";

const GMAIL_APP_PASSWORD =
    process.env.GMAIL_APP_PASSWORD || "";

function gmailIpv4Lookup(
    hostname,
    options,
    callback
) {
    dns.lookup(
        hostname,
        {
            family: 4,
            all: false,
        },
        callback
    );
}

const gmailTransporter =
    GMAIL_USER && GMAIL_APP_PASSWORD
        ? nodemailer.createTransport({
              host: "smtp.gmail.com",

              port: 587,

              secure: false,

              requireTLS: true,

              lookup: gmailIpv4Lookup,

              connectionTimeout: 30000,

              greetingTimeout: 30000,

              socketTimeout: 60000,

              auth: {
                  user: GMAIL_USER,
                  pass: GMAIL_APP_PASSWORD,
              },
          })
        : null;

/*
   Port 587 uses STARTTLS.
   Nodemailer documents port 587 with secure:false
   and STARTTLS rather than implicit TLS on port 465.
*/

/* ============================================================
   GOOGLE CLIENT
============================================================ */

const googleClient =
    GOOGLE_CLIENT_ID
        ? new OAuth2Client(
              GOOGLE_CLIENT_ID,
              GOOGLE_CLIENT_SECRET || undefined,
              GOOGLE_REDIRECT_URI
          )
        : null;

/* ============================================================
   HELPERS
============================================================ */

function normalizeEmail(email) {
    return String(email || "")
        .trim()
        .toLowerCase();
}

function isGmailAddress(email) {
    return /^[^\s@]+@gmail\.com$/i.test(
        email
    );
}

function generateOTP() {
    return crypto
        .randomInt(100000, 1000000)
        .toString();
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function publicUser(user) {
    return {
        id: String(user._id),
        fullName: user.fullName || "",
        email: user.email || "",
        age:
            typeof user.age === "number"
                ? user.age
                : null,
        language:
            user.language || "English",
        verified:
            Boolean(user.verified),
        authProvider:
            user.authProvider || "local",
    };
}

function getCookieOptions(
    maxAge
) {
    const options = {
        httpOnly: true,

        secure:
            BASE_URL.startsWith(
                "https://"
            ),

        sameSite: "lax",

        path: "/",
    };

    if (
        typeof maxAge ===
        "number"
    ) {
        options.maxAge = maxAge;
    }

    return options;
}

function createToken(
    user,
    rememberMe = false
) {
    if (!JWT_SECRET) {
        throw new Error(
            "JWT_SECRET is not configured."
        );
    }

    return jwt.sign(
        {
            id: String(
                user._id
            ),
        },

        JWT_SECRET,

        {
            expiresIn:
                rememberMe
                    ? "30d"
                    : "1d",
        }
    );
}

function setLoginCookie(
    res,
    user,
    rememberMe = false
) {
    const token =
        createToken(
            user,
            rememberMe
        );

    const maxAge =
        rememberMe
            ? 30 *
              24 *
              60 *
              60 *
              1000
            : 24 *
              60 *
              60 *
              1000;

    res.cookie(
        COOKIE_NAME,
        token,
        getCookieOptions(
            maxAge
        )
    );
}

/* ============================================================
   AUTH MIDDLEWARE
============================================================ */

async function requireAuth(
    req,
    res,
    next
) {
    try {
        if (!JWT_SECRET) {
            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Authentication is not configured.",
                });
        }

        const token =
            req.cookies?.[
                COOKIE_NAME
            ];

        if (!token) {
            return res
                .status(401)
                .json({
                    success: false,
                    message:
                        "You are not logged in.",
                });
        }

        const decoded =
            jwt.verify(
                token,
                JWT_SECRET
            );

        const user =
            await User.findById(
                decoded.id
            );

        if (!user) {
            return res
                .status(401)
                .json({
                    success: false,
                    message:
                        "User account not found.",
                });
        }

        req.user = user;

        next();
    } catch (error) {
        return res
            .status(401)
            .json({
                success: false,
                message:
                    "Your login session has expired.",
            });
    }
}

/* ============================================================
   EMAIL SENDER
============================================================ */

async function sendEmail(
    to,
    subject,
    html,
    text
) {
    if (!GMAIL_USER) {
        throw new Error(
            "GMAIL_USER is not configured."
        );
    }

    if (!GMAIL_APP_PASSWORD) {
        throw new Error(
            "GMAIL_APP_PASSWORD is not configured."
        );
    }

    if (!gmailTransporter) {
        throw new Error(
            "Gmail email service is not configured."
        );
    }

    try {
        const result =
            await gmailTransporter.sendMail(
                {
                    from:
                        `"TrueAegis" <${GMAIL_USER}>`,

                    to,

                    subject,

                    html,

                    text:
                        text ||
                        "This email was sent by TrueAegis.",
                }
            );

        console.log(
            "[EMAIL] Gmail email sent successfully:",
            result.messageId
        );

        return result;
    } catch (error) {
        console.error(
            "[EMAIL] Gmail sending error:",
            error?.message ||
                error
        );

        throw new Error(
            `Gmail email could not be sent: ${
                error?.message ||
                "Unknown SMTP error."
            }`
        );
    }
}

/* ============================================================
   VERIFICATION EMAIL
============================================================ */

async function sendVerificationEmail(
    user
) {
    const name =
        escapeHtml(
            user.fullName
        );

    const otp =
        escapeHtml(
            user.otp
        );

    await sendEmail(
        user.email,

        "TrueAegis - Verify your email",

        `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>TrueAegis Verification</title>
</head>

<body
style="
    margin:0;
    padding:0;
    background:#f8fafc;
    font-family:Arial,Helvetica,sans-serif;
    color:#172033;
"
>

<div
style="
    max-width:600px;
    margin:40px auto;
    background:#ffffff;
    border-radius:16px;
    padding:36px;
    box-shadow:0 10px 30px rgba(15,23,42,.08);
"
>

<h2
style="
    margin-top:0;
    color:#0f172a;
"
>
Welcome to TrueAegis
</h2>

<p>
Hello ${name},
</p>

<p>
Use the verification code below to verify your TrueAegis account.
</p>

<div
style="
    margin:28px 0;
    padding:20px;
    text-align:center;
    background:#f1f5f9;
    border-radius:12px;
"
>

<div
style="
    font-size:34px;
    font-weight:700;
    letter-spacing:8px;
    color:#0f172a;
"
>
${otp}
</div>

</div>

<p>
This code expires in
<strong>5 minutes</strong>.
</p>

<p>
If you did not create this account, you can safely ignore this email.
</p>

<hr
style="
    border:0;
    border-top:1px solid #e2e8f0;
    margin:28px 0;
"
>

<p
style="
    margin:0;
    font-size:12px;
    color:#64748b;
"
>
TrueAegis — Digital Trust Intelligence
</p>

</div>

</body>
</html>
        `,

        `Your TrueAegis verification code is ${user.otp}. This code expires in 5 minutes.`
    );
}

/* ============================================================
   PASSWORD RESET EMAIL
============================================================ */

async function sendResetEmail(
    user,
    resetToken
) {
    const resetUrl =
        `${BASE_URL}/reset-password.html?token=${encodeURIComponent(
            resetToken
        )}`;

    await sendEmail(
        user.email,

        "TrueAegis - Reset your password",

        `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>TrueAegis Password Reset</title>
</head>

<body
style="
    margin:0;
    padding:0;
    background:#f8fafc;
    font-family:Arial,Helvetica,sans-serif;
    color:#172033;
"
>

<div
style="
    max-width:600px;
    margin:40px auto;
    background:#ffffff;
    border-radius:16px;
    padding:36px;
"
>

<h2
style="
    margin-top:0;
    color:#0f172a;
"
>
Reset your TrueAegis password
</h2>

<p>
Hello ${escapeHtml(
            user.fullName
        )},
</p>

<p>
A password reset was requested for your TrueAegis account.
</p>

<p>
Use the button below to create a new password.
</p>

<div
style="
    text-align:center;
    margin:30px 0;
"
>

<a
href="${resetUrl}"
style="
    display:inline-block;
    padding:14px 24px;
    background:#0ea5e9;
    color:#ffffff;
    text-decoration:none;
    border-radius:10px;
    font-weight:700;
"
>
Reset Password
</a>

</div>

<p>
This link expires in
<strong>15 minutes</strong>.
</p>

<p>
If you did not request this reset, you can safely ignore this email.
</p>

<hr
style="
    border:0;
    border-top:1px solid #e2e8f0;
    margin:28px 0;
"
>

<p
style="
    margin:0;
    font-size:12px;
    color:#64748b;
"
>
TrueAegis — Digital Trust Intelligence
</p>

</div>

</body>
</html>
        `,

        `Reset your TrueAegis password using this link: ${resetUrl}`
    );
}

/* ============================================================
   HEALTH
============================================================ */

router.get(
    "/health",
    (req, res) => {
        return res.json({
            success: true,

            service:
                "TrueAegis Authentication",

            googleLogin:
                Boolean(
                    GOOGLE_CLIENT_ID
                ),

            googleRedirectUri:
                GOOGLE_REDIRECT_URI,

            emailService:
                Boolean(
                    GMAIL_USER &&
                    GMAIL_APP_PASSWORD
                ),

            emailProvider:
                "Gmail SMTP",

            smtpHost:
                "smtp.gmail.com",

            smtpPort: 587,

            smtpIpv4Only: true,

            jwt:
                Boolean(
                    JWT_SECRET
                ),
        });
    }
);

/* ============================================================
   REGISTER
============================================================ */

router.post(
    "/register",
    async (req, res) => {
        try {
            const body =
                req.body || {};

            const fullName =
                String(
                    body.fullName ||
                        ""
                ).trim();

            const email =
                normalizeEmail(
                    body.email
                );

            const password =
                String(
                    body.password ||
                        ""
                );

            const age =
                Number(
                    body.age
                );

            const language =
                String(
                    body.language ||
                        "English"
                ).trim() ||
                "English";

            if (!fullName) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Full name is required.",
                    });
            }

            if (
                fullName.length <
                2
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Please enter your full name.",
                    });
            }

            if (
                fullName.length >
                100
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Full name is too long.",
                    });
            }

            if (
                !isGmailAddress(
                    email
                )
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Please use a valid Gmail address.",
                    });
            }

            if (
                password.length <
                8
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Password must be at least 8 characters.",
                    });
            }

            if (
                password.length >
                128
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Password is too long.",
                    });
            }

            if (
                !Number.isInteger(
                    age
                ) ||
                age < 13
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "You must be at least 13 years old.",
                    });
            }

            let user =
                await User.findOne({
                    email,
                });

            if (
                user &&
                user.verified
            ) {
                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "An account with this email already exists.",
                    });
            }

            const otp =
                generateOTP();

            const otpExpires =
                new Date(
                    Date.now() +
                        OTP_EXPIRY_MS
                );

            const hashedPassword =
                await bcrypt.hash(
                    password,
                    12
                );

            if (user) {
                user.fullName =
                    fullName;

                user.password =
                    hashedPassword;

                user.age = age;

                user.language =
                    language;

                user.otp = otp;

                user.otpExpires =
                    otpExpires;

                user.verified =
                    false;

                user.authProvider =
                    "local";

                await user.save();
            } else {
                user =
                    await User.create({
                        fullName,

                        email,

                        age,

                        language,

                        password:
                            hashedPassword,

                        verified:
                            false,

                        authProvider:
                            "local",

                        otp,

                        otpExpires,
                    });
            }

            try {
                await sendVerificationEmail(
                    user
                );
            } catch (emailError) {
                console.error(
                    "[AUTH] Verification email failed:",
                    emailError.message
                );

                return res
                    .status(503)
                    .json({
                        success: false,
                        message:
                            "Account created, but the verification email could not be sent. Please try again.",
                    });
            }

            return res
                .status(201)
                .json({
                    success: true,
                    message:
                        "Registration successful. Check your Gmail for the verification code.",
                    email:
                        user.email,
                });
        } catch (error) {
            console.error(
                "[AUTH] Register error:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Registration failed.",
                });
        }
    }
);

/* ============================================================
   VERIFY OTP
============================================================ */

router.post(
    "/verify-otp",
    async (req, res) => {
        try {
            const email =
                normalizeEmail(
                    req.body?.email
                );

            const otp =
                String(
                    req.body?.otp ||
                        ""
                ).trim();

            if (
                !email ||
                !otp
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Email and OTP are required.",
                    });
            }

            if (
                !/^\d{6}$/.test(
                    otp
                )
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Verification code must contain 6 digits.",
                    });
            }

            const user =
                await User.findOne({
                    email,
                });

            if (!user) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Account not found.",
                    });
            }

            if (user.verified) {
                return res.json({
                    success: true,
                    message:
                        "Email is already verified.",
                    user:
                        publicUser(
                            user
                        ),
                });
            }

            if (
                !user.otp ||
                !user.otpExpires
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "No active verification code. Please request a new one.",
                    });
            }

            if (
                Date.now() >
                user.otpExpires.getTime()
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "OTP has expired. Please request a new one.",
                    });
            }

            if (
                user.otp !==
                otp
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Incorrect verification code.",
                    });
            }

            user.verified =
                true;

            user.otp = null;

            user.otpExpires =
                null;

            await user.save();

            return res.json({
                success: true,
                message:
                    "Email verified successfully.",
                user:
                    publicUser(
                        user
                    ),
            });
        } catch (error) {
            console.error(
                "[AUTH] Verify OTP error:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Verification failed.",
                });
        }
    }
);

/* ============================================================
   RESEND OTP
============================================================ */

router.post(
    "/resend-otp",
    async (req, res) => {
        try {
            const email =
                normalizeEmail(
                    req.body?.email
                );

            if (!email) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Email is required.",
                    });
            }

            const user =
                await User.findOne({
                    email,
                });

            if (!user) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Account not found.",
                    });
            }

            if (user.verified) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "This account is already verified.",
                    });
            }

            user.otp =
                generateOTP();

            user.otpExpires =
                new Date(
                    Date.now() +
                        OTP_EXPIRY_MS
                );

            await user.save();

            try {
                await sendVerificationEmail(
                    user
                );
            } catch (emailError) {
                console.error(
                    "[AUTH] Resend OTP email failed:",
                    emailError.message
                );

                return res
                    .status(503)
                    .json({
                        success: false,
                        message:
                            "Verification email could not be sent.",
                    });
            }

            return res.json({
                success: true,
                message:
                    "A new verification code has been sent.",
            });
        } catch (error) {
            console.error(
                "[AUTH] Resend OTP error:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Could not resend verification code.",
                });
        }
    }
);

/* ============================================================
   LOGIN
============================================================ */

router.post(
    "/login",
    async (req, res) => {
        try {
            const email =
                normalizeEmail(
                    req.body?.email
                );

            const password =
                String(
                    req.body?.password ||
                        ""
                );

            const rememberMe =
                req.body
                    ?.rememberMe ===
                    true ||
                req.body
                    ?.rememberMe ===
                    "true";

            if (
                !email ||
                !password
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Email and password are required.",
                    });
            }

            const user =
                await User.findOne({
                    email,
                });

            if (!user) {
                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Invalid email or password.",
                    });
            }

            if (
                user.authProvider ===
                    "google" &&
                !user.password
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "This account uses Google Login. Please continue with Google.",
                    });
            }

            if (!user.password) {
                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Invalid email or password.",
                    });
            }

            const correct =
                await bcrypt.compare(
                    password,
                    user.password
                );

            if (!correct) {
                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Invalid email or password.",
                    });
            }

            if (!user.verified) {
                return res
                    .status(403)
                    .json({
                        success: false,
                        message:
                            "Please verify your email before logging in.",
                    });
            }

            setLoginCookie(
                res,
                user,
                rememberMe
            );

            return res.json({
                success: true,
                message:
                    "Login successful.",
                user:
                    publicUser(
                        user
                    ),
            });
        } catch (error) {
            console.error(
                "[AUTH] Login error:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Login failed.",
                });
        }
    }
);

/* ============================================================
   GOOGLE OAUTH START
============================================================ */

router.get(
    "/google",
    (req, res) => {
        try {
            if (
                !googleClient ||
                !GOOGLE_CLIENT_ID
            ) {
                return res
                    .status(503)
                    .send(
                        "Google Login is not configured."
                    );
            }

            const authUrl =
                googleClient.generateAuthUrl(
                    {
                        access_type:
                            "offline",

                        prompt:
                            "select_account",

                        scope: [
                            "openid",
                            "email",
                            "profile",
                        ],
                    }
                );

            return res.redirect(
                authUrl
            );
        } catch (error) {
            console.error(
                "[AUTH] Google OAuth start error:",
                error
            );

            return res
                .status(500)
                .send(
                    "Could not start Google Login."
                );
        }
    }
);

/* ============================================================
   GOOGLE OAUTH CALLBACK
============================================================ */

router.get(
    "/google/callback",
    async (req, res) => {
        try {
            if (
                !googleClient ||
                !GOOGLE_CLIENT_ID
            ) {
                return res.redirect(
                    "/?google=error&message=Google+Login+is+not+configured."
                );
            }

            if (
                req.query?.error
            ) {
                return res.redirect(
                    "/?google=error&message=Google+Login+was+cancelled+or+denied."
                );
            }

            const code =
                String(
                    req.query?.code ||
                        ""
                ).trim();

            if (!code) {
                return res.redirect(
                    "/?google=error&message=Missing+Google+authorization+code."
                );
            }

            const { tokens } =
                await googleClient.getToken(
                    code
                );

            if (
                !tokens?.id_token
            ) {
                throw new Error(
                    "Google did not return an ID token."
                );
            }

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

            if (
                !payload ||
                !payload.email ||
                !payload.email_verified
            ) {
                throw new Error(
                    "Google account could not be verified."
                );
            }

            const email =
                normalizeEmail(
                    payload.email
                );

            if (
                !isGmailAddress(
                    email
                )
            ) {
                return res.redirect(
                    "/?google=error&message=Please+use+a+Gmail+account."
                );
            }

            let user =
                await User.findOne({
                    email,
                });

            if (!user) {
                user =
                    await User.create({
                        fullName:
                            payload.name ||
                            "TrueAegis User",

                        email,

                        age: null,

                        language:
                            "English",

                        password: null,

                        verified: true,

                        authProvider:
                            "google",

                        googleId:
                            payload.sub,
                    });
            } else {
                if (
                    user.googleId &&
                    user.googleId !==
                        payload.sub
                ) {
                    return res.redirect(
                        "/?google=error&message=This+email+is+already+connected+to+another+Google+account."
                    );
                }

                user.googleId =
                    payload.sub;

                user.verified =
                    true;

                if (!user.password) {
                    user.authProvider =
                        "google";
                }

                if (
                    !user.fullName &&
                    payload.name
                ) {
                    user.fullName =
                        payload.name;
                }

                await user.save();
            }

            setLoginCookie(
                res,
                user,
                true
            );

            return res.redirect(
                "/?google=success"
            );
        } catch (error) {
            console.error(
                "[AUTH] Google OAuth callback error:",
                error
            );

            return res.redirect(
                "/?google=error&message=Google+sign-in+could+not+be+completed."
            );
        }
    }
);

/* ============================================================
   GOOGLE LOGIN - CREDENTIAL MODE
============================================================ */

router.post(
    "/google",
    async (req, res) => {
        try {
            if (
                !googleClient
            ) {
                return res
                    .status(503)
                    .json({
                        success: false,
                        message:
                            "Google Login is not configured.",
                    });
            }

            const credential =
                req.body?.credential;

            if (!credential) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Google credential is missing.",
                    });
            }

            const ticket =
                await googleClient.verifyIdToken(
                    {
                        idToken:
                            credential,

                        audience:
                            GOOGLE_CLIENT_ID,
                    }
                );

            const payload =
                ticket.getPayload();

            if (
                !payload ||
                !payload.email ||
                !payload.email_verified
            ) {
                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Google account could not be verified.",
                    });
            }

            const email =
                normalizeEmail(
                    payload.email
                );

            if (
                !isGmailAddress(
                    email
                )
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Please use a Gmail account.",
                    });
            }

            let user =
                await User.findOne({
                    email,
                });

            if (!user) {
                user =
                    await User.create({
                        fullName:
                            payload.name ||
                            "TrueAegis User",

                        email,

                        age: null,

                        language:
                            "English",

                        password: null,

                        verified: true,

                        authProvider:
                            "google",

                        googleId:
                            payload.sub,
                    });
            } else {
                if (
                    user.googleId &&
                    user.googleId !==
                        payload.sub
                ) {
                    return res
                        .status(409)
                        .json({
                            success: false,
                            message:
                                "This email is already connected to another Google account.",
                        });
                }

                user.googleId =
                    payload.sub;

                user.verified =
                    true;

                if (!user.password) {
                    user.authProvider =
                        "google";
                }

                if (
                    !user.fullName &&
                    payload.name
                ) {
                    user.fullName =
                        payload.name;
                }

                await user.save();
            }

            const rememberMe =
                req.body
                    ?.rememberMe ===
                    true ||
                req.body
                    ?.rememberMe ===
                    "true";

            setLoginCookie(
                res,
                user,
                rememberMe
            );

            return res.json({
                success: true,
                message:
                    "Google Login successful.",
                user:
                    publicUser(
                        user
                    ),
            });
        } catch (error) {
            console.error(
                "[AUTH] Google Login error:",
                error
            );

            return res
                .status(401)
                .json({
                    success: false,
                    message:
                        "Google Login failed.",
                });
        }
    }
);

/* ============================================================
   CURRENT USER
============================================================ */

router.get(
    "/me",
    requireAuth,
    async (req, res) => {
        return res.json({
            success: true,
            user:
                publicUser(
                    req.user
                ),
        });
    }
);

/* ============================================================
   CHECK EMAIL
============================================================ */

router.post(
    "/check-email",
    async (req, res) => {
        try {
            const email =
                normalizeEmail(
                    req.body?.email
                );

            if (!email) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Email is required.",
                    });
            }

            const user =
                await User.findOne({
                    email,
                });

            return res.json({
                success: true,

                exists:
                    Boolean(user),

                verified:
                    Boolean(
                        user?.verified
                    ),

                authProvider:
                    user?.authProvider ||
                    null,
            });
        } catch (error) {
            console.error(
                "[AUTH] Check email error:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Could not check email.",
                });
        }
    }
);

/* ============================================================
   FORGOT PASSWORD
============================================================ */

router.post(
    "/forgot-password",
    async (req, res) => {
        try {
            const email =
                normalizeEmail(
                    req.body?.email
                );

            if (!email) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Email is required.",
                    });
            }

            const user =
                await User.findOne({
                    email,
                });

            /*
               Do not reveal whether an email exists.
            */

            if (!user) {
                return res.json({
                    success: true,
                    message:
                        "If an account exists with that email, a reset link has been sent.",
                });
            }

            if (
                user.authProvider ===
                    "google" &&
                !user.password
            ) {
                return res.json({
                    success: true,
                    message:
                        "This account uses Google Login. Please continue with Google.",
                });
            }

            const resetToken =
                crypto
                    .randomBytes(
                        32
                    )
                    .toString(
                        "hex"
                    );

            user.resetPasswordToken =
                resetToken;

            user.resetPasswordExpires =
                new Date(
                    Date.now() +
                        RESET_EXPIRY_MS
                );

            await user.save();

            try {
                await sendResetEmail(
                    user,
                    resetToken
                );
            } catch (emailError) {
                user.resetPasswordToken =
                    null;

                user.resetPasswordExpires =
                    null;

                await user.save();

                console.error(
                    "[AUTH] Password reset email failed:",
                    emailError.message
                );

                return res
                    .status(503)
                    .json({
                        success: false,
                        message:
                            "Password reset email could not be sent. Please try again.",
                    });
            }

            return res.json({
                success: true,
                message:
                    "If an account exists with that email, a reset link has been sent.",
            });
        } catch (error) {
            console.error(
                "[AUTH] Forgot password error:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Could not process password reset.",
                });
        }
    }
);

/* ============================================================
   RESET PASSWORD
============================================================ */

router.post(
    "/reset-password",
    async (req, res) => {
        try {
            const token =
                String(
                    req.body?.token ||
                        ""
                ).trim();

            const password =
                String(
                    req.body?.password ||
                        ""
                );

            if (
                !token ||
                !password
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Reset token and password are required.",
                    });
            }

            if (
                password.length <
                8
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Password must be at least 8 characters.",
                    });
            }

            if (
                password.length >
                128
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Password is too long.",
                    });
            }

            const user =
                await User.findOne({
                    resetPasswordToken:
                        token,

                    resetPasswordExpires:
                        {
                            $gt:
                                new Date(),
                        },
                });

            if (!user) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "This reset link is invalid or has expired.",
                    });
            }

            user.password =
                await bcrypt.hash(
                    password,
                    12
                );

            user.resetPasswordToken =
                null;

            user.resetPasswordExpires =
                null;

            user.verified =
                true;

            user.authProvider =
                "local";

            await user.save();

            /*
               Clear any old session cookie.
            */

            return res.json({
                success: true,
                message:
                    "Password reset successfully. You can now log in.",
            });
        } catch (error) {
            console.error(
                "[AUTH] Reset password error:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Could not reset password.",
                });
        }
    }
);

/* ============================================================
   DELETE ACCOUNT
============================================================ */

router.delete(
    "/account",
    requireAuth,
    async (req, res) => {
        try {
            const email =
                normalizeEmail(
                    req.body?.email
                );

            const password =
                String(
                    req.body?.password ||
                        ""
                );

            const confirmation =
                String(
                    req.body
                        ?.confirmation ||
                        ""
                ).trim();

            if (
                confirmation !==
                "DELETE"
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Type DELETE exactly to confirm account deletion.",
                    });
            }

            if (
                !email ||
                email !==
                    normalizeEmail(
                        req.user
                            .email
                    )
            ) {
                return res
                    .status(403)
                    .json({
                        success: false,
                        message:
                            "The account email does not match the authenticated session.",
                    });
            }

            const isGoogleAccount =
                req.user
                    .authProvider ===
                    "google" &&
                !req.user.password;

            if (
                !isGoogleAccount
            ) {
                if (!password) {
                    return res
                        .status(400)
                        .json({
                            success: false,
                            message:
                                "Your current password is required.",
                        });
                }

                const correct =
                    await bcrypt.compare(
                        password,
                        req.user
                            .password ||
                            ""
                    );

                if (!correct) {
                    return res
                        .status(401)
                        .json({
                            success: false,
                            message:
                                "The password is incorrect.",
                        });
                }
            }

            await User.deleteOne({
                _id:
                    req.user._id,
            });

            res.clearCookie(
                COOKIE_NAME,
                getCookieOptions()
            );

            return res.json({
                success: true,
                message:
                    "TrueAegis account deleted successfully.",
            });
        } catch (error) {
            console.error(
                "[AUTH] Delete account error:",
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Could not delete the account.",
                });
        }
    }
);

/* ============================================================
   LOGOUT
============================================================ */

router.post(
    "/logout",
    (req, res) => {
        res.clearCookie(
            COOKIE_NAME,
            getCookieOptions()
        );

        return res.json({
            success: true,
            message:
                "Logged out successfully.",
        });
    }
);

/* ============================================================
   GOOGLE CONFIG
============================================================ */

router.get(
    "/google/config",
    (req, res) => {
        if (
            !GOOGLE_CLIENT_ID
        ) {
            return res
                .status(503)
                .json({
                    success: false,
                    message:
                        "Google Login is not configured.",
                });
        }

        return res.json({
            success: true,

            clientId:
                GOOGLE_CLIENT_ID,

            redirectUri:
                GOOGLE_REDIRECT_URI,

            baseUrl:
                BASE_URL,
        });
    }
);

/* ============================================================
   EXPORT
============================================================ */

router.requireAuth =
    requireAuth;

module.exports = router;