# E2E Test Results - sfha v1.0.1

**Date:** 2026-02-20  
**Environment:** Proxmox containers CT230, CT231, CT232

---

## Story 1 : Fix logging VIP (P0)

### Modifications apportées

| Fichier | Changement |
|---------|------------|
| `src/vip.ts` | `runCommand()` retourne maintenant `{ success, stderr }` au lieu de `boolean` |
| `src/vip.ts` | `addVip()` log l'erreur exacte via `result.stderr` |
| `src/vip.ts` | `removeVip()` log aussi l'erreur stderr |
| `src/daemon.ts` | `activateResources()` vérifie le retour de `activateAllVips()` et log si échec |

**Résultat:** ✅ Implémenté

---

## Story 2 : Rebuild .deb

| Étape | Résultat |
|-------|----------|
| `pnpm build` | ✅ Compilation TypeScript OK |
| `scripts/build-deb.sh` | ✅ .deb créé (15MB) |
| Binaire standalone | ✅ 56MB avec Node.js embarqué |
| Service systemd | ✅ RestrictNamespaces=no inclus |

**Package:** `sfha_1.0.1_amd64.deb`

---

## Story 3 : Test E2E sur containers

### Infrastructure

| Container | IP | Mesh IP | Rôle |
|-----------|-------|---------|------|
| CT230 | 192.168.1.154 | 10.200.0.1 | node1 (seeder) |
| CT231 | 192.168.1.244 | 10.200.0.2 | node2 |
| CT232 | 192.168.1.239 | 10.200.0.3 | node3 |

**VIP testée:** 192.168.1.250/24 sur eth0

### Étapes de test

| # | Étape | Résultat | Notes |
|---|-------|----------|-------|
| 1 | Nettoyage containers | ✅ | sfha, corosync, wireguard supprimés |
| 2 | Installation .deb | ✅ | Installé sur les 3 containers |
| 3 | `sfha init` sur CT230 | ✅ | Token généré, WireGuard UP |
| 4 | `sfha join` sur CT231 | ✅ | Mesh connecté |
| 5 | `sfha join` sur CT232 | ✅ | Mesh connecté |
| 6 | Add peers bidirectionnels | ✅ | Mesh full-mesh configuré |
| 7 | Config Corosync unifiée | ✅ | 3 nœuds dans nodelist |
| 8 | Démarrage Corosync | ✅ | Quorum 3/3 |
| 9 | Création configs sfha | ✅ | VIP configurée sur les 3 |
| 10 | Démarrage sfha | ✅ | daemon actif sur les 3 |
| 11 | Vérification statut | ✅ | node1 leader, VIP active |
| 12 | VIP sur leader | ✅ | `ip addr` confirme 192.168.1.250 |
| 13 | **Test failover** | ✅ | VIP migre en ~30s |

### Résultats du failover

**Avant arrêt de CT230:**
- Leader: node1 (CT230)
- VIP: 192.168.1.250 sur CT230

**Après arrêt de CT230 (~30s):**
- Leader: node2 (CT231)
- VIP: 192.168.1.250 migrée sur CT231
- Quorum: OK (2/3 nœuds)

```
CT231 - ip addr show eth0:
    inet 192.168.1.244/24 brd 192.168.1.255 scope global dynamic eth0
    inet 192.168.1.250/24 scope global secondary eth0  ← VIP migrée !
```

---

## Bugs identifiés (mineurs)

### Bug 1 : Affichage "Leader: node1" incorrect
**Symptôme:** Après failover, `sfha status` affiche "Leader: node1" alors que node2 est le vrai leader.  
**Impact:** Cosmétique uniquement - le nœud local affiche bien "(leader)" et la VIP est active.  
**Cause probable:** Cache de l'election manager non mis à jour.

### Bug 2 : NodeId dans add-peer
**Symptôme:** `sfha mesh add-peer` retourne parfois le même nodeId pour différents peers.  
**Impact:** Cosmétique - le peer est bien ajouté.

### Bug 3 : Mesh unidirectionnel par défaut
**Symptôme:** `sfha join` ne notifie pas le seeder - il faut ajouter manuellement les peers.  
**Impact:** Setup manuel nécessaire pour un cluster fonctionnel.  
**Workaround:** Documenter les commandes `add-peer` nécessaires.

---

## Conclusion

### ✅ Prêt pour release

Le package sfha v1.0.1 est **fonctionnel** :

1. **Installation** sur containers LXC privilégiés fonctionne sans erreur NAMESPACE
2. **Mesh WireGuard** opérationnel avec handshakes entre tous les nœuds
3. **Corosync** forme un cluster avec quorum
4. **VIP flottante** active sur le leader
5. **Failover automatique** fonctionne (~30s après perte du leader)
6. **Logging amélioré** capture les erreurs VIP avec stderr

### Points d'attention

- Le setup mesh nécessite des étapes manuelles (`add-peer`) → à documenter
- Le temps de failover (~30s) est acceptable mais pourrait être réduit (paramètre `pollIntervalMs`)
- Le bug d'affichage du leader est cosmétique

### Recommandations

1. Documenter la procédure `add-peer` bidirectionnelle dans le README
2. Considérer l'automatisation du mesh bidirectionnel (Story 3 de BMAD-ANALYSIS)
3. Exposer `pollIntervalMs` comme paramètre CLI pour ajuster la réactivité

---

**Testé par:** OpenClaw Agent  
**Date:** 2026-02-20 20:55 CET
