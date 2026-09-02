/**
 * TeleDrive Authentication & Security Service
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const Helpers = require('../utils/helpers');

// In-memory rate limiting and failed attempts tracker
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const AuthService = {
    /**
     * Verify credentials
     */
    async login(username, password, clientIp) {
        // Check lockout
        const attempt = loginAttempts.get(clientIp);
        if (attempt && attempt.count >= MAX_ATTEMPTS) {
            const timeLeft = attempt.lockoutUntil - Date.now();
            if (timeLeft > 0) {
                return { success: false, locked: true, remainingSecs: Math.ceil(timeLeft / 1000) };
            } else {
                loginAttempts.delete(clientIp);
            }
        }

        const validUsername = (username === config.ADMIN_USERNAME);
        let validPassword = false;

        if (config.ADMIN_PASSWORD_HASH && config.ADMIN_PASSWORD_HASH.startsWith('$2')) {
            try {
                validPassword = await bcrypt.compare(password, config.ADMIN_PASSWORD_HASH);
            } catch (err) {
                validPassword = false;
            }
        } else if (config.ADMIN_PASSWORD_HASH) {
            // Plaintext fallback if user entered plaintext password in .env
            validPassword = (password === config.ADMIN_PASSWORD_HASH);
        } else {
            // Default setup password if empty: 'admin'
            validPassword = (password === 'admin');
        }

        if (validUsername && validPassword) {
            loginAttempts.delete(clientIp);
            return { success: true };
        }

        // Record failed attempt
        const current = loginAttempts.get(clientIp) || { count: 0, lockoutUntil: 0 };
        current.count += 1;
        if (current.count >= MAX_ATTEMPTS) {
            current.lockoutUntil = Date.now() + LOCKOUT_MS;
        }
        loginAttempts.set(clientIp, current);

        return {
            success: false,
            locked: current.count >= MAX_ATTEMPTS,
            remainingSecs: current.count >= MAX_ATTEMPTS ? Math.ceil(LOCKOUT_MS / 1000) : 0,
        };
    },

    /**
     * Generate or retrieve session CSRF token
     */
    getCsrfToken(req) {
        if (!req.session) return '';
        if (!req.session.csrfToken) {
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        }
        return req.session.csrfToken;
    },

    /**
     * Verify CSRF token
     */
    verifyCsrf(req) {
        const submitted = req.headers['x-csrf-token'] || req.body._csrf || req.query._csrf;
        const expected = req.session ? req.session.csrfToken : null;
        if (!expected || !submitted) return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
        } catch (e) {
            return false;
        }
    },

    /**
     * Express middleware to enforce authentication
     */
    requireAuth(req, res, next) {
        if (req.session && req.session.user) {
            return next();
        }
        if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api') || req.path.includes('api/index.php')) {
            return Helpers.error(res, 'Unauthorized. Please log in.', 401);
        }
        return res.redirect('/login');
    }
};

module.exports = AuthService;
