/**
 * eqmon-sync — Outbound sensor data sync node
 *
 * Accepts incoming messages containing sensor readings, filters to only
 * records newer than the stored high-water mark (HWM) for each device,
 * then emits a formatted POST payload on output 1 for wiring to an
 * http-request node (where TLS, retries, etc. are configured separately).
 *
 * High-water marks are stored in flow context under 'eqmon_hwm'.
 *
 * Inputs:
 *   msg.payload  — array of reading objects, or a single reading object
 *   msg.topic    — optional sync type override ('readings'|'vibration'|'devices'|'sensor-meta')
 *
 * Output 1 — POST payload:
 *   msg.url      — full endpoint URL
 *   msg.headers  — { 'Content-Type', 'X-Gateway-Key', 'Content-Encoding'? }
 *   msg.payload  — JSON body ready to POST
 *   msg.method   — 'POST'
 *
 * No reading is emitted if all records are below the HWM (already synced).
 */
'use strict';

const { PACKAGE_VERSION } = require('../lib/version');

module.exports = function (RED) {
    function EqmonSyncNode(config) {
        RED.nodes.createNode(this, config);

        this.server = RED.nodes.getNode(config.server);
        this.syncType = config.syncType || 'readings'; // readings|vibration|devices|sensor-meta
        this.useHwm = config.useHwm !== false; // default true

        const node = this;

        node.on('input', function (msg, send, done) {
            if (!node.server) {
                node.error('No eqmon config node selected');
                done();
                return;
            }

            const baseUrl   = node.server.baseUrl;
            const gatewayId = node.server.gatewayId;
            const apiKey    = node.server.credentials && node.server.credentials.apiKey;

            if (!gatewayId || !apiKey) {
                node.error('eqmon-config is missing gateway_id or API key');
                done();
                return;
            }

            const syncType = msg.topic || node.syncType;
            const suffix = syncTypeToEndpoint(syncType);
            const url    = baseUrl.replace(/\/$/, '') + suffix;

            // Normalise input to array
            let records = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
            records = records.filter(r => r && typeof r === 'object');

            if (records.length === 0) {
                node.debug('No records to sync');
                done();
                return;
            }

            // Apply high-water mark filtering
            if (node.useHwm) {
                const hwm = node.context().flow.get('eqmon_hwm') || {};
                records = records.filter(r => {
                    const key = hwmKey(syncType, r.device_id || r.gateway_id);
                    const lastTs = hwm[key] || 0;
                    return (r.ts || 0) > lastTs;
                });

                if (records.length === 0) {
                    node.status({ fill: 'grey', shape: 'ring', text: 'all below HWM' });
                    done();
                    return;
                }
            }

            // Build body
            const body = buildBody(syncType, gatewayId, records);

            // Update HWM after building body (so we don't skip on failure — caller handles)
            // HWM is updated only after a successful POST via msg.eqmon_hwm_update
            // (the calling flow should send a feedback msg back to update HWM on 2xx)
            msg.eqmon_hwm_pending = buildHwmUpdate(syncType, records);

            // Emit POST payload
            msg.method  = 'POST';
            msg.url     = url;
            msg.headers = {
                'Content-Type':  'application/json',
                'X-Gateway-Key': apiKey
            };
            msg.payload = JSON.stringify(body);

            node.status({ fill: 'blue', shape: 'dot', text: `${records.length} record(s) → ${url}` });

            send(msg);
            done();
        });

        // Allow external flows to commit HWM updates after confirming a 2xx response
        node.on('commit_hwm', function (updates) {
            if (!updates || typeof updates !== 'object') return;
            const hwm = node.context().flow.get('eqmon_hwm') || {};
            for (const [key, ts] of Object.entries(updates)) {
                if ((hwm[key] || 0) < ts) {
                    hwm[key] = ts;
                }
            }
            node.context().flow.set('eqmon_hwm', hwm);
        });
    }

    RED.nodes.registerType('eqmon-sync', EqmonSyncNode);
};

// ---------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------

function syncTypeToEndpoint(syncType) {
    // baseUrl is already the /sync root; sub-paths hang directly off it
    const map = {
        'readings':    '',            // POST {base}
        'vibration':   '/vibration',  // POST {base}/vibration
        'devices':     '/devices',    // POST {base}/devices
        'sensor-meta': '/sensor-meta' // POST {base}/sensor-meta
    };
    return map[syncType] !== undefined ? map[syncType] : '';
}

function hwmKey(syncType, deviceId) {
    return `${syncType}:${deviceId || '_'}`;
}

function buildHwmUpdate(syncType, records) {
    const updates = {};
    for (const r of records) {
        if (!r.ts) continue;
        const key = hwmKey(syncType, r.device_id || r.gateway_id);
        if ((updates[key] || 0) < r.ts) {
            updates[key] = r.ts;
        }
    }
    return updates;
}

function buildBody(syncType, gatewayId, records) {
    switch (syncType) {
        case 'vibration':
            return { gateway_id: gatewayId, readings: records };
        case 'devices':
            return { gateway_id: gatewayId, devices: records };
        case 'sensor-meta':
            return { gateway_id: gatewayId, sensors: records };
        case 'readings':
        default:
            return { gateway_id: gatewayId, readings: records };
    }
}
