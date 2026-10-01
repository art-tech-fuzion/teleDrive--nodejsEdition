const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CLEANUP_SCHEDULE = process.env.CLEANUP_SCHEDULE || process.env.CLEANUP_INTERVAL || '1d';

const MAX_CHUNK_AGE_SECONDS = parseInt(process.env.MAX_CHUNK_AGE_SECONDS || '60', 10);

const TEMP_DIR = path.resolve(__dirname, process.env.TEMP_CHUNK_DIR || 'temp_chunks');

function parseScheduleToMs(schedule) {
    if (typeof schedule === 'number') return Math.max(1000, schedule);
    const str = String(schedule).trim().toLowerCase();

    if (str === 'midnight' || str === 'daily') {
        return 24 * 60 * 60 * 1000;
    }

    const match = str.match(/^(\d+)\s*([smhdw])?$/);
    if (!match) return 3600000;

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

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

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

    }
    return size;
}

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

            if (entry === '.sessions' || entry === 'index_cache.json' || entry.startsWith('.')) {
                continue;
            }

            const fullPath = path.join(TEMP_DIR, entry);
            try {
                const stats = fs.statSync(fullPath);
                let newestMs = Math.max(stats.mtimeMs || 0, stats.ctimeMs || 0, stats.birthtimeMs || 0);

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

function startDaemonMode() {
    runTempChunksCleanup();

    const intervalMs = parseScheduleToMs(CLEANUP_SCHEDULE);
    console.log(`🤖 [TempCleaner] Automated background cleaner active.`);
    console.log(`🔁 Interval: Running every '${CLEANUP_SCHEDULE}' (${(intervalMs / 1000 / 60).toFixed(1)} minutes)`);

    setInterval(() => {
        runTempChunksCleanup();
    }, intervalMs);
}

module.exports = {
    runTempChunksCleanup,
    startDaemonMode,
    CLEANUP_SCHEDULE,
    MAX_CHUNK_AGE_SECONDS,
    TEMP_DIR,
};

if (require.main === module) {
    const isDaemon = process.argv.includes('--daemon') || process.argv.includes('-d');
    if (isDaemon) {
        startDaemonMode();
    } else {
        runTempChunksCleanup();
    }
}
