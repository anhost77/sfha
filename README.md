```
     ███████╗███████╗██╗  ██╗ █████╗
     ██╔════╝██╔════╝██║  ██║██╔══██╗
     ███████╗█████╗  ███████║███████║
     ╚════██║██╔══╝  ██╔══██║██╔══██║
     ███████║██║     ██║  ██║██║  ██║
     ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝
     Simple. Fast. High Availability.
```

# sfha — Haute Disponibilité légère pour Linux

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.70-green.svg)](package.json)
[![Debian](https://img.shields.io/badge/Debian-11%2B-red.svg)](https://www.debian.org/)
[![Ubuntu](https://img.shields.io/badge/Ubuntu-22.04%2B-orange.svg)](https://ubuntu.com/)
[![Made in France](https://img.shields.io/badge/Made%20in-France%20🇫🇷-blue.svg)](#)

**sfha** (Simple Fast High Availability) est un système de haute disponibilité léger et moderne, conçu comme alternative minimaliste à Pacemaker.

🚀 **~12K lignes TypeScript** | 📦 **15MB standalone** | ⚡ **Zéro I/O disque** | 🇫🇷 **CLI en français**

---

## ✨ Fonctionnalités

| Fonctionnalité | Description |
|----------------|-------------|
| 🔄 **VIP flottante** | Failover automatique des adresses IP virtuelles (~5s) |
| 🌐 **Mesh WireGuard** | Réseau chiffré intégré avec `init`/`join` simple |
| 🔫 **STONITH** | Fencing via API Proxmox ou Webhook (extensible) |
| 🛡️ **Détection conflits IP** | Vérifie les collisions avant activation (arping) |
| 💓 **Health checks** | HTTP, TCP, systemd avec hystérésis configurable |
| 🤝 **Quorum Corosync** | Intégration native avec votequorum |
| 🔁 **Propagation auto** | Config VIP/services synchronisée sur tous les nœuds |
| 🇫🇷 **Multilingue** | Français par défaut, `--lang=en` disponible |
| 📊 **CLI complète** | Status, resources, failover, standby, propagate... |

---

## 📦 Installation rapide

```bash
# Télécharger le .deb depuis les releases GitHub
wget https://github.com/anhost77/sfha/releases/latest/download/sfha_1.0.70_amd64.deb

# Installer (aucune dépendance requise sauf corosync)
sudo dpkg -i sfha_1.0.70_amd64.deb

# Vérifier l'installation
sfha --version
```

### Prérequis

- **OS** : Debian 11/12/13, Ubuntu 22.04/24.04
- **Node.js** : ❌ **Non requis** (embarqué dans le .deb)
- **Corosync** : Installé automatiquement comme dépendance
- **WireGuard** : `apt install wireguard-tools` (**obligatoire** pour le mesh P2P)

### Ports réseau requis

| Port | Protocole | Usage |
|------|-----------|-------|
| 5405 | UDP | Corosync (communication cluster) |
| 51820 | UDP | WireGuard mesh |
| **7777** | TCP | **Coordination P2P sfha** (sur IP mesh uniquement) |

> ⚠️ **WireGuard est obligatoire.** Le port 7777 est utilisé pour la synchronisation de l'état entre nœuds et n'écoute que sur l'interface mesh WireGuard (10.x.x.x) pour des raisons de sécurité.

---

## 🚀 Quick Start

### Étape 1 : Initialiser le cluster (nœud leader)

```bash
# Initialiser avec mesh WireGuard intégré
sudo sfha init --name mon-cluster --mesh --ip 10.100.0.1/24 --endpoint <IP_PUBLIQUE>

# Avec STONITH Proxmox (optionnel)
sudo sfha init --name mon-cluster --mesh --ip 10.100.0.1/24 --endpoint <IP_PUBLIQUE> \
  --stonith proxmox \
  --proxmox-url https://192.168.1.100:8006 \
  --proxmox-token root@pam!sfha \
  --proxmox-secret-file /etc/sfha/proxmox.secret \
  --pve-node pve01 \
  --vmid 101

# Ou configuration interactive STONITH
sudo sfha stonith setup

# ➜ Copier le token affiché pour les autres nœuds
```

### Étape 2 : Rejoindre le cluster (autres nœuds)

```bash
# Sur chaque nœud secondaire : établit uniquement le tunnel WireGuard
sudo sfha join <token> --endpoint <IP_PUBLIQUE_DU_NOEUD>
```

> ℹ️ **Note :** `sfha join` établit uniquement le tunnel WireGuard vers le leader. 
> Il n'y a pas encore de Corosync ni de full-mesh à cette étape.

### Étape 3 : Propager la configuration (sur le leader)

```bash
# Une fois tous les nœuds joints, exécuter sur le LEADER :
sudo sfha propagate
```

Cette commande :
- 🔍 Découvre tous les peers WireGuard connectés
- 🌐 Configure le full-mesh WireGuard (tous les nœuds se connaissent)
- ⚙️ Génère et distribue la configuration Corosync
- 🚀 Démarre les daemons sur tous les nœuds

```
✓ Propagation terminée: 3/3 nœuds mis à jour
```

### Configurer les ressources

Éditez `/etc/sfha/config.yml` :

```yaml
cluster:
  name: mon-cluster
  quorum_required: true
  failover_delay_ms: 3000

node:
  name: node1
  priority: 100

# VIP flottante
vips:
  - name: vip-web
    ip: 192.168.1.100
    cidr: 24
    interface: eth0

# Service géré
services:
  - name: nginx
    type: systemd
    unit: nginx
    healthcheck:
      type: http
      target: "http://127.0.0.1/health"
      interval_ms: 5000
      failures_before_unhealthy: 3

# Contraintes
constraints:
  - type: colocation
    resource: nginx
    with: vip-web
```

### Démarrer

```bash
sudo systemctl enable --now sfha
sfha status
```

---

## 💻 Commandes CLI

```bash
# Statut du cluster
sfha status              # Vue d'ensemble
sfha status --json       # Sortie JSON

# Ressources
sfha resources           # Liste des ressources
sfha health              # État des health checks

# Contrôle
sfha failover            # Forcer un basculement
sfha standby             # Mettre en standby
sfha unstandby           # Réactiver
sfha reload              # Recharger la config

# Mesh WireGuard
sfha mesh status         # État du mesh
sfha mesh token          # Générer un nouveau token

# Cluster
sfha propagate           # Propager la config à tous les nœuds (depuis le leader)

# STONITH
sfha stonith status      # État du fencing
sfha stonith setup       # Configuration interactive
sfha stonith fence node2 # Fence manuel
sfha stonith unfence node2 # Rallumer un nœud
sfha stonith history     # Historique

# Configuration
sfha config-check        # Valider la config
sfha config-example      # Afficher un exemple

# Options globales
sfha --lang=en status    # Interface en anglais
sfha --debug run         # Mode debug
```

---

## ⚙️ Configuration complète

<details>
<summary>📄 Exemple complet /etc/sfha/config.yml</summary>

```yaml
# sfha v1.0.0 - Configuration complète

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

# Contraintes
constraints:
  - type: colocation
    resource: nginx
    with: vip-main
  - type: order
    first: vip-main
    then: nginx

# STONITH (optionnel)
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

## 🆚 Positionnement

sfha se positionne entre keepalived (trop simple) et Pacemaker (trop complexe) :

| Critère | keepalived | sfha | Pacemaker |
|---------|------------|------|-----------|
| **Complexité** | Minimale | Modérée | Élevée |
| **Configuration** | Config texte | **YAML simple** | XML complexe |
| **I/O disque** | Faible | **Zéro** | Élevé (CIB XML) |
| **STONITH/Fencing** | ❌ | Proxmox + Webhook | 100+ agents |
| **Mesh chiffré** | ❌ | **WireGuard intégré** | ❌ |
| **Health checks** | VRRP scripts | **HTTP/TCP/systemd** | Via agents |
| **Propagation auto** | ❌ | **Oui (reload)** | ❌ |
| **Cas d'usage** | VIP simple | 2-10 nœuds, VIPs + services | Clusters complexes |

---

## 🔌 STONITH Webhook (API externe)

Pour intégrer avec des APIs externes (cloud, custom, etc.) :

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

Les variables `{{node}}` et `{{action}}` sont remplacées automatiquement.

---

## 💓 Health Checks Standalone

Vérifier des services indépendamment des resources :

```yaml
health_checks:
  - name: ssh
    type: tcp
    target: 127.0.0.1:22
    interval: 10        # secondes
    timeout: 5
    failures_before_unhealthy: 3
    successes_before_healthy: 2
    
  - name: api
    type: http
    target: http://localhost:8080/health
    interval: 15
    timeout: 3
```

Vérifier : `sfha health`

---

### sfha est fait pour vous si...

✅ Vous gérez 2-10 nœuds avec VIPs et services  
✅ Vous voulez une config YAML lisible en 5 minutes  
✅ Vous avez Proxmox et voulez du STONITH simple  
✅ Vous voulez un mesh chiffré auto-configuré  
✅ Vous voulez une propagation automatique des configs  

### sfha n'est PAS fait pour vous si...

❌ Vous avez besoin de ressources clonées/multi-state  
❌ Vous gérez 50+ nœuds en production  
❌ Vous avez besoin de fence-agents matériels (IPMI, iLO, DRAC...)  

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Configuration complète](docs/CONFIGURATION.md) | Toutes les options |
| [Architecture](docs/ARCHITECTURE.md) | Design interne |
| [STONITH Proxmox](docs/STONITH.md) | Guide fencing |
| [Mesh WireGuard](docs/MESH.md) | Guide réseau |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Résolution de problèmes |

---

## 🛠️ Développement

```bash
# Cloner
git clone https://github.com/anhost77/sfha.git
cd sfha

# Installer les dépendances
pnpm install

# Build TypeScript
pnpm build

# Tests
pnpm test

# Construire le .deb standalone (Node.js embarqué, ~27MB)
./scripts/build-deb-standalone.sh

# Ou construire le .deb léger (nécessite Node.js sur la cible, ~3.6MB)
./scripts/build-deb-nodejs.sh
```

### Scripts de build

| Script | Taille | Node.js requis |
|--------|--------|----------------|
| `build-deb.sh` | ~15MB | ❌ Non (binaire standalone) |

---

## 🤝 Contribuer

Les contributions sont les bienvenues ! Voir [CONTRIBUTING.md](CONTRIBUTING.md).

1. Fork le projet
2. Créer une branche (`git checkout -b feature/ma-feature`)
3. Commit (`git commit -m 'Ajout de ma feature'`)
4. Push (`git push origin feature/ma-feature`)
5. Ouvrir une Pull Request

---

## 📄 Licence

[MIT](LICENSE) © [ServerFlow](https://serverflow.io)

---

<p align="center">
  🇫🇷 <strong>Made in France</strong> avec ❤️
  <br>
  <sub>Par des admins sys, pour des admins sys.</sub>
</p>
