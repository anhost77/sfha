# SFHA Bugfix Sprint - BMAD

**Date:** 2026-02-20  
**Status:** 🔴 Bloquant release  
**Objectif:** Corriger tous les bugs pour que `sfha init/join` fonctionne de bout en bout sans intervention manuelle

---

## Contexte

Le package sfha devait permettre :
```bash
# Node 1
apt install ./sfha.deb
sfha init --name prod --mesh --ip 10.200.0.1/24 --endpoint 1.2.3.4
# → Génère token

# Node 2+
apt install ./sfha.deb  
sfha join <token> --endpoint 5.6.7.8
# → Rejoint le cluster automatiquement

systemctl start sfha
# → Cluster HA opérationnel
```

**Réalité :** Nombreuses étapes manuelles nécessaires, bugs critiques.

---

## Bugs à corriger

### BUG-1: Service systemd incompatible LXC (CRITIQUE)

**Symptôme:** `status=226/NAMESPACE` au démarrage dans containers LXC non-privilégiés

**Cause:** Le service systemd a des restrictions namespace (`PrivateTmp=true`, etc.)

**Fichier:** `package/sfha.service`

**Fix:**
```ini
[Service]
# Désactiver les restrictions pour compatibilité LXC
PrivateTmp=no
ProtectHome=no
ProtectSystem=no
PrivateDevices=no
ProtectHostname=no
ProtectClock=no
ProtectKernelTunables=no
ProtectKernelModules=no
ProtectKernelLogs=no
ProtectControlGroups=no
RestrictNamespaces=no
```

---

### BUG-2: Mesh incomplet entre peers (CRITIQUE)

**Symptôme:** Les nœuds qui `join` ne se voient pas entre eux (seulement vers le seeder)

**Cause:** `sfha join` configure uniquement le peer vers le seeder, pas les autres

**Fichier:** `src/commands/join.ts`

**Fix:** 
1. Le seeder doit broadcaster les nouveaux peers à tous les membres existants
2. OU le token doit contenir la liste de tous les peers existants
3. OU après join, le nouveau nœud doit récupérer la liste complète des peers

**Solution recommandée:** Option 3 - Après join réussi, récupérer la config mesh complète du seeder via le tunnel WireGuard et ajouter tous les peers manquants.

---

### BUG-3: Config Corosync pas générée (CRITIQUE)

**Symptôme:** Après `sfha init --mesh`, pas de `/etc/corosync/corosync.conf`

**Cause:** `sfha init` crée le mesh WireGuard mais pas la config Corosync

**Fichiers:** `src/commands/init.ts`, `src/commands/join.ts`

**Fix:**
1. `sfha init --mesh` doit générer `/etc/corosync/corosync.conf` avec le premier nœud
2. `sfha join` doit mettre à jour la config Corosync avec tous les nœuds
3. Générer l'authkey sur init et le distribuer via le token (chiffré)

**Template Corosync à générer:**
```
totem {
  version: 2
  cluster_name: <cluster_name>
  transport: knet
  crypto_cipher: aes256
  crypto_hash: sha256
}

nodelist {
  node {
    ring0_addr: <mesh_ip_1>
    name: <node_name_1>
    nodeid: 1
  }
  # ... autres nœuds
}

quorum {
  provider: corosync_votequorum
}

logging {
  to_syslog: yes
}
```

---

### BUG-4: VIP pas activée (CRITIQUE)

**Symptôme:** Logs disent "Ajout de la VIP" mais `ip addr show` ne montre rien

**Cause:** La commande `ip addr add` échoue silencieusement (pas de vérification du code retour)

**Fichier:** `src/vip.ts`

**Fix:**
```typescript
// Avant
execSync(`ip addr add ${ip} dev ${iface}`);
log(`Ajout de la VIP ${ip} sur ${iface}`);

// Après
const result = execSync(`ip addr add ${ip} dev ${iface} 2>&1`, { encoding: 'utf-8' });
// Vérifier avec ip addr show
const check = execSync(`ip addr show ${iface} | grep '${ip.split('/')[0]}'`, { encoding: 'utf-8' });
if (!check.includes(ip.split('/')[0])) {
  throw new Error(`Échec ajout VIP ${ip} sur ${iface}`);
}
log(`VIP ${ip} activée sur ${iface}`);
```

---

### BUG-5: Affichage VIP double /24 (MINEUR)

**Symptôme:** Status affiche `192.168.1.200/24/24`

**Cause:** Concaténation incorrecte du masque

**Fichier:** `src/commands/status.ts` ou `src/vip.ts`

**Fix:** Vérifier qu'on n'ajoute pas `/24` si déjà présent dans l'IP

---

## Stories de correction

### Story 1: Fix service systemd (BUG-1)
- [ ] Modifier `package/sfha.service` pour retirer les restrictions namespace
- [ ] Rebuild le .deb
- [ ] Tester sur container LXC non-privilégié

### Story 2: Fix génération Corosync (BUG-3)
- [ ] Créer `src/corosync.ts` avec fonctions de génération config
- [ ] Modifier `init.ts` : générer config + authkey après mesh init
- [ ] Modifier `join.ts` : mettre à jour config Corosync après join
- [ ] Inclure authkey chiffré dans le token
- [ ] Tester init + join avec vérification auto de Corosync

### Story 3: Fix mesh complet (BUG-2)
- [ ] Après `sfha join`, récupérer la liste des peers du seeder
- [ ] Ajouter automatiquement les peers manquants
- [ ] Mettre à jour la config Corosync avec tous les nœuds
- [ ] Tester avec 3 nœuds : tous doivent se voir

### Story 4: Fix activation VIP (BUG-4 + BUG-5)
- [ ] Ajouter vérification après `ip addr add`
- [ ] Logger l'erreur si échec
- [ ] Corriger l'affichage double /24
- [ ] Tester activation/désactivation VIP

### Story 5: Test intégration complet
- [ ] Fresh install sur 3 containers LXC
- [ ] `sfha init` + `sfha join` x2
- [ ] `systemctl start sfha` sur les 3
- [ ] Vérifier : quorum, VIP, failover
- [ ] Documenter le résultat

---

## Critères d'acceptation

1. ✅ `apt install ./sfha.deb` fonctionne sur Debian 12 LXC non-privilégié
2. ✅ `sfha init --mesh` génère WireGuard + Corosync config + authkey
3. ✅ `sfha join <token>` configure tout automatiquement (mesh complet + corosync)
4. ✅ `systemctl start sfha` démarre sans erreur
5. ✅ Cluster de 3 nœuds forme un quorum
6. ✅ VIP s'active sur le leader
7. ✅ Failover fonctionne (VIP migre en <10s)
8. ✅ Pas de VIP dupliquée après failover

---

## Priorité

1. BUG-1 (systemd) - Bloque tout test
2. BUG-3 (Corosync) - Bloque formation cluster
3. BUG-2 (mesh) - Bloque communication
4. BUG-4 (VIP) - Bloque fonctionnalité HA
5. BUG-5 (affichage) - Cosmétique
