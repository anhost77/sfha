# Stress Test Report v2 - Post-Fix

**Date:** 2026-02-20 18:22-18:33 CET  
**Version:** sfha 1.0.0 (post-fix)  
**Testeur:** Claude (subagent sfha-stress-v2)  
**Environnement:** Proxmox 192.168.1.100, CT210/211/212

---

## Résumé

| # | Scénario | Résultat | Temps | Notes |
|---|----------|----------|-------|-------|
| 1 | Failover auto | ✅ PASS | ~10s | VIP migrée proprement |
| 2 | Split-brain | ❌ **FAIL** | N/A | **BUG CRITIQUE** |
| 3 | Reboot/recovery | ✅ PASS | 9s | Réintégration propre |
| 4 | Perte de quorum | ✅ PASS | ~15s | VIP retirée sans quorum |
| 5 | STONITH réel | ✅ PASS | 4.2s | Fence Proxmox OK |
| 6 | Réseau instable | ✅ PASS | 30s stable | Pas de faux failover |

---

## Détails

### Scénario 1 : Failover automatique ✅

**Étapes:**
1. Cluster 3/3 nœuds, CT210 leader avec VIP
2. `pct stop 210` brutal
3. Monitoring de la migration VIP

**Résultats:**
- Failover détecté en ~10 secondes
- VIP migrée sur CT211 (node2)
- CT212 reste en standby
- Après redémarrage CT210, réintègre et reprend le leadership (priorité)
- ✅ Une seule VIP à tout moment

---

### Scénario 2 : Split-brain simulation ❌ ÉCHEC CRITIQUE

**Étapes:**
1. Cluster 3/3 nœuds, CT210 leader avec VIP
2. Isolation CT210 via iptables (DROP INPUT/OUTPUT)
3. Attente 60+ secondes

**Résultats:**
- ❌ **BUG CRITIQUE**: Le nœud isolé garde la VIP
- ❌ Le nœud isolé affiche "Quorum: OK (3/3 nœuds)" alors qu'il est complètement isolé
- ✅ Les 2 autres nœuds élisent correctement un nouveau leader (CT211)
- ✅ CT211 active la VIP
- ❌ **SPLIT-BRAIN**: 2 VIPs actives simultanément !

**Analyse:**
Le daemon ne détecte pas la perte de connectivité sortante. Il ne reçoit plus de heartbeats mais continue de croire qu'il a le quorum basé sur un état mis en cache.

**Impact:** CRITIQUE - Peut causer des corruptions de données en production.

---

### Scénario 3 : Reboot et recovery ✅

**Étapes:**
1. Cluster actif, CT210 leader
2. `pct reboot 210`
3. Monitoring VIP

**Résultats:**
- Failover en 9 secondes
- VIP migrée sur CT211
- CT210 réintègre après reboot (~25s total)
- CT210 reprend le leadership (priorité configurée)
- ✅ Une seule VIP à tout moment

---

### Scénario 4 : Perte de quorum ✅

**Étapes:**
1. Cluster 3/3 nœuds
2. `pct stop 211 && pct stop 212`
3. Vérification CT210 seul

**Résultats:**
- ✅ CT210 détecte la perte de quorum (1/3)
- ✅ CT210 retire la VIP
- ✅ CT210 affiche "PAS DE QUORUM"
- ✅ Après redémarrage CT211/212, quorum restauré (3/3)
- ✅ VIP réactivée

---

### Scénario 5 : STONITH réel ✅

**Étapes:**
1. Vérification `sfha stonith status`
2. Fence manuel CT212

**Résultats:**
- ✅ STONITH configuré (provider: proxmox)
- ✅ API Proxmox connectée
- ✅ Fence exécuté en 4191ms
- ✅ CT212 arrêté par Proxmox API
- ✅ Réintégration propre après redémarrage

---

### Scénario 6 : Réseau instable ✅

**Étapes:**
1. `tc qdisc add dev eth0 root netem delay 200ms loss 5%`
2. Monitoring 30 secondes
3. Retrait perturbation

**Résultats:**
- ✅ 6 checks sur 30 secondes
- ✅ Leader stable (sfha-node1)
- ✅ VIP stable sur CT210
- ✅ Aucun faux failover
- ✅ Cluster sain après retrait

---

## Bug Critique Identifié

### Split-brain non protégé (Scénario 2)

**Symptôme:** Un nœud isolé par firewall (iptables) garde la VIP et affiche un quorum erroné.

**Cause probable:** Le daemon calcule le quorum basé sur les derniers heartbeats reçus, sans vérifier activement que ses propres heartbeats sortants sont bien reçus par les pairs.

**Solution suggérée:**
1. Implémenter un "heartbeat acknowledgment" bidirectionnel
2. Ou: utiliser un timeout plus agressif pour marquer les pairs comme down si aucun heartbeat reçu
3. Ou: implémenter une vérification de connectivité sortante (ex: TCP health check vers les pairs)

**Impact:** Un nœud ne peut PAS savoir s'il est isolé uniquement en comptant les heartbeats entrants. Il doit aussi vérifier que ses messages sortants arrivent.

---

## Critères de succès

| Critère | Résultat |
|---------|----------|
| UN SEUL nœud a la VIP à tout moment | ❌ ÉCHEC (scénario 2) |
| Sans quorum → ZERO VIP active | ✅ OK (scénario 4) |
| Split-brain → nœud isolé perd la VIP | ❌ ÉCHEC |
| Temps de failover < 30s | ✅ OK (9-10s) |

---

## Verdict Final

```
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   RELEASE READY: ❌ NON                               ║
║                                                       ║
║   Bug critique: Split-brain non protégé               ║
║   Le nœud isolé garde la VIP → 2 VIPs simultanées    ║
║                                                       ║
║   Action requise: Corriger la détection d'isolation   ║
║   avant toute mise en production.                     ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
```

---

## Annexes

### Commandes de test utilisées

```bash
# Isolation split-brain
pct exec 210 -- iptables -A INPUT -s 192.168.1.0/24 -j DROP
pct exec 210 -- iptables -A OUTPUT -d 192.168.1.0/24 -j DROP

# Perturbation réseau
pct exec 210 -- tc qdisc add dev eth0 root netem delay 200ms loss 5%

# STONITH fence
pct exec 210 -- sfha stonith fence sfha-node3
```

### Configuration cluster

- CT210: sfha-node1 (priorité haute)
- CT211: sfha-node2
- CT212: sfha-node3
- VIP: 192.168.1.250/24
- STONITH: Proxmox API (root@pam!sfha)
