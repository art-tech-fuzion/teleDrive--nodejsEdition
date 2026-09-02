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

const app = express();

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
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

app.use(session({
    name: 'TELEDRIVE_SESSID',
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
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
    res.status(500).json({
        success: false,
        status: 'error',
        message: err.message || 'Internal Server Error',
    });
});

// -----------------------------------------------------------------------------
// 6. Server Initialization & Boot Check
// -----------------------------------------------------------------------------
const PORT = config.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

if (require.main === module) {
    app.listen(PORT, HOST, async () => {
        console.log('\n========================================================');
        console.log(`🚀 TeleDrive (Node.js + MTProto) is running at:`);
        console.log(`   http://localhost:${PORT}`);
        console.log('========================================================');

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
}

module.exports = app;
