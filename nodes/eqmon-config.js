/**
 * eqmon-config — Configuration node
 *
 * Holds shared settings used by all eqmon nodes:
 *   - eqmon base URL (e.g. https://telemetry.ecoeyetech.com)
 *   - gateway_id
 *   - API key (stored in Node-RED credential store, never exported)
 *
 * All other eqmon nodes reference this config node by ID.
 */
module.exports = function (RED) {
    function EqmonConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.baseUrl = config.baseUrl || 'https://telemetry.ecoeyetech.com/sync';
        this.gatewayId = config.gatewayId || '';
        // this.credentials.apiKey is injected by Node-RED from credential store
    }

    RED.nodes.registerType('eqmon-config', EqmonConfigNode, {
        credentials: {
            apiKey: { type: 'password' }
        }
    });
};
