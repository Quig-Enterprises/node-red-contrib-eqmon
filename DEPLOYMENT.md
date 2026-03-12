# Deployment Guide — node-red-contrib-eqmon

## Overview

This package provides five custom Node-RED nodes for syncing EcoEye gateway data to the telemetry server:

| Node | Purpose |
|------|---------|
| `eqmon-config` | Shared config: base URL, gateway ID, API key (credential) |
| `eqmon-sync` | Syncs a batch of data (readings / vibration / devices / sensor-meta) |
| `eqmon-heartbeat` | Sends periodic heartbeat to telemetry server |
| `eqmon-hwm-reset` | Resets the high-water mark for a device/sync type |
| `eqmon-name-sync` | Pulls device name updates from telemetry server |

---

## Prerequisites

- Node-RED ≥ 3.0 running under PM2 (`pm2 list`)
- Node.js ≥ 16 (≥ 18 preferred; 16 works with engine warning)
- Gateway SQLite DB at `/overlay/telemetry.db`
- API key for this gateway (from `telemetry.ecoeyetech.com`)
- Gateway ID: `gw_<mac_without_colons>` (e.g. `gw_34fa402aa735`)
  - If unknown: `sqlite3 /overlay/telemetry.db "SELECT value FROM gateway_config WHERE key='gateway_id'"`
  - Or derive from MAC: `cat /sys/class/net/eth0/address | tr -d ':'` → prepend `gw_`

---

## Step 1 — Install the package

```bash
cd ~/.node-red
npm install Quig-Enterprises/node-red-contrib-eqmon
```

Expected output includes `added 1 package`. An engine warning about Node 16 is non-fatal.

---

## Step 2 — Set a credentialSecret (if not already set)

Node-RED encrypts credentials using a secret. Setting an explicit one makes it portable.

Edit `~/.node-red/settings.js` and add after `flowFilePretty: true,`:

```js
credentialSecret: "eqmon-clc-2026",
```

If the existing `flows_cred.json` was encrypted with the old auto-generated secret, you must delete it before restarting (the old credentials will be lost — re-enter them via UI):

```bash
rm ~/.node-red/flows_cred.json
```

---

## Step 3 — Import the example flow

```bash
cat ~/.node-red/node_modules/node-red-contrib-eqmon/examples/ecoeye-sync-flow.json
```

In Node-RED UI:
- **Menu (☰) → Import**
- Paste the JSON content
- Select **"new flow"** tab option
- Click **Import**

The imported tab is called **"EcoEye Sync"** and contains:
- Vibration sync (every 30s)
- Readings sync (every 30s, fires once on start)
- Devices + sensor-meta sync (every 1h, fires once on start)
- Heartbeat (every 60s, auto-starts)
- HWM reset (manual inject trigger)
- Name sync (manual inject trigger)

---

## Step 4 — Configure the eqmon-config node

**This step must be done via the Node-RED UI — do not manually edit `flows_cred.json`.**

1. Double-click any **eqmon-sync** or **eqmon-heartbeat** node
2. Click the **pencil icon** (✏️) next to the server/config field
3. Fill in:
   - **Base URL**: `https://telemetry.ecoeyetech.com/sync`
   - **Gateway ID**: your gateway's ID (e.g. `gw_34fa402aa735`)
   - **API Key**: your gateway's API key (stored as a Node-RED credential — never visible after saving)
4. Click **Update** → **Done**
5. Click **Deploy** (top right)

The API key is now encrypted in `flows_cred.json` using `credentialSecret` and persists across restarts.

---

## Step 5 — Restart Node-RED

```bash
pm2 restart node-red
```

---

## Step 6 — Verify

Check PM2 logs:

```bash
pm2 logs node-red --lines 30 --nostream
```

**Expected (success):**
```
[info] Starting flows
[warn] [eqmon-heartbeat:eq_hb] Sync: heartbeat sent
```

**If you see `eqmon-config is missing API key`:** the credential wasn't saved — repeat Step 4.

**If you see `Failed to decrypt credentials`:** the credentialSecret changed. Delete `flows_cred.json` and repeat from Step 2.

---

## Cleanup — Duplicate Subflows

Artemis gateways may have duplicate "EcoEye Auth Preparer" subflows from earlier failed imports. Remove them:

1. In Node-RED UI: **Menu → Manage palette** or find subflows in the palette sidebar
2. Delete any subflows named `EcoEye Auth Preparer (2)`, `EcoEye Auth Preparer (3)`, etc.
3. Keep only the original `EcoEye Auth Preparer`

Or via script (run on gateway while Node-RED is stopped):

```python
python3 /path/to/eqmon/scripts/patch_nodered_backfill.py  # for backfill
# For duplicate removal, use the Node-RED UI
```

---

## Old "EcoEye Sync" Tab

Gateways provisioned before this package was available have a hardcoded "EcoEye Sync" flow tab with credentials embedded in function nodes. Once the new `eqmon-config`-based tab is verified working:

1. **Disable** the old tab (right-click tab → Disable) rather than deleting immediately
2. Confirm new tab syncs correctly for 24h
3. Then delete the old tab

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `eqmon-config is missing API key` | Credential not saved via UI | Repeat Step 4 |
| `eqmon-config is missing gateway_id` | Gateway ID blank | Set in eqmon-config node |
| `Failed to decrypt credentials` | credentialSecret mismatch | Delete flows_cred.json, restart, re-enter credentials |
| `SQLITE_ERROR: no such column: d.type` | Old package version | `npm install Quig-Enterprises/node-red-contrib-eqmon` to update |
| HTTP 401 on sync calls | Wrong API key | Verify API key matches this gateway in telemetry DB |
| HTTP 401 with correct key | Wrong gateway_id | Check `gw_` prefix and MAC matches this gateway |

---

## Updating the Package

```bash
cd ~/.node-red
npm install Quig-Enterprises/node-red-contrib-eqmon
pm2 restart node-red
```

No flow changes needed for patch/minor updates.
