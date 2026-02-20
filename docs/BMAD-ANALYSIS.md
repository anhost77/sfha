# BMAD Analysis - sfha Setup Automation

**Date:** 2026-02-20  
**Rôle:** Architect  
**Objectif:** Analyser pourquoi le setup sfha ne fonctionne pas de bout en bout

---

## 1. État Actuel du Code

### Service Systemd (`debian/sfha.service`)
✅ **DÉJÀ CORRIGÉ** - Les restrictions namespace sont désactivées :
```ini
PrivateTmp=no
ProtectHome=no
...
RestrictNamespaces=no
```

### Génération Corosync (`src/mesh/corosync-mesh.ts`)
✅ **EXISTE** - Fonctions `updateCorosyncForMesh()`, `generateCorosyncConfig()`, `addNodeToCorosync()`

### Mesh Manager (`src/mesh/manager.ts`)
✅ **EXISTE** - `init()` et `join()` créent les configs WireGuard + Corosync

### VIP (`src/vip.ts`)
✅ **EXISTE** - Vérification après ajout avec throw si échec

---

## 2. Problèmes Réels Identifiés

### PROBLÈME A : .deb non rebuildé
**Symptôme:** Container LXC → erreur NAMESPACE  
**Cause:** Le .deb testé date d'avant le fix du service systemd  
**Fix:** Rebuilder le .deb avec `pnpm build && pnpm package`

### PROBLÈME B : Mesh unidirectionnel (CRITIQUE)
**Symptôme:** Node2 connaît Node1, mais Node1 ne connaît pas Node2  
**Analyse du code `join()`:**

```typescript
// manager.ts ligne 180
// Ce code configure le nouveau nœud avec tous les peers existants
const initiatorPeer: MeshPeer = { ... token info ... };
const allPeers: MeshPeer[] = [initiatorPeer];
if (token.peers) { allPeers.push(...token.peers); }
```

**Mais :** Quand Node2 rejoint, Node1 ne sait pas qu'il doit ajouter Node2 !

**Le flow actuel :**
1. Node1 `init` → génère token avec sa pubkey
2. Node2 `join` → configure WireGuard avec Node1 comme peer
3. ❌ Node1 n'a AUCUNE connaissance de Node2
4. Résultat : mesh unidirectionnel → Corosync ne peut pas communiquer

**Solution proposée :**
Le join doit envoyer ses infos au seeder pour que celui-ci l'ajoute automatiquement. Options :

A. **API de coordination** - Le seeder expose un endpoint pour enregistrer les nouveaux peers
B. **Token bidirectionnel** - Le join génère un "reply token" que l'admin copie manuellement sur le seeder
C. **Scripts post-join** - Documenter clairement que `add-peer` est requis des deux côtés

**Recommandation :** Option A (API coordination) pour une vraie automatisation.

### PROBLÈME C : Ordre de démarrage Corosync
**Symptôme:** Corosync ne forme pas de quorum même avec config correcte  
**Cause possible :** Les nœuds démarrent Corosync avant que le mesh WireGuard soit up  

**Le code actuel dans `join()`:**
```typescript
// Créer l'interface WireGuard
createInterface(WG_INTERFACE, meshIp, keys.privateKey, port);

// ... plus tard ...

// Démarrer Corosync automatiquement
execSync('systemctl start corosync', { stdio: 'pipe' });
```

**Problème :** Pas de vérification que le mesh est UP et que les peers sont connectés avant de démarrer Corosync.

### PROBLÈME D : VIP non activée
**Analyse du code `addVip()`:**

```typescript
// vip.ts
export function addVip(vip: VipConfig, log): boolean {
  log(t('vip.adding', { ip: vip.ip, iface: vip.interface }));

  const addCmd = `ip addr add ${vip.ip}/${vip.cidr} dev ${vip.interface}`;
  if (!runCommand(addCmd)) {
    log(`Erreur: échec de la commande '${addCmd}'`);
    return false;  // ← Return false mais pas de throw
  }

  // Vérification post-ajout
  if (!hasVip(vip)) {
    const errorMsg = `Erreur: VIP ${vip.ip} n'est pas présente...`;
    log(errorMsg);
    throw new Error(errorMsg);
  }
  ...
}
```

**Problème :** La fonction peut retourner `false` sans throw. L'appelant (`activateAllVips`) ne vérifie pas le retour :

```typescript
export function activateAllVips(vips: VipConfig[], log?): boolean {
  let success = true;
  for (const vip of vips) {
    if (!addVip(vip, log)) {
      success = false;  // ← On note l'échec mais on continue
    }
  }
  return success;  // ← L'appelant dans daemon.ts ne check pas ce retour !
}
```

**Et dans daemon.ts :**
```typescript
private activateResources(): void {
  logger.info('Activation des ressources...');
  activateAllVips(this.config.vips, this.log);  // ← Retour ignoré !
  this.resourceManager?.startAll();
  logger.info('Ressources activées');  // ← Toujours affiché même si VIP fail
}
```

**Fix :** Vérifier le retour et logger correctement l'échec.

---

## 3. Solution Architecture

### Phase 1 : Fixes immédiats (Quick Wins)

1. **Rebuilder le .deb** avec le service systemd corrigé
2. **Vérifier retour `activateAllVips`** dans daemon.ts
3. **Logger l'erreur exacte** de `ip addr add` (stderr)

### Phase 2 : Coordination Mesh Automatique

**Nouveau composant : Coordination Server**

Quand un nœud fait `join`, il doit pouvoir notifier le seeder de son existence.

```
┌──────────┐   join request    ┌──────────┐
│  Node2   │ ───────────────→  │  Node1   │
│ (joiner) │                   │ (seeder) │
└──────────┘                   └──────────┘
     │                              │
     │  1. Parse token              │
     │  2. Configure WG local       │
     │  3. Connect to seeder mesh   │
     │  4. Send registration ───────┤
     │                              │
     │                    5. Add peer to WG
     │                    6. Update Corosync
     │                    7. Broadcast to other nodes
     │                              │
     │  8. ACK ←────────────────────┤
     │                              │
     ▼                              ▼
   Ready                         Ready
```

**Implémentation :**
- Utiliser le tunnel WireGuard comme canal de communication
- Un simple serveur TCP/UDP sur le mesh pour les enregistrements
- Message format : `{ action: "register", name, pubkey, endpoint, meshIp }`

### Phase 3 : Validation Startup

Avant de démarrer le daemon sfha :
1. Vérifier que WireGuard interface est UP
2. Vérifier que les peers sont connectés (handshake récent)
3. Vérifier que Corosync a le quorum
4. Seulement alors activer les VIPs

---

## 4. Stories

### Story 1 : Rebuild .deb et test basique
**Priority:** P0  
**Effort:** 15 min  
- Rebuilder le .deb
- Installer sur container LXC frais
- Vérifier que sfha démarre sans erreur NAMESPACE

### Story 2 : Fix logging VIP
**Priority:** P0  
**Effort:** 30 min  
- Capturer stderr de `ip addr add`
- Vérifier retour de `activateAllVips` dans daemon
- Logger explicitement succès/échec

### Story 3 : Coordination mesh automatique
**Priority:** P1  
**Effort:** 4h  
- Créer serveur de coordination sur le seeder (port mesh)
- Modifier `join` pour envoyer registration
- Modifier seeder pour auto-ajouter les peers
- Broadcast aux autres nœuds

### Story 4 : Validation pre-startup
**Priority:** P1  
**Effort:** 2h  
- Vérifier WG interface UP avant Corosync
- Attendre handshake avec au moins 1 peer
- Timeout avec message d'erreur clair

### Story 5 : Test intégration E2E
**Priority:** P0  
**Effort:** 1h  
- 3 containers LXC fresh
- `apt install ./sfha.deb` sur les 3
- `sfha init` + `sfha join` x2
- Vérifier quorum et VIP
- Test failover

---

## 5. Critères d'Acceptation

| Test | Expected |
|------|----------|
| Install .deb on LXC | No NAMESPACE error |
| `sfha init --mesh` | WireGuard UP + Corosync config generated |
| `sfha join <token>` | WireGuard UP + Connected to seeder + Corosync config |
| 3 nodes cluster | Quorum = Yes, 3/3 nodes |
| VIP activation | Leader has VIP (verified with `ip addr`) |
| Leader failover | VIP migrates in <10s, no duplicate |
| Logs | `sfha logs -f` shows daemon activity |

---

## 6. Décision

**Approche recommandée :**
1. D'abord les quick wins (Stories 1, 2) → valider que le code existant marche
2. Puis Story 5 (test E2E) → identifier les vrais blocages restants
3. Enfin Story 3 (coordination) si vraiment nécessaire

Le code semble plus complet que prévu. Le problème principal est probablement le .deb non rebuildé et le mesh unidirectionnel.
