'use strict';

const pkg = require('../package.json');

/**
 * The installed version of this node package.
 * Included in heartbeat payloads so eqmon can detect outdated gateway nodes.
 */
const PACKAGE_VERSION = pkg.version;

module.exports = { PACKAGE_VERSION };
