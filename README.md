```
     ███████╗███████╗██╗  ██╗ █████╗
     ██╔════╝██╔════╝██║  ██║██╔══██╗
     ███████╗█████╗  ███████║███████║
     ╚════██║██╔══╝  ██╔══██║██╔══██║
     ███████║██║     ██║  ██║██║  ██║
     ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝
     Simple. Fast. High Availability.
```

# sfha — Lightweight High Availability for Linux

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.70-green.svg)](package.json)
[![Debian](https://img.shields.io/badge/Debian-11%2B-red.svg)](https://www.debian.org/)
[![Ubuntu](https://img.shields.io/badge/Ubuntu-22.04%2B-orange.svg)](https://ubuntu.com/)
[![Made in France](https://img.shields.io/badge/Made%20in-France%20🇫🇷-blue.svg)](#)

**sfha** (Simple Fast High Availability) is a lightweight, modern high availability system designed as a minimalist alternative to Pacemaker.

🚀 **~12K lines TypeScript** | 📦 **15MB standalone** | ⚡ **Zero disk I/O** | 🌐 **Multilingual CLI**

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔄 **Floating VIP** | Automatic virtual IP failover (~5s) |
| 🌐 **WireGuard Mesh** | Built-in encrypted network with simple `init`/`join` |
| 🔫 **STONITH** | Fencing via Proxmox API or Webhook (extensible) |
| 🛡️ **IP Conflict Detection** | Checks for collisions before activation (arping) |
| 💓 **Health Checks** | HTTP, TCP, systemd with configurable hysteresis |
| 🤝 **Corosync Quorum** | Native integration with votequorum |
| 🔁 **Auto Propagation** | VIP/services config synced across all nodes |
| 🌍 **Multilingual** | French by default, `--lang=en` available |
| 📊 **Full CLI** | Status, resources, failover, standby, propagate... |

---

## 📦 Quick Install

```bash
# Download the .deb from GitHub releases
wget https://github.com/anhost77/sfha/releases/latest/download/sfha_1.0.70_amd64.deb

# Install (no dependencies required except corosync)
sudo dpkg -i sfha_1.0.70_amd64.deb

# Verify installation
sfha --version
```

### Prerequisites

- **OS**: Debian 11/12/13, Ubuntu 22.04/24.04
- **Node.js**: ❌ **Not required** (bundled in the .deb)
- **Corosync**: Automatically installed as dependency
- **WireGuard**: `apt install wireguard-tools` (**required** for P2P mesh)

### Required Network Ports

| Port | Protocol | Usage |
|------|----------|-------|
| 5405 | UDP | Corosync (cluster communication) |
| 51820 | UDP | WireGuard mesh |
| **7777** | TCP | **sfha P2P coordination** (mesh IP only) |

> ⚠️ **WireGuard is mandatory.** Port 7777 is used for state synchronization between nodes and only listens on the WireGuard mesh interface (10.x.x.x) for security reasons.

---

## 🚀 Quick Start

### Step 1: Initialize the cluster (leader node)

```bash
# Initialize with built-in WireGuard mesh
sudo sfha init --name my-cluster --mesh --ip 10.100.0.1/24 --endpoint <PUBLIC_IP>

# With Proxmox STONITH (optional)
sudo sfha init --name my-cluster --mesh --ip 10.100.0.1/24 --endpoint <PUBLIC_IP> \
  --stonith proxmox \
  --proxmox-url https://192.168.1.100:8006 \
  --proxmox-token root@pam!sfha \
  --proxmox-secret-file /etc/sfha/proxmox.secret \
  --pve-node pve01 \
  --vmid 101

# Or interactive STONITH setup
sudo sfha stonith setup

# ➜ Copy the displayed token for other nodes
```

### Step 2: Join the cluster (other nodes)

```bash
# On each secondary node: establishes WireGuard tunnel only
sudo sfha join <token> --endpoint <NODE_PUBLIC_IP>
```

> ℹ️ **Note:** `sfha join` only establishes the WireGuard tunnel to the leader. 
> There's no Corosync or full-mesh at this stage yet.

### Step 3: Propagate configuration (on the leader)

```bash
# Once all nodes have joined, run on the LEADER:
sudo sfha propagate
```

This command:
- 🔍 Discovers all connected WireGuard peers
- 🌐 Configures full-mesh WireGuard (all nodes know each other)
- ⚙️ Generates and distributes Corosync configuration
- 🚀 Starts daemons on all nodes

```
✓ Propagation complete: 3/3 nodes updated
```

### Configure Resources

Edit `/etc/sfha/config.yml`:

```yaml
cluster:
  name: my-cluster
  quorum_required: true
  failover_delay_ms: 3000

node:
  name: node1
  priority: 100

# Floating VIP
vips:
  - name: vip-web
    ip: 192.168.1.100
    cidr: 24
    interface: eth0

# Managed service
services:
  - name: nginx
    type: systemd
    unit: nginx
    healthcheck:
      type: http
      target: "http://127.0.0.1/health"
      interval_ms: 5000
      failures_before_unhealthy: 3

# Constraints
constraints:
  - type: colocation
    resource: nginx
    with: vip-web
```

### Start

```bash
sudo systemctl enable --now sfha
sfha status
```

---

## 💻 CLI Commands

```bash
# Cluster status
sfha status              # Overview
sfha status --json       # JSON output

# Resources
sfha resources           # List resources
sfha health              # Health check status

# Control
sfha failover            # Force failover
sfha standby             # Put node in standby
sfha unstandby           # Reactivate node
sfha reload              # Reload config

# WireGuard mesh
sfha mesh status         # Mesh status
sfha mesh token          # Generate new token

# Cluster
sfha propagate           # Propagate config to all nodes (from leader)

# STONITH
sfha stonith status      # Fencing status
sfha stonith setup       # Interactive setup
sfha stonith fence node2 # Manual fence
sfha stonith unfence node2 # Power on a node
sfha stonith history     # History

# Configuration
sfha config-check        # Validate config
sfha config-example      # Show example

# Global options
sfha --lang=en status    # English interface
sfha --debug run         # Debug mode
```

---

## ⚙️ Full Configuration

<details>
<summary>📄 Complete /etc/sfha/config.yml example</summary>

```yaml
# sfha v1.0.0 - Complete configuration

cluster:
  name: production
  quorum_required: true
  failover_delay_ms: 3000
  poll_interval_ms: 5000

node:
  name: node1
  priority: 100

# VIPs
vips:
  - name: vip-main
    ip: 192.168.1.100
    cidr: 24
    interface: eth0

# Services
services:
  - name: nginx
    type: systemd
    unit: nginx
    healthcheck:
      type: http
      target: "http://127.0.0.1/health"
      interval_ms: 5000
      timeout_ms: 2000
      failures_before_unhealthy: 3
      successes_before_healthy: 2

  - name: postgresql
    type: systemd
    unit: postgresql
    healthcheck:
      type: tcp
      target: "127.0.0.1:5432"

# Constraints
constraints:
  - type: colocation
    resource: nginx
    with: vip-main
  - type: order
    first: vip-main
    then: nginx

# STONITH (optional)
stonith:
  enabled: true
  provider: proxmox
  proxmox:
    api_url: https://192.168.1.100:8006
    token_id: root@pam!sfha
    token_secret_file: /etc/sfha/proxmox.secret
    verify_ssl: false
    pve_node: pve01
  nodes:
    node1:
      type: lxc
      vmid: 101
    node2:
      type: lxc
      vmid: 102
  safety:
    require_quorum: true
    min_delay_between_fence: 60
    max_fences_per_5min: 2
    startup_grace_period: 120

logging:
  level: info
```

</details>

---

## 🆚 Positioning

sfha sits between keepalived (too simple) and Pacemaker (too complex):

| Criteria | keepalived | sfha | Pacemaker |
|----------|------------|------|-----------|
| **Complexity** | Minimal | Moderate | High |
| **Configuration** | Text config | **Simple YAML** | Complex XML |
| **Disk I/O** | Low | **Zero** | High (CIB XML) |
| **STONITH/Fencing** | ❌ | Proxmox + Webhook | 100+ agents |
| **Encrypted mesh** | ❌ | **Built-in WireGuard** | ❌ |
| **Health checks** | VRRP scripts | **HTTP/TCP/systemd** | Via agents |
| **Auto propagation** | ❌ | **Yes (reload)** | ❌ |
| **Use case** | Simple VIP | 2-10 nodes, VIPs + services | Complex clusters |

---

## 🔌 STONITH Webhook (External API)

For integration with external APIs (cloud, custom, etc.):

```yaml
stonith:
  enabled: true
  provider: webhook
  webhook:
    fence_url: https://api.example.com/servers/{{node}}/stop
    unfence_url: https://api.example.com/servers/{{node}}/start
    status_url: https://api.example.com/servers/{{node}}/status
    method: POST
    headers:
      Authorization: Bearer your-token
      Content-Type: application/json
    body_template: '{"node": "{{node}}", "action": "{{action}}"}'
    timeout: 30
    verify_ssl: true
```

Variables `{{node}}` and `{{action}}` are automatically replaced.

---

## 💓 Standalone Health Checks

Monitor services independently of resources:

```yaml
health_checks:
  - name: ssh
    type: tcp
    target: 127.0.0.1:22
    interval: 10        # seconds
    timeout: 5
    failures_before_unhealthy: 3
    successes_before_healthy: 2
    
  - name: api
    type: http
    target: http://localhost:8080/health
    interval: 15
    timeout: 3
```

Check with: `sfha health`

---

### sfha is for you if...

✅ You manage 2-10 nodes with VIPs and services  
✅ You want readable YAML config in 5 minutes  
✅ You have Proxmox and want simple STONITH  
✅ You want an auto-configured encrypted mesh  
✅ You want automatic config propagation  

### sfha is NOT for you if...

❌ You need cloned/multi-state resources  
❌ You manage 50+ nodes in production  
❌ You need hardware fence agents (IPMI, iLO, DRAC...)  

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Full Configuration](docs/CONFIGURATION.md) | All options |
| [Architecture](docs/ARCHITECTURE.md) | Internal design |
| [STONITH Proxmox](docs/STONITH.md) | Fencing guide |
| [WireGuard Mesh](docs/MESH.md) | Network guide |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Problem solving |

---

## 🛠️ Development

```bash
# Clone
git clone https://github.com/anhost77/sfha.git
cd sfha

# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Tests
pnpm test

# Build standalone .deb (bundled Node.js, ~15MB)
./scripts/build-deb.sh
```

### Build Scripts

| Script | Size | Node.js required |
|--------|------|------------------|
| `build-deb.sh` | ~15MB | ❌ No (standalone binary) |

---

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

1. Fork the project
2. Create a branch (`git checkout -b feature/my-feature`)
3. Commit (`git commit -m 'Add my feature'`)
4. Push (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## 📄 License

[MIT](LICENSE) © [ServerFlow](https://serverflow.io)

---

<p align="center">
  🇫🇷 <strong>Made in France</strong> with ❤️
  <br>
  <sub>By sysadmins, for sysadmins.</sub>
</p>
