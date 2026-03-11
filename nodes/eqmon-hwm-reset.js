/**
 * eqmon-hwm-reset — High-water mark management node
 *
 * Resets individual (or all) high-water marks stored in flow context
 * under 'eqmon_hwm'. Useful for forcing a full re-sync of a device,
 * or clearing stale state after a gateway reset.
 *
 * Input:
 *   msg.device_id  — device ID to reset, or '*' to reset all
 *   msg.sync_type  — optional sync type filter ('readings'|'vibration'|'devices'|'sensor-meta')
 *                    omit to reset all sync types for the device
 *
 * Output 1:
 *   msg.payload    — { reset: true, cleared: [keys], remaining: {key: ts, ...} }
 *
 * Can also be configured with static device_id + sync_type in the node editor
 * for use with an Inject node trigger.
 */
'use strict';

module.exports = function (RED) {
    function EqmonHwmResetNode(config) {
        RED.nodes.createNode(this, config);

        this.deviceId = config.deviceId || '';   // static device_id ('' = use msg)
        this.syncType = config.syncType || '';   // static sync_type ('' = all)

        const node = this;

        node.on('input', function (msg, send, done) {
            const deviceId = msg.device_id || node.deviceId || '*';
            const syncType = msg.sync_type  || node.syncType || '';

            const hwm     = node.context().flow.get('eqmon_hwm') || {};
            const cleared = [];

            if (deviceId === '*') {
                // Reset all entries (optionally filtered by sync type)
                for (const key of Object.keys(hwm)) {
                    if (!syncType || key.startsWith(syncType + ':')) {
                        cleared.push(key);
                        delete hwm[key];
                    }
                }
            } else {
                // Reset specific device (optionally filtered by sync type)
                for (const key of Object.keys(hwm)) {
                    const [kType, kDevice] = key.split(':');
                    if (kDevice === deviceId) {
                        if (!syncType || kType === syncType) {
                            cleared.push(key);
                            delete hwm[key];
                        }
                    }
                }
            }

            node.context().flow.set('eqmon_hwm', hwm);

            const summary = `cleared ${cleared.length} HWM(s)`;
            node.status({ fill: cleared.length > 0 ? 'yellow' : 'grey', shape: 'ring', text: summary });

            msg.payload = {
                reset:     true,
                cleared:   cleared,
                remaining: { ...hwm }
            };

            send(msg);
            done();
        });
    }

    RED.nodes.registerType('eqmon-hwm-reset', EqmonHwmResetNode);
};
