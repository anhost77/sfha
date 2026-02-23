# Changelog

Toutes les modifications notables de ce projet seront documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/),
et ce projet adhère au [Versionnement Sémantique](https://semver.org/lang/fr/).

## [1.0.70] - 2026-02-24

### Ajouté

- **Commandes VIP CLI** : gestion des VIPs sans éditer manuellement le YAML
  - `sfha vip list` : liste les VIPs configurées
  - `sfha vip add <name> <ip/cidr> [interface]` : ajoute une VIP
  - `sfha vip remove <name>` : supprime une VIP
  - Auto-reload après modification (désactivable avec `--no-reload`)

---

## [1.0.69] - 2026-02-24

### Ajouté

- **Propagation automatique au reload** : quand le leader fait `sfha reload`, la config est automatiquement propagée à tous les nœuds
- **Debug logs dans handleLeaderChange** : meilleur diagnostic de l'activation des ressources

### Corrigé

- **Fix import dynamique yaml** : remplacé `await import('yaml')` par import statique (compatibilité bundling pkg)
- **Fix systemd restart LXC** : ajout `KillMode=process` et `ExecStop` pour un arrêt propre dans les containers
- **Timeout propagation** : augmenté de 5s à 30s pour éviter les échecs sur nœuds occupés

---

## [1.0.67] - 2026-02-24

### Corrigé

- **Fix "A dynamic import callback was not specified"** : erreur fatale lors de la propagation causée par `import('yaml')` dynamique incompatible avec pkg

---

## [1.0.66] - 2026-02-24

### Corrigé

- **Fix activation VIP au démarrage** : les ressources s'activent maintenant correctement quand le daemon devient leader
- **Ajout appel explicite à handleLeaderChange** dans checkElection() pour garantir l'activation

---

## [1.0.65] - 2026-02-24

### Modifié

- **Timeout propagation** : 5s → 30s pour éviter les échecs sur nœuds occupés à activer leurs VIPs

---

## [1.0.64] - 2026-02-24

### Ajouté

- **Propagation automatique** : `reload()` sur le leader déclenche automatiquement la propagation aux autres nœuds

---

## [1.0.63] - 2026-02-24

### Ajouté

- **Propagation des VIPs** : la commande `propagate` inclut maintenant les VIPs, services et constraints du leader

### Corrigé

- **Config YAML complète** : le handler `/full-config` génère maintenant un YAML complet avec toutes les VIPs

---

## [1.0.62] - 2026-02-23

### Corrigé

- **Activation VIP après reload** : nouvelles VIPs activées automatiquement sur le leader lors d'un `sfha reload`

---

## [1.0.61] - 2026-02-23

### Corrigé

- **Null checks arrays** : protection contre les crashes quand vips/services/constraints sont undefined
- **Propagation ordre** : Corosync config créée AVANT l'ajout des peers WireGuard
- **addPeerWgOnly()** : nouvelle fonction pour ajouter un peer WG sans toucher à Corosync

---

## [1.0.60] - 2026-02-23

### Corrigé

- **Fix ESM imports** : `require('os')` remplacé par `import os`
- **Service systemd** : utilise `/bin/sfha run` au lieu du chemin node interne
- **VERSION hardcodée** : synchronisation cli.ts et daemon.ts

---

## [1.0.59] - 2026-02-23

### Corrigé

- **Destroy cluster** : suppression correcte de cluster-state.json, interface wg-sfha et wg-sfha.conf

---

## [1.0.58] - 2026-02-23

### Changements majeurs

- **Nouveau workflow de déploiement en 2 étapes** : plus stable pour les clusters multi-nœuds
  - `sfha join` établit uniquement le tunnel WireGuard vers le leader
  - `sfha propagate` (sur le leader) configure le full-mesh et démarre Corosync

### Ajouté

- **Commande `sfha propagate`** : propagation explicite de la configuration à tous les nœuds
  - Découvre automatiquement les peers via `wg show wg-sfha`
  - Génère les configs WireGuard full-mesh
  - Génère et distribue les configs Corosync
  - Démarre les daemons sur tous les nœuds

- **Méthode `joinSimple()`** : join léger sans notification des peers

### Corrigé

- **Cascades de restart Corosync** : suppression du restart automatique dans `syncMeshPeersFromInitiator()`
- **Sync périodique supprimé** : plus de sync automatique toutes les 30s qui causait des désynchronisations
- **Stabilité multi-nœuds** : le cluster scale correctement à 4+ nœuds sans cascades

### Supprimé

- Notification automatique des peers lors du join (remplacé par propagate explicite)
- Sync périodique de la configuration (source de bugs)

---

## [1.0.3] - 2026-02-20

### Ajouté

- **Health checks standalone** : section `health_checks:` au niveau racine de la config
- **Setup STONITH interactif** : `sfha stonith setup [proxmox|webhook]`
- **Flags STONITH dans init** : `sfha init --stonith proxmox --proxmox-url ...`
- **Driver STONITH Webhook** : fencing via API HTTP externe
- **Auto-détection VMID** : détection automatique pour LXC/QEMU Proxmox

### Format health checks standalone
```yaml
health_checks:
  - name: ssh
    type: tcp
    target: 127.0.0.1:22
    interval: 10
    timeout: 5
```

### Format STONITH Webhook
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

### Modifié

- **Failover optimisé** : ~6s au lieu de ~30s
  - Grace period: 30s → 10s
  - Polls requis: 3 → 2
  - Intervalle polling: 5s → 2s

### Corrigé

- Fix double affichage /24 dans `normalizeVip()`
- Fix vérification VIP après `ip addr add`

---

## [1.0.1] - 2026-02-20

### Corrigé

- **VIP cleanup** : suppression correcte de la VIP au shutdown
- **Quorum check** : vérification avant activation des ressources
- **Follower watchdog** : détection correcte de la perte du leader
- **Service systemd LXC** : désactivation des restrictions namespace

---

## [1.0.0] - 2026-02-20

### Ajouté

- **VIP flottante** avec failover automatique et gratuitous ARP
- **Mesh WireGuard intégré** : commandes `init` et `join` pour créer un cluster en une commande
- **STONITH Proxmox** : fencing automatique via API Proxmox (VMs et containers LXC)
- **Détection de conflits IP** : vérification avant activation des VIPs
- **Health checks** : HTTP, TCP et systemd avec hystérésis configurable
- **CLI complète en français** avec option `--lang=en` pour l'anglais
- **Contraintes** : colocation et ordre entre ressources
- **Intégration Corosync** : quorum et membership via votequorum
- **Service systemd** : démarrage automatique, reload via SIGHUP
- **Socket Unix de contrôle** : communication CLI ↔ daemon

### Sécurité

- Quorum obligatoire pour activer les ressources
- Protection anti-fencing storm (max 2 fencing / 5 min)
- Délai de grâce configurable au démarrage (120s par défaut)
- Token Proxmox stocké dans fichier séparé (600)

### Plateformes supportées

- Debian 11 (Bullseye)
- Debian 12 (Bookworm)
- Debian 13 (Trixie)
- Ubuntu 22.04 LTS (Jammy)
- Ubuntu 24.04 LTS (Noble)

---

## [Unreleased]

### Prévu

- Driver STONITH IPMI/iLO
- Driver STONITH VMware vSphere
- Driver STONITH AWS EC2
- Interface web de monitoring
- Métriques Prometheus
- Support multi-VIP sur même interface
