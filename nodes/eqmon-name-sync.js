/**
 * eqmon-name-sync — Pull sensor/gateway name changes from eqmon and apply
 * them to the local gateway SQLite DB.
 *
 * Direction: eqmon → gateway (one-way)
 *
 * Polls eqmon for sensor names and gateway name, compares against a local
 * snapshot, and for each change writes directly to the local SQLite DB:
 *   - devices.sensor_name  (and sensor_meta.name)
 *   - gateway_config WHERE key = 'gateway_name'
 *
 * No Node-RED admin API calls needed — we write to SQLite directly.
 *
 * Output fires only when at least one name changed.
 * msg.payload = { applied: [{device_id, old_name, new_name}], gateway_renamed: bool }
 */
'use strict';

const https = require('https');
const http  = require('http');
const url   = require('url');

let sqlite3;
try { sqlite3 = require('sqlite3').verbose(); } catch (e) { sqlite3 = null; }

const DB_PATH = '/overlay/telemetry.db';

module.exports = function (RED) {
    function EqmonNameSyncNode(config) {
        RED.nodes.createNode(this, config);

        this.server   = RED.nodes.getNode(config.server);
        this.interval = parseInt(config.interval, 10) || 300;

        const node = this;
        let timer = null;

        function doSync() {
            if (!node.server) {
                node.warn('No eqmon config node selected');
                return;
            }

            // apiRoot = base URL with /sync stripped
            const apiRoot   = node.server.baseUrl.replace(/\/sync\/?$/, '');
            const gatewayId = node.server.gatewayId;
            const apiKey    = node.server.credentials && node.server.credentials.apiKey;

            if (!gatewayId || !apiKey) {
                node.warn('eqmon-config missing gateway_id or API key');
                return;
            }

            // Fetch sensors from eqmon
            fetchJson(apiRoot + '/api/sensors.php?gateway_id=' + encodeURIComponent(gatewayId), apiKey, function (err, sensors) {
                if (err) { node.warn('eqmon-name-sync: sensors fetch failed: ' + err); return; }

                // Fetch gateway info
                fetchJson(apiRoot + '/api/admin/gateways.php?gateway_id=' + encodeURIComponent(gatewayId), apiKey, function (err2, gwData) {
                    if (err2) { node.warn('eqmon-name-sync: gateway fetch failed: ' + err2); }

                    const prevSnapshot  = node.context().flow.get('eqmon_name_snapshot')  || {};
                    const prevGwName    = node.context().flow.get('eqmon_gw_name_snapshot') || null;

                    const applied = [];
                    const tasks   = [];

                    // ── Sensor names ──────────────────────────────────────────
                    const sensorList = Array.isArray(sensors) ? sensors
                        : (sensors && Array.isArray(sensors.sensors)) ? sensors.sensors : [];

                    sensorList.forEach(function (s) {
                        const deviceId = s.device_id;
                        const newName  = s.sensor_name || s.name;
                        if (!deviceId || !newName) return;

                        const oldName = prevSnapshot[deviceId];
                        if (oldName === newName) return; // no change

                        tasks.push(function (done) {
                            writeSensorName(deviceId, newName, function (err) {
                                if (err) { node.warn('eqmon-name-sync: DB write failed for ' + deviceId + ': ' + err); }
                                else {
                                    applied.push({ device_id: deviceId, old_name: oldName || null, new_name: newName });
                                }
                                done();
                            });
                        });
                    });

                    // ── Gateway name ──────────────────────────────────────────
                    const newGwName = gwData && (gwData.gateway_name || (Array.isArray(gwData) && gwData[0] && gwData[0].gateway_name));
                    let gatewayRenamed = false;

                    if (newGwName && newGwName !== prevGwName) {
                        tasks.push(function (done) {
                            writeGatewayName(newGwName, function (err) {
                                if (err) { node.warn('eqmon-name-sync: gateway name DB write failed: ' + err); }
                                else { gatewayRenamed = true; }
                                done();
                            });
                        });
                    }

                    // Run all tasks, then update snapshots and emit
                    runSerial(tasks, function () {
                        if (applied.length === 0 && !gatewayRenamed) {
                            node.status({ fill: 'grey', shape: 'ring', text: 'no changes @ ' + new Date().toLocaleTimeString() });
                            return;
                        }

                        // Persist updated snapshot
                        const newSnapshot = Object.assign({}, prevSnapshot);
                        applied.forEach(function (a) { newSnapshot[a.device_id] = a.new_name; });
                        node.context().flow.set('eqmon_name_snapshot', newSnapshot);
                        if (gatewayRenamed) {
                            node.context().flow.set('eqmon_gw_name_snapshot', newGwName);
                        }

                        node.status({ fill: 'green', shape: 'dot', text: applied.length + ' name(s) updated' });
                        node.send({ payload: { applied: applied, gateway_renamed: gatewayRenamed } });
                    });
                });
            });
        }

        // Input: manual trigger
        node.on('input', function () { doSync(); });

        // Kick off on deploy, then on interval
        doSync();
        timer = setInterval(doSync, node.interval * 1000);

        node.on('close', function () {
            if (timer) clearInterval(timer);
        });
    }

    RED.nodes.registerType('eqmon-name-sync', EqmonNameSyncNode);
};

// ---------------------------------------------------------------
//  SQLite helpers
// ---------------------------------------------------------------

function writeSensorName(deviceId, name, cb) {
    if (!sqlite3) { cb('sqlite3 not available'); return; }
    const db = new sqlite3.Database(DB_PATH, function (err) {
        if (err) { cb(err.message); return; }
        db.run(
            'UPDATE devices SET sensor_name = ? WHERE device_id = ?',
            [name, deviceId],
            function (err) {
                if (err) { db.close(); cb(err.message); return; }
                // Also upsert sensor_meta.name
                db.run(
                    'INSERT INTO sensor_meta (device_id, name) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET name = excluded.name',
                    [deviceId, name],
                    function (err2) {
                        db.close();
                        cb(err2 ? err2.message : null);
                    }
                );
            }
        );
    });
}

function writeGatewayName(name, cb) {
    if (!sqlite3) { cb('sqlite3 not available'); return; }
    const db = new sqlite3.Database(DB_PATH, function (err) {
        if (err) { cb(err.message); return; }
        db.run(
            "INSERT OR REPLACE INTO gateway_config (key, value) VALUES ('gateway_name', ?)",
            [name],
            function (err) {
                db.close();
                cb(err ? err.message : null);
            }
        );
    });
}

// ---------------------------------------------------------------
//  HTTP helpers
// ---------------------------------------------------------------

function fetchJson(rawUrl, apiKey, cb) {
    const parsed   = url.parse(rawUrl);
    const lib      = parsed.protocol === 'https:' ? https : http;
    const options  = {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.path,
        method:   'GET',
        headers:  { 'Accept': 'application/json', 'X-Gateway-Key': apiKey },
        rejectUnauthorized: false
    };

    const req = lib.request(options, function (res) {
        let data = '';
        res.on('data', function (c) { data += c; });
        res.on('end', function () {
            try { cb(null, JSON.parse(data)); }
            catch (e) { cb('JSON parse error: ' + e.message); }
        });
    });
    req.on('error', function (e) { cb(e.message); });
    req.end();
}

function runSerial(tasks, done) {
    if (tasks.length === 0) { done(); return; }
    tasks[0](function () { runSerial(tasks.slice(1), done); });
}
