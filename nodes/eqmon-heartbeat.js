/**
 * eqmon-heartbeat — Gateway heartbeat / config sync node
 *
 * Emits a POST payload to /sync/gateway-config on a configurable interval.
 * Includes:
 *   - gateway_id, hostname, ip_address
 *   - node_package_version (this npm package version — lets eqmon flag outdated nodes)
 *   - nodered_version (runtime version)
 *   - firmware (configurable string — e.g. flow version tag)
 *   - uptime_seconds
 *
 * Output 1 — POST payload (wire to http request node for TLS/auth config)
 */
'use strict';

const os             = require('os');
const { PACKAGE_VERSION } = require('../lib/version');

module.exports = function (RED) {
    function EqmonHeartbeatNode(config) {
        RED.nodes.createNode(this, config);

        this.server   = RED.nodes.getNode(config.server);
        this.firmware = config.firmware || '';          // e.g. flow version tag
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
            const gatewayId = node.server.gatewayId;
            const apiKey    = node.server.credentials && node.server.credentials.apiKey;

            if (!gatewayId || !apiKey) {
                node.warn('eqmon-config is missing gateway_id or API key');
                return;
            }

            const hostname   = os.hostname();
            const interfaces = os.networkInterfaces();
            const ipAddress  = getLocalIp(interfaces);
            const uptimeSec  = Math.floor((Date.now() - startTime) / 1000);

            const body = {
                gateway_id:            gatewayId,
                hostname:              hostname,
                ip_address:            ipAddress,
                node_package_version:  PACKAGE_VERSION,
                nodered_version:       RED.version ? RED.version() : 'unknown',
                firmware:              node.firmware || undefined,
                uptime_seconds:        uptimeSec
            };

            // Remove undefined fields
            Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

            // baseUrl is the /sync root (e.g. https://telemetry.ecoeyetech.com/sync)
            const url = `${baseUrl.replace(/\/$/, '')}/gateway-config`;

            const msg = {
                method:  'POST',
                url:     url,
                headers: {
                    'Content-Type':  'application/json',
                    'X-Gateway-Key': apiKey
                },
                payload: JSON.stringify(body)
            };

            node.status({ fill: 'green', shape: 'dot', text: `sent @ ${new Date().toLocaleTimeString()}` });
            node.send(msg);
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
