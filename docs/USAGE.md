# Guide d'utilisation sfha

## Gestion des VIPs

### Ajouter une VIP

```bash
# Méthode recommandée (v1.0.70+)
sudo sfha vip add api 192.168.1.201/24 eth0
```

C'est tout ! La VIP est :
- ✅ Ajoutée à la config
- ✅ Activée sur le leader (reload automatique)
- ✅ Propagée automatiquement à tous les nœuds

### Lister les VIPs

```bash
sfha vip list

# Sortie :
# VIPs configurées:
#   • web: 192.168.1.200/24 sur eth0
#   • api: 192.168.1.201/24 sur eth0
```

### Supprimer une VIP

```bash
sudo sfha vip remove api
```

La VIP sera désactivée sur le leader et retirée de tous les nœuds.

### Options

```bash
# Ajouter sans recharger (utile pour batch)
sudo sfha vip add vip1 192.168.1.201/24 eth0 --no-reload
sudo sfha vip add vip2 192.168.1.202/24 eth0 --no-reload
sudo sfha reload  # Recharger une seule fois à la fin

# Sortie JSON
sfha vip list --json
```

### Méthode alternative (édition manuelle)

Si vous préférez éditer le YAML directement :

```bash
sudo nano /etc/sfha/config.yml
```

```yaml
vips:
  - name: web
    ip: 192.168.1.200
    cidr: 24
    interface: eth0
```

```bash
sudo sfha reload
```

---

## Gestion des Services

### Ajouter un service géré

```yaml
services:
  - name: nginx
    type: systemd
    unit: nginx
    healthcheck:
      type: http
      target: "http://127.0.0.1/health"
      interval_ms: 5000
      timeout_ms: 2000
      failures_before_unhealthy: 3
      successes_before_healthy: 2
```

### Types de health checks

| Type | Exemple target | Description |
|------|----------------|-------------|
| `http` | `http://127.0.0.1:8080/health` | Vérifie HTTP 2xx |
| `tcp` | `127.0.0.1:5432` | Vérifie connexion TCP |
| `systemd` | *(pas de target)* | Vérifie `systemctl is-active` |

### Contraintes

```yaml
constraints:
  # Le service nginx suit la VIP web
  - type: colocation
    resource: nginx
    with: web
    
  # La VIP doit être active AVANT nginx
  - type: order
    first: web
    then: nginx
```

---

## Propagation manuelle

Si la propagation automatique a échoué (timeout, nœud offline temporaire) :

```bash
# Sur le leader uniquement
sudo sfha propagate
```

Vérifier que tous les nœuds ont la même config :
```bash
# Sur chaque nœud
grep -c "name:" /etc/sfha/config.yml
```

---

## Failover manuel

### Forcer un basculement

```bash
# Met le leader actuel en standby → nouveau leader élu
sudo sfha standby
```

### Réactiver un nœud

```bash
sudo sfha unstandby
```

### Forcer un failover immédiat

```bash
sudo sfha failover
```

---

## Commandes utiles

```bash
# État du cluster
sfha status
sfha status --json

# Ressources (VIPs + services)
sfha resources

# Health checks
sfha health

# Logs en temps réel
sfha logs -f

# Vérifier la config
sfha config-check

# État du mesh WireGuard
sfha mesh status

# État STONITH
sfha stonith status
```

---

## Dépannage

### VIP non active après reload

1. Vérifier les logs :
```bash
journalctl -u sfha -n 50
```

2. Vérifier le quorum :
```bash
sfha status
# Quorum: Yes (3/4 nodes)
```

3. Forcer une propagation :
```bash
sudo sfha propagate
```

### Propagation partielle (2/3 nœuds)

Un nœud n'a pas répondu à temps. Causes possibles :
- Nœud occupé (activation de ses propres VIPs)
- Problème réseau mesh
- Daemon sfha down

Solution :
```bash
# Vérifier le nœud problématique
ssh node2 "systemctl status sfha"

# Relancer la propagation
sudo sfha propagate
```

### VIPs en double (split-brain)

Situation critique où 2 nœuds ont la même VIP.

1. **Vérifier le quorum** — si pas de quorum, c'est normal que les VIPs soient désactivées
2. **Vérifier Corosync** :
```bash
corosync-quorumtool
```

3. **Restart du nœud fautif** :
```bash
sudo systemctl restart sfha
```

### Nœud qui ne rejoint pas le cluster

1. Vérifier WireGuard :
```bash
wg show wg-sfha
```

2. Vérifier la connectivité mesh :
```bash
ping 10.200.0.1  # IP mesh du leader
```

3. Vérifier le port P2P :
```bash
nc -zv 10.200.0.1 7777
```
