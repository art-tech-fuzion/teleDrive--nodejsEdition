const tempCleanerScript = require('../../cleanup-temp-chunks');

let isStarted = false;

const TempCleanerService = {

    init() {
        if (isStarted) return;
        isStarted = true;
        tempCleanerScript.startDaemonMode();
    },

    runNow() {
        return tempCleanerScript.runTempChunksCleanup();
    }
};

module.exports = TempCleanerService;
