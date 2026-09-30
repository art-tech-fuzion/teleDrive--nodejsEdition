const pkg = require('../package.json');

const VERSION = pkg.version;

module.exports = {
    VERSION,
    ENGINE_VERSION: `${VERSION} (MTProto Node.js)`,
    MANIFEST_VERSION: VERSION,
};
