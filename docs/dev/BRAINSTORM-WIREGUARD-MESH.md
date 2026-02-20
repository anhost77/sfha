# BRAINSTORM : Intégration WireGuard Mesh dans sfha

**Date:** 2026-02-20  
**Contexte:** sfha gère VIP + services + health checks + STONITH, mais nécessite un réseau fonctionnel entre les nœuds  
**Objectif:** Permettre à sfha de créer et gérer automatiquement un mesh WireGuard pour la communication inter-nœuds

---

## 📚 RÉSUMÉ DES PRDs EXISTANTS

### PRD-SFHA.md — Ce qu'on a déjà

| Composant | État | Notes |
|-----------|------|-------|
| Corosync watcher | ✅ Implémenté | Quorum, membership via polling |
| VIP management | ✅ Implémenté | ip addr add/del + arping |
| Services systemd | ✅ Implémenté | start/stop/restart |
| Health checks | ✅ Implémenté | HTTP, TCP, systemd |
| Election | ✅ Implémenté | Plus petit nodeId online |
| STONITH | ✅ Implémenté | Driver Proxmox, architecture extensible |
| Config YAML | ✅ Implémenté | Parsing complet avec validation |
| CLI | ✅ Implémenté | status, run, stonith, etc. |
| i18n FR | ✅ Implémenté | Français par défaut |

### PRD-NETWORK-HA-MODULES.md — Architecture réseau cible

| Concept | Pertinent pour sfha | Notes |
|---------|---------------------|-------|
| Module réseau indépendant | ⚠️ Partiellement | sfha = standalone, pas de Control Plane |
| Tunnels point-à-point | ✅ Oui | Mais mesh full, pas point-à-point |
| Génération auto des clés | ✅ Oui | À implémenter |
| IPs privées 10.x.x.x | ✅ Oui | Plage dédiée sfha |
| Stockage local | ✅ Oui | /etc/sfha/wireguard/ |

### Code WireGuard ServerFlow

**⚠️ Les fichiers `wireguard.ts` et `mesh.ts` n'existent pas dans server-node.**

Il n'y a pas de code WireGuard existant à réutiliser. L'implémentation sera from scratch, mais on peut s'inspirer des patterns sfha existants (drivers STONITH, etc.).

---

## 🎯 1. PM (Product Manager)

### Use Cases Concrets

1. **Cluster multi-datacenter** : 3 serveurs dans différents datacenters, VIP sur mesh WireGuard (pas de LAN commun)
2. **Cluster homelab avec NAT** : Serveurs derrière NAT/box, mesh pour contourner les restrictions réseau
3. **Migration vers sfha simplifiée** : Un seul outil qui fait tout (pas besoin de configurer WireGuard séparément)
4. **Isolation réseau HA** : Corosync bind sur interface wg, protégé du réseau public
5. **Ajout dynamique de nœuds** : Nouveau serveur rejoint le cluster avec un simple token

### UX CLI Proposée

```bash
# Initialiser un cluster avec mesh
sfha init --cluster prod --mesh --ip 10.100.0.1/24

# Générer un token de join
sfha mesh token
# Output: sfha-join://eyJjbHVzdGVyIjoicHJvZCIsIm1lc2hfaXAiOi...

# Rejoindre le cluster avec mesh
sfha join sfha-join://eyJjbHVzdGVyIjo...

# Vérifier l'état du mesh
sfha mesh status

# Ajouter un peer manuellement
sfha mesh add-peer --name node3 --endpoint 1.2.3.4:51820 --ip 10.100.0.3

# Supprimer un peer
sfha mesh remove-peer node3

# Régénérer les clés (rotation)
sfha mesh rotate-keys
```

### Différenciation vs Solutions Existantes

| Solution | sfha + WireGuard intégré |
|----------|-------------------------|
| **Pacemaker + WireGuard manuel** | Config séparée, complexe | Tout-en-un, UX simple |
| **Tailscale/Netbird** | Service externe, dépendance | Standalone, self-hosted |
| **Keepalived** | Pas de mesh, VRRP only | Mesh full intégré |
| **Manual WireGuard** | Config manuelle par nœud | Auto-config via token |

### Simplifications Clés

- **Zéro config WireGuard manuelle** : sfha génère tout
- **Token unique** pour rejoindre (contient clé publique du cluster, IP assignée, endpoint)
- **Autodétection de l'endpoint** (IP publique ou configurée)
- **Corosync auto-configuré** pour bind sur interface mesh

---

## 🏗️ 2. Architect

### Architecture Technique

```
┌─────────────────────────────────────────────────────────────────┐
│                           sfha                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐          │
│  │  Cluster    │───▶│   Mesh      │───▶│  WireGuard  │          │
│  │  Manager    │    │  Manager    │    │  Driver     │          │
│  │             │    │             │    │             │          │
│  │ - Election  │    │ - Peers     │    │ - wg-quick  │          │
│  │ - VIPs      │    │ - IPs       │    │ - ip link   │          │
│  │ - Services  │    │ - Keys      │    │ - wg set    │          │
│  └─────────────┘    └─────────────┘    └─────────────┘          │
│        │                  │                   │                  │
│        │                  │                   ▼                  │
│        │                  │           ┌─────────────┐            │
│        │                  │           │   wg-sfha   │            │
│        │                  │           │  interface  │            │
│        │                  │           └─────────────┘            │
│        │                  │                   │                  │
│        ▼                  ▼                   │                  │
│  ┌────────────────────────────────────────────┴────────────────┐ │
│  │                     Corosync                                │ │
│  │                  (bind: wg-sfha)                            │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Intégration dans l'Architecture sfha Existante

**Nouveau module : `src/mesh/`**

```
sfha/src/
├── mesh/
│   ├── index.ts         # Export principal
│   ├── types.ts         # Types MeshConfig, Peer, etc.
│   ├── manager.ts       # MeshManager (gestion peers, IPs)
│   ├── wireguard.ts     # Driver WireGuard (commandes système)
│   ├── keys.ts          # Génération/gestion des clés
│   ├── token.ts         # Génération/parsing des tokens join
│   └── corosync.ts      # Mise à jour corosync.conf pour mesh
├── config.ts            # Ajout section mesh
├── daemon.ts            # Initialisation mesh au démarrage
├── cli.ts               # Nouvelles commandes mesh
└── ...
```

### Stockage des Clés et Configs

```
/etc/sfha/
├── config.yml              # Config principale
├── wireguard/
│   ├── private.key         # Clé privée (0600)
│   ├── public.key          # Clé publique (0644)
│   └── wg-sfha.conf        # Config WireGuard générée
└── mesh.yml                # État du mesh (peers, IPs)
```

**Fichier mesh.yml :**

```yaml
# /etc/sfha/mesh.yml - État du mesh (auto-généré)
local:
  name: node1
  ip: 10.100.0.1/24
  public_key: "abc123..."
  endpoint: 1.2.3.4:51820

peers:
  - name: node2
    ip: 10.100.0.2/24
    public_key: "def456..."
    endpoint: 5.6.7.8:51820
    persistent_keepalive: 25
    
  - name: node3
    ip: 10.100.0.3/24
    public_key: "ghi789..."
    endpoint: 9.10.11.12:51820
    persistent_keepalive: 25

settings:
  interface: wg-sfha
  port: 51820
  network: 10.100.0.0/24
  mtu: 1420
```

### Gestion Ajout/Suppression de Nœuds

**Ajout d'un nœud (via token) :**

```
1. Nouveau nœud exécute: sfha join <token>
2. Token contient:
   - Clé publique du cluster (nœud initiateur)
   - Endpoint du nœud initiateur
   - Plage IP du mesh
   - IP assignée au nouveau nœud
3. Nouveau nœud:
   - Génère sa paire de clés
   - Configure WireGuard avec le peer du token
   - Établit le tunnel
4. Via le tunnel établi, échange les infos avec les autres peers
5. Mise à jour mesh.yml sur tous les nœuds
```

**Suppression d'un nœud :**

```
1. Leader détecte nœud offline (via Corosync ou health check)
2. Après timeout: sfha mesh remove-peer <node> automatique
3. Mise à jour wg-sfha.conf sur tous les nœuds
4. wg set wg-sfha peer <pubkey> remove
```

### Interaction avec Corosync

**Option 1 : Corosync bind sur interface mesh (RECOMMANDÉ)**

```
# /etc/corosync/corosync.conf
totem {
    interface {
        bindnetaddr: 10.100.0.0  # Réseau mesh WireGuard
    }
}
nodelist {
    node {
        ring0_addr: 10.100.0.1   # IP mesh node1
        name: node1
        nodeid: 1
    }
    node {
        ring0_addr: 10.100.0.2   # IP mesh node2
        name: node2
        nodeid: 2
    }
}
```

**Option 2 : Dual-ring (mesh + LAN)**

```
totem {
    interface {
        ringnumber: 0
        bindnetaddr: 192.168.1.0  # LAN
    }
    interface {
        ringnumber: 1
        bindnetaddr: 10.100.0.0   # Mesh
    }
}
```

**Recommandation : Option 1** (simplicité) sauf si LAN fiable disponible.

---

## 🔒 3. Security Expert

### Génération et Stockage des Clés Privées

**Génération :**

```typescript
// keys.ts
import { execSync } from 'child_process';
import { writeFileSync, chmodSync } from 'fs';

export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const privateKey = execSync('wg genkey', { encoding: 'utf-8' }).trim();
  const publicKey = execSync(`echo "${privateKey}" | wg pubkey`, { encoding: 'utf-8' }).trim();
  return { privateKey, publicKey };
}

export function saveKeys(privateKey: string, publicKey: string, dir: string): void {
  writeFileSync(`${dir}/private.key`, privateKey, { mode: 0o600 });
  writeFileSync(`${dir}/public.key`, publicKey, { mode: 0o644 });
  // Propriétaire root:root
}
```

**Stockage sécurisé :**

```
/etc/sfha/wireguard/private.key
- Mode: 0600 (rw-------)
- Owner: root:root
- Jamais logué, jamais transmis
```

### Échange des Clés Publiques Entre Nœuds

**Mécanisme du Token :**

```typescript
// token.ts
interface JoinToken {
  cluster: string;           // Nom du cluster
  initiator: {
    name: string;
    publicKey: string;       // Clé publique du nœud initial
    endpoint: string;        // IP:port
  };
  mesh: {
    network: string;         // 10.100.0.0/24
    assignedIp: string;      // IP assignée au nouveau nœud
    port: number;
  };
  expires: number;           // Timestamp expiration
  signature: string;         // HMAC signature
}

// Token encodé en base64url
// Préfixé: sfha-join://eyJjbHVzdGVyIjo...
```

**Flux d'échange sécurisé :**

```
1. Nœud A génère token (contient sa clé publique + IP assignée)
2. Admin copie token vers nœud B (out-of-band)
3. Nœud B parse token, configure peer A, démarre WireGuard
4. Nœud B envoie sa clé publique à A via le tunnel chiffré
5. Nœud A ajoute B comme peer
6. Mesh établi, échange des infos des autres peers via tunnel
```

### Rotation des Clés

**Complexité : Élevée** — Tous les peers doivent être mis à jour simultanément.

**Approche recommandée v1 : Pas de rotation automatique**

- Rotation manuelle via `sfha mesh rotate-keys`
- Processus coordonné avec interruption de service minimale
- Rollout progressif possible avec dual-key (optionnel v2)

**Rotation manuelle :**

```bash
# Sur chaque nœud, dans l'ordre
sfha mesh rotate-keys --prepare  # Génère nouvelle clé, garde l'ancienne
sfha mesh rotate-keys --commit   # Applique la nouvelle clé
sfha mesh rotate-keys --cleanup  # Supprime l'ancienne
```

### Risques de Split-Brain Réseau

| Risque | Impact | Mitigation |
|--------|--------|------------|
| **Tunnel down** | Nœuds isolés | PersistentKeepalive, multi-path |
| **Faux partitionnement** | Split-brain | Quorum Corosync obligatoire |
| **Clé compromise** | Accès mesh | Rotation manuelle, monitoring |
| **Endpoint change** | Perte connectivité | Endpoint dynamique via DNS/API |
| **DoS sur port WireGuard** | Isolation | Rate limiting, fail2ban |

### Recommandations Sécurité

1. **Clés privées jamais transmises** — Seules les clés publiques sont échangées
2. **Tokens expirent** — Validité limitée (ex: 1h)
3. **Signature HMAC** — Tokens signés avec secret cluster
4. **Endpoint validation** — Vérifier que l'IP est atteignable avant ajout
5. **Logs masqués** — Jamais de clés dans les logs
6. **Firewall recommandé** — Port 51820/UDP ouvert uniquement

---

## 🔧 4. DevOps/SRE

### Commandes WireGuard Nécessaires

**Installation (prérequis) :**

```bash
# Debian/Ubuntu
apt install wireguard wireguard-tools

# RHEL/CentOS
dnf install wireguard-tools
```

**Commandes utilisées par sfha :**

```bash
# Génération de clés
wg genkey                    # Génère clé privée
wg pubkey                    # Dérive clé publique

# Gestion interface
ip link add wg-sfha type wireguard
ip link set wg-sfha up
ip addr add 10.100.0.1/24 dev wg-sfha
ip link delete wg-sfha

# Configuration
wg set wg-sfha private-key /etc/sfha/wireguard/private.key
wg set wg-sfha listen-port 51820
wg set wg-sfha peer <pubkey> endpoint <ip:port> allowed-ips 10.100.0.2/32 persistent-keepalive 25
wg set wg-sfha peer <pubkey> remove

# Status
wg show wg-sfha
wg show wg-sfha dump        # Format parsable
```

### Persistance au Reboot

**Option 1 : wg-quick (simple mais moins de contrôle)**

```ini
# /etc/wireguard/wg-sfha.conf
[Interface]
PrivateKey = <contenu private.key>
Address = 10.100.0.1/24
ListenPort = 51820

[Peer]
PublicKey = <clé publique node2>
Endpoint = 5.6.7.8:51820
AllowedIPs = 10.100.0.2/32
PersistentKeepalive = 25
```

```bash
systemctl enable wg-quick@wg-sfha
systemctl start wg-quick@wg-sfha
```

**Option 2 : Service sfha gère tout (RECOMMANDÉ)**

```ini
# /etc/systemd/system/sfha.service
[Unit]
Description=sfha High Availability
After=network-online.target
Wants=network-online.target
Before=corosync.service

[Service]
Type=simple
ExecStartPre=/usr/bin/sfha mesh up      # Démarre WireGuard
ExecStart=/usr/bin/sfha run
ExecStopPost=/usr/bin/sfha mesh down    # Arrête WireGuard
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Recommandation : Option 2** — sfha garde le contrôle total sur WireGuard.

### Debugging Réseau

```bash
# Status WireGuard
sfha mesh status
wg show wg-sfha

# Test connectivité mesh
ping 10.100.0.2

# Voir les peers actifs
wg show wg-sfha latest-handshakes

# Debug Corosync sur mesh
corosync-cfgtool -s

# Packets sur interface
tcpdump -i wg-sfha

# Logs WireGuard (kernel)
dmesg | grep wireguard
```

### Compatibilité avec WireGuard Existant

**Cas : WireGuard déjà installé sur le serveur**

| Situation | Compatibilité | Notes |
|-----------|---------------|-------|
| wg0 existe (autre usage) | ✅ Compatible | sfha utilise wg-sfha |
| Port 51820 utilisé | ⚠️ Conflit | sfha configurable sur autre port |
| wireguard module chargé | ✅ OK | Pas de conflit |
| wg-quick@wg0 actif | ✅ OK | Interfaces séparées |

**Configuration port alternatif :**

```yaml
# /etc/sfha/config.yml
mesh:
  port: 51821  # Au lieu de 51820
```

---

## 👨‍💻 5. Developer

### Réutilisation du Code Existant

**Code sfha réutilisable :**

| Module | Réutilisation | Comment |
|--------|---------------|---------|
| `config.ts` | ✅ Étendre | Ajouter section `mesh:` |
| `daemon.ts` | ✅ Intégrer | Appeler MeshManager au start |
| `cli.ts` | ✅ Ajouter | Nouvelles commandes `mesh *` |
| `corosync.ts` | ⚠️ Adapter | Helper pour modifier corosync.conf |
| `stonith/drivers/base.ts` | ✅ Pattern | Même pattern pour WireGuard driver |
| `control.ts` | ✅ Étendre | Nouvelles actions mesh |

**Code ServerFlow :** Aucun (les fichiers n'existent pas).

### Structure des Nouveaux Fichiers

```
sfha/src/
├── mesh/
│   ├── index.ts              # Export public
│   │   export { MeshManager } from './manager.js';
│   │   export { generateKeyPair, loadKeys } from './keys.js';
│   │   export { createJoinToken, parseJoinToken } from './token.js';
│   │   export * from './types.js';
│   │
│   ├── types.ts              # ~50 LOC
│   │   interface MeshConfig { ... }
│   │   interface Peer { ... }
│   │   interface MeshState { ... }
│   │   interface JoinToken { ... }
│   │
│   ├── manager.ts            # ~200 LOC
│   │   class MeshManager {
│   │     constructor(config: MeshConfig)
│   │     async initialize(): Promise<void>
│   │     async addPeer(peer: Peer): Promise<void>
│   │     async removePeer(name: string): Promise<void>
│   │     async up(): Promise<void>
│   │     async down(): Promise<void>
│   │     getState(): MeshState
│   │   }
│   │
│   ├── wireguard.ts          # ~150 LOC
│   │   function createInterface(name: string, ip: string): void
│   │   function deleteInterface(name: string): void
│   │   function addPeer(iface: string, peer: WgPeer): void
│   │   function removePeer(iface: string, pubkey: string): void
│   │   function getStatus(iface: string): WgStatus
│   │   function generateConfig(state: MeshState): string
│   │
│   ├── keys.ts               # ~50 LOC
│   │   function generateKeyPair(): { privateKey, publicKey }
│   │   function loadKeys(dir: string): { privateKey, publicKey }
│   │   function saveKeys(keys, dir: string): void
│   │
│   ├── token.ts              # ~80 LOC
│   │   function createJoinToken(cluster, initiator, mesh, secret): string
│   │   function parseJoinToken(token: string): JoinToken
│   │   function validateToken(token: JoinToken): boolean
│   │
│   └── corosync.ts           # ~100 LOC
│       function updateCorosyncForMesh(nodes: MeshNode[]): void
│       function generateCorosyncConfig(cluster, nodes): string

Total nouveau code estimé : ~630 LOC
```

### Tests à Prévoir

**Tests Unitaires (`tests/mesh/`):**

```typescript
// keys.test.ts
describe('Key Generation', () => {
  it('should generate valid WireGuard key pair');
  it('should save keys with correct permissions');
  it('should load existing keys');
});

// token.test.ts
describe('Join Token', () => {
  it('should create valid token');
  it('should parse token correctly');
  it('should reject expired token');
  it('should reject invalid signature');
});

// manager.test.ts
describe('MeshManager', () => {
  it('should initialize mesh');
  it('should add peer');
  it('should remove peer');
  it('should handle interface up/down');
});
```

**Tests d'Intégration (`tests/integration/`):**

```bash
# test-mesh-2nodes.sh
# - Crée 2 containers
# - Init mesh sur node1
# - Join node2 avec token
# - Vérifie ping entre nodes
# - Vérifie Corosync fonctionne sur mesh

# test-mesh-failover.sh
# - Setup 3 nodes mesh
# - Kill node1
# - Vérifie failover VIP
# - Vérifie mesh se reconfigure
```

### Impact sur le Build Standalone (pkg)

**Dépendances système requises :**

```
- wireguard-tools (wg, wg-quick)
- iproute2 (ip)
- arping (pour VIP ARP)
```

**Impact sur le .deb :**

```diff
  Package: sfha
- Depends: nodejs (>= 18), corosync (>= 3.0)
+ Depends: nodejs (>= 18), corosync (>= 3.0), wireguard-tools
  Recommends: corosync-qdevice
  Suggests: fence-agents
```

**Taille du package :**

- Actuel : ~2 MB (estimation)
- Avec mesh : ~2.1 MB (+100 KB de code TypeScript)
- Pas de dépendance Node.js supplémentaire

---

## 🔧 ARCHITECTURE PROPOSÉE

### Schéma Complet

```
                                 INTERNET
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
              │  Firewall │   │  Firewall │   │  Firewall │
              │   :51820  │   │   :51820  │   │   :51820  │
              └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
                    │               │               │
┌───────────────────┼───────────────┼───────────────┼───────────────────┐
│                   │               │               │                   │
│   ┌───────────────┴───────────────┴───────────────┴───────────────┐   │
│   │                     WireGuard Mesh (wg-sfha)                   │   │
│   │                                                                │   │
│   │   node1                  node2                  node3          │   │
│   │   10.100.0.1            10.100.0.2             10.100.0.3      │   │
│   │      │                     │                      │            │   │
│   │      └─────────────────────┼──────────────────────┘            │   │
│   │                            │                                   │   │
│   └────────────────────────────┼───────────────────────────────────┘   │
│                                │                                       │
│   ┌────────────────────────────┼───────────────────────────────────┐   │
│   │                    Corosync (bind: 10.100.0.0/24)              │   │
│   │                                                                │   │
│   │    Quorum │ Membership │ Communication inter-nœuds              │   │
│   └────────────────────────────┼───────────────────────────────────┘   │
│                                │                                       │
│   ┌────────────────────────────┼───────────────────────────────────┐   │
│   │                           sfha                                  │   │
│   │                                                                │   │
│   │    MeshManager │ Election │ VIP Manager │ STONITH              │   │
│   └────────────────────────────┼───────────────────────────────────┘   │
│                                │                                       │
│                          VIP: 10.100.0.100                            │
│                     (flottante sur le mesh)                           │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Flux Détaillés

**Initialisation du cluster :**

```
Admin                  Node1                    System
  │                      │                        │
  ├──sfha init ─────────▶│                        │
  │   --cluster prod     │                        │
  │   --mesh             │                        │
  │   --ip 10.100.0.1    │                        │
  │                      │                        │
  │                      ├──generateKeyPair()────▶│
  │                      │◀──{priv,pub}──────────┤
  │                      │                        │
  │                      ├──ip link add wg-sfha──▶│
  │                      ├──wg set...────────────▶│
  │                      │                        │
  │                      ├──writeConfig()────────▶│
  │                      │  /etc/sfha/mesh.yml    │
  │                      │                        │
  │◀─Token: sfha-join://│                        │
  │                      │                        │
```

**Join d'un nouveau nœud :**

```
Admin       Node2             WireGuard           Node1
  │           │                   │                 │
  ├─sfha join─▶                   │                 │
  │  <token>  │                   │                 │
  │           │                   │                 │
  │           ├──parseToken()──   │                 │
  │           │                   │                 │
  │           ├──generateKeyPair()│                 │
  │           │                   │                 │
  │           ├──createInterface()│                 │
  │           │                   │                 │
  │           ├──addPeer(node1)──▶│                 │
  │           │                   │                 │
  │           │◀══WG Tunnel══════▶│◀═══════════════▶│
  │           │  (encrypted)      │                 │
  │           │                   │                 │
  │           ├──POST /mesh/join─────────────────▶│
  │           │  {myPubKey, myIp} │                 │
  │           │                   │                 │
  │           │                   │    ┌──addPeer(node2)
  │           │                   │    │
  │           │◀──200 {allPeers}──────────────────┤
  │           │                   │                 │
  │           ├──addPeer(node3)──▶│                 │
  │           │  (si existe)      │                 │
  │           │                   │                 │
  │◀──Join OK─┤                   │                 │
```

---

## 📝 NOUVELLES COMMANDES CLI

### Commandes `sfha init`

```bash
sfha init --cluster <name> [--mesh] [--ip <mesh_ip>]

Options:
  --cluster <name>     Nom du cluster (requis)
  --mesh               Activer le mesh WireGuard
  --ip <ip/cidr>       IP locale sur le mesh (ex: 10.100.0.1/24)
  --port <port>        Port WireGuard (défaut: 51820)
  --endpoint <ip>      IP publique/endpoint (auto-détection si absent)

Exemples:
  sfha init --cluster prod
  sfha init --cluster prod --mesh --ip 10.100.0.1/24
  sfha init --cluster prod --mesh --ip 10.100.0.1/24 --endpoint 1.2.3.4
```

### Commandes `sfha join`

```bash
sfha join <token>

Arguments:
  token                Token de join (sfha-join://...)

Exemples:
  sfha join sfha-join://eyJjbHVzdGVyIjoicHJvZCI...
```

### Commandes `sfha mesh`

```bash
sfha mesh <subcommand>

Subcommands:
  status              Afficher l'état du mesh
  token               Générer un token de join
  up                  Démarrer l'interface mesh
  down                Arrêter l'interface mesh
  add-peer            Ajouter un peer manuellement
  remove-peer         Supprimer un peer
  rotate-keys         Régénérer les clés WireGuard

sfha mesh status [--json]
  Affiche l'état du mesh, peers, latence

sfha mesh token [--expires <duration>] [--ip <assigned_ip>]
  --expires <duration>  Durée de validité (défaut: 1h)
  --ip <ip>             IP à assigner au nouveau nœud (auto si absent)

sfha mesh up
  Démarre l'interface wg-sfha

sfha mesh down
  Arrête l'interface wg-sfha

sfha mesh add-peer --name <name> --endpoint <ip:port> --pubkey <key> --ip <mesh_ip>
  Ajoute un peer manuellement (sans token)

sfha mesh remove-peer <name>
  Supprime un peer du mesh

sfha mesh rotate-keys [--prepare|--commit|--cleanup]
  Rotation des clés (processus en 3 étapes)
```

### Exemple Sortie `sfha mesh status`

```
╭──────────────────────────────────────────╮
│  sfha mesh - prod                        │
├──────────────────────────────────────────┤
│  Interface: wg-sfha                      │
│  IP locale: 10.100.0.1/24                │
│  Port: 51820                             │
│  Clé publique: abc123...                 │
╰──────────────────────────────────────────╯

Peers:
  ● node2 (10.100.0.2)
    Endpoint: 5.6.7.8:51820
    Dernier handshake: il y a 12s
    Transfert: ↓ 1.2 MiB  ↑ 0.8 MiB
    
  ● node3 (10.100.0.3)
    Endpoint: 9.10.11.12:51820
    Dernier handshake: il y a 8s
    Transfert: ↓ 0.9 MiB  ↑ 0.6 MiB
```

---

## 📁 STRUCTURE DES FICHIERS À CRÉER

```
sfha/
├── src/
│   ├── mesh/                          # NOUVEAU MODULE
│   │   ├── index.ts                   # ~20 LOC
│   │   ├── types.ts                   # ~60 LOC
│   │   ├── manager.ts                 # ~250 LOC
│   │   ├── wireguard.ts               # ~180 LOC
│   │   ├── keys.ts                    # ~60 LOC
│   │   ├── token.ts                   # ~100 LOC
│   │   └── corosync-mesh.ts           # ~120 LOC
│   │
│   ├── config.ts                      # MODIFIER (+50 LOC)
│   ├── daemon.ts                      # MODIFIER (+30 LOC)
│   ├── cli.ts                         # MODIFIER (+150 LOC)
│   └── control.ts                     # MODIFIER (+40 LOC)
│
├── tests/
│   └── mesh/                          # NOUVEAUX TESTS
│       ├── keys.test.ts
│       ├── token.test.ts
│       ├── manager.test.ts
│       └── wireguard.test.ts
│
├── docs/
│   ├── MESH.md                        # Documentation mesh
│   └── BRAINSTORM-WIREGUARD-MESH.md   # Ce fichier
│
└── debian/
    └── control                        # MODIFIER (dépendance wireguard-tools)

Total nouveau code : ~890 LOC
Total modifications : ~270 LOC
Total tests : ~300 LOC (estimation)
```

---

## ⚠️ RISQUES ET MITIGATIONS

| Risque | Probabilité | Impact | Mitigation |
|--------|-------------|--------|------------|
| **WireGuard non installé** | Moyenne | Bloquant | Check au démarrage, message clair |
| **Port 51820 déjà utilisé** | Faible | Moyen | Port configurable, check au start |
| **NAT symétrique** | Moyenne | Élevé | Documentation, PersistentKeepalive |
| **Endpoint dynamique** | Moyenne | Moyen | Option endpoint auto-update (v2) |
| **Perte de clé privée** | Faible | Critique | Backup doc, rotation possible |
| **Token intercepté** | Faible | Élevé | Expiration courte, HMAC signature |
| **Split-brain mesh** | Faible | Critique | Quorum Corosync obligatoire |
| **Performance mesh** | Faible | Moyen | MTU configurable, benchmark |
| **Corosync ne démarre pas** | Moyenne | Bloquant | Vérification interface wg up avant |
| **Upgrade sfha casse mesh** | Faible | Élevé | Migration progressive, backup |

### Mitigations Détaillées

**WireGuard non installé :**
```typescript
async function checkWireGuardInstalled(): Promise<boolean> {
  try {
    execSync('which wg', { stdio: 'pipe' });
    return true;
  } catch {
    console.error('❌ WireGuard n\'est pas installé.');
    console.error('   Installez-le avec: apt install wireguard-tools');
    return false;
  }
}
```

**NAT symétrique :**
```
# Documentation recommandée:
1. Ouvrir le port 51820/UDP sur le firewall
2. Configurer PersistentKeepalive: 25
3. Si NAT symétrique, utiliser un nœud avec IP publique comme hub
```

---

## 📋 PLAN D'IMPLÉMENTATION

### Phase 1 : Fondations (2-3 jours)

**Jour 1 :**
- [ ] Créer structure `src/mesh/`
- [ ] Implémenter `types.ts` (interfaces)
- [ ] Implémenter `keys.ts` (génération/stockage clés)
- [ ] Tests unitaires keys

**Jour 2 :**
- [ ] Implémenter `wireguard.ts` (wrapper commandes wg)
- [ ] Tests unitaires wireguard
- [ ] Implémenter `token.ts` (génération/parsing)
- [ ] Tests unitaires token

**Jour 3 :**
- [ ] Implémenter `manager.ts` (MeshManager basique)
- [ ] Intégration dans `config.ts` (section mesh)
- [ ] Tests unitaires manager

### Phase 2 : CLI & Intégration (2 jours)

**Jour 4 :**
- [ ] Ajouter commandes CLI (`sfha mesh *`)
- [ ] Implémenter `sfha init --mesh`
- [ ] Implémenter `sfha mesh up/down/status`

**Jour 5 :**
- [ ] Implémenter `sfha mesh token`
- [ ] Implémenter `sfha join <token>`
- [ ] Tests d'intégration 2 nœuds

### Phase 3 : Corosync & Production (2 jours)

**Jour 6 :**
- [ ] Implémenter `corosync-mesh.ts` (update corosync.conf)
- [ ] Intégration daemon.ts (mesh up au démarrage)
- [ ] Tests Corosync sur mesh

**Jour 7 :**
- [ ] `sfha mesh add-peer/remove-peer`
- [ ] Update `debian/control` (dépendance wireguard-tools)
- [ ] Documentation `docs/MESH.md`
- [ ] Tests d'intégration 3 nœuds

### Phase 4 : Hardening (1-2 jours)

**Jour 8 :**
- [ ] Gestion erreurs robuste
- [ ] Timeouts et retries
- [ ] Logs structurés
- [ ] Monitoring mesh dans `sfha status`

**Jour 9 (optionnel) :**
- [ ] `sfha mesh rotate-keys`
- [ ] Endpoint auto-detection
- [ ] Tests de stress

---

## ⏱️ ESTIMATION EFFORT

| Composant | LOC | Effort | Notes |
|-----------|-----|--------|-------|
| types.ts | 60 | 🟢 0.5j | Interfaces simples |
| keys.ts | 60 | 🟢 0.5j | Wrapper wg genkey |
| wireguard.ts | 180 | 🟡 1j | Wrapper wg set, parsing |
| token.ts | 100 | 🟡 1j | Encode/decode/sign |
| manager.ts | 250 | 🟠 1.5j | Orchestration |
| corosync-mesh.ts | 120 | 🟡 1j | Config Corosync |
| CLI extensions | 150 | 🟡 1j | Commandes mesh |
| Config extensions | 50 | 🟢 0.5j | Section mesh |
| Daemon integration | 30 | 🟢 0.25j | Appels mesh |
| Tests unitaires | 200 | 🟡 1j | ~70% coverage |
| Tests intégration | 100 | 🟡 1j | 2-3 scénarios |
| Documentation | N/A | 🟡 0.5j | MESH.md |

**Total estimé : 9-10 jours développeur**

### Breakdown par Phase

| Phase | Jours | Livrable |
|-------|-------|----------|
| Phase 1 : Fondations | 3 | Module mesh fonctionnel (API) |
| Phase 2 : CLI | 2 | Commandes utilisables |
| Phase 3 : Production | 2 | Intégration Corosync + .deb |
| Phase 4 : Hardening | 2 | Production-ready |
| **Total** | **9** | sfha avec mesh intégré |

---

## 🎯 QUESTIONS SPÉCIFIQUES — RÉPONSES

### 1. Init cluster avec mesh : Comment ça marche concrètement ?

```bash
# Sur le premier nœud
sfha init --cluster production --mesh --ip 10.100.0.1/24

# Ce qui se passe:
# 1. Génère paire de clés WireGuard
# 2. Crée /etc/sfha/config.yml avec section mesh
# 3. Crée /etc/sfha/mesh.yml (état local)
# 4. Configure Corosync pour ce nœud seul
# 5. Démarre interface wg-sfha
# 6. Affiche token pour le join des autres
```

### 2. Join cluster : Comment un nouveau nœud récupère les infos mesh ?

```bash
# Sur le nouveau nœud
sfha join sfha-join://eyJjbHVzdGVyIjoicHJvZCI...

# Ce qui se passe:
# 1. Parse le token (contient: pubkey initiateur, endpoint, IP assignée)
# 2. Génère sa propre paire de clés
# 3. Configure WireGuard avec le peer de l'initiateur
# 4. Établit le tunnel
# 5. Via tunnel: POST /mesh/join avec sa pubkey
# 6. Reçoit la liste de tous les peers
# 7. Configure les autres peers
# 8. Update Corosync et rejoint le cluster
```

### 3. Token/secret : Format et contenu pour rejoindre ?

```json
// Token décodé (base64url)
{
  "cluster": "production",
  "initiator": {
    "name": "node1",
    "publicKey": "abc123...",
    "endpoint": "1.2.3.4:51820"
  },
  "mesh": {
    "network": "10.100.0.0/24",
    "assignedIp": "10.100.0.2",
    "port": 51820
  },
  "expires": 1708444800,
  "signature": "hmac-sha256(secret, payload)"
}

// Token encodé
sfha-join://eyJjbHVzdGVyIjoicHJvZHVjdGlvbiIsImluaXRpYXRvciI6...
```

### 4. Interface réseau : wg0, wg-sfha, autre ?

**Décision : `wg-sfha`**

- Préfixe `wg-` = convention WireGuard
- Suffixe `sfha` = identification claire
- Évite conflit avec wg0 existant

### 5. Port WireGuard : 51820 par défaut, configurable ?

**Décision : 51820 par défaut, configurable**

```yaml
mesh:
  port: 51821  # Si 51820 déjà utilisé
```

### 6. Allocation IPs mesh : Automatique ou manuelle ?

**Décision : Automatique avec override possible**

- Init : IP obligatoire (premier nœud définit la plage)
- Join : IP dans le token, auto-incrémentée
- Override : `sfha mesh token --ip 10.100.0.5`

### 7. Persistance : Où stocker la config WireGuard ?

**Décision : sfha gère tout**

```
/etc/sfha/
├── wireguard/
│   ├── private.key      # Clé privée (0600)
│   ├── public.key       # Clé publique (0644)
│   └── wg-sfha.conf     # Config générée (pour debug)
└── mesh.yml             # État mesh (peers, IPs)
```

La config WireGuard est générée dynamiquement par sfha, pas de wg-quick.

### 8. Coexistence : Si WireGuard existe déjà sur le serveur ?

**Décision : Coexistence supportée**

- Interface séparée (`wg-sfha` vs `wg0`)
- Port configurable (évite conflit 51820)
- Pas de modification des interfaces existantes

### 9. Rebuild .deb : Impact sur la taille, dépendances ?

**Impact minimal :**

```diff
  Package: sfha
  Version: 1.1.0
- Depends: nodejs (>= 18), corosync (>= 3.0)
+ Depends: nodejs (>= 18), corosync (>= 3.0), wireguard-tools
```

- Taille package : +100 KB (code TypeScript)
- `wireguard-tools` : ~200 KB (déjà installé sur beaucoup de serveurs)
- Module kernel wireguard : inclus dans kernel moderne (5.6+)

---

## ✅ CHECKLIST PRÉ-DÉVELOPPEMENT

- [ ] Valider l'architecture avec Adrien
- [ ] Confirmer les choix (port, interface, etc.)
- [ ] Créer les issues/tasks correspondantes
- [ ] Setup environnement de test (3 containers)
- [ ] Lire doc WireGuard : https://www.wireguard.com/

---

*Document généré le 2026-02-20 via brainstorming BMAD*
*Prêt pour implémentation après validation*
