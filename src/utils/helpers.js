/**
 * TeleDrive Helper Utilities
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');

const Helpers = {
    /**
     * Sanitize filename to prevent directory traversal, header injection, and illegal characters
     */
    sanitizeFilename(filename) {
        if (!filename) return 'unnamed_file';
        let safe = path.basename(String(filename));
        safe = safe.replace(/[/\\?%*:|"<>;&\r\n\x00-\x1F\x7F]/g, '_');
        safe = safe.replace(/^\.+/, '');
        return safe.trim() || 'unnamed_file';
    },

    /**
     * Generate unique identifier
     */
    generateId(prefix = 'item') {
        const rand = crypto.randomBytes(8).toString('hex');
        const timestamp = Date.now().toString(36);
        return `${prefix}_${timestamp}_${rand}`;
    },

    /**
     * Format bytes to human readable format (KB, MB, GB, TB)
     */
    formatBytes(bytes, decimals = 2) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    },

    /**
     * Get MIME type with comprehensive fallback mapping
     */
    getMimeType(filename) {
        const ext = path.extname(filename).toLowerCase().replace('.', '');
        const customMap = {
            wpress: 'application/octet-stream',
            mkv: 'video/webm',
            apk: 'application/vnd.android.package-archive',
            ipa: 'application/octet-stream',
        };
        if (customMap[ext]) {
            return customMap[ext];
        }
        return mime.lookup(filename) || 'application/octet-stream';
    },

    /**
     * Standard JSON success response
     */
    success(res, data = {}, message = 'Success', statusCode = 200) {
        return res.status(statusCode).json({
            success: true,
            status: 'success',
            message,
            ...data,
            data,
        });
    },

    /**
     * Standard JSON error response
     */
    error(res, message = 'Internal Server Error', statusCode = 500) {
        return res.status(statusCode).json({
            success: false,
            status: 'error',
            message,
            error: message,
        });
    },

    /**
     * Recursively remove a directory
     */
    removeDir(dirPath) {
        if (fs.existsSync(dirPath)) {
            try {
                fs.rmSync(dirPath, { recursive: true, force: true });
            } catch (err) {
                console.error(`Error removing dir ${dirPath}:`, err.message);
            }
        }
    },

    /**
     * Clean stale upload session folders from temp directory
     */
    cleanStaleUploadSessions(tempDir, maxAgeSecs = 3600) {
        if (!fs.existsSync(tempDir)) return;
        const now = Date.now();
        try {
            const entries = fs.readdirSync(tempDir);
            for (const entry of entries) {
                const fullPath = path.join(tempDir, entry);
                try {
                    const stats = fs.statSync(fullPath);
                    if (stats.isDirectory()) {
                        const ageSecs = (now - stats.mtimeMs) / 1000;
                        if (ageSecs > maxAgeSecs) {
                            Helpers.removeDir(fullPath);
                        }
                    }
                } catch (e) {
                    // Ignore stat errors for deleted files
                }
            }
        } catch (e) {
            console.error('Error cleaning stale upload sessions:', e.message);
        }
    }
};

module.exports = Helpers;
