# Test Report - sfha v1.0.0

**Date:** 2026-02-20  
**Environment:** Proxmox LXC containers (CT210, CT211, CT212)  
**OS:** Debian 12  
**Corosync:** 3.1.7  
**Node.js:** 18.20.4 / 20.20.0  

---

## Environment Setup

### Containers
| CT ID | Hostname | IP | NodeID | Role |
|-------|----------|-----|--------|------|
| 210 | sfha-node1 | 192.168.1.210 | 1 | Leader (nodeId le plus petit) |
| 211 | sfha-node2 | 192.168.1.211 | 2 | Standby |
| 212 | sfha-node3 | 192.168.1.212 | 3 | Standby |

### Corosync Cluster
- Transport: UDPU (unicast)
- Quorum provider: votequorum
- 3 nodes configured
- ✅ All nodes joined successfully

### VIP Testée
- IP: 192.168.1.250/24
- Interface: eth0

---

## Tests effectués

### Test 1: Installation .deb ✅
```bash
dpkg -i sfha_1.0.0_amd64.deb
```
- Installation propre sur les 3 containers
- Message d'aide affiché post-installation
- Service systemd créé

### Test 2: Configuration Validation ✅
```bash
sfha config-check
```
- Configuration YAML parsée correctement
- Validation des VIPs, services et contraintes

### Test 3: Cluster Status ✅
```bash
sfha status
```
- 3 nœuds détectés comme online
- Quorum OK (3/3)
- Node1 élu comme leader (plus petit nodeId)
- Affichage formaté avec couleurs

### Test 4: VIP Activation ✅
- VIP 192.168.1.250/24 ajoutée sur eth0 du leader
- Gratuitous ARP envoyé (-U et -A)
- VIP visible via `ip addr show`

### Test 5: Health Checks ✅
- Health check TCP sur nginx:80
- Hysteresis fonctionne (3 échecs avant unhealthy, 2 succès avant healthy)
- Logs clairs

### Test 6: Socket de contrôle ✅
- Socket Unix `/var/run/sfha.sock` créé
- CLI communique avec daemon via socket
- Commandes: status, health, resources, standby, unstandby, failover, reload

### Test 7: Failover manuel ✅
```bash
sfha failover
```
**Timeline:**
- T+0s: Failover initié sur Node1
- T+0s: Node1 désactive VIP et services
- T+0s: Node1 passe en standby
- T+15s: Node2 détecte absence VIP (3 polls)
- T+21s: Node2 prend le leadership
- T+21s: VIP active sur Node2

**Résultat:** Failover fonctionne correctement ✅

### Test 8: Retour leader (unstandby) ✅
```bash
sfha unstandby
```
- Node1 sort du standby
- Node1 devient leader (plus petit nodeId)
- VIP retourne sur Node1

### Test 9: Standby/Unstandby ✅
```bash
sfha standby
sfha unstandby
```
- Standby libère les ressources
- Unstandby re-évalue l'élection

### Test 10: Status JSON ✅
```bash
sfha status --json
```
- Sortie JSON valide
- Toutes les infos présentes

### Test 11: Reload config ✅
```bash
sfha reload
# ou
kill -HUP $(pidof sfha)
```
- Configuration rechargée sans interruption

---

## Métriques de performance

| Métrique | Valeur |
|----------|--------|
| Temps de détection VIP absente | ~15s (3 × 5s polls) |
| Temps d'activation VIP | ~6s (avec ARP) |
| Temps total failover | ~21s |
| Taille paquet .deb | 56 KB |
| Taille bundle JS | 184 KB |
| Mémoire utilisée | ~25 MB |

---

## Bugs trouvés et corrigés

### Bug 1: Socket ne répond pas
**Problème:** Le socket attendait 'end' event avant de répondre.
**Solution:** Réponse immédiate après parsing JSON.

### Bug 2: Failover boucle infinie
**Problème:** `becomeLeader()` appelait `forceElection()` qui re-élisait Node1.
**Solution:** Ne pas appeler forceElection dans becomeLeader.

### Bug 3: Split-brain potentiel
**Problème:** Quand l'ancien leader revient, il reprend le leadership mais l'autre nœud garde la VIP.
**Solution:** Grace period de 6 polls (30s) avant de céder le leadership si VIP active.

---

## Limitations connues

1. **État standby non partagé** - Les autres nœuds ne savent pas qu'un nœud est en standby
2. **Pas de fencing** - Pas de STONITH intégré
3. **Split-brain edge case** - Si un nœud revient très vite après un failover, il peut y avoir un bref moment avec 2 VIPs

---

## Conclusion

sfha v1.0.0 est **prêt pour production** pour les cas d'usage simples :
- ✅ VIP failover fonctionne
- ✅ Health checks fonctionnent
- ✅ Services systemd gérés
- ✅ CLI complète
- ✅ Socket de contrôle
- ✅ Paquet .deb fonctionnel
- ✅ Documentation complète

**Recommandations:**
- Tester sur un environnement de staging avant production
- Configurer le monitoring (journalctl -u sfha -f)
- Ajuster poll_interval_ms selon les besoins (défaut: 5s)
