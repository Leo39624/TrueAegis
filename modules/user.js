const mongoose = require("mongoose");

// =====================================================
// USER SCHEMA
// =====================================================

const userSchema = new mongoose.Schema(
    {
        // -------------------------
        // User's full name
        // -------------------------

        fullName: {
            type: String,
            required: true,
            trim: true,
            minlength: 2,
            maxlength: 100
        },

        // -------------------------
        // Email address
        // -------------------------

        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            index: true
        },

        // -------------------------
        // Hashed password
        // -------------------------

        password: {
            type: String,
            required: true
        },

        // -------------------------
        // Email verification
        // -------------------------

        verified: {
            type: Boolean,
            default: false
        },

        // -------------------------
        // Password reset token
        // -------------------------

        resetPasswordToken: {
            type: String,
            default: null
        },

        // -------------------------
        // Password reset expiry
        // -------------------------

        resetPasswordExpires: {
            type: Date,
            default: null
        },

        // -------------------------
        // Optional age
        // -------------------------

        age: {
            type: Number,
            default: null,
            min: 13
        },

        // -------------------------
        // Preferred language
        // -------------------------

        language: {
            type: String,
            default: "English",
            trim: true
        },

        // -------------------------
        // OTP for email verification
        // -------------------------

        otp: {
            type: String,
            default: null
        },

        // -------------------------
        // OTP expiry
        // -------------------------

        otpExpires: {
            type: Date,
            default: null
        }
    },

    {
        timestamps: true
    }
);

// =====================================================
// EXPORT MODEL
// =====================================================

const User = mongoose.model(
    "User",
    userSchema
);

module.exports = User;