# Compatibilité

## Systèmes d'exploitation supportés

| Distribution | Version | Node.js | Statut |
|--------------|---------|---------|--------|
| Debian | 11 (Bullseye) | 18.x | ✅ Supporté |
| Debian | 12 (Bookworm) | 18.x | ✅ Supporté |
| Debian | 13 (Trixie) | 20.x | ✅ Supporté |
| Ubuntu | 22.04 LTS | 18.x | ✅ Supporté |
| Ubuntu | 24.04 LTS | 18.x | ✅ Supporté |

## Prérequis

- **Node.js** ≥ 18 (inclus dans le bundle .deb)
- **Corosync** ≥ 3.0
- **WireGuard** (optionnel, pour le mesh)
- **iproute2** (pour `ip addr`)
- **iputils-arping** (pour gratuitous ARP)

## Notes

- Sur Debian 11 et Ubuntu 22.04, vous devrez peut-être installer Node.js 18+ depuis NodeSource si vous compilez depuis les sources.
- Le paquet .deb inclut le bundle Node.js, donc aucune dépendance externe n'est requise pour l'exécution.
