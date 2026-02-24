# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.70] - 2026-02-24

### Added

- **VIP CLI commands**: manage VIPs without manually editing YAML
  - `sfha vip list`: list configured VIPs
  - `sfha vip add <name> <ip/cidr> [interface]`: add a VIP
  - `sfha vip remove <name>`: remove a VIP
  - Auto-reload after modification (disable with `--no-reload`)

---

## [1.0.69] - 2026-02-24

### Added

- **Automatic propagation on reload**: when the leader runs `sfha reload`, config is automatically propagated to all nodes
- **Debug logs in handleLeaderChange**: better resource activation diagnostics

### Fixed

- **Fix dynamic yaml import**: replaced `await import('yaml')` with static import (pkg bundling compatibility)
- **Fix systemd restart in LXC**: added `KillMode=process` and `ExecStop` for clean shutdown in containers
- **Propagation timeout**: increased from 5s to 30s to avoid failures on busy nodes

---

## [1.0.67] - 2026-02-24

### Fixed

- **Fix "A dynamic import callback was not specified"**: fatal error during propagation caused by dynamic `import('yaml')` incompatible with pkg

---

## [1.0.66] - 2026-02-24

### Fixed

- **Fix VIP activation at startup**: resources now activate correctly when daemon becomes leader
- **Added explicit handleLeaderChange call** in checkElection() to guarantee activation

---

## [1.0.65] - 2026-02-24

### Changed

- **Propagation timeout**: 5s → 30s to avoid failures on nodes busy activating their VIPs

---

## [1.0.64] - 2026-02-24

### Added

- **Automatic propagation**: `reload()` on the leader automatically triggers propagation to other nodes

---

## [1.0.63] - 2026-02-24

### Added

- **VIP propagation**: the `propagate` command now includes VIPs, services and constraints from the leader

### Fixed

- **Complete YAML config**: the `/full-config` handler now generates complete YAML with all VIPs

---

## [1.0.62] - 2026-02-23

### Fixed

- **VIP activation after reload**: new VIPs automatically activated on the leader during `sfha reload`

---

## [1.0.61] - 2026-02-23

### Fixed

- **Null checks arrays**: protection against crashes when vips/services/constraints are undefined
- **Propagation order**: Corosync config created BEFORE adding WireGuard peers
- **addPeerWgOnly()**: new function to add a WG peer without touching Corosync

---

## [1.0.60] - 2026-02-23

### Fixed

- **Fix ESM imports**: `require('os')` replaced with `import os`
- **Systemd service**: uses `/bin/sfha run` instead of internal node path
- **Hardcoded VERSION**: synchronized cli.ts and daemon.ts

---

## [1.0.59] - 2026-02-23

### Fixed

- **Destroy cluster**: correct deletion of cluster-state.json, wg-sfha interface and wg-sfha.conf

---

## [1.0.58] - 2026-02-23

### Major Changes

- **New 2-step deployment workflow**: more stable for multi-node clusters
  - `sfha join` only establishes the WireGuard tunnel to the leader
  - `sfha propagate` (on the leader) configures full-mesh and starts Corosync

### Added

- **`sfha propagate` command**: explicit configuration propagation to all nodes
  - Automatically discovers peers via `wg show wg-sfha`
  - Generates full-mesh WireGuard configs
  - Generates and distributes Corosync configs
  - Starts daemons on all nodes

- **`joinSimple()` method**: lightweight join without peer notification

### Fixed

- **Corosync restart cascades**: removed automatic restart in `syncMeshPeersFromInitiator()`
- **Periodic sync removed**: no more automatic sync every 30s that caused desynchronization
- **Multi-node stability**: cluster now scales correctly to 4+ nodes without cascades

### Removed

- Automatic peer notification during join (replaced by explicit propagate)
- Periodic config sync (bug source)

---

## [1.0.3] - 2026-02-20

### Added

- **Standalone health checks**: `health_checks:` section at config root level
- **Interactive STONITH setup**: `sfha stonith setup [proxmox|webhook]`
- **STONITH flags in init**: `sfha init --stonith proxmox --proxmox-url ...`
- **STONITH Webhook driver**: fencing via external HTTP API
- **VMID auto-detection**: automatic detection for Proxmox LXC/QEMU

### Standalone health checks format
```yaml
health_checks:
  - name: ssh
    type: tcp
    target: 127.0.0.1:22
    interval: 10
    timeout: 5
```

### STONITH Webhook format
```yaml
stonith:
  provider: webhook
  webhook:
    fence_url: https://api.example.com/fence/{{node}}
    unfence_url: https://api.example.com/unfence/{{node}}
    method: POST
    headers:
      Authorization: Bearer xxx
    body_template: '{"node": "{{node}}", "action": "{{action}}"}'
    timeout: 30
```

---

## [1.0.2] - 2026-02-20

### Changed

- **Optimized failover**: ~6s instead of ~30s
  - Grace period: 30s → 10s
  - Required polls: 3 → 2
  - Polling interval: 5s → 2s

### Fixed

- Fix double /24 display in `normalizeVip()`
- Fix VIP verification after `ip addr add`

---

## [1.0.1] - 2026-02-20

### Fixed

- **VIP cleanup**: correct VIP removal at shutdown
- **Quorum check**: verification before resource activation
- **Follower watchdog**: correct leader loss detection
- **Systemd service LXC**: disabled namespace restrictions

---

## [1.0.0] - 2026-02-20

### Added

- **Floating VIP** with automatic failover and gratuitous ARP
- **Built-in WireGuard mesh**: `init` and `join` commands to create a cluster in one command
- **Proxmox STONITH**: automatic fencing via Proxmox API (VMs and LXC containers)
- **IP conflict detection**: verification before VIP activation
- **Health checks**: HTTP, TCP and systemd with configurable hysteresis
- **Full CLI in French** with `--lang=en` option for English
- **Constraints**: colocation and order between resources
- **Corosync integration**: quorum and membership via votequorum
- **Systemd service**: automatic startup, reload via SIGHUP
- **Unix control socket**: CLI ↔ daemon communication

### Security

- Required quorum to activate resources
- Anti-fencing storm protection (max 2 fencing / 5 min)
- Configurable startup grace period (120s by default)
- Proxmox token stored in separate file (600)

### Supported Platforms

- Debian 11 (Bullseye)
- Debian 12 (Bookworm)
- Debian 13 (Trixie)
- Ubuntu 22.04 LTS (Jammy)
- Ubuntu 24.04 LTS (Noble)

---

## [Unreleased]

### Planned

- IPMI/iLO STONITH driver
- VMware vSphere STONITH driver
- AWS EC2 STONITH driver
- Web monitoring interface
- Prometheus metrics
- Multi-VIP support on same interface
