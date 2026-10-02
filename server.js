/**
 * TeleDrive Node.js Server Entry Point
 * 
 * Powered by Telegram MTProto User API (GramJS)
 * Zero-Database Architecture with 50-Message Manifest Checkpointing
 */

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const config = require('./src/config');
const apiRoutes = require('./src/routes/api');
const viewRoutes = require('./src/routes/views');
const telegramService = require('./src/services/telegram');
const storageEngine = require('./src/services/storageEngine');
const tempCleaner = require('./src/services/tempCleaner');

const app = express();

// Trust reverse proxy (Hostinger Nginx/Passenger)
app.set('trust proxy', 1);

// -----------------------------------------------------------------------------
// 1. Security & Header Hardening Middleware
// -----------------------------------------------------------------------------
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'self';"
    );
    next();
});

// -----------------------------------------------------------------------------
// 2. Request Parsers & Sessions
// -----------------------------------------------------------------------------
// Secure CORS configuration: only allow configured origins, or block cross-origin requests by default
const allowedOrigins = process.env.CORS_ORIGIN 
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
    : null;

app.use(cors({
    origin: allowedOrigins ? (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, or same-origin)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Blocked by CORS policy'));
        }
    } : false, // Default to false: prevents unauthorized cross-origin web requests
    credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// File-based persistent session store for multi-process / server restarts
class DiskSessionStore extends session.Store {
    constructor() {
        super();
        this.dir = process.env.SESSION_DIR 
            ? path.resolve(process.env.SESSION_DIR)
            : path.join(__dirname, 'temp_chunks', '.sessions');
        this._ensureDir();
    }
    _ensureDir() {
        try {
            if (!fs.existsSync(this.dir)) {
                fs.mkdirSync(this.dir, { recursive: true });
            }
        } catch (e) {
            console.error('⚠️ Could not create session directory:', e.message);
        }
    }
    _getFilePath(sid) {
        if (!sid) return null;
        // Strictly sanitize sid to prevent directory traversal
        const safeSid = String(sid).replace(/[^a-zA-Z0-9_\-]/g, '');
        if (!safeSid) return null;
        return path.join(this.dir, `${safeSid}.json`);
    }
    get(sid, cb) {
        this._ensureDir();
        const filePath = this._getFilePath(sid);
        if (!filePath || !fs.existsSync(filePath)) return cb(null, null);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (data.cookie && data.cookie.expires && new Date(data.cookie.expires) < new Date()) {
                try { fs.unlinkSync(filePath); } catch (e) {}
                return cb(null, null);
            }
            return cb(null, data);
        } catch (e) {
            return cb(null, null);
        }
    }
    set(sid, sess, cb) {
        this._ensureDir();
        const filePath = this._getFilePath(sid);
        if (!filePath) return cb && cb(new Error('Invalid session ID'));
        try {
            fs.writeFileSync(filePath, JSON.stringify(sess), 'utf8');
            return cb && cb(null);
        } catch (e) {
            return cb && cb(e);
        }
    }
    destroy(sid, cb) {
        this._ensureDir();
        const filePath = this._getFilePath(sid);
        if (!filePath) return cb && cb(null);
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return cb && cb(null);
        } catch (e) {
            return cb && cb(null);
        }
    }
    touch(sid, sess, cb) {
        return this.set(sid, sess, cb);
    }
}

app.use(session({
    store: new DiskSessionStore(),
    name: 'TELEDRIVE_SESSID',
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        // Secure dynamically based on environment or explicit flag; supports reverse-proxy HTTPS via trust proxy
        secure: process.env.COOKIE_SECURE === 'true' ? true : (process.env.COOKIE_SECURE === 'false' ? false : (process.env.NODE_ENV === 'production' ? true : 'auto')),
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    }
}));

// -----------------------------------------------------------------------------
// 3. Static Assets
// -----------------------------------------------------------------------------
const ASSETS_PATH = path.resolve(__dirname, 'assets');
const SHARED_PATH = path.resolve(__dirname, 'shared');
app.use('/assets', express.static(ASSETS_PATH, {
    maxAge: '1d',
    etag: true,
}));
app.use('/shared', express.static(SHARED_PATH, {
    maxAge: '1d',
    etag: true,
}));

// Serve favicon
app.get('/favicon.ico', (req, res) => {
    const favPath = path.join(ASSETS_PATH, 'favicon.svg');
    if (fs.existsSync(favPath)) {
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.sendFile(favPath);
    }
    res.status(204).end();
});

// -----------------------------------------------------------------------------
// 4. API & Route Mounting
// -----------------------------------------------------------------------------
// REST API routes
app.use('/api', apiRoutes);

// Backward-compatibility bridge for existing frontend AJAX calls to 'api/index.php'
app.use('/api/index.php', apiRoutes);
app.use('/login/api/index.php', apiRoutes);
app.use('/index.php', (req, res, next) => {
    if (req.query.action || req.body.action) {
        return apiRoutes(req, res, next);
    }
    return res.redirect('/');
});

// Frontend Views
app.use('/', viewRoutes);

// -----------------------------------------------------------------------------
// 5. Global Error Handling
// -----------------------------------------------------------------------------
app.use((err, req, res, next) => {
    console.error('Unhandled Application Error:', err);
    if (res.headersSent) {
        return next(err);
    }
    // MED-1 Fix: Never expose raw error internals (stack traces, Telegram details) to the client in production.
    const isProd = process.env.NODE_ENV === 'production';
    const clientMessage = isProd ? 'An internal server error occurred. Please try again.' : (err.message || 'Internal Server Error');
    res.status(500).json({
        success: false,
        status: 'error',
        message: clientMessage,
        error: clientMessage,
    });
});

// -----------------------------------------------------------------------------
// 6. Server Initialization & Boot Check
// -----------------------------------------------------------------------------
const PORT = config.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

if (require.main === module) {
    const server = app.listen(PORT, HOST, async () => {
        console.log('\n========================================================');
        console.log(`🚀 TeleDrive v${config.VERSION} (Node.js + MTProto) is running at:`);
        console.log(`   http://localhost:${PORT}`);
        console.log('========================================================');
        if (!config.ADMIN_PASSWORD_HASH) {
            console.warn("⚠️  SECURITY WARNING: ADMIN_PASSWORD_HASH is not configured in .env! Default password 'admin' is active. Please set a strong bcrypt password hash.");
        }

        if (config.isConfigured()) {
            console.log('📡 Telegram MTProto credentials detected.');
            console.log('🔗 Connecting to Telegram MTProto and warming storage engine cache...');
            try {
                await telegramService.getClient();
                console.log('✅ Telegram MTProto client connected.');
                storageEngine.getFileSystemIndex(false).then((idx) => {
                    console.log(`📂 Storage index loaded (${idx.total_items} items, pinnedMsg: ${idx.pinned_message_id}, deltas: ${idx.delta_count}).`);
                }).catch(e => {
                    console.warn('⚠️  Could not preload filesystem index:', e.message);
                });
            } catch (e) {
                console.error('⚠️  Failed to connect to Telegram MTProto on startup:', e.message);
                console.log('👉 Make sure API_ID, API_HASH, and STRING_SESSION are valid.');
            }
        } else {
            console.log('⚠️  Notice: Telegram MTProto credentials are not fully configured yet in .env');
            console.log('👉 Run `npm run generate-session` to generate your Telegram STRING_SESSION.');
        }

        console.log('========================================================\n');
    });

    // Configure Keep-Alive timeouts to prevent connection drops during file downloads
    server.timeout = 0;
    server.keepAliveTimeout = 65000; // 65 seconds
    server.headersTimeout = 66000; // 66 seconds
}

// Initialize automated background temp chunk cleaner ONCE on app server startup
tempCleaner.init();

module.exports = app;
