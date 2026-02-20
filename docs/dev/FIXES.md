# Corrections de bugs critiques - sfha v1.0.0

**Date:** 2026-02-20  
**Rapport de bugs:** [STRESS-TEST-REPORT.md](./STRESS-TEST-REPORT.md)

---

## Résumé

Trois bugs critiques ont été identifiés lors des stress tests et corrigés :

| Bug | Gravité | Status |
|-----|---------|--------|
| #1 VIP non nettoyée lors des changements de leadership | CRITIQUE | ✅ Corrigé |
| #2 Leadership forcé sans vérification du quorum | CRITIQUE | ✅ Corrigé |
| #3 Les followers activent la VIP | CRITIQUE | ✅ Corrigé |

---

## BUG #1 : VIP non nettoyée lors des changements de leadership

### Symptôme
Plusieurs nœuds avaient la même VIP simultanément après un changement de leadership.

### Cause racine
Dans `handleLeaderChange()`, il y avait un `return` précoce qui empêchait la désactivation des VIPs quand un nœud perdait le leadership :

```typescript
// AVANT (buggy)
if (weHaveVip) {
  this.pollsAsSecondary = (this.pollsAsSecondary || 0) + 1;
  if (this.pollsAsSecondary >= 6) {
    // Continue pour céder
  } else {
    return;  // ❌ Ne désactive JAMAIS la VIP !
  }
}
```

### Correction
La VIP est maintenant désactivée **immédiatement** quand un nœud perd le leadership :

```typescript
// APRÈS (corrigé)
if (wasLeader && !isLeader) {
  this.log('⚠️ Perte du leadership - désactivation immédiate des ressources');
  this.pollsAsSecondary = 0;
  this.isLeader = false;
  this.deactivateResources();  // ✅ Désactivation IMMÉDIATE
  this.emit('leaderChange', false, leaderName);
  return;
}
```

### Fichiers modifiés
- `src/daemon.ts` : `handleLeaderChange()`

---

## BUG #2 : Leadership forcé sans vérification du quorum

### Symptôme
Un nœud seul (sans quorum) pouvait devenir leader et activer la VIP après 3 polls sans VIP détectée.

### Cause racine
La méthode `becomeLeader()` ne vérifiait pas le quorum avant d'activer les ressources :

```typescript
// AVANT (buggy)
private becomeLeader(): void {
  if (this.isLeader || this.standby) return;
  this.log('👑 Ce nœud devient leader');
  this.isLeader = true;
  this.activateResources();  // ❌ Pas de vérification du quorum !
}
```

### Correction
Plusieurs vérifications du quorum ont été ajoutées :

1. **Dans `becomeLeader()`** - vérification avant de devenir leader :
```typescript
private becomeLeader(): void {
  if (this.isLeader || this.standby) return;
  
  // Vérifier le quorum AVANT de devenir leader
  const quorum = getQuorumStatus();
  if (!quorum.quorate) {
    this.log('⚠️ Pas de quorum - impossible de devenir leader');
    return;
  }
  // ...
}
```

2. **Dans `handlePoll()`** - désactivation si perte de quorum :
```typescript
if (!state.quorum.quorate && this.config?.cluster.quorumRequired) {
  if (this.isLeader) {
    this.log('⚠️ Perte de quorum détectée - désactivation des ressources');
    this.isLeader = false;
    this.deactivateResources();
  }
  return;
}
```

3. **Dans `activateResources()`** - double vérification :
```typescript
private activateResources(): void {
  const quorum = getQuorumStatus();
  if (!quorum.quorate && this.config.cluster.quorumRequired) {
    this.log('⚠️ Tentative d\'activation sans quorum - ignorée');
    this.isLeader = false;
    return;
  }
  // ...
}
```

### Fichiers modifiés
- `src/daemon.ts` : `becomeLeader()`, `handlePoll()`, `activateResources()`
- `src/election.ts` : ajout du champ `quorate` dans `ElectionResult`

---

## BUG #3 : Les followers activent la VIP

### Symptôme
Des nœuds qui n'étaient pas leaders avaient quand même la VIP active.

### Cause racine
1. La méthode `becomeLeader()` ne vérifiait pas que le nœud était éligible au leadership selon l'élection
2. Pas de watchdog pour détecter et corriger les états incohérents

### Correction

1. **Vérification de l'éligibilité dans `becomeLeader()`** :
```typescript
// Vérifier que ce nœud DEVRAIT être leader selon l'élection
const election = electLeader();
if (!election?.isLocalLeader) {
  this.log(`⚠️ Ce nœud n'est pas éligible au leadership`);
  return;
}
```

2. **Ajout d'un watchdog dans `handlePoll()`** :
```typescript
// Si on n'est pas leader, on ne doit JAMAIS avoir la VIP
if (!this.isLeader && this.config) {
  this.ensureNoVipOnFollower();
}
```

3. **Méthode `ensureNoVipOnFollower()`** (nouveau) :
```typescript
private ensureNoVipOnFollower(): void {
  if (this.isLeader || !this.config) return;
  
  const vipStates = getVipsState(this.config.vips);
  const activeVips = vipStates.filter(v => v.active);
  
  if (activeVips.length > 0) {
    this.log('🚨 WATCHDOG: VIP active sur un follower ! Désactivation...');
    deactivateAllVips(this.config.vips, this.log);
  }
}
```

4. **Garde dans `activateResources()`** :
```typescript
if (!this.isLeader) {
  this.log('⚠️ Tentative d\'activation sans être leader - ignorée');
  return;
}
```

### Fichiers modifiés
- `src/daemon.ts` : `becomeLeader()`, `handlePoll()`, `activateResources()`, nouvelle méthode `ensureNoVipOnFollower()`

---

## Tests de validation

Tous les scénarios suivants ont été testés avec succès après les corrections :

| Scénario | Résultat |
|----------|----------|
| État initial (3 nœuds, 1 leader) | ✅ Un seul nœud a la VIP |
| Perte de quorum (2 nœuds down) | ✅ VIP supprimée |
| Recovery après quorum restauré | ✅ VIP restaurée sur le leader |
| Failover (crash du leader) | ✅ VIP migrée, pas de duplication |
| Retour de l'ancien leader | ✅ VIP migrée proprement |

### Critères de succès atteints
- ✅ Un seul nœud a la VIP à tout moment
- ✅ Sans quorum, aucun nœud n'a la VIP
- ✅ Le split-brain ne cause pas de VIP dupliquée

---

## Recommandations pour la suite

1. **Monitoring** : Ajouter une alerte si plus d'un nœud a la VIP (anomalie)
2. **Tests de charge** : Tester le cluster sous charge pendant 24h
3. **Documentation** : Mettre à jour le README avec les nouvelles garanties

---

*Document généré le 2026-02-20*
