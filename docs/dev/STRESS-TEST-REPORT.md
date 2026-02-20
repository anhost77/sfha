# sfha Stress Test Report

**Date:** 2026-02-20
**Version:** sfha v1.0.0
**Testeur:** Claude (Agent IA)
**Environnement:** Proxmox 9.1.5, Containers LXC (CT210, CT211, CT212)

---

## Résumé Exécutif

| Scénario | Résultat | Gravité |
|----------|----------|---------|
| 1. Failover automatique | ⚠️ PARTIAL | Critique |
| 2. Split-brain simulation | ❌ FAIL | **CRITIQUE** |
| 3. Reboot et recovery | ⚠️ PARTIAL | Critique |
| 4. Perte de quorum | ❌ FAIL | **CRITIQUE** |
| 5. STONITH réel | ✅ PASS (avec limitations) | Moyen |
| 6. Réseau instable | ⚠️ PARTIAL | Majeur |

**Verdict global:** ❌ **NON PRÊT POUR PRODUCTION**

Plusieurs bugs critiques de sécurité ont été identifiés, notamment concernant la gestion de la VIP.

---

## Scénario 1 : Failover automatique

**Résultat:** ⚠️ PARTIAL

### Étapes
1. Cluster 3 nœuds configuré (CT210=leader, VIP active)
2. Tué brutalement CT210 avec `pct stop 210`
3. Mesuré le temps de failover
4. Vérifié la migration de la VIP

### Observations
- **Temps de failover:** ~9.5 secondes ✅
- La VIP a migré vers CT211 ✅
- **BUG CRITIQUE:** Après le failover, la VIP était sur **CT211 ET CT212** simultanément ❌

### Temps de failover
~9.5 secondes (acceptable)

### Bugs trouvés
1. **VIP dupliquée sur plusieurs nœuds après failover**
   - Gravité: CRITIQUE
   - Impact: Deux IPs identiques sur le réseau = conflits ARP, perte de connectivité
   - Reproduction: Systématique lors de chaque failover

---

## Scénario 2 : Split-brain simulation

**Résultat:** ❌ FAIL

### Étapes
1. Cluster 3 nœuds actif (CT210=leader avec VIP)
2. Isolé CT210 avec iptables (blocage trafic vers CT211/CT212)
3. Vérifié le comportement de chaque partition

### Observations
- **CRITIQUE:** Pendant l'isolation, **3 nœuds avaient la VIP simultanément**
- CT210 (isolé) : continuait de penser avoir 3/3 nœuds et gardait la VIP
- CT211 : détecté 2/3 nœuds, activé la VIP
- CT212 : activé aussi la VIP (alors qu'il reconnaît CT211 comme leader)
- STONITH a finalement fencé CT210 après ~2 minutes ✅

### Temps de failover
N/A (comportement anormal)

### Bugs trouvés
1. **Triple VIP pendant split-brain**
   - Gravité: CRITIQUE
   - Impact: Trois IPs identiques = réseau inutilisable

2. **Délai de détection trop long**
   - L'isolation n'est pas détectée par Corosync/sfha pendant plusieurs secondes
   - Le nœud isolé ne perd pas immédiatement le quorum

3. **Les followers activent la VIP sans être leaders**
   - CT212 a la VIP alors qu'il reconnaît CT211 comme leader
   - Bug de logique dans l'activation des ressources

---

## Scénario 3 : Reboot et recovery

**Résultat:** ⚠️ PARTIAL

### Étapes
1. Activé `systemctl enable sfha corosync` sur tous les nœuds
2. Rebooté CT210 (leader avec VIP)
3. Monitoré la migration de VIP et la réintégration

### Observations
- Reboot très rapide (~19 secondes pour recovery complète) ✅
- sfha redémarre automatiquement après le boot ✅
- CT210 réintègre le cluster Corosync ✅
- **BUG:** Après recovery, les 3 nœuds avaient la VIP ❌

### Temps de failover
~19 secondes (reboot complet + recovery)

### Bugs trouvés
1. **VIP non nettoyée lors des changements de leadership**
   - Les anciens leaders gardent la VIP
   - Même bug que scénario 1 et 2

---

## Scénario 4 : Perte de quorum

**Résultat:** ❌ FAIL

### Étapes
1. Cluster 3 nœuds actif
2. Arrêté CT211 et CT212 (`pct stop`)
3. Vérifié que CT210 détecte la perte de quorum
4. Vérifié que la VIP est désactivée

### Observations
- Perte de quorum détectée en ~6 secondes ✅
- VIP correctement supprimée ✅
- **BUG CRITIQUE:** Après 15 secondes, sfha réactive la VIP malgré l'absence de quorum ❌

### Logs révélateurs
```
17:02:54 ⚠️ PAS DE QUORUM
17:02:54 VIP 192.168.1.250 supprimée ✅
17:02:54 ⚠️ Aucune VIP active détectée (1/3)...
17:02:59 ⚠️ Aucune VIP active détectée (2/3)...
17:03:04 🚨 VIP absente depuis 3 polls - prise de leadership forcée
17:03:04 👑 Ce nœud devient leader (prise de relai)
17:03:10 VIP 192.168.1.250 ajoutée ❌
```

### Bugs trouvés
1. **VIP réactivée sans quorum**
   - Gravité: **CRITIQUE - BUG DE SÉCURITÉ**
   - La logique de "prise de leadership forcée" ne vérifie pas le quorum
   - Un nœud seul peut activer la VIP = violation du principe de quorum
   - Impact: Split-brain si les autres nœuds reviennent

---

## Scénario 5 : STONITH réel

**Résultat:** ✅ PASS (avec limitations)

### Étapes
1. STONITH configuré avec API Proxmox
2. Simulé isolation réseau (scénario 2)
3. Vérifié le fencing du nœud isolé

### Observations
- STONITH a correctement fencé CT210 après l'isolation réseau ✅
- Période de grâce respectée (premiers appels refusés) ✅
- Logs clairs et informatifs ✅
- L'erreur "CT 210 not running" après fence réussi est cosmétique ⚠️

### Logs STONITH
```
16:55:25 🔴 Nœud sfha-node1 offline depuis 3 polls
16:55:25 🚫 STONITH REFUSÉ: En période de grâce (23s restantes)
16:57:50 🔴 STONITH: FENCING sfha-node1 (lxc/210)...
16:57:50 🔴 STONITH: Arrêt forcé de sfha-node1
16:58:05 ❌ Erreur: CT 210 not running (déjà arrêté)
```

### Limitation trouvée
1. **Pas de détection des nœuds "zombie sfha"**
   - Si sfha crash mais que Corosync continue de tourner, le nœud n'est pas fencé
   - STONITH ne se déclenche que quand Corosync perd le nœud
   - Recommandation: Ajouter un healthcheck sfha indépendant de Corosync

---

## Scénario 6 : Réseau instable (packet loss)

**Résultat:** ⚠️ PARTIAL

### Étapes
1. Appliqué `tc qdisc add dev eth0 root netem delay 200ms loss 10%` sur CT210
2. Monitoré la stabilité du cluster pendant 60s
3. Vérifié l'absence de faux failovers

### Observations
- Aucun failover pendant le test (stable) ✅
- Le cluster a toléré la latence et la perte de paquets ✅
- **BUG:** Leader = sfha-node1 (CT210) mais VIP sur CT211 ❌

### Bugs trouvés
1. **Incohérence leader/VIP**
   - Le leader déclaré n'a pas la VIP
   - La VIP reste sur l'ancien leader après changement

---

## Bugs Récurrents Majeurs

### BUG #1 : VIP non nettoyée (CRITIQUE)
**Description:** Quand un nœud perd le leadership, il ne retire pas la VIP de son interface réseau.

**Impact:** 
- Plusieurs nœuds peuvent avoir la même IP
- Conflits ARP sur le réseau
- Perte de connectivité imprévisible

**Reproduction:** Systématique à chaque changement de leadership

**Correction suggérée:**
1. Au démarrage, chaque nœud doit d'abord retirer la VIP s'il l'a
2. Seul le leader confirmé peut activer la VIP
3. Ajouter un watchdog qui vérifie la cohérence VIP/leadership

### BUG #2 : Leadership forcé sans quorum (CRITIQUE)
**Description:** Un nœud sans quorum peut devenir leader et activer la VIP après 3 polls sans VIP détectée.

**Impact:**
- Violation du principe de quorum
- Split-brain garanti si les autres nœuds reviennent

**Correction suggérée:**
```typescript
// AVANT (buggy)
if (noVipDetectedCount >= 3) {
  forceLeadership();  // ❌ Ne vérifie pas le quorum
}

// APRÈS (correct)
if (noVipDetectedCount >= 3 && hasQuorum()) {
  forceLeadership();  // ✅ Quorum requis
}
```

### BUG #3 : Followers activent la VIP (CRITIQUE)
**Description:** Des nœuds qui ne sont pas leaders activent quand même la VIP.

**Impact:** VIP dupliquée sur plusieurs nœuds

**Correction suggérée:**
- Vérifier strictement le statut de leader avant toute activation de ressource
- Ajouter un mutex distribué pour la VIP

---

## Recommandations

### Corrections Prioritaires (avant release)
1. ❌ Fixer le bug de VIP non nettoyée
2. ❌ Empêcher l'activation de VIP sans quorum
3. ❌ Empêcher les followers d'activer la VIP

### Améliorations Recommandées
1. ⚠️ Ajouter un healthcheck sfha indépendant de Corosync
2. ⚠️ Implémenter un mécanisme de "VIP grab" avec vérification
3. ⚠️ Ajouter des logs plus détaillés sur les décisions de leadership

### Tests Additionnels Suggérés
1. Test de longue durée (24h) pour détecter les race conditions
2. Test avec plus de nœuds (5-7) pour les cas de quorum complexes
3. Test de performance sous charge

---

## Conclusion

sfha v1.0.0 présente des **bugs critiques de sécurité** qui empêchent son utilisation en production. Le problème principal est la gestion de la VIP qui n'est pas correctement synchronisée avec l'état du cluster.

**Points positifs:**
- Architecture globale correcte
- STONITH fonctionnel
- Temps de failover acceptables
- Bonne intégration Corosync/Proxmox

**Points bloquants:**
- VIP dupliquée sur plusieurs nœuds (split-brain)
- Activation de VIP sans quorum
- Incohérence leader/VIP

**Recommandation:** Corriger les bugs critiques avant tout déploiement, même en test.

---

*Rapport généré automatiquement par les tests de stress sfha*
