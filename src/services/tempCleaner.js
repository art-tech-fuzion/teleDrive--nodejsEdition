/**
 * TeleDrive Temp Chunk Cleaner Service
 * 
 * Automatically initializes and manages the background chunk cleaner timer
 * for the server application.
 */

const tempCleanerScript = require('../../cleanup-temp-chunks');

let isStarted = false;

const TempCleanerService = {
    /**
     * Start background chunk cleaner service on server boot
     */
    init() {
        if (isStarted) return;
        isStarted = true;
        tempCleanerScript.startDaemonMode();
    },

    /**
     * Execute immediate one-shot cleanup
     */
    runNow() {
        return tempCleanerScript.runTempChunksCleanup();
    }
};

module.exports = TempCleanerService;
