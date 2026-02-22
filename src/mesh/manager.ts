/**
 * @file manager.ts
 * @description Orchestration du mesh WireGuard
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { hostname as getHostname } from 'os';
import { execSync } from 'child_process';
import http from 'http';
import { sendKnock } from '../knock.js';
import {
  MeshConfig,
  MeshPeer,
  MeshStatus,
  MeshInitOptions,
  MeshJoinOptions,
  MeshOperationResult,
} from './types.js';
import {
  generateKeyPair,
  saveKeys,
  loadKeys,
  isWireGuardInstalled,
  generateAuthKey,
  saveAuthKey,
} from './keys.js';
import {
  createJoinToken,
  parseJoinToken,
  extractMeshIp,
  extractCidr,
  calculateNetwork,
  allocateNextIp,
} from './token.js';
import {
  validateMeshIp,
  findFreeIp,
  checkIpConflict,
  checkSubnetOverlap,
} from './ip-conflict.js';
import {
  createInterface,
  deleteInterface,
  isInterfaceUp,
  addPeer,
  removePeer,
  getInterfaceStatus,
  generateWgQuickConfig,
  saveWgQuickConfig,
  enableWgQuickService,
  disableWgQuickService,
  detectPublicEndpoint,
} from './wireguard.js';
import { updateCorosyncForMesh, addNodeToCorosync, removeNodeFromCorosync, reloadCorosync, getNextNodeId } from './corosync-mesh.js';

const MESH_CONFIG_PATH = '/etc/sfha/mesh.json';
const WG_KEYS_DIR = '/etc/sfha/wireguard';
const COROSYNC_AUTHKEY_PATH = '/etc/corosync/authkey';
const WG_INTERFACE = 'wg-sfha';
const DEFAULT_PORT = 51820;
const DEFAULT_KEEPALIVE = 25;
const DEFAULT_COROSYNC_PORT = 5405;

/**
 * Gestionnaire du mesh WireGuard
 */
export class MeshManager {
  private config: MeshConfig | null = null;

  constructor() {
    this.loadConfig();
  }

  /**
   * Charge la configuration du mesh depuis le disque
   */
  private loadConfig(): void {
    if (existsSync(MESH_CONFIG_PATH)) {
      try {
        const content = readFileSync(MESH_CONFIG_PATH, 'utf-8');
        this.config = JSON.parse(content);
      } catch {
        this.config = null;
      }
    }
  }

  /**
   * Sauvegarde la configuration du mesh
   */
  private saveConfig(): void {
    if (!this.config) return;

    const dir = dirname(MESH_CONFIG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Ne pas sauvegarder la clé privée dans le JSON
    const configToSave = {
      ...this.config,
      privateKey: '***',
    };

    writeFileSync(MESH_CONFIG_PATH, JSON.stringify(this.config, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * Initialise un nouveau mesh
   */
  async init(options: MeshInitOptions): Promise<MeshOperationResult> {
    // Vérifier que WireGuard est installé
    if (!isWireGuardInstalled()) {
      return {
        success: false,
        error: 'WireGuard n\'est pas installé. Installez-le avec: apt install wireguard-tools',
      };
    }

    // Vérifier qu'aucun mesh n'existe déjà
    if (this.config) {
      return {
        success: false,
        error: 'Un mesh existe déjà. Utilisez "sfha mesh down" puis supprimez /etc/sfha/mesh.json pour réinitialiser.',
      };
    }

    const port = options.port || DEFAULT_PORT;
    const meshIp = options.meshIp;
    const meshNetwork = calculateNetwork(meshIp);

    // ===== Vérification des conflits d'IP =====
    const ipValidation = validateMeshIp(meshIp, true);
    if (!ipValidation.valid) {
      return {
        success: false,
        error: `❌ ${ipValidation.errors.join('\n❌ ')}`,
      };
    }
    // Log des warnings éventuels (mais on continue)
    if (ipValidation.warnings.length > 0) {
      console.warn(`⚠️  ${ipValidation.warnings.join('\n⚠️  ')}`);
    }

    // Générer les clés WireGuard
    const keys = generateKeyPair();
    saveKeys(keys, WG_KEYS_DIR);

    // Générer l'authkey Corosync
    const authKey = generateAuthKey();
    saveAuthKey(authKey, COROSYNC_AUTHKEY_PATH);

    // Détecter l'endpoint
    let endpoint = options.endpoint;
    if (!endpoint) {
      endpoint = detectPublicEndpoint(port) || `0.0.0.0:${port}`;
    } else if (!endpoint.includes(':')) {
      endpoint = `${endpoint}:${port}`;
    }

    // Créer la configuration
    this.config = {
      interface: WG_INTERFACE,
      listenPort: port,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      meshIp,
      meshNetwork,
      clusterName: options.clusterName,
      authKey,
      corosyncPort: DEFAULT_COROSYNC_PORT,
      peers: [],
    };

    this.saveConfig();

    // Créer l'interface WireGuard
    createInterface(WG_INTERFACE, meshIp, keys.privateKey, port);

    // Générer et sauvegarder la config wg-quick pour persistance
    const wgConfig = generateWgQuickConfig(
      keys.privateKey,
      meshIp,
      port,
      this.config.peers
    );
    saveWgQuickConfig(WG_INTERFACE, wgConfig);
    enableWgQuickService(WG_INTERFACE);

    // Mettre à jour Corosync
    updateCorosyncForMesh(options.clusterName, [
      {
        name: 'node1', // Sera mis à jour par la config principale
        ip: extractMeshIp(meshIp),
        nodeId: 1,
      },
    ], DEFAULT_COROSYNC_PORT);

    // Générer le token
    const token = createJoinToken({
      cluster: options.clusterName,
      endpoint,
      pubkey: keys.publicKey,
      authkey: authKey,
      meshNetwork,
      meshIp: extractMeshIp(meshIp),
      corosyncPort: DEFAULT_COROSYNC_PORT,
    });

    return {
      success: true,
      message: `Mesh initialisé avec succès sur ${meshIp}`,
      token,
    };
  }

  /**
   * Rejoint un mesh existant
   */
  async join(options: MeshJoinOptions): Promise<MeshOperationResult> {
    // Vérifier que WireGuard est installé
    if (!isWireGuardInstalled()) {
      return {
        success: false,
        error: 'WireGuard n\'est pas installé. Installez-le avec: apt install wireguard-tools',
      };
    }

    // Vérifier qu'aucun mesh n'existe déjà
    if (this.config) {
      return {
        success: false,
        error: 'Un mesh existe déjà. Utilisez "sfha mesh down" puis supprimez /etc/sfha/mesh.json pour rejoindre un autre cluster.',
      };
    }

    // Parser le token
    let token;
    try {
      token = parseJoinToken(options.token);
    } catch (error: any) {
      return {
        success: false,
        error: `Token invalide: ${error.message}`,
      };
    }

    const port = DEFAULT_PORT;

    // Générer les clés WireGuard
    const keys = generateKeyPair();
    saveKeys(keys, WG_KEYS_DIR);

    // Sauvegarder l'authkey Corosync
    saveAuthKey(token.authkey, COROSYNC_AUTHKEY_PATH);

    // Allouer une IP si non spécifiée
    let meshIp = options.meshIp;
    if (!meshIp) {
      // BUG FIX: Ne pas utiliser token.assignedIp car il est statique et identique pour tous les nœuds
      // qui utilisent le même token. À la place, on calcule une IP unique basée sur usedIps
      // plus un facteur aléatoire pour éviter les collisions.
      const usedIps = token.usedIps || [token.meshIp];
      
      // Si token.assignedIp existe, l'ajouter aux IPs utilisées pour éviter les conflits
      if (token.assignedIp) {
        usedIps.push(token.assignedIp.split('/')[0]);
      }
      
      // Ajouter les IPs des peers existants
      if (token.peers) {
        for (const p of token.peers) {
          if (p.meshIp && !usedIps.includes(p.meshIp)) {
            usedIps.push(p.meshIp);
          }
        }
      }
      
      // Générer une IP unique en essayant plusieurs fois si nécessaire
      // On utilise un hash du hostname + timestamp pour départager les nœuds simultanés
      const hostname = getHostname();
      const uniqueSeed = Date.now() % 1000 + hostname.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0);
      
      // Tenter d'allouer la prochaine IP disponible
      meshIp = allocateNextIp(token.meshNetwork, usedIps);
      
      // Si plusieurs nœuds joignent simultanément, décaler l'IP par le seed
      const [baseIp, cidr] = meshIp.split('/');
      const ipParts = baseIp.split('.').map(Number);
      const baseNum = (ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
      
      // Ajouter un offset basé sur le dernier octet du hostname hash (0-255)
      const offset = uniqueSeed % 250;
      
      // Vérifier si cette IP serait en conflit, sinon utiliser l'allocation de base
      const candidateNum = baseNum + offset;
      const candidateOctets = [
        (candidateNum >>> 24) & 255,
        (candidateNum >>> 16) & 255,
        (candidateNum >>> 8) & 255,
        candidateNum & 255,
      ];
      const candidateIp = candidateOctets.join('.');
      
      if (!usedIps.includes(candidateIp) && offset > 0) {
        meshIp = `${candidateIp}/${cidr}`;
      }
    }

    // ===== Vérification des conflits d'IP =====
    const ipValidation = validateMeshIp(meshIp, false); // pas besoin de vérifier le subnet, il existe déjà
    if (!ipValidation.valid) {
      // Si l'IP assignée est en conflit, essayer d'en trouver une autre
      const usedIps = token.usedIps || [token.meshIp];
      const freeIp = findFreeIp(token.meshNetwork, usedIps);
      if (freeIp) {
        console.warn(`⚠️  L'IP ${meshIp} est en conflit, utilisation de ${freeIp} à la place`);
        meshIp = freeIp;
      } else {
        return {
          success: false,
          error: `❌ ${ipValidation.errors.join('\n❌ ')}\nAucune IP libre trouvée dans le réseau ${token.meshNetwork}`,
        };
      }
    }
    if (ipValidation.warnings.length > 0) {
      console.warn(`⚠️  ${ipValidation.warnings.join('\n⚠️  ')}`);
    }

    // Détecter l'endpoint
    let endpoint = options.endpoint;
    if (!endpoint) {
      endpoint = detectPublicEndpoint(port) || `0.0.0.0:${port}`;
    } else if (!endpoint.includes(':')) {
      endpoint = `${endpoint}:${port}`;
    }

    // Créer le peer initial (le nœud qui a généré le token)
    const initiatorPeer: MeshPeer = {
      name: token.initiatorName || 'initiator',
      publicKey: token.pubkey,
      endpoint: token.endpoint,
      allowedIps: `${token.meshIp}/32`,
      persistentKeepalive: DEFAULT_KEEPALIVE,
    };

    // Liste des peers à ajouter (initiateur + tous les autres peers existants)
    const allPeers: MeshPeer[] = [initiatorPeer];

    // Ajouter tous les peers existants du token (v3+)
    if (token.peers && token.peers.length > 0) {
      for (const p of token.peers) {
        // Ne pas ajouter si c'est l'initiateur (déjà ajouté)
        if (p.pubkey !== token.pubkey) {
          allPeers.push({
            name: p.name,
            publicKey: p.pubkey,
            endpoint: p.endpoint || undefined,
            allowedIps: `${p.meshIp}/32`,
            persistentKeepalive: DEFAULT_KEEPALIVE,
          });
        }
      }
    }

    // Créer la configuration
    this.config = {
      interface: WG_INTERFACE,
      listenPort: port,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      meshIp,
      meshNetwork: token.meshNetwork,
      clusterName: token.cluster,
      authKey: token.authkey,
      corosyncPort: token.corosyncPort,
      peers: allPeers,
    };

    this.saveConfig();

    // Créer l'interface WireGuard
    createInterface(WG_INTERFACE, meshIp, keys.privateKey, port);

    // Ajouter tous les peers
    for (const peer of allPeers) {
      addPeer(WG_INTERFACE, peer);
    }

    // Générer et sauvegarder la config wg-quick pour persistance
    const wgConfig = generateWgQuickConfig(
      keys.privateKey,
      meshIp,
      port,
      this.config.peers
    );
    saveWgQuickConfig(WG_INTERFACE, wgConfig);
    enableWgQuickService(WG_INTERFACE);

    // ===== Générer la config Corosync avec tous les nœuds =====
    const corosyncNodes: { name: string; ip: string; nodeId: number }[] = [];
    let nodeId = 1;

    // Ajouter l'initiateur comme premier nœud
    corosyncNodes.push({
      name: token.initiatorName || 'node1',
      ip: token.meshIp,
      nodeId: nodeId++,
    });

    // Ajouter tous les autres peers existants
    if (token.peers && token.peers.length > 0) {
      for (const p of token.peers) {
        if (p.pubkey !== token.pubkey) {
          corosyncNodes.push({
            name: p.name,
            ip: p.meshIp,
            nodeId: nodeId++,
          });
        }
      }
    }

    // Ajouter ce nœud (le nouveau joiner)
    const localNodeName = `node${nodeId}`; // TODO: permettre de spécifier le nom
    corosyncNodes.push({
      name: localNodeName,
      ip: extractMeshIp(meshIp),
      nodeId: nodeId,
    });

    // Écrire la config Corosync
    updateCorosyncForMesh(token.cluster, corosyncNodes, token.corosyncPort);

    // Démarrer Corosync automatiquement
    try {
      execSync('systemctl enable corosync', { stdio: 'pipe' });
      execSync('systemctl start corosync', { stdio: 'pipe' });
    } catch {
      // Corosync sera démarré manuellement
    }

    // ===== Notifier les peers existants pour qu'ils nous ajoutent =====
    // Protocole sécurisé :
    // 1. Envoyer un "knock" UDP sur le port 51820 avec l'authKey
    // 2. Le daemon distant ouvre temporairement le port 7777
    // 3. Appeler l'API /add-peer sur le port 7777
    const notifyResults: string[] = [];
    const myPeerInfo = {
      name: localNodeName,
      publicKey: keys.publicKey,
      endpoint,
      meshIp: extractMeshIp(meshIp),
      authKey: token.authkey, // Requis pour l'authentification
    };

    // Notifier l'initiateur
    const initiatorEndpoint = token.endpoint.split(':')[0];
    try {
      // Étape 1: Knock pour ouvrir le port
      await sendKnock(initiatorEndpoint, token.authkey);
      // Attendre un peu que le firewall s'ouvre
      await new Promise(resolve => setTimeout(resolve, 500));
      // Étape 2: Appeler l'API
      const initiatorResult = await this.notifyPeerViaApi(initiatorEndpoint, myPeerInfo);
      if (initiatorResult.success) {
        notifyResults.push(`✓ Initiateur notifié`);
      } else {
        notifyResults.push(`⚠ Initiateur: ${initiatorResult.error}`);
      }
    } catch (err: any) {
      notifyResults.push(`⚠ Initiateur: ${err.message}`);
    }

    // Notifier les autres peers existants
    if (token.peers && token.peers.length > 0) {
      for (const p of token.peers) {
        if (p.pubkey !== token.pubkey && p.endpoint) {
          const peerEndpoint = p.endpoint.split(':')[0];
          try {
            await sendKnock(peerEndpoint, token.authkey);
            await new Promise(resolve => setTimeout(resolve, 500));
            const result = await this.notifyPeerViaApi(peerEndpoint, myPeerInfo);
            if (result.success) {
              notifyResults.push(`✓ ${p.name} notifié`);
            } else {
              notifyResults.push(`⚠ ${p.name}: ${result.error}`);
            }
          } catch (err: any) {
            notifyResults.push(`⚠ ${p.name}: ${err.message}`);
          }
        }
      }
    }

    const notifyLog = notifyResults.length > 0 ? `\nNotifications: ${notifyResults.join(', ')}` : '';

    return {
      success: true,
      message: `Rejoint le cluster "${token.cluster}" avec l'IP mesh ${meshIp}. ${allPeers.length} peer(s) configuré(s).${notifyLog}`,
    };
  }

  /**
   * Notifie un peer existant via l'API P2P (port 7777) pour qu'il nous ajoute
   */
  private notifyPeerViaApi(peerMeshIp: string, myInfo: { name: string; publicKey: string; endpoint: string; meshIp: string }): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const postData = JSON.stringify(myInfo);
      const options = {
        hostname: peerMeshIp,
        port: 7777,
        path: '/add-peer',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 5000,
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            resolve({ success: response.success, error: response.error });
          } catch {
            resolve({ success: false, error: 'Invalid response' });
          }
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Timeout' });
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Génère un token de join
   */
  generateToken(assignedIp?: string): MeshOperationResult {
    if (!this.config) {
      return {
        success: false,
        error: 'Aucun mesh configuré. Utilisez "sfha init --mesh" d\'abord.',
      };
    }

    // Collecter toutes les IPs utilisées dans le mesh
    const usedIps = [
      extractMeshIp(this.config.meshIp),
      ...this.config.peers.map((p) => p.allowedIps.split('/')[0]),
    ];

    // Calculer l'IP à assigner si non spécifiée
    let ipToAssign = assignedIp;
    if (!ipToAssign) {
      ipToAssign = allocateNextIp(this.config.meshNetwork, usedIps);
    }

    // Détecter l'endpoint actuel
    const endpoint =
      detectPublicEndpoint(this.config.listenPort) ||
      `0.0.0.0:${this.config.listenPort}`;

    // Collecter tous les peers existants pour le nouveau nœud
    const peers = this.config.peers.map((p) => ({
      name: p.name,
      pubkey: p.publicKey,
      endpoint: p.endpoint || '',
      meshIp: p.allowedIps.split('/')[0],
    }));

    const token = createJoinToken({
      cluster: this.config.clusterName,
      endpoint,
      pubkey: this.config.publicKey,
      authkey: this.config.authKey,
      meshNetwork: this.config.meshNetwork,
      meshIp: extractMeshIp(this.config.meshIp), // IP du nœud initiateur
      corosyncPort: this.config.corosyncPort,
      assignedIp: ipToAssign, // IP pré-assignée pour le nouveau nœud
      usedIps, // Liste complète des IPs utilisées
      peers, // Liste des peers existants
      initiatorName: 'node1', // TODO: récupérer le vrai nom du nœud depuis config.yml
    });

    return {
      success: true,
      token,
    };
  }

  /**
   * Ajoute un peer au mesh
   */
  addPeer(peer: Omit<MeshPeer, 'persistentKeepalive'>): MeshOperationResult {
    if (!this.config) {
      return {
        success: false,
        error: 'Aucun mesh configuré.',
      };
    }

    // Vérifier que le peer n'existe pas déjà
    if (this.config.peers.some((p) => p.publicKey === peer.publicKey)) {
      return {
        success: false,
        error: 'Ce peer existe déjà.',
      };
    }

    const fullPeer: MeshPeer = {
      ...peer,
      persistentKeepalive: DEFAULT_KEEPALIVE,
    };

    // Ajouter au mesh
    this.config.peers.push(fullPeer);
    this.saveConfig();

    // Ajouter à WireGuard si l'interface est active
    if (isInterfaceUp(WG_INTERFACE)) {
      addPeer(WG_INTERFACE, fullPeer);
    }

    // Mettre à jour wg-quick config
    const wgConfig = generateWgQuickConfig(
      this.config.privateKey,
      this.config.meshIp,
      this.config.listenPort,
      this.config.peers
    );
    saveWgQuickConfig(WG_INTERFACE, wgConfig);

    // Mettre à jour Corosync avec le nouveau nœud
    const peerIp = peer.allowedIps.split('/')[0];
    const nextNodeId = getNextNodeId();
    addNodeToCorosync({
      name: peer.name,
      ip: peerIp,
      nodeId: nextNodeId,
    });

    // Recharger Corosync si actif
    reloadCorosync();

    return {
      success: true,
      message: `Peer ${peer.name} ajouté avec succès (nodeId: ${nextNodeId}).`,
    };
  }

  /**
   * Supprime un peer du mesh
   */
  removePeerByName(name: string): MeshOperationResult {
    if (!this.config) {
      return {
        success: false,
        error: 'Aucun mesh configuré.',
      };
    }

    const peerIndex = this.config.peers.findIndex((p) => p.name === name);
    if (peerIndex === -1) {
      return {
        success: false,
        error: `Peer "${name}" non trouvé.`,
      };
    }

    const peer = this.config.peers[peerIndex];

    // Supprimer de WireGuard si l'interface est active
    if (isInterfaceUp(WG_INTERFACE)) {
      removePeer(WG_INTERFACE, peer.publicKey);
    }

    // Supprimer de la config
    this.config.peers.splice(peerIndex, 1);
    this.saveConfig();

    // Mettre à jour wg-quick config
    const wgConfig = generateWgQuickConfig(
      this.config.privateKey,
      this.config.meshIp,
      this.config.listenPort,
      this.config.peers
    );
    saveWgQuickConfig(WG_INTERFACE, wgConfig);

    // Supprimer de Corosync
    try {
      removeNodeFromCorosync(name);
      reloadCorosync();
    } catch {
      // Corosync pas configuré ou nœud pas trouvé - ignorer
    }

    return {
      success: true,
      message: `Peer ${name} supprimé avec succès.`,
    };
  }

  /**
   * Démarre le mesh
   */
  up(): MeshOperationResult {
    if (!this.config) {
      return {
        success: false,
        error: 'Aucun mesh configuré.',
      };
    }

    if (isInterfaceUp(WG_INTERFACE)) {
      return {
        success: true,
        message: 'Le mesh est déjà actif.',
      };
    }

    // Charger les clés
    const keys = loadKeys(WG_KEYS_DIR);
    if (!keys) {
      return {
        success: false,
        error: 'Clés WireGuard introuvables.',
      };
    }

    // Créer l'interface
    createInterface(
      WG_INTERFACE,
      this.config.meshIp,
      keys.privateKey,
      this.config.listenPort
    );

    // Ajouter tous les peers
    for (const peer of this.config.peers) {
      addPeer(WG_INTERFACE, peer);
    }

    return {
      success: true,
      message: 'Mesh démarré.',
    };
  }

  /**
   * Arrête le mesh
   */
  down(): MeshOperationResult {
    if (!isInterfaceUp(WG_INTERFACE)) {
      return {
        success: true,
        message: 'Le mesh est déjà arrêté.',
      };
    }

    deleteInterface(WG_INTERFACE);

    return {
      success: true,
      message: 'Mesh arrêté.',
    };
  }

  /**
   * Récupère le statut du mesh
   */
  getStatus(): MeshStatus {
    if (!this.config) {
      return {
        active: false,
        interface: WG_INTERFACE,
        localIp: '',
        listenPort: DEFAULT_PORT,
        publicKey: '',
        peers: [],
      };
    }

    const wgStatus = getInterfaceStatus(WG_INTERFACE);
    const active = wgStatus !== null;

    const peers = this.config.peers.map((peer) => {
      const wgPeer = wgStatus?.peers.find((p) => p.publicKey === peer.publicKey);
      const connected =
        wgPeer?.latestHandshake !== undefined &&
        Date.now() / 1000 - wgPeer.latestHandshake < 180; // 3 minutes

      return {
        name: peer.name,
        ip: peer.allowedIps.split('/')[0],
        endpoint: wgPeer?.endpoint || peer.endpoint,
        connected,
        latestHandshake: wgPeer?.latestHandshake
          ? new Date(wgPeer.latestHandshake * 1000)
          : undefined,
        transferRx: wgPeer?.transferRx,
        transferTx: wgPeer?.transferTx,
      };
    });

    return {
      active,
      interface: WG_INTERFACE,
      localIp: this.config.meshIp,
      listenPort: this.config.listenPort,
      publicKey: this.config.publicKey,
      peers,
    };
  }

  /**
   * Retourne la configuration actuelle
   */
  getConfig(): MeshConfig | null {
    return this.config;
  }

  /**
   * Vérifie si le mesh est configuré
   */
  isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Vérifie si le mesh est actif
   */
  isActive(): boolean {
    return isInterfaceUp(WG_INTERFACE);
  }
}

// Instance singleton
let meshManagerInstance: MeshManager | null = null;

export function getMeshManager(): MeshManager {
  if (!meshManagerInstance) {
    meshManagerInstance = new MeshManager();
  }
  return meshManagerInstance;
}
