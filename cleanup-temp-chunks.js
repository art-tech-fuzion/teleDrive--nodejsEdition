/**
 * TeleDrive Automatic Temporary Chunk Cleanup Script
 * 
 * Automatically scans and purges stale temporary chunk directories on the server
 * to prevent disk space leaks on hosting environments (Hostinger / cPanel / Linux).
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

// =============================================================================
// CONFIGURATION (USER ADJUSTABLE)
// Edit these top-level variables or set corresponding environment variables in .env
// =============================================================================

/**
 * How often the cleanup script runs automatically in daemon/server mode.
 * Supported formats:
 *  - '1m'   : Every 1 minute
 *  - '15m'  : Every 15 minutes
 *  - '1h'   : Every 1 hour (Default)
 *  - '12h'  : Every 12 hours
 *  - '24h'  : Every 24 hours (Daily)
 *  - '1w'   : Every 1 week
 *  - 'midnight': Every day at 00:00 midnight
 *  - Number : Milliseconds directly (e.g., 3600000 for 1 hour)
 */
const CLEANUP_SCHEDULE = process.env.CLEANUP_SCHEDULE || process.env.CLEANUP_INTERVAL || '1d';

/**
 * Maximum age threshold (in seconds) for temporary chunk folders.
 * Folders older than this threshold will be deleted.
 *  - 1800  : 30 minutes (Default for active uploads)
 *  - 3600  : 1 hour
 *  - 86400 : 24 hours
 *  - 0     : Force purge ALL temporary chunk folders immediately
 */
const MAX_CHUNK_AGE_SECONDS = parseInt(process.env.MAX_CHUNK_AGE_SECONDS || '60', 10);

/**
 * Target temporary chunk directory path
 */
const TEMP_DIR = path.resolve(__dirname, process.env.TEMP_CHUNK_DIR || 'temp_chunks');

// =============================================================================
// HELPER FUNCTIONS & CLEANUP ENGINE
// =============================================================================

/**
 * Convert human-readable schedule string ('1m', '1h', '24h', etc.) to milliseconds
 */
function parseScheduleToMs(schedule) {
    if (typeof schedule === 'number') return Math.max(1000, schedule);
    const str = String(schedule).trim().toLowerCase();
    
    if (str === 'midnight' || str === 'daily') {
        return 24 * 60 * 60 * 1000; // 24 hours
    }
    
    const match = str.match(/^(\d+)\s*([smhdw])?$/);
    if (!match) return 3600000; // Fallback to 1 hour
    
    const val = parseInt(match[1], 10);
    const unit = match[2] || 'ms';
    
    switch (unit) {
        case 's': return val * 1000;
        case 'm': return val * 60 * 1000;
        case 'h': return val * 60 * 60 * 1000;
        case 'd': return val * 24 * 60 * 60 * 1000;
        case 'w': return val * 7 * 24 * 60 * 60 * 1000;
        default: return Math.max(1000, val);
    }
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Calculate total size of a directory recursively
 */
function getDirSize(dirPath) {
    let size = 0;
    if (!fs.existsSync(dirPath)) return 0;
    try {
        const stats = fs.statSync(dirPath);
        if (!stats.isDirectory()) return stats.size;

        const entries = fs.readdirSync(dirPath);
        for (const entry of entries) {
            size += getDirSize(path.join(dirPath, entry));
        }
    } catch (e) {
        // Ignore file access errors
    }
    return size;
}

/**
 * Main cleanup runner function
 */
function runTempChunksCleanup() {
    const now = Date.now();
    console.log(`\n========================================================`);
    console.log(`🧹 [TempCleaner] Starting temp chunk directory scan...`);
    console.log(`📂 Target Directory: ${TEMP_DIR}`);
    console.log(`⏱️  Age Threshold: ${MAX_CHUNK_AGE_SECONDS === 0 ? 'PURGE ALL (0s)' : `${MAX_CHUNK_AGE_SECONDS} seconds (${(MAX_CHUNK_AGE_SECONDS / 60).toFixed(1)} mins)`}`);
    console.log(`========================================================`);

    if (!fs.existsSync(TEMP_DIR)) {
        console.log(`ℹ️  Temp directory does not exist. Nothing to clean.`);
        return { deletedFolders: 0, bytesFreed: 0 };
    }

    let deletedFolders = 0;
    let bytesFreed = 0;

    try {
        const entries = fs.readdirSync(TEMP_DIR);
        for (const entry of entries) {
            // Protected system entries that must never be deleted by chunk cleaner
            if (entry === '.sessions' || entry === 'index_cache.json' || entry.startsWith('.')) {
                continue;
            }

            const fullPath = path.join(TEMP_DIR, entry);
            try {
                const stats = fs.statSync(fullPath);
                let newestMs = Math.max(stats.mtimeMs || 0, stats.ctimeMs || 0, stats.birthtimeMs || 0);

                // If it's a directory, check inner files to get accurate last-touch timestamp
                if (stats.isDirectory()) {
                    try {
                        const innerFiles = fs.readdirSync(fullPath);
                        for (const file of innerFiles) {
                            const fileStats = fs.statSync(path.join(fullPath, file));
                            const fileMs = Math.max(fileStats.mtimeMs || 0, fileStats.ctimeMs || 0);
                            if (fileMs > newestMs) newestMs = fileMs;
                        }
                    } catch (e) {}
                }

                const ageSecs = (now - newestMs) / 1000;

                // Delete if MAX_CHUNK_AGE_SECONDS is 0 (force purge) or folder age exceeds threshold
                if (MAX_CHUNK_AGE_SECONDS === 0 || ageSecs >= MAX_CHUNK_AGE_SECONDS) {
                    const folderSize = getDirSize(fullPath);
                    fs.rmSync(fullPath, { recursive: true, force: true });
                    deletedFolders++;
                    bytesFreed += folderSize;
                    console.log(`  ✓ Removed stale chunk folder: ${entry} (${formatBytes(folderSize)}, age: ${Math.round(ageSecs)}s)`);
                }
            } catch (err) {
                console.warn(`  ⚠️ Could not process ${entry}:`, err.message);
            }
        }
    } catch (err) {
        console.error(`❌ Error reading temp directory:`, err.message);
    }

    console.log(`--------------------------------------------------------`);
    console.log(`🎉 [TempCleaner] Scan complete.`);
    console.log(`📊 Purged ${deletedFolders} folders, freed ${formatBytes(bytesFreed)} of server disk space.`);
    console.log(`========================================================\n`);

    return { deletedFolders, bytesFreed };
}

/**
 * Start daemon mode interval runner
 */
function startDaemonMode() {
    runTempChunksCleanup();
    
    const intervalMs = parseScheduleToMs(CLEANUP_SCHEDULE);
    console.log(`🤖 [TempCleaner] Automated background cleaner active.`);
    console.log(`🔁 Interval: Running every '${CLEANUP_SCHEDULE}' (${(intervalMs / 1000 / 60).toFixed(1)} minutes)`);
    
    setInterval(() => {
        runTempChunksCleanup();
    }, intervalMs);
}

// Module export for server integration
module.exports = {
    runTempChunksCleanup,
    startDaemonMode,
    CLEANUP_SCHEDULE,
    MAX_CHUNK_AGE_SECONDS,
    TEMP_DIR,
};

// Execute if called directly via CLI (`node cleanup-temp-chunks.js`)
if (require.main === module) {
    const isDaemon = process.argv.includes('--daemon') || process.argv.includes('-d');
    if (isDaemon) {
        startDaemonMode();
    } else {
        runTempChunksCleanup();
    }
}
