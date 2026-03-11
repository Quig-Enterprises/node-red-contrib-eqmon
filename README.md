# node-red-contrib-eqmon

Node-RED nodes for EcoEye equipment monitoring (eqmon) gateway sync.

## Nodes

### eqmon-config
Shared configuration node. Holds the eqmon base URL, gateway ID, and API key (stored securely in Node-RED's credential store).

### eqmon-sync
Formats sensor readings for the eqmon sync API and emits a POST-ready payload.

**Output wires to a standard `http request` node** — this separation lets you configure TLS certificates, retries, and proxy settings on the HTTP node independently.

Supported sync types:
- `readings` → `POST /sync`
- `vibration` → `POST /sync/vibration`
- `devices` → `POST /sync/devices`
- `sensor-meta` → `POST /sync/sensor-meta`

High-water mark (HWM) filtering ensures only records newer than the last successfully synced timestamp are included, preventing duplicate submissions.

### eqmon-heartbeat
Sends a gateway heartbeat to `/sync/gateway-config` at a configurable interval. Includes:
- `node_package_version` — this npm package version (lets eqmon flag outdated nodes)
- `nodered_version` — Node-RED runtime version
- `firmware` — flow version tag (set in node config)
- `hostname`, `ip_address`, `uptime_seconds`

Output wires to a standard `http request` node for TLS/auth configuration.

### eqmon-hwm-reset
Resets individual or all high-water marks stored in flow context. Use with an Inject node for manual resets, or an HTTP-in node for automated resets (e.g. after a firmware update).

## Installation

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-eqmon
```

Or from npm (once published):
```bash
npm install node-red-contrib-eqmon
```

## Flow Pattern

```
[eqmon-heartbeat] → [http request (POST /sync/gateway-config, TLS configured here)]

[your data source] → [eqmon-sync (readings)] → [http request (POST /sync)]
                                              ↓ on 2xx
                                        [commit HWM function node]

[inject: reset] → [eqmon-hwm-reset (device_id=*)]
```

## High-Water Marks

HWMs are stored in flow context under `eqmon_hwm` as a map of `{syncType}:{deviceId}` → timestamp (ms).

To commit HWMs after a successful POST, use a function node:
```javascript
// After 2xx response from http request node
const pending = msg.eqmon_hwm_pending;
if (pending) {
    const hwm = flow.get('eqmon_hwm') || {};
    for (const [key, ts] of Object.entries(pending)) {
        if ((hwm[key] || 0) < ts) hwm[key] = ts;
    }
    flow.set('eqmon_hwm', hwm);
}
return msg;
```
