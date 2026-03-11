/**
 * eqmon-name-sync — Inbound name sync node (eqmon → gateway)
 *
 * Polls eqmon for sensor names and gateway name, then applies any changes
 * to the local Atrium gateway by calling the gateway's own Node-RED HTTP API
 * on localhost.
 *
 * Flow:
 *   1. GET {eqmon}/api/sensors.php  (using gateway API key)
 *   2. GET {eqmon}/api/admin/gateways.php?gateway_id=X  (gateway name)
 *   3. Compare against snapshot stored in flow context
 *   4. For each changed sensor name: POST http://localhost:1880/api/sensors/:mac/meta
 *   5. For changed gateway name:    POST http://localhost:1880/api/gateway/config
 *   6. Save new snapshot
 *
 * Output 1 — summary msg (fires only when changes were applied):
 *   msg.payload = { applied: [{device_id, old_name, new_name}], gateway_renamed: bool }
 *
 * No output is emitted when nothing changed.
 *
 * Auth:
 *   eqmon calls use X-Gateway-Key header (same key as sync nodes).
 *   Local Node-RED calls use the node-red admin token obtained via the
 *   config node credentials (nodered_username / nodered_password).
 */
'use strict';

const http  = require('http');
const https = require('https');

module.exports = function (RED) {
    function EqmonNameSyncNode(config) {
        RED.nodes.createNode(this, config);

        this.server         = RED.nodes.getNode(config.server);
        this.interval       = parseInt(config.interval, 10) || 300; // seconds, default 5 min
        this.nrPort         = parseInt(config.nrPort, 10)   || 1880;
        this.nrUsername     = config.nrUsername || 'ncdio';
        // nrPassword stored in credentials
        this.nrPassword     = this.credentials && this.credentials.nrPassword;

        const node = this;
        let timer  = null;

        async function syncNames() {
            if (!node.server) return;

            const baseUrl   = node.server.baseUrl;
            const gatewayId = node.server.gatewayId;
            const apiKey    = node.server.credentials && node.server.credentials.apiKey;

            if (!gatewayId || !apiKey) {
                node.warn('eqmon-config is missing gateway_id or API key');
                return;
            }

            node.status({ fill: 'blue', shape: 'ring', text: 'checking...' });

            try {
                // Derive the management API root from the sync base URL
                // e.g. https://telemetry.ecoeyetech.com/sync → https://telemetry.ecoeyetech.com
                const apiRoot = baseUrl.replace(/\/sync\/?$/, '');

                // 1. Fetch current sensor list from eqmon (filtered to this gateway)
                const sensorsUrl = `${apiRoot}/api/sensors.php?gateway_id=${encodeURIComponent(gatewayId)}`;
                const sensorsResp = await fetchJson(sensorsUrl, { 'X-Gateway-Key': apiKey });
                const sensors = (sensorsResp.sensors || sensorsResp.devices || []);

                // 2. Fetch gateway info
                const gwUrl = `${apiRoot}/api/admin/gateways.php?gateway_id=${encodeURIComponent(gatewayId)}`;
                let gatewayName = null;
                try {
                    const gwResp = await fetchJson(gwUrl, { 'X-Gateway-Key': apiKey });
                    gatewayName = gwResp.gateway_name || gwResp.name || null;
                } catch (_) { /* non-fatal */ }

                // 3. Load snapshot from context
                const snapshot    = node.context().flow.get('eqmon_name_snapshot') || {};
                const gwSnapshot  = node.context().flow.get('eqmon_gw_name_snapshot') || null;

                // 4. Authenticate to local Node-RED
                let nrToken = null;
                try {
                    nrToken = await getNrToken(node.nrPort, node.nrUsername, node.nrPassword);
                } catch (e) {
                    node.warn(`Local Node-RED auth failed: ${e.message}`);
                }

                const applied = [];

                // 5. Apply sensor name changes
                for (const sensor of sensors) {
                    const deviceId   = sensor.device_id;
                    const newName    = sensor.name || sensor.sensor_name || null;
                    if (!deviceId || !newName) continue;

                    const oldName = snapshot[deviceId] || null;
                    if (newName === oldName) continue;

                    // Format device_id as colon MAC for gateway API
                    const colonMac = toColonMac(deviceId);
                    if (!colonMac) continue;

                    if (nrToken) {
                        try {
                            await postJson(
                                node.nrPort,
                                `/api/sensors/${encodeURIComponent(colonMac)}/meta`,
                                { sensor_name: newName },
                                nrToken
                            );
                            applied.push({ device_id: deviceId, old_name: oldName, new_name: newName });
                            snapshot[deviceId] = newName;
                        } catch (e) {
                            node.warn(`Failed to update ${deviceId}: ${e.message}`);
                        }
                    } else {
                        // No NR token — just track what would have changed
                        applied.push({ device_id: deviceId, old_name: oldName, new_name: newName, dry_run: true });
                    }
                }

                // 6. Apply gateway name change
                let gatewayRenamed = false;
                if (gatewayName && gatewayName !== gwSnapshot && nrToken) {
                    try {
                        await postJson(node.nrPort, '/api/gateway/config', { gateway_name: gatewayName }, nrToken);
                        gatewayRenamed = true;
                        node.context().flow.set('eqmon_gw_name_snapshot', gatewayName);
                    } catch (e) {
                        node.warn(`Failed to update gateway name: ${e.message}`);
                    }
                }

                // 7. Save updated snapshot
                node.context().flow.set('eqmon_name_snapshot', snapshot);

                if (applied.length > 0 || gatewayRenamed) {
                    const summary = `${applied.length} sensor(s)${gatewayRenamed ? ' + gateway' : ''} renamed`;
                    node.status({ fill: 'green', shape: 'dot', text: summary });
                    node.send({
                        payload: { applied, gateway_renamed: gatewayRenamed },
                        topic:   'eqmon-name-sync'
                    });
                } else {
                    node.status({ fill: 'grey', shape: 'ring', text: `synced @ ${new Date().toLocaleTimeString()}` });
                }

            } catch (e) {
                node.status({ fill: 'red', shape: 'ring', text: e.message });
                node.error(`eqmon-name-sync: ${e.message}`);
            }
        }

        // Run immediately on deploy, then on interval
        syncNames();
        timer = setInterval(syncNames, node.interval * 1000);

        node.on('input', function (_msg, _send, done) {
            // Manual trigger
            syncNames().then(() => done()).catch(e => done(e));
        });

        node.on('close', function () {
            if (timer) clearInterval(timer);
        });
    }

    RED.nodes.registerType('eqmon-name-sync', EqmonNameSyncNode, {
        credentials: {
            nrPassword: { type: 'password' }
        }
    });
};

// ---------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------

function toColonMac(deviceId) {
    if (!deviceId) return null;
    const raw = deviceId.replace(/:/g, '');
    if (raw.length % 2 !== 0) return null;
    return raw.match(/.{2}/g).join(':');
}

function fetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const lib      = url.startsWith('https') ? https : http;
        const reqHeaders = { 'Accept': 'application/json', ...headers };

        lib.get(url, { headers: reqHeaders }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 100)}`));
                }
            });
        }).on('error', reject);
    });
}

function postJson(port, path, data, bearerToken) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const opts = {
            hostname: 'localhost',
            port:     port,
            path:     path,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization':  `Bearer ${bearerToken}`
            }
        };

        const req = http.request(opts, (res) => {
            let respBody = '';
            res.on('data', chunk => respBody += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(respBody);
                } else {
                    reject(new Error(`POST ${path} returned ${res.statusCode}: ${respBody.slice(0, 100)}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function getNrToken(port, username, password) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            client_id:  'node-red-admin',
            grant_type: 'password',
            scope:      '*',
            username,
            password: password || ''
        }).toString();

        const opts = {
            hostname: 'localhost',
            port,
            path:    '/auth/token',
            method:  'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = http.request(opts, (res) => {
            let respBody = '';
            res.on('data', chunk => respBody += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(respBody);
                    if (data.access_token) {
                        resolve(data.access_token);
                    } else {
                        reject(new Error('No access_token in Node-RED auth response'));
                    }
                } catch (e) {
                    reject(new Error(`Node-RED auth parse error: ${respBody.slice(0, 100)}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
