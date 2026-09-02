// ============================================================
// TRUEAEGIS AUTHENTICATION ROUTES
// routes/auth.js
// ============================================================

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { OAuth2Client } = require("google-auth-library");

const User = require("../modules/user");

const router = express.Router();

// ============================================================
// CONFIGURATION
// ============================================================

const OTP_EXPIRY_MS = 5 * 60 * 1000;
const RESET_EXPIRY_MS = 15 * 60 * 1000;

// ============================================================
// GOOGLE AUTHENTICATION
// ============================================================

const googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID
);

// ============================================================
// EMAIL TRANSPORTER
// ============================================================

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

// ============================================================
// HELPERS
// ============================================================

function normalizeEmail(email) {
    return String(email || "")
        .trim()
        .toLowerCase();
}

function generateOTP() {
    return crypto
        .randomInt(100000, 1000000)
        .toString();
}

function publicUser(user) {
    return {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        age: user.age,
        language: user.language,
        verified: user.verified,
        authProvider: user.authProvider || "local"
    };
}

// ============================================================
// SEND EMAIL
// ============================================================

async function sendEmail(options) {
    if (
        !process.env.GMAIL_USER ||
        !process.env.GMAIL_APP_PASSWORD
    ) {
        throw new Error(
            "Gmail email configuration is missing."
        );
    }

    return transporter.sendMail({
        from: process.env.GMAIL_USER,
        ...options
    });
}

// ============================================================
// VERIFICATION EMAIL
// ============================================================

async function sendVerificationEmail(email, otp) {

    const textMessage = [
        "Hello,",
        "",
        "Your TrueAegis email verification code is:",
        "",
        String(otp),
        "",
        "This code expires in 5 minutes.",
        "",
        "If you did not request this code, you can safely ignore this email.",
        "",
        "TrueAegis Security Team"
    ].join("\n");

    const htmlMessage = [
        "<!DOCTYPE html>",
        "<html>",
        "<head>",
        '<meta charset="UTF-8">',
        "<title>TrueAegis Verification</title>",
        "</head>",
        '<body style="margin:0;padding:30px;background:#06101a;font-family:Arial,Helvetica,sans-serif;color:#ffffff;">',

        '<div style="max-width:600px;margin:auto;background:#091b29;border:1px solid #21435d;border-radius:16px;padding:35px;">',

        '<h1 style="color:#16c7f2;">🛡️ TrueAegis</h1>',

        "<h2>Email Verification</h2>",

        "<p>Your verification code is:</p>",

        '<div style="background:#102d43;border-radius:12px;padding:25px;text-align:center;font-size:36px;font-weight:bold;letter-spacing:10px;color:#ffffff;">',

        String(otp),

        "</div>",

        '<p style="color:#9db0c5;">This code expires in <strong>5 minutes</strong>.</p>',

        '<p style="color:#9db0c5;">If you did not request this code, you can safely ignore this email.</p>',

        '<hr style="border:none;border-top:1px solid #24445a;margin:30px 0;">',

        '<p style="color:#6f8ca3;font-size:13px;">TrueAegis Security Team</p>',

        "</div>",
        "</body>",
        "</html>"
    ].join("");

    await sendEmail({
        to: email,
        subject: "TrueAegis - Email Verification Code",
        text: textMessage,
        html: htmlMessage
    });
}

// ============================================================
// PASSWORD RESET EMAIL
// ============================================================

async function sendPasswordResetEmail(email, token) {

    const baseUrl = (
        process.env.APP_URL ||
        "http://localhost:3000"
    ).replace(/\/+$/, "");

    const resetUrl =
        `${baseUrl}/?resetToken=${encodeURIComponent(token)}`;

    const textMessage = [
        "A password reset was requested for your TrueAegis account.",
        "",
        "Reset your password using this link:",
        "",
        resetUrl,
        "",
        "This reset link expires in 15 minutes.",
        "",
        "If you did not request this, you can safely ignore this email.",
        "",
        "TrueAegis Security Team"
    ].join("\n");

    const htmlMessage = [
        "<!DOCTYPE html>",
        "<html>",
        "<head>",
        '<meta charset="UTF-8">',
        "<title>TrueAegis Password Reset</title>",
        "</head>",

        '<body style="margin:0;padding:30px;background:#06101a;font-family:Arial,Helvetica,sans-serif;color:#ffffff;">',

        '<div style="max-width:600px;margin:auto;background:#091b29;border:1px solid #21435d;border-radius:16px;padding:35px;">',

        '<h1 style="color:#16c7f2;">🛡️ TrueAegis</h1>',

        "<h2>Password Reset</h2>",

        "<p>A password reset was requested for your TrueAegis account.</p>",

        "<p>Click the button below to reset your password:</p>",

        `<p><a href="${resetUrl}" style="display:inline-block;padding:12px 18px;background:#16c7f2;color:#001018;text-decoration:none;border-radius:8px;font-weight:bold;">Reset Password</a></p>`,

        '<p style="color:#9db0c5;">This reset link expires in 15 minutes.</p>',

        '<p style="color:#9db0c5;">If you did not request this, you can safely ignore this email.</p>',

        "</div>",
        "</body>",
        "</html>"
    ].join("");

    await sendEmail({
        to: email,
        subject: "TrueAegis - Password Reset",
        text: textMessage,
        html: htmlMessage
    });
}

// ============================================================
// HEALTH CHECK
// GET /api/auth/health
// ============================================================

router.get("/health", (req, res) => {

    res.json({
        success: true,
        message: "TrueAegis authentication API is running.",

        googleAuthConfigured:
            Boolean(process.env.GOOGLE_CLIENT_ID),

        emailConfigured:
            Boolean(
                process.env.GMAIL_USER &&
                process.env.GMAIL_APP_PASSWORD
            )
    });
});

// ============================================================
// REGISTER
// POST /api/auth/register
// ============================================================

router.post("/register", async (req, res) => {

    try {

        const {
            name,
            fullName,
            email,
            password,
            age,
            language
        } = req.body || {};

        const finalFullName =
            String(fullName || name || "").trim();

        const normalizedEmail =
            normalizeEmail(email);

        if (!finalFullName) {
            return res.status(400).json({
                success: false,
                message: "Full name is required."
            });
        }

        if (finalFullName.length < 2) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid full name."
            });
        }

        if (!normalizedEmail) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        if (
            !/^[^\s@]+@gmail\.com$/i.test(
                normalizedEmail
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "Please use a valid Gmail address."
            });
        }

        if (!password) {
            return res.status(400).json({
                success: false,
                message: "Password is required."
            });
        }

        if (String(password).length < 8) {
            return res.status(400).json({
                success: false,
                message:
                    "Password must be at least 8 characters."
            });
        }

        const finalAge = Number(age);

        if (
            !Number.isFinite(finalAge) ||
            finalAge < 13
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "You must be at least 13 years old."
            });
        }

        const finalLanguage =
            String(language || "English").trim();

        let user = await User.findOne({
            email: normalizedEmail
        });

        if (
            user &&
            user.verified === true
        ) {
            return res.status(409).json({
                success: false,
                code: "ACCOUNT_EXISTS",
                message:
                    "An account with this email already exists. Please log in."
            });
        }

        const hashedPassword =
            await bcrypt.hash(
                String(password),
                12
            );

        const otp = generateOTP();

        const otpExpires =
            new Date(
                Date.now() + OTP_EXPIRY_MS
            );

        if (user) {

            user.fullName =
                finalFullName;

            user.password =
                hashedPassword;

            user.age =
                finalAge;

            user.language =
                finalLanguage;

            user.verified =
                false;

            user.authProvider =
                "local";

            user.otp =
                otp;

            user.otpExpires =
                otpExpires;

            await user.save();

            console.log(
                `♻️ Updated unverified account: ${normalizedEmail}`
            );

        } else {

            user = new User({

                fullName:
                    finalFullName,

                email:
                    normalizedEmail,

                password:
                    hashedPassword,

                age:
                    finalAge,

                language:
                    finalLanguage,

                verified:
                    false,

                authProvider:
                    "local",

                otp:
                    otp,

                otpExpires:
                    otpExpires

            });

            await user.save();

            console.log(
                `✅ New account created: ${normalizedEmail}`
            );
        }

        await sendVerificationEmail(
            normalizedEmail,
            otp
        );

        console.log(
            `✅ OTP sent to ${normalizedEmail}`
        );

        return res.status(200).json({

            success: true,

            message:
                "Verification code sent to your Gmail address.",

            email:
                normalizedEmail

        });

    } catch (error) {

        console.error(
            "❌ REGISTER ERROR:",
            error
        );

        if (
            error &&
            error.code === 11000
        ) {
            return res.status(409).json({
                success: false,
                code: "ACCOUNT_EXISTS",
                message:
                    "An account with this email already exists. Please log in."
            });
        }

        return res.status(500).json({
            success: false,
            message:
                "Registration failed. Please try again."
        });
    }
});

// ============================================================
// VERIFY OTP
// POST /api/auth/verify-otp
// ============================================================

router.post("/verify-otp", async (req, res) => {

    try {

        const {
            email,
            otp
        } = req.body || {};

        const normalizedEmail =
            normalizeEmail(email);

        const enteredOTP =
            String(otp || "").trim();

        if (!normalizedEmail) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        if (!/^\d{6}$/.test(enteredOTP)) {
            return res.status(400).json({
                success: false,
                message:
                    "Please enter the 6-digit verification code."
            });
        }

        const user =
            await User.findOne({
                email: normalizedEmail
            });

        if (!user) {
            return res.status(404).json({
                success: false,
                message:
                    "No account was found for this email."
            });
        }

        if (user.verified === true) {
            return res.status(200).json({
                success: true,
                message:
                    "Your email is already verified.",
                verified: true,
                user:
                    publicUser(user)
            });
        }

        if (!user.otp) {
            return res.status(400).json({
                success: false,
                message:
                    "No verification code found. Please request a new one."
            });
        }

        if (
            !user.otpExpires ||
            Date.now() >
            new Date(user.otpExpires).getTime()
        ) {

            user.otp = null;
            user.otpExpires = null;

            await user.save();

            return res.status(400).json({
                success: false,
                message:
                    "Verification code has expired. Please request a new one."
            });
        }

        if (
            enteredOTP !==
            String(user.otp)
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Incorrect verification code."
            });
        }

        user.verified = true;
        user.otp = null;
        user.otpExpires = null;

        await user.save();

        console.log(
            `✅ Email verified permanently: ${normalizedEmail}`
        );

        return res.status(200).json({

            success: true,

            message:
                "Email verified successfully. You can now log in.",

            verified:
                true,

            user:
                publicUser(user)

        });

    } catch (error) {

        console.error(
            "❌ OTP VERIFY ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Email verification failed."
        });
    }
});

// ============================================================
// RESEND OTP
// POST /api/auth/resend-otp
// ============================================================

router.post("/resend-otp", async (req, res) => {

    try {

        const {
            email
        } = req.body || {};

        const normalizedEmail =
            normalizeEmail(email);

        if (!normalizedEmail) {
            return res.status(400).json({
                success: false,
                message:
                    "Email is required."
            });
        }

        const user =
            await User.findOne({
                email: normalizedEmail
            });

        if (!user) {
            return res.status(404).json({
                success: false,
                message:
                    "No account was found for this email."
            });
        }

        if (user.verified === true) {
            return res.status(400).json({
                success: false,
                message:
                    "This email is already verified. Please log in."
            });
        }

        const otp = generateOTP();

        user.otp = otp;

        user.otpExpires =
            new Date(
                Date.now() + OTP_EXPIRY_MS
            );

        await user.save();

        await sendVerificationEmail(
            normalizedEmail,
            otp
        );

        return res.status(200).json({
            success: true,
            message:
                "A new verification code has been sent."
        });

    } catch (error) {

        console.error(
            "❌ RESEND OTP ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Could not resend the verification code."
        });
    }
});

// ============================================================
// LOGIN
// POST /api/auth/login
// ============================================================

router.post("/login", async (req, res) => {

    try {

        const {
            email,
            password
        } = req.body || {};

        const normalizedEmail =
            normalizeEmail(email);

        if (
            !normalizedEmail ||
            !password
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Email and password are required."
            });
        }

        const user =
            await User.findOne({
                email: normalizedEmail
            });

        if (!user) {
            return res.status(401).json({
                success: false,
                message:
                    "Invalid email or password."
            });
        }

        if (!user.password) {
            return res.status(401).json({
                success: false,
                code:
                    "GOOGLE_ACCOUNT",
                message:
                    "This account uses Google Sign-In. Please continue with Google."
            });
        }

        const passwordMatches =
            await bcrypt.compare(
                String(password),
                user.password
            );

        if (!passwordMatches) {
            return res.status(401).json({
                success: false,
                message:
                    "Invalid email or password."
            });
        }

        if (user.verified !== true) {
            return res.status(403).json({
                success: false,
                code:
                    "EMAIL_NOT_VERIFIED",
                message:
                    "Please verify your email before logging in."
            });
        }

        console.log(
            `✅ Login successful: ${normalizedEmail}`
        );

        return res.status(200).json({

            success: true,

            message:
                "Login successful.",

            user:
                publicUser(user)

        });

    } catch (error) {

        console.error(
            "❌ LOGIN ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Login failed. Please try again."
        });
    }
});

// ============================================================
// GOOGLE LOGIN
// POST /api/auth/google
// ============================================================

router.post("/google", async (req, res) => {

    try {

        const {
            credential
        } = req.body || {};

        if (!credential) {
            return res.status(400).json({
                success: false,
                message:
                    "Google authentication credential is required."
            });
        }

        if (!process.env.GOOGLE_CLIENT_ID) {
            return res.status(500).json({
                success: false,
                message:
                    "Google authentication is not configured on the server."
            });
        }

        const ticket =
            await googleClient.verifyIdToken({

                idToken:
                    credential,

                audience:
                    process.env.GOOGLE_CLIENT_ID

            });

        const payload =
            ticket.getPayload();

        if (!payload) {
            return res.status(401).json({
                success: false,
                message:
                    "Invalid Google authentication."
            });
        }

        const googleId =
            payload.sub;

        const googleEmail =
            normalizeEmail(payload.email);

        const googleName =
            String(
                payload.name ||
                "TrueAegis User"
            ).trim();

        const emailVerified =
            payload.email_verified === true;

        if (
            !googleId ||
            !googleEmail
        ) {
            return res.status(401).json({
                success: false,
                message:
                    "Google account information is incomplete."
            });
        }

        if (!emailVerified) {
            return res.status(403).json({
                success: false,
                message:
                    "Your Google email has not been verified."
            });
        }

        let user =
            await User.findOne({
                googleId:
                    googleId
            });

        if (!user) {
            user =
                await User.findOne({
                    email:
                        googleEmail
                });
        }

        if (!user) {

            user = new User({

                fullName:
                    googleName,

                email:
                    googleEmail,

                password:
                    null,

                googleId:
                    googleId,

                authProvider:
                    "google",

                verified:
                    true,

                age:
                    null,

                language:
                    "English"

            });

            await user.save();

            console.log(
                `✅ New Google account created: ${googleEmail}`
            );

        } else {

            if (
                user.googleId &&
                user.googleId !== googleId
            ) {

                return res.status(409).json({

                    success: false,

                    code:
                        "GOOGLE_ACCOUNT_CONFLICT",

                    message:
                        "This Google account cannot be linked to the existing account."

                });
            }

            if (!user.googleId) {

                user.googleId =
                    googleId;

                if (!user.password) {
                    user.authProvider =
                        "google";
                }
            }

            user.verified =
                true;

            if (!user.fullName) {
                user.fullName =
                    googleName;
            }

            await user.save();
        }

        console.log(
            `✅ Google login successful: ${googleEmail}`
        );

        return res.status(200).json({

            success: true,

            message:
                "Google login successful.",

            user:
                publicUser(user)

        });

    } catch (error) {

        console.error(
            "❌ GOOGLE LOGIN ERROR:",
            error
        );

        return res.status(401).json({
            success: false,
            message:
                "Google authentication failed. Please try again."
        });
    }
});

// ============================================================
// CHECK EMAIL
// POST /api/auth/check-email
// ============================================================

router.post("/check-email", async (req, res) => {

    try {

        const {
            email
        } = req.body || {};

        const normalizedEmail =
            normalizeEmail(email);

        if (!normalizedEmail) {
            return res.status(400).json({
                success: false,
                message:
                    "Email is required."
            });
        }

        const user =
            await User.findOne({
                email:
                    normalizedEmail
            });

        if (!user) {
            return res.json({
                success: true,
                exists: false,
                verified: false
            });
        }

        return res.json({

            success: true,

            exists: true,

            verified:
                user.verified === true,

            authProvider:
                user.authProvider ||
                "local"

        });

    } catch (error) {

        console.error(
            "❌ CHECK EMAIL ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Could not check the email."
        });
    }
});

// ============================================================
// FORGOT PASSWORD
// POST /api/auth/forgot-password
// ============================================================

router.post("/forgot-password", async (req, res) => {

    try {

        const {
            email
        } = req.body || {};

        const normalizedEmail =
            normalizeEmail(email);

        if (!normalizedEmail) {
            return res.status(400).json({
                success: false,
                message:
                    "Email is required."
            });
        }

        const user =
            await User.findOne({
                email:
                    normalizedEmail
            });

        if (!user) {
            return res.status(200).json({
                success: true,
                message:
                    "If an account exists for that email, a password reset email has been sent."
            });
        }

        if (
            user.authProvider === "google" &&
            !user.password
        ) {

            return res.status(200).json({

                success: true,

                code:
                    "GOOGLE_ACCOUNT",

                message:
                    "This account uses Google Sign-In. Please sign in with Google."

            });
        }

        const resetToken =
            crypto
                .randomBytes(32)
                .toString("hex");

        user.resetPasswordToken =
            crypto
                .createHash("sha256")
                .update(resetToken)
                .digest("hex");

        user.resetPasswordExpires =
            new Date(
                Date.now() +
                RESET_EXPIRY_MS
            );

        await user.save();

        await sendPasswordResetEmail(
            normalizedEmail,
            resetToken
        );

        return res.status(200).json({

            success: true,

            message:
                "If an account exists for that email, a password reset email has been sent."

        });

    } catch (error) {

        console.error(
            "❌ FORGOT PASSWORD ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Could not process the password reset request."
        });
    }
});

// ============================================================
// RESET PASSWORD
// POST /api/auth/reset-password
// ============================================================

router.post("/reset-password", async (req, res) => {

    try {

        const {
            token,
            password
        } = req.body || {};

        if (!token || !password) {
            return res.status(400).json({
                success: false,
                message:
                    "Reset token and new password are required."
            });
        }

        if (String(password).length < 8) {
            return res.status(400).json({
                success: false,
                message:
                    "Password must be at least 8 characters."
            });
        }

        const hashedToken =
            crypto
                .createHash("sha256")
                .update(String(token))
                .digest("hex");

        const user =
            await User.findOne({

                resetPasswordToken:
                    hashedToken,

                resetPasswordExpires: {
                    $gt:
                        new Date()
                }

            });

        if (!user) {
            return res.status(400).json({
                success: false,
                message:
                    "The password reset token is invalid or has expired."
            });
        }

        user.password =
            await bcrypt.hash(
                String(password),
                12
            );

        user.resetPasswordToken =
            null;

        user.resetPasswordExpires =
            null;

        user.authProvider =
            "local";

        user.verified =
            true;

        await user.save();

        console.log(
            `✅ Password reset successful: ${user.email}`
        );

        return res.status(200).json({

            success: true,

            message:
                "Password reset successfully. You can now log in."

        });

    } catch (error) {

        console.error(
            "❌ RESET PASSWORD ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Could not reset the password."
        });
    }
});

// ============================================================
// LOGOUT
// POST /api/auth/logout
// ============================================================

router.post("/logout", (req, res) => {

    return res.status(200).json({

        success: true,

        message:
            "Logged out successfully."

    });
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;