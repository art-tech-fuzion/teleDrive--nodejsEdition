/**
 * TeleDrive Authentication & Security Service
 * Stateless HMAC-Signed Token Engine (Zero Disk Dependency)
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const Helpers = require('../utils/helpers');

// In-memory rate limiting and failed attempts tracker
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Base64Url encoding/decoding helpers
 */
function base64UrlEncode(str) {
    return Buffer.from(str)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function base64UrlDecode(str) {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return Buffer.from(base64, 'base64').toString('utf8');
}

const AuthService = {
    /**
     * Generate HMAC signature for payload string
     */
    _sign(data) {
        const secret = config.SESSION_SECRET || 'teledrive_fallback_secret_key_32bytes';
        return crypto
            .createHmac('sha256', secret)
            .update(data)
            .digest('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    },

    /**
     * Create a signed stateless session token
     */
    createToken(username) {
        const csrfToken = crypto.randomBytes(32).toString('hex');
        const payload = JSON.stringify({
            u: username,
            csrf: csrfToken,
            exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days expiration
        });
        const encodedPayload = base64UrlEncode(payload);
        const signature = this._sign(encodedPayload);
        const token = `${encodedPayload}.${signature}`;
        return { token, csrfToken, username };
    },

    /**
     * Verify and parse signed session token
     */
    verifyToken(token) {
        if (!token || typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length !== 2) return null;

        const [encodedPayload, signature] = parts;
        const expectedSignature = this._sign(encodedPayload);

        // Constant-time signature verification
        try {
            const sigBuf = Buffer.from(signature);
            const expectedBuf = Buffer.from(expectedSignature);
            if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
                return null;
            }

            const payloadStr = base64UrlDecode(encodedPayload);
            const payload = JSON.parse(payloadStr);

            // Check expiration
            if (!payload || !payload.exp || payload.exp < Date.now()) {
                return null;
            }

            return payload;
        } catch (e) {
            return null;
        }
    },

    /**
     * Express middleware to attach user session from signed cookie or header
     */
    attachUserMiddleware(req, res, next) {
        const token = (req.cookies && req.cookies.TELEDRIVE_SESSID) ||
                      req.headers['x-tele-session'] ||
                      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

        const sessionData = AuthService.verifyToken(token);
        if (sessionData) {
            req.userSession = sessionData;
            req.user = sessionData.u;
            req.csrfToken = sessionData.csrf;
        } else {
            req.userSession = null;
            req.user = null;
            req.csrfToken = null;
        }
        next();
    },

    /**
     * Verify credentials with lockout protection
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

        // Periodically prune stale lockout records
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
            // Plaintext fallback if user entered plaintext password in .env
            validPassword = (password === config.ADMIN_PASSWORD_HASH);
        } else {
            // Default setup password if empty: 'admin'
            console.warn("⚠️  [SECURITY WARNING] Logging in using default fallback password 'admin'! Please set ADMIN_PASSWORD_HASH in .env");
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
     * Retrieve current CSRF token from active request session
     */
    getCsrfToken(req) {
        return req.csrfToken || (req.userSession ? req.userSession.csrf : '');
    },

    /**
     * Verify CSRF token using length-safe constant-time comparison
     */
    verifyCsrf(req) {
        const submitted = req.headers['x-csrf-token'] || 
                          (req.body && (req.body._csrf || req.body.csrf_token)) || 
                          (req.query && (req.query._csrf || req.query.csrf_token));
        const expected = AuthService.getCsrfToken(req);
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

    /**
     * Express middleware to enforce authentication
     */
    requireAuth(req, res, next) {
        if (req.userSession && req.userSession.u) {
            return next();
        }
        if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api') || req.path.includes('api/index.php')) {
            return Helpers.error(res, 'Unauthorized. Please log in.', 401);
        }
        return res.redirect('/login');
    }
};

module.exports = AuthService;
