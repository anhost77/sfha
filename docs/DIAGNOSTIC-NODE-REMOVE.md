# 🩺 Diagnostic Dr. Quinn : Séparation Corosync / sfha

**Date :** 25 février 2026  
**Problème :** Retrait de nœud casse le cluster, restarts Corosync inutiles

---

## 📊 Architecture — Qui fait quoi ?

```
┌─────────────────────────────────────────────────────────────────┐
│                        ARCHITECTURE SFHA                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌───────────────┐     ┌───────────────┐     ┌─────────────┐  │
│   │   COROSYNC    │     │  SFHA DAEMON  │     │  WIREGUARD  │  │
│   │               │     │               │     │   (mesh)    │  │
│   │ • Membership  │     │ • VIPs        │     │             │  │
│   │ • Quorum      │     │ • Services    │     │ • Tunnel    │  │
│   │ • Qui est là? │     │ • Élection    │     │ • Crypto    │  │
│   │               │     │ • STONITH     │     │             │  │
│   └───────┬───────┘     └───────┬───────┘     └──────┬──────┘  │
│           │                     │                    │         │
│           │    ┌────────────────┼────────────────────┘         │
│           │    │                │                              │
│           ▼    ▼                ▼                              │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │                    P2P API (port 7777)                   │ │
│   │           Communication inter-daemons sfha               │ │
│   └──────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🎯 Règle d'Or : Quand toucher quoi ?

### ✅ Opérations qui nécessitent de toucher Corosync

| Opération | Action sur Corosync |
|-----------|---------------------|
| `sfha init` (bootstrap cluster) | `systemctl start corosync` |
| `sfha join` (nouveau nœud rejoint) | Modifier `corosync.conf` + `corosync-cfgtool -R` |
| `sfha node remove` | Modifier `corosync.conf` + `corosync-cfgtool -R` |
| `sfha leave` | Modifier `corosync.conf` + `systemctl stop corosync` |
| `sfha propagate` (sync config) | Si Corosync pas démarré: `systemctl start corosync`<br>Si déjà actif: `corosync-cfgtool -R` |

### ❌ Opérations qui ne touchent PAS Corosync

| Opération | Pourquoi pas Corosync ? |
|-----------|-------------------------|
| `sfha vip add/remove` | VIPs gérées par sfha, pas Corosync |
| `sfha service add/remove` | Services gérés par sfha |
| `sfha standby/unstandby` | État publié dans CMAP, pas de reconfiguration |
| Failover automatique | Élection sfha, Corosync juste fournit le quorum |
| Health checks | Gérés par sfha |

### ⚠️ JAMAIS restart Corosync pendant le fonctionnement !

```bash
# ❌ MAUVAIS - provoque split-brain et perte de quorum
systemctl restart corosync

# ✅ BON - hot-reload de la config
corosync-cfgtool -R
```

---

## 🔴 Problème 1 : `sfha node remove` casse le cluster

### Symptômes observés
1. Leader perd sa connexion P2P aux autres nœuds
2. Corosync ne se met pas à jour automatiquement
3. Nécessite: restart Corosync + restart sfha + sfha propagate

### Cause racine

L'ordre actuel des opérations est **incorrect** :

```
ORDRE ACTUEL (BUGUÉ):
1. Envoie leave au nœud cible (/leave)        ← OK
2. Supprime le peer WireGuard LOCAL          ← ⚠️ PROBLÈME!
3. Supprime de Corosync LOCAL                 ← OK
4. Propage aux autres nœuds (/remove-peer)    ← ❌ ÉCHOUE car WG cassé!
```

**Explication :** À l'étape 2, on supprime le peer WireGuard **AVANT** de propager. Or, si le nœud initiateur communiquait avec les autres nœuds **via** ce peer (route mesh), les connexions P2P sont coupées !

### Solution : Inverser les étapes 2 et 4

```
ORDRE CORRIGÉ:
1. Envoie leave au nœud cible (/leave)        ← Le nœud se prépare à partir
2. PROPAGER aux autres nœuds (/remove-peer)   ← Tous mettent à jour WG + Corosync
3. Attendre les confirmations                  ← S'assurer que c'est propagé
4. Supprimer le peer WireGuard LOCAL          ← Maintenant c'est safe
5. Supprimer de Corosync LOCAL                 ← Finir le ménage local
```

---

## 🟡 Problème 2 : `sfha vip add` a nécessité restart Corosync

### Analyse

L'ajout d'une VIP **ne devrait JAMAIS** toucher Corosync. Les VIPs sont gérées à 100% par sfha daemon :

```
sfha vip add → 
  1. Écrit dans /etc/sfha/config.yml
  2. Reload sfha daemon (socket)
  3. Propage aux peers via P2P /vip-sync
  4. Si leader: active la VIP sur l'interface
```

### Hypothèses du bug

1. **Timing race :** Si le cluster n'était pas stable (propagation incomplète), le reload sfha a peut-être échoué silencieusement
2. **P2P déconnecté :** Si les connexions P2P étaient cassées (voir Problème 1), la propagation a échoué
3. **Corosync en état incohérent :** Si Corosync avait une config différente des peers, restart l'a "réinitialisé"

### Vérification recommandée

Avant un `vip add`, vérifier l'état du cluster :
```bash
# Vérifier que P2P fonctionne entre tous les nœuds
sfha status --json | jq '.nodes[] | {name, online, sfhaRunning}'

# Vérifier que Corosync voit les mêmes nœuds
corosync-quorumtool -l
```

---

## 📋 Flow Corrigé : `sfha node remove <hostname>`

```
┌──────────────────────────────────────────────────────────────────┐
│                    sfha node remove <target>                     │
│                    (exécuté sur n'importe quel nœud)             │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │ 1. VALIDATION                               │
        │    • Target ≠ self (utiliser 'sfha leave')  │
        │    • Target existe dans Corosync            │
        │    • Vérifier quorum post-suppression       │
        │    • Vérifier que target est offline/standby│
        └─────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │ 2. NOTIFIER LE NŒUD CIBLE (best effort)     │
        │    POST /leave à target (via IP mesh)       │
        │    → Target: stop sfha, stop corosync       │
        │    → Target: supprime sa propre config      │
        └─────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │ 3. PROPAGER AUX AUTRES NŒUDS (AVANT local!) │
        │    Pour chaque peer ≠ target:               │
        │    POST /remove-peer {peerName, peerMeshIp} │
        │    → Peer: supprime de WireGuard            │
        │    → Peer: supprime de corosync.conf        │
        │    → Peer: corosync-cfgtool -R              │
        └─────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │ 4. ATTENDRE LES CONFIRMATIONS               │
        │    • Timeout: 10s par peer                  │
        │    • Si échec partiel: warning (pas erreur) │
        └─────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │ 5. SUPPRIMER LOCALEMENT (en dernier!)       │
        │    • mesh.removePeerByName(target)          │
        │    • removeNodeFromCorosync(target)         │
        │    • corosync-cfgtool -R                    │
        └─────────────────────────────────────────────┘
                              │
                              ▼
                         ✅ SUCCÈS
```

---

## 🔧 Code à Modifier

### Fichier : `src/cli.ts` — fonction `nodeRemoveCommand`

```typescript
// AVANT (bugué) - lignes ~940-970
// 4. Supprimer le peer de la config locale WireGuard
const removeResult = mesh.removePeerByName(targetHostname);
// ...
// 5. Supprimer de Corosync local
removeNodeFromCorosync(targetHostname);
// ...
// 6. Propager la suppression aux autres nœuds
const propagateResult = await sendRemovePeerToAllNodes(...);

// APRÈS (corrigé)
// 4. PROPAGER D'ABORD aux autres nœuds (avant de supprimer local!)
console.log(colorize('→', 'blue'), 'Propagation aux autres nœuds...');
const propagateResult = await sendRemovePeerToAllNodes(
  targetHostname, 
  targetIp, 
  meshConfig!.authKey
);
if (propagateResult.success) {
  console.log(colorize('✓', 'green'), 
    `Propagé à ${propagateResult.succeeded}/${propagateResult.total} nœuds`);
} else if (propagateResult.total > 0) {
  console.log(colorize('⚠', 'yellow'), 
    `Propagation partielle: ${propagateResult.succeeded}/${propagateResult.total}`);
}

// 5. ENSUITE supprimer le peer WireGuard local
console.log(colorize('→', 'blue'), 'Suppression du peer WireGuard local...');
const removeResult = mesh.removePeerByName(targetHostname);
// ...

// 6. ENFIN supprimer de Corosync local
console.log(colorize('→', 'blue'), 'Suppression du nœud de Corosync local...');
removeNodeFromCorosync(targetHostname);
execSync('corosync-cfgtool -R 2>/dev/null || true', { stdio: 'pipe' });
```

---

## 📊 Récapitulatif : Quand reload/restart ?

| Composant | Quand RELOAD | Quand RESTART | JAMAIS |
|-----------|--------------|---------------|--------|
| **Corosync** | Ajout/retrait nœud (`cfgtool -R`) | Bootstrap initial | Pendant fonctionnement cluster |
| **sfha daemon** | Changement config VIP/service | Mise à jour binaire | — |
| **WireGuard** | Ajout/retrait peer (`wg set`) | — | — |

---

## ✅ Checklist Anti-Régression

Avant de valider un fix `node remove` :

- [ ] Test 1 : Retrait d'un nœud offline → les autres restent connectés en P2P
- [ ] Test 2 : Retrait d'un nœud online (avec --force) → le nœud reçoit /leave
- [ ] Test 3 : `sfha status` sur chaque nœud → tous voient la même liste
- [ ] Test 4 : Corosync membership cohérent (`corosync-quorumtool -l`)
- [ ] Test 5 : VIP reste active si leader non touché
- [ ] Test 6 : Failover fonctionne après le retrait

---

## 🎯 Actions Recommandées

1. **Immédiat :** Inverser l'ordre des opérations dans `nodeRemoveCommand`
2. **Court terme :** Ajouter des logs de diagnostic avant/après chaque étape
3. **Moyen terme :** Implémenter un "dry-run" pour prévisualiser les changements
4. **Long terme :** Tests automatisés avec 3+ nœuds

---

*Dr. Quinn — "Un bon diagnostic vaut mieux que dix traitements"* 🩺
