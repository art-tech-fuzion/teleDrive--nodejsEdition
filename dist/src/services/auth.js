const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const Helpers = require('../utils/helpers');

const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const AuthService = {

    async login(username, password, clientIp) {

        const attempt = loginAttempts.get(clientIp);
        if (attempt && attempt.count >= MAX_ATTEMPTS) {
            const timeLeft = attempt.lockoutUntil - Date.now();
            if (timeLeft > 0) {
                return { success: false, locked: true, remainingSecs: Math.ceil(timeLeft / 1000) };
            } else {
                loginAttempts.delete(clientIp);
            }
        }

        if (loginAttempts.size > 200) {
            const now = Date.now();
            for (const [ip, data] of loginAttempts.entries()) {
                if (data.lockoutUntil < now) {
                    loginAttempts.delete(ip);
                }
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

            validPassword = (password === config.ADMIN_PASSWORD_HASH);
        } else {

            console.warn("⚠️  [SECURITY WARNING] Logging in using default fallback password 'admin'! Please set ADMIN_PASSWORD_HASH in .env");
            validPassword = (password === 'admin');
        }

        if (validUsername && validPassword) {
            loginAttempts.delete(clientIp);
            return { success: true };
        }

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

    getCsrfToken(req) {
        if (!req.session) return '';
        if (!req.session.csrfToken) {
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        }
        return req.session.csrfToken;
    },

    verifyCsrf(req) {
        const submitted = req.headers['x-csrf-token'] ||
                          (req.body && (req.body._csrf || req.body.csrf_token)) ||
                          (req.query && (req.query._csrf || req.query.csrf_token));
        const expected = req.session ? req.session.csrfToken : null;
        if (!expected || !submitted) return false;
        try {
            const submittedBuf = Buffer.from(String(submitted));
            const expectedBuf = Buffer.from(String(expected));
            if (submittedBuf.length !== expectedBuf.length) {
                return false;
            }
            return crypto.timingSafeEqual(submittedBuf, expectedBuf);
        } catch (e) {
            return false;
        }
    },

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
