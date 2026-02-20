# BRAINSTORM : STONITH pour sfha via APIs

**Date:** 2026-02-20  
**Contexte:** sfha gère VIP + services + health checks mais manque de fencing pour éviter le split-brain  
**Objectif:** Implémenter STONITH de manière simple et moderne via APIs (pas de réinvention des agents Pacemaker)

---

## 🎯 1. PM (Product Manager)

### Use Cases Concrets
- **Split-brain recovery** : Quand deux nœuds croient être master simultanément, fence l'ancien pour garantir un seul master
- **Node unresponsive** : Le nœud ne répond plus aux health checks mais la VM/serveur tourne encore → force stop
- **Maintenance planifiée** : Éviction propre d'un nœud avec garantie qu'il ne reviendra pas perturber le cluster
- **Disaster recovery** : En cas de perte réseau totale, s'assurer que le nœud isolé est bien éteint avant failover

### Providers à Cibler en Priorité
1. **Proxmox** — Cible principale (ton infra, très demandé en homelab/PME)
2. **AWS EC2** — Standard cloud public
3. **Hetzner Cloud** — Populaire en Europe, API simple
4. **IPMI/iLO/iDRAC** — Bare metal universel
5. **Libvirt/KVM** — Virtualisation locale sans Proxmox

### UX Config
- **YAML simple** avec autodétection du provider quand possible
- **Dry-run mode** obligatoire pour tester sans risque
- **Logs clairs** : "Fencing node X via Proxmox API: VM 102 stopped"
- **Healthcheck du fencing** : vérifier que l'API est accessible au démarrage

---

## 🏗️ 2. Architect

### Architecture Technique

```
┌─────────────────────────────────────────────────┐
│                    sfha                          │
├─────────────────────────────────────────────────┤
│  Cluster Manager                                 │
│      │                                           │
│      ▼                                           │
│  ┌─────────────┐    ┌─────────────────────────┐ │
│  │ Fence       │───▶│ Fence Drivers           │ │
│  │ Coordinator │    │  ├─ proxmox.ts          │ │
│  │             │    │  ├─ aws.ts              │ │
│  │ - Quorum    │    │  ├─ hetzner.ts          │ │
│  │ - Delays    │    │  ├─ ipmi.ts             │ │
│  │ - Retries   │    │  └─ libvirt.ts          │ │
│  └─────────────┘    └─────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Intégration dans sfha
- **Interface `FenceDriver`** : méthodes `powerOff()`, `powerOn()`, `status()`, `verify()`
- **Fence Coordinator** : 
  - Gère le quorum (ne fence pas si on est minoritaire)
  - Délai configurable avant fencing (évite les faux positifs)
  - Retry avec backoff exponentiel
  - Confirmation post-fence (vérifier que le nœud est bien down)
- **Event-driven** : le cluster manager émet `node:unreachable`, le Fence Coordinator décide

### Sécurité des Credentials
- **Fichier séparé** : `/etc/sfha/fence-secrets.yaml` (mode 0600, root only)
- **Support variables d'environnement** : `PROXMOX_TOKEN`, `AWS_ACCESS_KEY_ID`...
- **Pas de credentials dans les logs** (masquage automatique)
- **Validation au démarrage** : teste l'accès API sans action destructive

---

## 🔧 3. DevOps/SRE

### APIs Existantes — Analyse de Complexité

| Provider | API | Auth | Complexité | Notes |
|----------|-----|------|------------|-------|
| **Proxmox** | REST | Token/Password | 🟢 Simple | `POST /nodes/{node}/qemu/{vmid}/status/stop` |
| **AWS EC2** | SDK | IAM Keys | 🟢 Simple | `ec2.stopInstances()` — SDK officiel parfait |
| **Hetzner Cloud** | REST | Bearer Token | 🟢 Simple | `POST /servers/{id}/actions/poweroff` |
| **GCP** | REST/SDK | Service Account | 🟡 Moyen | OAuth2 + scopes à gérer |
| **Azure** | REST/SDK | Service Principal | 🟡 Moyen | Auth complexe mais SDK OK |
| **OVH** | REST | App Key + Consumer | 🟡 Moyen | Triple auth, un peu pénible |
| **IPMI** | ipmitool CLI | User/Pass | 🟢 Simple | `ipmitool -H x -U x -P x power off` |
| **iLO/iDRAC** | Redfish REST | User/Pass | 🟡 Moyen | Standard mais implémentations variables |
| **Libvirt** | virsh CLI/API | SSH/Socket | 🟢 Simple | `virsh destroy {domain}` |

### Recommandations Pratiques
- **Commencer par Proxmox + IPMI** — couvre 80% des cas homelab/PME
- **AWS en second** — standard cloud, SDK mature
- **Libvirt pour les setups KVM simples** — wrapper virsh suffit
- **Hetzner** — très demandé, API propre, facile à implémenter

### Exemple Concret Proxmox
```bash
# Test manuel
curl -k -X POST "https://proxmox:8006/api2/json/nodes/pve/qemu/102/status/stop" \
  -H "Authorization: PVEAPIToken=root@pam!sfha=xxxxx"
```

---

## 🔒 4. Security Expert

### Risques du STONITH Mal Implémenté

1. **Fencing Storm** — Boucle où les nœuds se fencent mutuellement
   - *Mitigation* : Quorum obligatoire, délai minimum entre fences, self-fencing priority

2. **Credentials Leak** — API tokens dans logs/configs world-readable
   - *Mitigation* : Fichier secrets séparé (0600), masquage logs, rotation tokens

3. **Faux Positifs** — Fence d'un nœud sain sur glitch réseau
   - *Mitigation* : Délai configurable (30-60s), confirmation multi-path, retry health check

4. **API Indisponible** — Proxmox/cloud down au moment du fence
   - *Mitigation* : Retry avec backoff, alerting, fallback manuel documenté

5. **Split-brain du fencing** — Deux nœuds tentent de fence simultanément
   - *Mitigation* : Distributed lock (etcd/consul) OU leader-only fencing

### Credentials Management Best Practices
```yaml
# ❌ MAUVAIS
fence:
  proxmox:
    password: "monsecret"  # Dans le fichier principal

# ✅ BON
fence:
  proxmox:
    credentials_file: /etc/sfha/fence-secrets.yaml
    # OU
    token_env: PROXMOX_API_TOKEN
```

### Checklist Sécurité
- [ ] Credentials jamais en clair dans config principale
- [ ] Logs masquent les secrets
- [ ] Rate limiting sur les appels fence
- [ ] Audit log de chaque action fence
- [ ] Dry-run testé avant prod

---

## 👥 5. Community Voice

### Attentes de la Communauté Open Source

- **Documentation claire** — Exemples pour chaque provider, pas juste une référence API
- **Fail-safe par défaut** — Ne jamais fence sans quorum, préférer la prudence
- **Extensibilité** — Interface claire pour ajouter ses propres drivers
- **Pas de vendor lock-in** — Drivers optionnels, core fonctionne sans
- **Logs humainement lisibles** — "Node web-02 fenced via Proxmox (VM 103 stopped)" pas "fence_action=1 target=0x67"

### Intégrations les Plus Demandées (ordre de priorité communautaire)

1. **Proxmox** — Énorme en homelab, PME, Europe
2. **AWS** — Standard cloud
3. **Bare metal (IPMI)** — Universel pour le hardware physique
4. **Hetzner** — Prix, popularité Europe
5. **Libvirt/KVM** — Alternative gratuite à Proxmox
6. **DigitalOcean** — Simple et populaire pour les devs

### Ce que la Communauté NE Veut PAS
- Configuration XML complexe (syndrome Pacemaker)
- Dépendances lourdes (Java, agents séparés)
- Vendor lock-in sur un cloud spécifique

---

## 📊 SYNTHÈSE

### 1. APIs à Supporter en Priorité (Top 5)

| Rang | Provider | Justification |
|------|----------|---------------|
| 1 | **Proxmox** | Cible principale, ton infra, très demandé |
| 2 | **IPMI/BMC** | Universel bare metal, fallback pour tout |
| 3 | **AWS EC2** | Standard cloud, SDK mature |
| 4 | **Hetzner Cloud** | Europe, API simple, populaire |
| 5 | **Libvirt/KVM** | Gratuit, local, complémentaire |

### 2. Architecture Recommandée

```
sfha.yaml (config)
     │
     ▼
┌─────────────────┐
│ FenceCoordinator│ ← Quorum check, delays, retries
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│ Driver │ │ Driver │  ← Interface commune
│Proxmox │ │  IPMI  │
└────────┘ └────────┘
```

**Principes :**
- Un seul nœud fence à la fois (distributed lock ou leader-only)
- Quorum obligatoire avant tout fence
- Confirmation post-fence (le nœud est vraiment down)
- Timeout + retry avec backoff

### 3. Config YAML Exemple

```yaml
# /etc/sfha/config.yaml
cluster:
  name: prod-cluster
  nodes:
    - name: node-01
      address: 192.168.1.101
      fence:
        driver: proxmox
        vmid: 101
    - name: node-02
      address: 192.168.1.102
      fence:
        driver: proxmox
        vmid: 102

fence:
  enabled: true
  
  # Sécurité
  require_quorum: true          # Ne fence que si on a le quorum
  delay_seconds: 30             # Attendre avant de fence
  max_retries: 3
  confirm_down: true            # Vérifier que le nœud est bien off
  
  # Drivers config
  drivers:
    proxmox:
      api_url: https://192.168.1.100:8006
      credentials_file: /etc/sfha/fence-secrets.yaml
      verify_ssl: false         # Homelab avec self-signed
      
    ipmi:
      # Fallback si Proxmox indisponible
      interface: lanplus
      
---
# /etc/sfha/fence-secrets.yaml (mode 0600)
proxmox:
  token_id: "root@pam!sfha"
  token_secret: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

ipmi:
  node-01:
    host: 192.168.1.201
    user: admin
    password: "secret"
  node-02:
    host: 192.168.1.202
    user: admin
    password: "secret"
```

### 4. Risques et Mitigations

| Risque | Impact | Mitigation |
|--------|--------|------------|
| Fencing storm | 🔴 Critique | Quorum obligatoire + délai minimum + rate limit |
| Credentials leak | 🔴 Critique | Fichier séparé 0600, masquage logs, env vars |
| Faux positifs | 🟠 Majeur | Délai 30s+, multi-check, confirmation |
| API down | 🟡 Modéré | Retry backoff, alerting, fallback IPMI |
| Split-brain fence | 🔴 Critique | Leader-only fencing OU distributed lock |

### 5. Estimation Effort

| Composant | Effort | Notes |
|-----------|--------|-------|
| FenceCoordinator (core) | 🟡 Moyen | Quorum, delays, retries, state machine |
| Driver Proxmox | 🟢 Simple | REST API, 1-2 jours |
| Driver IPMI | 🟢 Simple | Wrapper ipmitool, 1 jour |
| Driver AWS | 🟢 Simple | SDK officiel, 1 jour |
| Driver Hetzner | 🟢 Simple | REST simple, 1 jour |
| Driver Libvirt | 🟢 Simple | Wrapper virsh, 1 jour |
| Credentials management | 🟡 Moyen | Fichier séparé, env vars, masquage |
| Tests & dry-run | 🟡 Moyen | Mock APIs, tests d'intégration |
| Documentation | 🟡 Moyen | Exemples par provider |

**Total estimé :** 2-3 semaines pour un MVP fonctionnel (Proxmox + IPMI + core)

---

## 🚀 Plan d'Action Recommandé

### Phase 1 — MVP (1 semaine)
- [ ] Interface `FenceDriver` + FenceCoordinator basique
- [ ] Driver Proxmox (priorité #1)
- [ ] Config YAML + fichier secrets séparé
- [ ] Dry-run mode
- [ ] Tests unitaires

### Phase 2 — Hardening (1 semaine)
- [ ] Quorum check avant fence
- [ ] Retry avec backoff
- [ ] Confirmation post-fence
- [ ] Logs structurés + masquage secrets
- [ ] Driver IPMI (fallback universel)

### Phase 3 — Cloud (optionnel)
- [ ] Driver AWS
- [ ] Driver Hetzner
- [ ] Driver Libvirt
- [ ] Documentation complète

---

*Document généré le 2026-02-20 via brainstorming BMAD*
