# Azure VM Setup for QuestWorks Hub

This guide covers provisioning an Azure VM to run the QuestWorks dashboard/bus hub.
The hub is lightweight — it's a Node.js Express server that writes flat files.

---

## Recommended VM Size

| Size | vCPUs | RAM | Use case |
|------|-------|-----|---------|
| **Standard_B2s** | 2 | 4 GB | ✅ Recommended for hub-only (no GPU needed) |
| Standard_B1s | 1 | 1 GB | Minimal; fine if load is low (<5 agents) |
| Standard_B4ms | 4 | 16 GB | If you also run OpenClaw on the same VM |

The dashboard server + bus typically uses < 100MB RAM and < 5% CPU.

---

## Provision the VM

### Azure CLI

```bash
# Create resource group
az group create --name questworks-rg --location eastus

# Create VM
az vm create \
  --resource-group questworks-rg \
  --name questworks-hub \
  --image Ubuntu2204 \
  --size Standard_B2s \
  --admin-username azureuser \
  --ssh-key-values ~/.ssh/id_rsa.pub \
  --public-ip-sku Standard \
  --output json

# Open port 8788 (dashboard/bus)
az vm open-port --port 8788 --resource-group questworks-rg --name questworks-hub

# Optional: open port 18789 if running OpenClaw+plugin on same VM
az vm open-port --port 18789 --resource-group questworks-rg --name questworks-hub --priority 900
```

### Azure Portal (manual)

1. Create a VM → Ubuntu 22.04 LTS → Standard_B2s
2. Under **Networking**, add an inbound rule: TCP port 8788, source Any
3. Generate or upload your SSH key

---

## Initial Server Setup (Ubuntu 22.04 LTS)

SSH into the VM and run:

```bash
# Update packages
sudo apt-get update && sudo apt-get upgrade -y

# Install build tools
sudo apt-get install -y curl git build-essential
```

---

## Install Node.js 22

```bash
# Install Node.js 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version   # must show v22.x.x
npm --version
```

---

## Install QuestWorks

```bash
# Create workspace
mkdir -p ~/.openclaw/workspace
cd ~/.openclaw/workspace

# Upload and unpack the bundle (from your local machine):
#   scp questworks.tar.gz azureuser@<vm-ip>:~/
# Then on the VM:
tar xzf ~/questworks.tar.gz -C ~/.openclaw/workspace/

# Run the install script
cd ~/.openclaw/workspace/questworks
chmod +x install.sh
./install.sh
```

---

## systemd Service

Create the service file:

```bash
sudo nano /etc/systemd/system/questworks-dashboard.service
```

Paste the following (adjust paths as needed):

```ini
[Unit]
Description=QuestWorks Dashboard + QuestBus Hub
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=azureuser
WorkingDirectory=/home/azureuser/.openclaw/workspace/questworks/dashboard
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=questworks

# Environment — override tokens and peer URLs here
Environment=NODE_ENV=production
Environment=PORT=8788
Environment=AUTH_TOKEN=wq-dash-token-2026
Environment=SQUIRRELBUS_TOKEN=clawmeh
# Environment=BULLWINKLE_TOKEN=clawmeh
# Environment=NATASHA_TOKEN=clawmeh
# Environment=SHAWN_TOKEN=clawmeh

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable questworks-dashboard
sudo systemctl start questworks-dashboard

# Check status
sudo systemctl status questworks-dashboard

# Watch logs
sudo journalctl -u questworks-dashboard -f
```

Verify from your local machine:
```bash
curl http://<vm-public-ip>:8788/api/status
```

---

## Firewall Rules Summary

| Port | Protocol | Purpose | Required |
|------|----------|---------|---------|
| 22 | TCP | SSH | Yes |
| 8788 | TCP | Dashboard + QuestBus hub | Yes |
| 18789 | TCP | OpenClaw gateway (if on same VM) | Optional |
| 9000 | TCP | MinIO (if on same VM) | Optional |

Azure NSG rule for port 8788:
- Priority: 1000
- Name: Allow-QuestWorks
- Source: Any (or restrict to agent IP ranges for security)
- Destination: Any
- Port: 8788
- Protocol: TCP
- Action: Allow

---

## Optional: Tailscale (Private Agent Mesh)

For a more secure setup where agents communicate over a private Tailscale network:

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --authkey=<your-auth-key>

# Check your Tailscale IP
tailscale ip -4
```

With Tailscale:
- Use Tailscale IPs in `BUS_PEERS` instead of public IPs
- You can remove port 8788 from public Azure NSG (only Tailscale peers can reach it)
- Latency is typically lower and the connection is always encrypted

---

## Optional: MinIO Object Storage

If you want heartbeats and health data stored in object storage:

```bash
# Install MinIO server (single-node dev mode)
wget https://dl.min.io/server/minio/release/linux-amd64/minio
chmod +x minio
sudo mv minio /usr/local/bin/

# Start MinIO
mkdir -p ~/minio-data
MINIO_ROOT_USER=<access-key> MINIO_ROOT_PASSWORD=<secret-key> \
  minio server ~/minio-data --console-address :9001 &

# Install mc client
curl -sL https://dl.min.io/client/mc/release/linux-amd64/mc -o ~/.local/bin/mc
chmod +x ~/.local/bin/mc
mc alias set local http://localhost:9000 <access-key> <secret-key>
mc mb local/agents
mc mb local/agents/shared
```

---

## Cost Estimate

| Component | Monthly Cost (East US) |
|-----------|----------------------|
| Standard_B2s VM | ~$30 |
| 30 GB OS disk | ~$2.50 |
| Public IP (Standard) | ~$3.60 |
| Bandwidth (outbound ~10GB) | ~$0.70 |
| **Total** | **~$37/month** |

For just the hub (no GPU), Standard_B2s is more than sufficient.

---

*Last updated: 2026-03-21 by Dr. Quest*
