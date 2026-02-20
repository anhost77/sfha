# Changelog

Toutes les modifications notables de ce projet seront documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/),
et ce projet adhère au [Versionnement Sémantique](https://semver.org/lang/fr/).

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
- Interface web de monitoring
- Métriques Prometheus
- Support multi-VIP sur même interface
