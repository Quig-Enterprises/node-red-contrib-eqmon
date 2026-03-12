/**
 * eqmon-heartbeat — Gateway heartbeat / config sync node
 *
 * Emits a POST payload to /sync/gateway-config on a configurable interval.
 * Firmware version and gateway_id are read automatically from the local
 * SQLite gateway_config table (no manual configuration required).
 *
 * Includes:
 *   - gateway_id         (derived from gateway_mac in gateway_config)
 *   - hostname, ip_address
 *   - node_package_version (this npm package version)
 *   - nodered_version    (runtime version)
 *   - firmware           (platform_version from gateway_config table)
 *   - uptime_seconds
 *
 * Output 1 — POST payload (wire to http request node for TLS/auth config)
 */
'use strict';

const os             = require('os');
const path           = require('path');
const { PACKAGE_VERSION } = require('../lib/version');

// SQLite3 — bundled with the Atrium gateway; if not available fall back to null
let sqlite3;
try { sqlite3 = require('sqlite3').verbose(); } catch (e) { sqlite3 = null; }

const DB_PATH = '/overlay/telemetry.db';

module.exports = function (RED) {
    function EqmonHeartbeatNode(config) {
        RED.nodes.createNode(this, config);

        this.server   = RED.nodes.getNode(config.server);
        this.interval = parseInt(config.interval, 10) || 60; // seconds

        const node = this;
        let timer = null;
        const startTime = Date.now();

        function sendHeartbeat() {
            if (!node.server) {
                node.warn('No eqmon config node selected');
                return;
            }

            const baseUrl   = node.server.baseUrl;
            const apiKey    = node.server.credentials && node.server.credentials.apiKey;

            if (!apiKey) {
                node.warn('eqmon-config is missing API key');
                return;
            }

            readGatewayConfig(function (cfg) {
                const gatewayId = cfg.gatewayId || node.server.gatewayId;
                if (!gatewayId) {
                    node.warn('Cannot determine gateway_id (no gateway_mac in DB and none in config)');
                    return;
                }

                const hostname  = os.hostname();
                const ifaces    = os.networkInterfaces();
                const ipAddress = getLocalIp(ifaces);
                const uptimeSec = Math.floor((Date.now() - startTime) / 1000);

                const gatewayMac = cfg.mac || node.server.gatewayMac || undefined;
                const body = {
                    gateway_id:            gatewayId,
                    gateway_mac:           gatewayMac,
                    hostname:              hostname,
                    ip_address:            ipAddress,
                    node_package_version:  PACKAGE_VERSION,
                    nodered_version:       RED.version ? RED.version() : 'unknown',
                    firmware:              cfg.firmware || undefined,
                    uptime_seconds:        uptimeSec
                };

                // Remove undefined fields
                Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

                const url = baseUrl.replace(/\/$/, '') + '/gateway-config';

                const msg = {
                    url:     url,
                    headers: {
                        'Content-Type':  'application/json',
                        'X-Gateway-Key': apiKey
                    },
                    payload: JSON.stringify(body)
                };

                node.status({ fill: 'green', shape: 'dot', text: 'sent @ ' + new Date().toLocaleTimeString() });
                node.send(msg);
            });
        }

        // Send immediately on deploy, then on interval
        sendHeartbeat();
        timer = setInterval(sendHeartbeat, node.interval * 1000);

        node.on('close', function () {
            if (timer) clearInterval(timer);
        });
    }

    RED.nodes.registerType('eqmon-heartbeat', EqmonHeartbeatNode);
};

// ---------------------------------------------------------------
//  Read firmware + gateway_id from local SQLite DB
// ---------------------------------------------------------------

function readGatewayConfig(cb) {
    if (!sqlite3) {
        cb({ firmware: null, gatewayId: null });
        return;
    }
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, function (err) {
        if (err) { cb({ firmware: null, gatewayId: null }); return; }
        db.all(
            "SELECT key, value FROM gateway_config WHERE key IN ('platform_version','gateway_mac')",
            function (err, rows) {
                db.close();
                if (err || !rows) { cb({ firmware: null, gatewayId: null }); return; }
                const map = {};
                rows.forEach(function (r) { map[r.key] = r.value; });
                const firmware  = map['platform_version'] || null;
                const mac       = map['gateway_mac'] || null;
                // gateway_id = "gw_" + MAC without colons, e.g. gw_34fa402aa72a
                const gatewayId = mac ? 'gw_' + mac.replace(/:/g, '').toLowerCase() : null;
                cb({ firmware: firmware, gatewayId: gatewayId, mac: mac });
            }
        );
    });
}

// ---------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------

function getLocalIp(interfaces) {
    for (const iface of Object.values(interfaces)) {
        for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) {
                return addr.address;
            }
        }
    }
    return null;
}
