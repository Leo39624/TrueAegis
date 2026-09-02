const mongoose = require("mongoose");

// ============================================================
// TRUEAEGIS USER SCHEMA
// ============================================================

const userSchema = new mongoose.Schema(
    {
        // ----------------------------------------------------
        // BASIC INFORMATION
        // ----------------------------------------------------

        fullName: {
            type: String,
            required: true,
            trim: true
        },

        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },

        age: {
            type: Number,
            default: null
        },

        language: {
            type: String,
            default: "English",
            trim: true
        },

        // ----------------------------------------------------
        // LOCAL AUTHENTICATION
        // ----------------------------------------------------

        password: {
            type: String,
            default: null
        },

        // ----------------------------------------------------
        // ACCOUNT VERIFICATION
        // ----------------------------------------------------

        verified: {
            type: Boolean,
            default: false
        },

        authProvider: {
            type: String,
            enum: ["local", "google"],
            default: "local"
        },

        // ----------------------------------------------------
        // OTP VERIFICATION
        // ----------------------------------------------------

        otp: {
            type: String,
            default: null
        },

        otpExpires: {
            type: Date,
            default: null
        },

        // ----------------------------------------------------
        // GOOGLE SIGN-IN
        // ----------------------------------------------------

        googleId: {
            type: String,
            default: null,
            sparse: true
        },

        // ----------------------------------------------------
        // PASSWORD RESET
        // ----------------------------------------------------

        resetPasswordToken: {
            type: String,
            default: null
        },

        resetPasswordExpires: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: true
    }
);

// ============================================================
// EXPORT MODEL
// ============================================================

module.exports =
    mongoose.models.User ||
    mongoose.model("User", userSchema);