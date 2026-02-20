# Rapport de Stress Tests - sfha v1.0.0

**Date:** 2026-02-20  
**Version testée:** 1.0.0  
**Status:** ✅ Tous les bugs critiques corrigés

---

## Résumé

Stress tests exécutés sur un cluster de 3 nœuds (node1, node2, node3) avec :
- Arrêts/redémarrages forcés des nœuds
- Partitions réseau simulées
- Basculements rapides répétés
- Tests de split-brain

---

## Bugs Critiques Identifiés

### Bug #1 : VIP pas nettoyée au changement de leadership [CORRIGÉ]

**Symptôme:**  
Quand le leader change, l'ancien leader garde la VIP → 2 nœuds avec la même IP (IP dupliquée).

**Impact:** Critique - Split-brain au niveau réseau, paquets routés vers le mauvais nœud.

**Fix appliqué dans `src/daemon.ts`:**
- Dans `handleLeaderChange()`: Quand `wasLeader && !isLeader`, appel immédiat de `deactivateResources()` qui supprime les VIPs via `ip addr del`
- Log explicite : `"Perte du leadership - désactivation immédiate des ressources"`
- Pas de délai, pas de compteur - la VIP est supprimée instantanément

**Lignes de code:**
```typescript
if (wasLeader && !isLeader) {
  logger.warn('Perte du leadership - désactivation immédiate des ressources');
  this.pollsAsSecondary = 0;
  this.isLeader = false;
  this.deactivateResources();
  // ...
}
```

---

### Bug #2 : Leadership forcé sans vérification du quorum [CORRIGÉ]

**Symptôme:**  
Un nœud peut devenir leader même sans quorum → split-brain possible entre partitions.

**Impact:** Critique - Risque de divergence de données entre partitions isolées.

**Fix appliqué dans `src/daemon.ts`:**
- Nouvelle méthode `hasQuorum(): Promise<boolean>` pour vérification centralisée
- Dans `becomeLeader()`: Vérification du quorum AVANT toute prise de leadership
- Dans `handleLeaderChange()`: Vérification du quorum avant activation des ressources
- Dans `handlePoll()`: Si perte de quorum et leader → désactivation immédiate
- Dans `activateResources()`: Double vérification du quorum

**Lignes de code:**
```typescript
// Dans becomeLeader()
const quorum = getQuorumStatus();
if (!quorum.quorate) {
  logger.warn('Pas de quorum - impossible de devenir leader');
  return;
}

// Nouvelle méthode utilitaire
async hasQuorum(): Promise<boolean> {
  const quorum = getQuorumStatus();
  return quorum.quorate;
}
```

---

### Bug #3 : Followers activent la VIP [CORRIGÉ]

**Symptôme:**  
Des followers (pas leaders) activent quand même la VIP → plusieurs nœuds avec la même VIP.

**Impact:** Critique - Conflit d'adresses IP, instabilité réseau.

**Fix appliqué dans `src/daemon.ts`:**
- Dans `activateResources()`: Vérification `this.isLeader === true` au début
- Watchdog `ensureNoVipOnFollower()`: Appelé à chaque poll pour garantir qu'un follower n'a JAMAIS la VIP
- Si un follower détecte qu'il a la VIP, elle est immédiatement supprimée avec log d'erreur

**Lignes de code:**
```typescript
// Dans activateResources()
if (!this.isLeader) {
  logger.warn('Tentative d\'activation des ressources sans être leader - ignorée');
  return;
}

// Watchdog dans ensureNoVipOnFollower()
if (activeVips.length > 0) {
  logger.error('WATCHDOG: VIP active sur un follower ! Désactivation immédiate...');
  deactivateAllVips(this.config.vips, this.log);
}
```

---

## Tests de Validation

| Test | Résultat |
|------|----------|
| Arrêt brutal du leader | ✅ VIP migrée en <5s, ancienne VIP nettoyée |
| Partition réseau (split-brain) | ✅ Seule la partition quorate garde la VIP |
| Redémarrage rapide node1→node2→node1 | ✅ Pas de VIP dupliquée |
| Follower isolé | ✅ Ne prend pas la VIP sans quorum |
| 3 nœuds simultanés | ✅ Un seul leader, une seule VIP |

---

## Changements de Code

Fichiers modifiés :
- `src/daemon.ts` : Fixes des 3 bugs critiques

Méthodes ajoutées/modifiées :
- `hasQuorum(): Promise<boolean>` - Nouvelle méthode pour vérification centralisée
- `handleLeaderChange()` - Désactivation immédiate à la perte de leadership
- `becomeLeader()` - Vérification quorum + éligibilité avant prise de leadership
- `activateResources()` - Double vérification leader + quorum
- `ensureNoVipOnFollower()` - Watchdog pour garantir cohérence

---

## Recommandations

1. **Monitoring:** Ajouter des alertes sur les logs `WATCHDOG:` qui indiquent une incohérence
2. **Tests réguliers:** Exécuter les stress tests avant chaque release
3. **Documentation:** Les 3 bugs étaient des edge cases non couverts par les tests unitaires initiaux
