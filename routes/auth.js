// ============================================================
// TRUEAEGIS AUTHENTICATION ROUTES
// routes/auth.js
// ============================================================

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const User = require("../modules/user");

const router = express.Router();

// ============================================================
// CONFIGURATION
// ============================================================

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const RESET_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

// ============================================================
// EMAIL TRANSPORTER
// ============================================================
//
// .env should contain:
//
// GMAIL_USER=yourgmail@gmail.com
// GMAIL_APP_PASSWORD=your-app-password
//
// ============================================================

const transporter = nodemailer.createTransport({
    service: "gmail",

    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

// ============================================================
// HELPER: NORMALIZE EMAIL
// ============================================================

function normalizeEmail(email) {
    return String(email || "")
        .trim()
        .toLowerCase();
}

// ============================================================
// HELPER: GENERATE OTP
// ============================================================

function generateOTP() {
    return crypto
        .randomInt(100000, 1000000)
        .toString();
}

// ============================================================
// HELPER: SEND VERIFICATION EMAIL
// ============================================================

async function sendVerificationEmail(email, otp) {

    await transporter.sendMail({

        from:
            `"TrueAegis Security" <${process.env.GMAIL_USER}>`,

        to: email,

        subject:
            "TrueAegis - Email Verification Code",

        text:
`Hello,

Your TrueAegis email verification code is:

${otp}

This code expires in 5 minutes.

If you did not request this code, you can safely ignore this email.

TrueAegis Security Team`,

        html:
`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>TrueAegis Verification</title>
</head>

<body style="
    margin:0;
    padding:30px;
    background:#06101a;
    font-family:Arial,Helvetica,sans-serif;
    color:#ffffff;
">

<div style="
    max-width:600px;
    margin:auto;
    background:#091b29;
    border:1px solid #21435d;
    border-radius:16px;
    padding:35px;
">

<h1 style="
    color:#16c7f2;
    margin-top:0;
">
🛡️ TrueAegis
</h1>

<h2>Email Verification</h2>

<p>
Your verification code is:
</p>

<div style="
    background:#102d43;
    border-radius:12px;
    padding:25px;
    text-align:center;
    font-size:36px;
    font-weight:bold;
    letter-spacing:10px;
    color:#ffffff;
">
${otp}
</div>

<p style="color:#9db0c5;">
This code expires in
<strong>5 minutes</strong>.
</p>

<p style="color:#9db0c5;">
If you did not request this code,
you can safely ignore this email.
</p>

<hr style="
    border:none;
    border-top:1px solid #24445a;
    margin:30px 0;
">

<p style="
    color:#6f8ca3;
    font-size:13px;
">
TrueAegis Security Team
</p>

</div>

</body>
</html>
`
    });
}

// ============================================================
// HELPER: SEND PASSWORD RESET EMAIL
// ============================================================

async function sendPasswordResetEmail(email, token) {

    const resetUrl =
        `http://localhost:3000/?resetToken=${encodeURIComponent(token)}`;

    await transporter.sendMail({

        from:
            `"TrueAegis Security" <${process.env.GMAIL_USER}>`,

        to: email,

        subject:
            "TrueAegis - Password Reset",

        text:
`A password reset was requested for your TrueAegis account.

Reset your password using this token:

${token}

This reset token expires in 15 minutes.

If you did not request this, you can ignore this email.`,

        html:
`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>TrueAegis Password Reset</title>
</head>

<body style="
    margin:0;
    padding:30px;
    background:#06101a;
    font-family:Arial,Helvetica,sans-serif;
    color:#ffffff;
">

<div style="
    max-width:600px;
    margin:auto;
    background:#091b29;
    border:1px solid #21435d;
    border-radius:16px;
    padding:35px;
">

<h1 style="color:#16c7f2;">
🛡️ TrueAegis
</h1>

<h2>Password Reset</h2>

<p>
A password reset was requested for your account.
</p>

<p>
Your reset token is:
</p>

<div style="
    background:#102d43;
    padding:20px;
    border-radius:10px;
    text-align:center;
    word-break:break-all;
    color:#16c7f2;
">
${token}
</div>

<p style="color:#9db0c5;">
This token expires in 15 minutes.
</p>

<p style="color:#9db0c5;">
You can use the reset link below:
</p>

<p>
<a
    href="${resetUrl}"
    style="
        display:inline-block;
        padding:12px 18px;
        background:#16c7f2;
        color:#001018;
        text-decoration:none;
        border-radius:8px;
        font-weight:bold;
    "
>
Reset Password
</a>
</p>

</div>

</body>
</html>
`
    });
}

// ============================================================
// HEALTH
// GET /api/auth/health
// ============================================================

router.get("/health", (req, res) => {

    res.json({
        success: true,
        message: "TrueAegis authentication API is running."
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

        // ----------------------------------------------------
        // SUPPORT BOTH "name" AND "fullName"
        // ----------------------------------------------------

        const finalFullName =
            String(fullName || name || "").trim();

        const normalizedEmail =
            normalizeEmail(email);

        // ----------------------------------------------------
        // VALIDATION
        // ----------------------------------------------------

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

        if (!normalizedEmail.endsWith("@gmail.com")) {

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

        const finalAge =
            Number(age);

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

        // ----------------------------------------------------
        // FIND EXISTING USER
        // ----------------------------------------------------

        let user =
            await User.findOne({
                email: normalizedEmail
            });

        // ----------------------------------------------------
        // EXISTING VERIFIED USER
        // ----------------------------------------------------

        if (user && user.verified === true) {

            return res.status(409).json({

                success: false,

                code: "ACCOUNT_EXISTS",

                message:
                    "An account with this email already exists. Please log in."

            });

        }

        // ----------------------------------------------------
        // HASH PASSWORD
        // ----------------------------------------------------

        const hashedPassword =
            await bcrypt.hash(
                String(password),
                12
            );

        // ----------------------------------------------------
        // GENERATE OTP
        // ----------------------------------------------------

        const otp =
            generateOTP();

        const otpExpires =
            new Date(
                Date.now() + OTP_EXPIRY_MS
            );

        // ----------------------------------------------------
        // UPDATE EXISTING UNVERIFIED USER
        // ----------------------------------------------------

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

            user.otp =
                otp;

            user.otpExpires =
                otpExpires;

            await user.save();

            console.log(
                `♻️ Updated unverified account: ${normalizedEmail}`
            );

        }

        // ----------------------------------------------------
        // CREATE NEW USER
        // ----------------------------------------------------

        else {

            user =
                new User({

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

        // ----------------------------------------------------
        // SEND OTP
        // ----------------------------------------------------

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

    }

    catch (error) {

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

        // ----------------------------------------------------
        // VALIDATION
        // ----------------------------------------------------

        if (!normalizedEmail) {

            return res.status(400).json({

                success: false,

                message:
                    "Email is required."

            });

        }

        if (!/^\d{6}$/.test(enteredOTP)) {

            return res.status(400).json({

                success: false,

                message:
                    "Please enter the 6-digit verification code."

            });

        }

        // ----------------------------------------------------
        // FIND USER
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // ALREADY VERIFIED
        // ----------------------------------------------------

        if (user.verified === true) {

            return res.status(200).json({

                success: true,

                message:
                    "Your email is already verified.",

                verified: true,

                user: {
                    id: user._id,
                    fullName: user.fullName,
                    email: user.email,
                    age: user.age,
                    language: user.language
                }

            });

        }

        // ----------------------------------------------------
        // CHECK OTP
        // ----------------------------------------------------

        if (!user.otp) {

            return res.status(400).json({

                success: false,

                message:
                    "No verification code found. Please request a new one."

            });

        }

        // ----------------------------------------------------
        // CHECK OTP EXPIRY
        // ----------------------------------------------------

        if (
            !user.otpExpires ||
            Date.now() > new Date(user.otpExpires).getTime()
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

        // ----------------------------------------------------
        // COMPARE OTP
        // ----------------------------------------------------

        if (
            enteredOTP !==
            String(user.otp)
        ) {

            console.log(
                `❌ Incorrect OTP for ${normalizedEmail}`
            );

            return res.status(400).json({

                success: false,

                message:
                    "Incorrect verification code."

            });

        }

        // ----------------------------------------------------
        // *** THIS IS THE IMPORTANT PART ***
        // ----------------------------------------------------
        //
        // Your User model uses:
        //
        // verified
        //
        // NOT:
        //
        // isVerified
        //
        // ----------------------------------------------------

        user.verified = true;

        user.otp = null;

        user.otpExpires = null;

        await user.save();

        console.log(
            `✅ Email verified permanently: ${normalizedEmail}`
        );

        // ----------------------------------------------------
        // RETURN USER
        // ----------------------------------------------------

        return res.status(200).json({

            success: true,

            message:
                "Email verified successfully. You can now log in.",

            verified: true,

            user: {

                id:
                    user._id,

                fullName:
                    user.fullName,

                email:
                    user.email,

                age:
                    user.age,

                language:
                    user.language,

                verified:
                    user.verified

            }

        });

    }

    catch (error) {

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

        const otp =
            generateOTP();

        user.otp =
            otp;

        user.otpExpires =
            new Date(
                Date.now() + OTP_EXPIRY_MS
            );

        await user.save();

        await sendVerificationEmail(
            normalizedEmail,
            otp
        );

        console.log(
            `✅ New OTP sent to ${normalizedEmail}`
        );

        return res.status(200).json({

            success: true,

            message:
                "A new verification code has been sent."

        });

    }

    catch (error) {

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

        // ----------------------------------------------------
        // VALIDATION
        // ----------------------------------------------------

        if (!normalizedEmail || !password) {

            return res.status(400).json({

                success: false,

                message:
                    "Email and password are required."

            });

        }

        // ----------------------------------------------------
        // FIND USER
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // CHECK PASSWORD
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // CHECK VERIFIED STATUS
        // ----------------------------------------------------
        //
        // IMPORTANT:
        // Your User model uses "verified".
        //
        // ----------------------------------------------------

        if (user.verified !== true) {

            return res.status(403).json({

                success: false,

                code:
                    "EMAIL_NOT_VERIFIED",

                message:
                    "Please verify your email before logging in."

            });

        }

        // ----------------------------------------------------
        // LOGIN SUCCESS
        // ----------------------------------------------------

        console.log(
            `✅ Login successful: ${normalizedEmail}`
        );

        return res.status(200).json({

            success: true,

            message:
                "Login successful.",

            user: {

                id:
                    user._id,

                fullName:
                    user.fullName,

                email:
                    user.email,

                age:
                    user.age,

                language:
                    user.language,

                verified:
                    user.verified

            }

        });

    }

    catch (error) {

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
                email: normalizedEmail
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
                user.verified === true

        });

    }

    catch (error) {

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
                email: normalizedEmail
            });

        /*
         * Don't reveal whether the account exists.
         */

        if (!user) {

            return res.status(200).json({

                success: true,

                message:
                    "If an account exists for that email, a password reset email has been sent."

            });

        }

        // ----------------------------------------------------
        // GENERATE RESET TOKEN
        // ----------------------------------------------------

        const resetToken =
            crypto.randomBytes(32).toString("hex");

        user.resetPasswordToken =
            crypto
                .createHash("sha256")
                .update(resetToken)
                .digest("hex");

        user.resetPasswordExpires =
            new Date(
                Date.now() + RESET_EXPIRY_MS
            );

        await user.save();

        // ----------------------------------------------------
        // SEND RESET EMAIL
        // ----------------------------------------------------

        await sendPasswordResetEmail(
            normalizedEmail,
            resetToken
        );

        return res.status(200).json({

            success: true,

            message:
                "If an account exists for that email, a password reset email has been sent."

        });

    }

    catch (error) {

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
                    $gt: new Date()
                }

            });

        if (!user) {

            return res.status(400).json({

                success: false,

                message:
                    "The password reset token is invalid or has expired."

            });

        }

        // ----------------------------------------------------
        // UPDATE PASSWORD
        // ----------------------------------------------------

        user.password =
            await bcrypt.hash(
                String(password),
                12
            );

        user.resetPasswordToken =
            null;

        user.resetPasswordExpires =
            null;

        await user.save();

        console.log(
            `✅ Password reset successful: ${user.email}`
        );

        return res.status(200).json({

            success: true,

            message:
                "Password reset successfully. You can now log in."

        });

    }

    catch (error) {

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
//
// There is no server-side session to destroy yet.
// The current frontend can clear its local login state.
//
// ============================================================

router.post("/logout", (req, res) => {

    return res.status(200).json({

        success: true,

        message:
            "Logged out successfully."

    });

});

// ============================================================
// EXPORT ROUTER
// ============================================================

module.exports = router;