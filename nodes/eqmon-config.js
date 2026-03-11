/**
 * eqmon-config — Configuration node
 *
 * Holds shared settings used by all eqmon nodes:
 *   - eqmon base URL (e.g. https://telemetry.ecoeyetech.com/sync)
 *   - gateway_id  (auto-detected from gateway_mac in local SQLite DB if left blank)
 *   - API key (stored in Node-RED credential store, never exported)
 *
 * All other eqmon nodes reference this config node by ID.
 */
'use strict';

let sqlite3;
try { sqlite3 = require('sqlite3').verbose(); } catch (e) { sqlite3 = null; }

const DB_PATH = '/overlay/telemetry.db';

module.exports = function (RED) {
    function EqmonConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.baseUrl   = config.baseUrl || 'https://telemetry.ecoeyetech.com/sync';
        this.gatewayId = config.gatewayId || '';
        // this.credentials.apiKey is injected by Node-RED from credential store

        this.gatewayMac = ''; // populated from SQLite
        const node = this;

        // Auto-detect gateway_id and gateway_mac from SQLite
        if (sqlite3) {
            const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, function (err) {
                if (err) return;
                db.get("SELECT value FROM gateway_config WHERE key = 'gateway_mac' LIMIT 1", function (err, row) {
                    db.close();
                    if (!err && row && row.value) {
                        node.gatewayMac = row.value;
                        if (!node.gatewayId) {
                            node.gatewayId = 'gw_' + row.value.replace(/:/g, '').toLowerCase();
                        }
                    }
                });
            });
        }
    }

    RED.nodes.registerType('eqmon-config', EqmonConfigNode, {
        credentials: {
            apiKey: { type: 'password' }
        }
    });
};
