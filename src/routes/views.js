/**
 * TeleDrive Views Router
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const AuthService = require('../services/auth');

const APP_TEMPLATE_PATH = path.resolve(__dirname, '../../templates/frontend/app.html');
const LOGIN_TEMPLATE_PATH = path.resolve(__dirname, '../../templates/backend/login.html');

// Login page
router.get('/login', (req, res) => {
    if (req.userSession && req.userSession.u) {
        return res.redirect('/');
    }
    if (!fs.existsSync(LOGIN_TEMPLATE_PATH)) {
        return res.status(404).send('Login template not found.');
    }
    try {
        let html = fs.readFileSync(LOGIN_TEMPLATE_PATH, 'utf8');
        const config = require('../config');
        let assetVersion = config.VERSION;
        try {
            const loginJsPath = path.resolve(__dirname, '../../assets/backend/login.js');
            if (fs.existsSync(loginJsPath)) {
                assetVersion = `${assetVersion}.${fs.statSync(loginJsPath).mtimeMs}`;
            }
        } catch (e) {}

        html = html.replace(/{{ASSET_VERSION}}/g, assetVersion);
        html = html.replace(/{{APP_VERSION}}/g, config.VERSION);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        return res.sendFile(LOGIN_TEMPLATE_PATH);
    }
});

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Dashboard root
router.get('/', AuthService.requireAuth, (req, res) => {
    if (!fs.existsSync(APP_TEMPLATE_PATH)) {
        return res.status(404).send('Dashboard template not found.');
    }

    try {
        let html = fs.readFileSync(APP_TEMPLATE_PATH, 'utf8');
        const csrfToken = AuthService.getCsrfToken(req);
        const username = (req.userSession && req.userSession.u) || 'Admin';

        // Dynamic file-modified timestamp or centralized version for cache-busting
        const config = require('../config');
        let assetVersion = config.VERSION;
        try {
            const appJsPath = path.resolve(__dirname, '../../assets/frontend/app.js');
            if (fs.existsSync(appJsPath)) {
                assetVersion = `${assetVersion}.${fs.statSync(appJsPath).mtimeMs}`;
            }
        } catch (e) {}

        html = html.replace(/{{CSRF_TOKEN}}/g, csrfToken);
        html = html.replace(/{{USERNAME}}/g, escapeHtml(username));
        html = html.replace(/{{ASSET_VERSION}}/g, assetVersion);
        html = html.replace(/{{APP_VERSION}}/g, config.VERSION);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        console.error('Error rendering app template:', err.message);
        return res.status(500).send('Internal Server Error rendering page.');
    }
});

module.exports = router;
