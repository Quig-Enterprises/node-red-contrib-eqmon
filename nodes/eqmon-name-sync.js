/**
 * eqmon-name-sync — Apply pending name changes delivered in heartbeat response
 *
 * Direction: eqmon → gateway (one-way)
 *
 * The /sync/gateway-config endpoint returns a `pending_updates` array in its
 * response body whenever sensor or gateway names have been changed server-side.
 * This node reads that response and writes the changes to the local SQLite DB.
 *
 * Wire it after the http request node that POSTs the heartbeat:
 *   [eqmon-heartbeat] → [http request] → [eqmon-name-sync]
 *
 * Input (msg.payload) — the parsed JSON response from POST /sync/gateway-config:
 *   {
 *     "status": "ok",
 *     "pending_updates": [
 *       { "id": 1, "entity_type": "sensor", "device_id": "...", "new_name": "Pump Motor" },
 *       { "id": 2, "entity_type": "gateway", "device_id": null, "new_name": "Pickerel GW" }
 *     ]
 *   }
 *
 * Output fires only when at least one name was applied.
 * msg.payload = { applied: [{device_id, new_name, entity_type}], count: N }
 */
'use strict';

let sqlite3;
try { sqlite3 = require('sqlite3').verbose(); } catch (e) { sqlite3 = null; }

const DB_PATH = '/overlay/telemetry.db';

module.exports = function (RED) {
    function EqmonNameSyncNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;

        node.on('input', function (msg, send, done) {
            // Accept either the raw http-request response (msg.payload is object)
            // or a pre-parsed object passed directly.
            let body = msg.payload;
            if (typeof body === 'string') {
                try { body = JSON.parse(body); } catch (e) {
                    // Not JSON — nothing to do
                    send([null, msg]);
                    done();
                    return;
                }
            }

            const pendingUpdates = Array.isArray(body && body.pending_updates)
                ? body.pending_updates : [];

            if (pendingUpdates.length === 0) {
                node.status({ fill: 'grey', shape: 'ring', text: 'no name updates' });
                send([null, msg]);
                done();
                return;
            }

            const tasks = [];
            const applied = [];

            for (const update of pendingUpdates) {
                const entityType = update.entity_type;
                const newName    = update.new_name;

                if (!newName) continue;

                if (entityType === 'sensor' && update.device_id) {
                    const deviceId = update.device_id;
                    tasks.push(function (cb) {
                        writeSensorName(deviceId, newName, function (err) {
                            if (err) {
                                node.warn('eqmon-name-sync: DB write failed for ' + deviceId + ': ' + err);
                            } else {
                                applied.push({ device_id: deviceId, new_name: newName, entity_type: 'sensor' });
                            }
                            cb();
                        });
                    });
                } else if (entityType === 'gateway') {
                    tasks.push(function (cb) {
                        writeGatewayName(newName, function (err) {
                            if (err) {
                                node.warn('eqmon-name-sync: gateway name write failed: ' + err);
                            } else {
                                applied.push({ device_id: null, new_name: newName, entity_type: 'gateway' });
                            }
                            cb();
                        });
                    });
                }
            }

            runSerial(tasks, function () {
                if (applied.length === 0) {
                    node.status({ fill: 'grey', shape: 'ring', text: 'no changes written' });
                    send([null, msg]);
                    done();
                    return;
                }

                node.status({ fill: 'green', shape: 'dot', text: applied.length + ' name(s) updated' });
                msg.payload = { applied: applied, count: applied.length };
                send([msg, null]);
                done();
            });
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

function runSerial(tasks, done) {
    if (tasks.length === 0) { done(); return; }
    tasks[0](function () { runSerial(tasks.slice(1), done); });
}
