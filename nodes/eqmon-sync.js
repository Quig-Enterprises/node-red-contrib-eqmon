/**
 * eqmon-sync — Outbound sensor data sync node
 *
 * Reads records from the local SQLite DB and POSTs them to the eqmon sync
 * endpoint. Maintains a per-device high-water mark (HWM) so only new records
 * are sent on each trigger.
 *
 * Input (msg.payload) — all fields optional:
 *   {}                          — sync all records newer than HWM (default)
 *   { since: <ms epoch> }       — override HWM, re-send records since this time
 *   { until: <ms epoch> }       — only send records up to this time
 *   { device_id: "..." }        — restrict to one device
 *   { device_ids: ["..."] }     — restrict to a list of devices
 *   { sensor_type: 111 }        — restrict to a sensor type
 *   { probe: 1 }                — restrict to a vibration probe (vibration sync only)
 *   { force: true }             — ignore HWM, send all matching records
 *
 * msg.topic — optional sync type override: 'readings'|'vibration'|'devices'|'sensor-meta'
 *
 * Output 1 — POST payload (wire to http request node):
 *   msg.url      — full endpoint URL
 *   msg.headers  — { 'Content-Type', 'X-Gateway-Key' }
 *   msg.payload  — JSON body ready to POST
 *   msg.method   — 'POST'
 *   msg.eqmon_hwm_pending — HWM updates to commit after 2xx response
 *
 * Output 2 — fires when all records are below HWM (nothing to send)
 */
'use strict';

let sqlite3;
try { sqlite3 = require('sqlite3').verbose(); } catch (e) { sqlite3 = null; }

const DB_PATH = '/overlay/telemetry.db';

module.exports = function (RED) {
    function EqmonSyncNode(config) {
        RED.nodes.createNode(this, config);

        this.server   = RED.nodes.getNode(config.server);
        this.syncType = config.syncType || 'readings';
        this.useHwm   = config.useHwm !== false;

        const node = this;

        node.on('input', function (msg, send, done) {
            if (!node.server) {
                node.error('No eqmon config node selected');
                done();
                return;
            }

            const baseUrl    = node.server.baseUrl;
            const gatewayId  = node.server.gatewayId;
            const gatewayMac = node.server.gatewayMac || undefined;
            const apiKey     = node.server.credentials && node.server.credentials.apiKey;

            if (!apiKey) {
                node.error('eqmon-config is missing API key');
                done();
                return;
            }
            if (!gatewayId) {
                node.error('eqmon-config is missing gateway_id (check gateway_mac in SQLite)');
                done();
                return;
            }

            const syncType = msg.topic || node.syncType;
            const criteria = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};

            // Determine HWM cutoff
            const hwm = node.context().flow.get('eqmon_hwm') || {};
            const force = criteria.force === true;

            queryRecords(syncType, criteria, hwm, force, function (err, records) {
                if (err) {
                    node.error('SQLite query failed: ' + err);
                    done();
                    return;
                }

                if (records.length === 0) {
                    node.status({ fill: 'grey', shape: 'ring', text: 'nothing new' });
                    send([null, msg]);
                    done();
                    return;
                }

                const suffix = syncTypeToEndpoint(syncType);
                const url    = baseUrl.replace(/\/$/, '') + suffix;
                const body   = buildBody(syncType, gatewayId, gatewayMac, records);

                msg.eqmon_hwm_pending = buildHwmUpdate(syncType, records);
                msg.url     = url;
                msg.headers = { 'Content-Type': 'application/json', 'X-Gateway-Key': apiKey };
                msg.payload = JSON.stringify(body);

                node.status({ fill: 'blue', shape: 'dot', text: records.length + ' record(s)' });
                send([msg, null]);
                done();
            });
        });
    }

    RED.nodes.registerType('eqmon-sync', EqmonSyncNode);
};

// ---------------------------------------------------------------
//  SQLite queries
// ---------------------------------------------------------------

function queryRecords(syncType, criteria, hwm, force, cb) {
    if (!sqlite3) {
        cb('sqlite3 module not available');
        return;
    }

    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, function (err) {
        if (err) { cb(err.message); return; }

        let sql, params;

        switch (syncType) {
            case 'vibration':
                [sql, params] = buildVibrationQuery(criteria, hwm, force);
                break;
            case 'devices':
                [sql, params] = buildDevicesQuery(criteria, hwm, force);
                break;
            case 'sensor-meta':
                [sql, params] = buildSensorMetaQuery(criteria);
                break;
            case 'readings':
            default:
                [sql, params] = buildReadingsQuery(criteria, hwm, force);
                break;
        }

        db.all(sql, params, function (err, rows) {
            db.close();
            if (err) { cb(err.message); return; }
            cb(null, normaliseRows(rows || [], syncType));
        });
    });
}

function buildReadingsQuery(criteria, hwm, force) {
    const conditions = [];
    const params = [];

    // HWM per device or global minimum
    if (!force) {
        const globalHwm = criteria.since || getGlobalHwm(hwm, 'readings') || 0;
        conditions.push('r.ts > ?');
        params.push(globalHwm);
    } else if (criteria.since) {
        conditions.push('r.ts >= ?');
        params.push(criteria.since);
    }

    if (criteria.until) { conditions.push('r.ts <= ?'); params.push(criteria.until); }

    if (criteria.device_id) {
        conditions.push('r.device_id = ?');
        params.push(criteria.device_id);
    } else if (criteria.device_ids && criteria.device_ids.length) {
        conditions.push('r.device_id IN (' + criteria.device_ids.map(() => '?').join(',') + ')');
        params.push(...criteria.device_ids);
    }

    if (criteria.sensor_type != null) {
        conditions.push('r.sensor_type = ?');
        params.push(criteria.sensor_type);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    // Pivot wide: group by ts+device to build one row per reading.
    // The /sync/readings endpoint accepts type=1 (env), type=2 (env), type=28 (current).
    // Only include devices whose type is known to the server (1, 2, 28).
    // Vibration sensors (type 82, 111) go through /sync/vibration, not here.
    // Note: 'devices' table schema varies by gateway firmware — 'type' column may not exist.
    // Use r.sensor_type from the readings table directly; map vibration types (82, 111) to 1
    // so they don't get sent via /sync/readings (they belong in /sync/vibration).
    const sql = `
        SELECT r.ts, r.device_id,
               CASE WHEN r.sensor_type IN (1, 2, 28) THEN r.sensor_type ELSE 1 END AS sensor_type,
               MAX(CASE WHEN r.metric='firmware'     THEN r.value END) AS firmware,
               MAX(CASE WHEN r.metric='temperature'  THEN r.value END) AS temperature,
               MAX(CASE WHEN r.metric='humidity'     THEN r.value END) AS humidity,
               MAX(CASE WHEN r.metric='battery_v'    THEN r.value END) AS battery_v,
               MAX(CASE WHEN r.metric='battery_pct'  THEN r.value END) AS battery_pct
        FROM readings r
        ${where}
        GROUP BY r.ts, r.device_id
        ORDER BY r.ts ASC
        LIMIT 500
    `;
    return [sql, params];
}

function buildVibrationQuery(criteria, hwm, force) {
    const conditions = [];
    const params = [];

    if (!force) {
        const globalHwm = criteria.since || getGlobalHwm(hwm, 'vibration') || 0;
        conditions.push('ts > ?');
        params.push(globalHwm);
    } else if (criteria.since) {
        conditions.push('ts >= ?');
        params.push(criteria.since);
    }

    if (criteria.until) { conditions.push('ts <= ?'); params.push(criteria.until); }

    if (criteria.device_id) {
        conditions.push('device_id = ?');
        params.push(criteria.device_id);
    } else if (criteria.device_ids && criteria.device_ids.length) {
        conditions.push('device_id IN (' + criteria.device_ids.map(() => '?').join(',') + ')');
        params.push(...criteria.device_ids);
    }

    // raw_vibration_data doesn't have a probe column — sensor_type differentiates
    if (criteria.sensor_type != null) {
        conditions.push('sensor_type = ?');
        params.push(criteria.sensor_type);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `
        SELECT ts, device_id, sensor_type, temperature,
               odr, total_samples, fsr, rpm, fft_confidence, fault_results
        FROM raw_vibration_data
        ${where}
        ORDER BY ts ASC
        LIMIT 200
    `;
    return [sql, params];
}

function buildDevicesQuery(criteria, hwm, force) {
    // devices table — return all known devices (no HWM concept)
    const conditions = [];
    const params = [];

    if (criteria.device_id) {
        conditions.push('device_id = ?');
        params.push(criteria.device_id);
    } else if (criteria.device_ids && criteria.device_ids.length) {
        conditions.push('device_id IN (' + criteria.device_ids.map(() => '?').join(',') + ')');
        params.push(...criteria.device_ids);
    }

    if (criteria.sensor_type != null) {
        conditions.push('sensor_type = ?');
        params.push(criteria.sensor_type);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `SELECT device_id, sensor_type AS device_type, firmware FROM devices ${where} LIMIT 500`;
    return [sql, params];
}

function buildSensorMetaQuery(criteria) {
    const conditions = [];
    const params = [];

    if (criteria.device_id) {
        conditions.push('device_id = ?');
        params.push(criteria.device_id);
    } else if (criteria.device_ids && criteria.device_ids.length) {
        conditions.push('device_id IN (' + criteria.device_ids.map(() => '?').join(',') + ')');
        params.push(...criteria.device_ids);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `SELECT device_id, name, location, asset, install_date FROM sensor_meta ${where} LIMIT 500`;
    return [sql, params];
}

// ---------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------

function getGlobalHwm(hwm, syncType) {
    // Return the minimum HWM across all devices for this sync type
    // (so we don't miss any device)
    let min = null;
    for (const [key, ts] of Object.entries(hwm)) {
        if (key.startsWith(syncType + ':')) {
            if (min === null || ts < min) min = ts;
        }
    }
    return min || 0;
}

function normaliseRows(rows, syncType) {
    return rows.map(function (r) {
        const out = {};
        for (const k of Object.keys(r)) {
            if (r[k] === null || r[k] === undefined) continue;
            out[k] = r[k];
        }
        if ('sensor_type' in out) {
            // /sync/vibration endpoint requires type=111 regardless of local storage code
            out.type = (syncType === 'vibration') ? 111 : out.sensor_type;
            delete out.sensor_type;
        }
        return out;
    });
}

function syncTypeToEndpoint(syncType) {
    const map = {
        'readings':    '/readings',
        'vibration':   '/vibration',
        'devices':     '/devices',
        'sensor-meta': '/sensor-meta'
    };
    return map[syncType] || '/readings';
}

function hwmKey(syncType, deviceId) {
    return `${syncType}:${deviceId || '_'}`;
}

function buildHwmUpdate(syncType, records) {
    const updates = {};
    for (const r of records) {
        if (!r.ts) continue;
        const key = hwmKey(syncType, r.device_id);
        if ((updates[key] || 0) < r.ts) updates[key] = r.ts;
    }
    return updates;
}

function buildBody(syncType, gatewayId, gatewayMac, records) {
    const base = { gateway_id: gatewayId };
    if (gatewayMac) base.gateway_mac = gatewayMac;
    switch (syncType) {
        case 'vibration':   return Object.assign({}, base, { readings: records });
        case 'devices':     return Object.assign({}, base, { devices: records });
        case 'sensor-meta': return Object.assign({}, base, { sensors: records });
        case 'readings':
        default:            return Object.assign({}, base, { readings: records });
    }
}
