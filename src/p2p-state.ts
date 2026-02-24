/**
 * @file p2p-state.ts
 * @description Coordination P2P de l'état des nœuds via HTTP
 * 
 * Chaque nœud sfha expose un petit serveur HTTP sur un port dédié (default: 7777)
 * qui permet aux autres nœuds de connaître son état (standby, leader, etc.)
 * 
 * Cela résout le problème de cmapctl qui n'est pas répliqué entre nœuds.
 * 
 * Endpoints:
 * - GET /state : État du nœud (standby, leader)
 * - GET /health : Health check simple
 * - POST /add-peer : Ajouter un peer au mesh (appelé par les nœuds qui rejoignent)
 */

import http, { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import os from 'os';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { getClusterNodes } from './corosync.js';
import { logger } from './utils/logger.js';
import { getMeshManager } from './mesh/manager.js';
import { addPeerToState } from './cluster-state.js';
import { isIpAuthorized, authorizePermanently, sendKnock } from './knock.js';
import { getCorosyncNodes, updateCorosyncForMesh, reloadCorosync, MeshNode } from './mesh/corosync-mesh.js';
import { loadConfig } from './config.js';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

// ============================================
// Types
// ============================================

export interface NodeState {
  name: string;
  standby: boolean;
  isLeader: boolean;
  timestamp: number;
}

export interface AddPeerRequest {
  name: string;
  publicKey: string;
  endpoint: string;
  meshIp: string;
  propagated?: boolean; // True si cette requête est une propagation (évite les boucles infinies)
}

export interface AddPeerResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface P2PStateConfig {
  port: number;
  pollIntervalMs: number;
  bindAddress?: string; // IP sur laquelle binder (défaut: 127.0.0.1 pour sécurité)
}

// ============================================
// Constants
// ============================================

const DEFAULT_PORT = 7777;
const DEFAULT_POLL_INTERVAL = 5000;
const REQUEST_TIMEOUT = 2000;

// ============================================
// P2P State Manager
// ============================================

/**
 * Gestionnaire d'état P2P
 * Expose l'état local et récupère l'état des autres nœuds
 */
export class P2PStateManager {
  private server: Server | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private config: P2PStateConfig;
  
  // État local
  private localNodeName: string = '';
  private localStandby: boolean = false;
  private localIsLeader: boolean = false;
  
  // États des autres nœuds (nodeIp -> NodeState)
  private remoteStates: Map<string, NodeState> = new Map();
  
  // Callback quand un état change
  private onStateChangeCallback: ((states: Map<string, NodeState>) => void) | null = null;

  constructor(config?: Partial<P2PStateConfig>) {
    this.config = {
      port: config?.port ?? DEFAULT_PORT,
      pollIntervalMs: config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL,
      bindAddress: config?.bindAddress ?? '127.0.0.1', // Sécurité: localhost par défaut
    };
  }

  /**
   * Démarre le serveur HTTP et le polling
   */
  start(nodeName: string): void {
    this.localNodeName = nodeName;
    
    // Démarrer le serveur HTTP
    this.startServer();
    
    // Démarrer le polling des autres nœuds
    this.startPolling();
    
    logger.info(`P2P State: démarré sur port ${this.config.port}`);
  }

  /**
   * Arrête le serveur et le polling
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    
    logger.info('P2P State: arrêté');
  }

  /**
   * Met à jour l'état local
   */
  setLocalState(standby: boolean, isLeader: boolean): void {
    this.localStandby = standby;
    this.localIsLeader = isLeader;
  }

  /**
   * Récupère l'état standby de tous les nœuds distants
   */
  getStandbyNodes(): Set<string> {
    const standbyNodes = new Set<string>();
    
    for (const [, state] of this.remoteStates) {
      if (state.standby) {
        standbyNodes.add(state.name);
      }
    }
    
    return standbyNodes;
  }

  /**
   * Définit un callback pour les changements d'état
   */
  onStateChange(callback: (states: Map<string, NodeState>) => void): void {
    this.onStateChangeCallback = callback;
  }

  /**
   * Démarre le serveur HTTP local
   */
  private startServer(): void {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Vérifier si l'IP source est autorisée
      // On retourne 404 au lieu de 403 pour ne pas révéler l'existence du service
      const clientIp = req.socket.remoteAddress?.replace('::ffff:', '') || '';
      if (!isIpAuthorized(clientIp)) {
        logger.debug(`P2P: Connexion ignorée de ${clientIp} (non autorisé)`);
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      
      // Simple endpoint GET /state
      if (req.method === 'GET' && req.url === '/state') {
        const state: NodeState = {
          name: this.localNodeName,
          standby: this.localStandby,
          isLeader: this.localIsLeader,
          timestamp: Date.now(),
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }
      
      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end('OK');
        return;
      }
      
      // Simple ping endpoint - NO AUTH required (used for sfha daemon health detection)
      // Returns { ok: true } if sfha daemon is running and responding
      if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      
      // Info endpoint - returns node hostname for proper naming during propagation
      // NO AUTH required (called during propagation to get real hostnames)
      if (req.method === 'GET' && req.url === '/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hostname: os.hostname() }));
        return;
      }
      
      // Add peer endpoint - called by joining nodes to register themselves
      // SECURITY: Requires valid cluster authKey in request
      if (req.method === 'POST' && req.url === '/add-peer') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const peerData = JSON.parse(body) as AddPeerRequest & { authKey?: string };
            
            // Validate required fields
            if (!peerData.name || !peerData.publicKey || !peerData.endpoint || !peerData.meshIp) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Missing required fields: name, publicKey, endpoint, meshIp' }));
              return;
            }
            
            // SECURITY: Verify authKey matches cluster authKey
            const mesh = getMeshManager();
            const meshConfig = mesh.getConfig();
            if (!meshConfig) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'No mesh configured' }));
              return;
            }
            
            if (!peerData.authKey || peerData.authKey !== meshConfig.authKey) {
              logger.debug(`P2P: Rejected add-peer from ${peerData.meshIp} - invalid authKey`);
              res.writeHead(404);
              res.end('Not Found');
              return;
            }
            
            // Add the peer using MeshManager
            // Nettoyer le meshIp au cas où il contient déjà un CIDR
            const cleanMeshIp = peerData.meshIp.split('/')[0];
            const result = mesh.addPeer({
              name: peerData.name,
              publicKey: peerData.publicKey,
              endpoint: peerData.endpoint,
              allowedIps: `${cleanMeshIp}/32`,
            });
            
            if (result.success) {
              logger.info(`P2P: Added peer ${peerData.name} (${peerData.meshIp}) via API`);
              
              // Marquer le timestamp pour éviter les syncs trop rapides
              lastJoinReceived = Date.now();
              
              // Autoriser l'IP publique ET mesh de ce peer de façon permanente
              if (peerData.endpoint) {
                const peerIp = peerData.endpoint.split(':')[0];
                authorizePermanently(peerIp);
              }
              authorizePermanently(cleanMeshIp);
              logger.debug(`P2P: Authorized IPs for ${peerData.name}: public=${peerData.endpoint?.split(':')[0]}, mesh=${cleanMeshIp}`);
              
              // NOTE: Pas de propagation automatique aux autres nœuds.
              // L'utilisateur doit exécuter 'sfha propagate' sur le leader pour synchroniser.
              // Cela évite les race conditions et les cascades de restart.
              
              if (!peerData.propagated) {
                logger.info(`P2P: Peer ${peerData.name} enregistré. Exécutez 'sfha propagate' pour synchroniser tous les nœuds.`);
                
                // Mettre à jour l'état du cluster (phase: collecting)
                const peerPublicIp = peerData.endpoint?.split(':')[0];
                addPeerToState(peerData.name, cleanMeshIp, peerPublicIp);
              }
              
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: result.message }));
            } else {
              logger.warn(`P2P: Failed to add peer ${peerData.name}: ${result.error}`);
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: result.error }));
            }
          } catch (err: any) {
            logger.error(`P2P: Error parsing add-peer request: ${err.message}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
          }
        });
        return;
      }
      
      // ===== GET /corosync-nodes =====
      // Retourne la liste complète des nœuds du corosync.conf local
      // SECURITY: Requires valid authKey in query or header
      if (req.method === 'GET' && req.url?.startsWith('/corosync-nodes')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const authKey = url.searchParams.get('authKey') || req.headers['x-auth-key'] as string;
        
        const mesh = getMeshManager();
        const meshConfig = mesh.getConfig();
        
        if (!meshConfig) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No mesh configured' }));
          return;
        }
        
        if (!authKey || authKey !== meshConfig.authKey) {
          logger.debug(`P2P: Rejected corosync-nodes request - invalid authKey`);
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        
        const nodes = getCorosyncNodes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          clusterName: meshConfig.clusterName,
          corosyncPort: meshConfig.corosyncPort,
          nodes 
        }));
        return;
      }
      
      // ===== GET /mesh-peers =====
      // Retourne la liste complète des peers WireGuard
      // SECURITY: Requires valid authKey in query or header
      if (req.method === 'GET' && req.url?.startsWith('/mesh-peers')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const authKey = url.searchParams.get('authKey') || req.headers['x-auth-key'] as string;
        
        const mesh = getMeshManager();
        const meshConfig = mesh.getConfig();
        
        if (!meshConfig) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No mesh configured' }));
          return;
        }
        
        if (!authKey || authKey !== meshConfig.authKey) {
          logger.debug(`P2P: Rejected mesh-peers request - invalid authKey`);
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        
        // Retourner tous les peers avec leurs infos complètes
        const peers = meshConfig.peers.map(p => ({
          name: p.name,
          publicKey: p.publicKey,
          endpoint: p.endpoint,
          meshIp: p.allowedIps?.split('/')[0] || '',
        }));
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          peers,
        }));
        return;
      }
      
      // ===== POST /sync-corosync =====
      // Reçoit une nodelist complète et réécrit le corosync.conf local
      // SECURITY: Requires valid authKey in request body
      if (req.method === 'POST' && req.url === '/sync-corosync') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as { 
              authKey?: string; 
              clusterName: string;
              corosyncPort?: number;
              nodes: MeshNode[];
            };
            
            const mesh = getMeshManager();
            const meshConfig = mesh.getConfig();
            
            if (!meshConfig) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'No mesh configured' }));
              return;
            }
            
            if (!data.authKey || data.authKey !== meshConfig.authKey) {
              logger.debug(`P2P: Rejected sync-corosync request - invalid authKey`);
              res.writeHead(404);
              res.end('Not Found');
              return;
            }
            
            if (!data.nodes || !Array.isArray(data.nodes) || data.nodes.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Missing or empty nodes array' }));
              return;
            }
            
            // Vérifier si la config locale a plus de nodes - ne pas écraser une config plus complète
            const localNodes = getCorosyncNodes();
            if (localNodes.length > data.nodes.length) {
              logger.info(`P2P: Ignoring sync-corosync with ${data.nodes.length} nodes (local has ${localNodes.length})`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: 'Local config is more complete, keeping it' }));
              return;
            }
            
            // Réécrire le corosync.conf avec la nouvelle nodelist
            const corosyncPort = data.corosyncPort || meshConfig.corosyncPort || 5405;
            updateCorosyncForMesh(data.clusterName, data.nodes, corosyncPort);
            
            // Recharger Corosync
            reloadCorosync();
            
            logger.info(`P2P: Synced corosync.conf with ${data.nodes.length} nodes`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Synced ${data.nodes.length} nodes` }));
          } catch (err: any) {
            logger.error(`P2P: Error parsing sync-corosync request: ${err.message}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
          }
        });
        return;
      }
      
      // ===== POST /full-config =====
      // Reçoit la config complète (WireGuard + Corosync) et l'applique
      // Utilisé par 'sfha propagate' pour configurer les nœuds après un joinSimple
      if (req.method === 'POST' && req.url === '/full-config') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body) as {
              authKey?: string;
              clusterName: string;
              corosyncPort?: number;
              corosyncNodes: MeshNode[];
              wgPeers: Array<{ name: string; publicKey: string; endpoint: string; meshIp: string }>;
              nodeId: number;
              vips?: Array<{ name: string; ip: string; cidr: number; interface: string }>;
              services?: Array<any>;
              constraints?: Array<any>;
            };
            
            const mesh = getMeshManager();
            const meshConfig = mesh.getConfig();
            
            if (!meshConfig) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'No mesh configured' }));
              return;
            }
            
            if (!data.authKey || data.authKey !== meshConfig.authKey) {
              logger.debug(`P2P: Rejected full-config request - invalid authKey`);
              res.writeHead(404);
              res.end('Not Found');
              return;
            }
            
            logger.info(`P2P: Receiving full config (${data.wgPeers.length} WG peers, ${data.corosyncNodes.length} Corosync nodes)`);
            
            // 1. D'ABORD créer corosync.conf (avant d'ajouter les peers qui appellent addNodeToCorosync)
            const corosyncPort = data.corosyncPort || meshConfig.corosyncPort || 5405;
            updateCorosyncForMesh(data.clusterName, data.corosyncNodes, corosyncPort);
            logger.info(`P2P: Created corosync.conf with ${data.corosyncNodes.length} nodes`);
            
            // 2. ENSUITE ajouter les peers WireGuard (skipCorosync=true car déjà configuré)
            for (const peer of data.wgPeers) {
              const exists = meshConfig.peers.some(p => p.publicKey === peer.publicKey);
              if (!exists) {
                mesh.addPeerWgOnly({
                  name: peer.name,
                  publicKey: peer.publicKey,
                  endpoint: peer.endpoint,
                  allowedIps: `${peer.meshIp}/32`,
                });
                logger.info(`P2P: Added WG peer ${peer.name} (${peer.meshIp})`);
              }
            }
            
            // 3. Créer/mettre à jour le fichier config.yml
            const configPath = '/etc/sfha/config.yml';
            const hostname = os.hostname();
            
            // Générer les VIPs en YAML
            let vipsYaml = '';
            if (data.vips && data.vips.length > 0) {
              vipsYaml = data.vips.map(v => 
                `  - name: ${v.name}\n    ip: ${v.ip}\n    cidr: ${v.cidr}\n    interface: ${v.interface}`
              ).join('\n');
            }
            
            // Générer les services en YAML  
            let servicesYaml = '';
            if (data.services && data.services.length > 0) {
              // Pour l'instant on stringify basiquement
              servicesYaml = data.services.map((s: any) => {
                let yaml = `  - name: ${s.name}\n    type: ${s.type || 'systemd'}`;
                if (s.unit) yaml += `\n    unit: ${s.unit}`;
                return yaml;
              }).join('\n');
            }
            
            // Toujours régénérer la config pour avoir les VIPs à jour
            const configContent = `# Configuration sfha - générée par sfha propagate
cluster:
  name: ${data.clusterName}
  quorum_required: true
  failover_delay_ms: 3000
  poll_interval_ms: 2000
node:
  name: ${hostname}
  priority: ${100 - data.nodeId * 10}
vips:
${vipsYaml || '  []'}
services:
${servicesYaml || '  []'}
`;
            writeFileSync(configPath, configContent);
            logger.info(`P2P: Config.yml updated for ${hostname} with ${data.vips?.length || 0} VIPs`)
            
            // 4. NE PAS démarrer Corosync maintenant - attendre que TOUS les nœuds soient configurés
            // Le leader enverra /reload-services quand tout sera prêt
            logger.info(`P2P: Config applied, waiting for reload signal`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Config applied, waiting for reload' }));
          } catch (err: any) {
            logger.error(`P2P: Error parsing full-config request: ${err.message}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
      
      // ===== POST /reload-services =====
      // Appelé par le leader APRÈS que tous les nœuds ont reçu leur config
      // Démarre/restart Corosync et sfha
      if (req.method === 'POST' && req.url === '/reload-services') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as { authKey?: string };
            
            const mesh = getMeshManager();
            const meshConfig = mesh.getConfig();
            
            if (!meshConfig) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'No mesh configured' }));
              return;
            }
            
            if (!data.authKey || data.authKey !== meshConfig.authKey) {
              res.writeHead(404);
              res.end('Not Found');
              return;
            }
            
            logger.info(`P2P: Reload signal received, starting services...`);
            
            // Démarrer/hot-reload Corosync et sfha
            // IMPORTANT: On utilise corosync-cfgtool -R pour hot-reload, PAS restart
            // restart corosync corrompt l'état du cluster et cause des split-brain
            try {
              // Corosync: enable + start si pas running, sinon hot-reload
              execSync('systemctl enable corosync 2>/dev/null || true', { stdio: 'pipe' });
              const corosyncRunning = execSync('systemctl is-active corosync 2>/dev/null || echo inactive', { encoding: 'utf-8' }).trim();
              if (corosyncRunning === 'active') {
                // Hot-reload: recharge la config sans perdre l'état
                execSync('corosync-cfgtool -R 2>/dev/null || true', { stdio: 'pipe' });
                logger.info(`P2P: Corosync hot-reloaded (cfgtool -R)`);
              } else {
                // Premier démarrage
                execSync('systemctl start corosync 2>/dev/null || true', { stdio: 'pipe' });
                logger.info(`P2P: Corosync started`);
              }
              execSync('sleep 2', { stdio: 'pipe' });
              // sfha: enable + reload si running, sinon start
              execSync('systemctl enable sfha 2>/dev/null || true', { stdio: 'pipe' });
              const sfhaRunning = execSync('systemctl is-active sfha 2>/dev/null || echo inactive', { encoding: 'utf-8' }).trim();
              if (sfhaRunning === 'active') {
                execSync('sfha reload 2>/dev/null || true', { stdio: 'pipe' });
                logger.info(`P2P: sfha reloaded`);
              } else {
                execSync('systemctl start sfha 2>/dev/null || true', { stdio: 'pipe' });
                logger.info(`P2P: sfha started`);
              }
            } catch (e: any) {
              logger.warn(`P2P: Error with services: ${e.message}`);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Services restarted' }));
          } catch (err: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
      
      // ===== POST /forward-vip-change =====
      // Reçoit une demande de modification VIP d'un follower et la propage
      // Appelé par les followers pour que le leader propage les changements
      if (req.method === 'POST' && req.url === '/forward-vip-change') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body) as { 
              authKey?: string;
              action: 'add' | 'remove';
              vip?: { name: string; ip: string; cidr: number; interface: string };
              vipName?: string;
            };
            
            const mesh = getMeshManager();
            const meshConfig = mesh.getConfig();
            
            if (!meshConfig) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'No mesh configured' }));
              return;
            }
            
            if (!data.authKey || data.authKey !== meshConfig.authKey) {
              res.writeHead(404);
              res.end('Not Found');
              return;
            }
            
            logger.info(`P2P: Received VIP ${data.action} request from follower`);
            
            // Apply the change to local config first
            const configPath = '/etc/sfha/config.yml';
            if (!existsSync(configPath)) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Config file not found' }));
              return;
            }
            
            const configContent = readFileSync(configPath, 'utf-8');
            const config = yamlParse(configContent);
            
            if (!config.vips) {
              config.vips = [];
            }
            
            if (data.action === 'add' && data.vip) {
              // Check if VIP already exists
              const existing = config.vips.find((v: any) => v.name === data.vip!.name);
              if (existing) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `VIP "${data.vip.name}" already exists` }));
                return;
              }
              config.vips.push(data.vip);
              logger.info(`P2P: Added VIP ${data.vip.name} (${data.vip.ip}/${data.vip.cidr})`);
            } else if (data.action === 'remove' && data.vipName) {
              const index = config.vips.findIndex((v: any) => v.name === data.vipName);
              if (index === -1) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `VIP "${data.vipName}" not found` }));
                return;
              }
              const removed = config.vips.splice(index, 1)[0];
              logger.info(`P2P: Removed VIP ${data.vipName} (${removed.ip}/${removed.cidr})`);
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Invalid action or missing parameters' }));
              return;
            }
            
            // Write config
            writeFileSync(configPath, yamlStringify(config, { indent: 2 }));
            
            // Reload local sfha
            try {
              execSync('sfha reload', { stdio: 'pipe' });
            } catch {
              // Ignore reload errors
            }
            
            // Propagate VIPs to all peers
            const propagateResult = await propagateVipsToAllPeers();
            
            if (propagateResult.success) {
              logger.info(`P2P: VIP change propagated to ${propagateResult.succeeded}/${propagateResult.total} peers`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                success: true, 
                message: `VIP ${data.action} applied and propagated to ${propagateResult.succeeded} peers` 
              }));
            } else {
              logger.warn(`P2P: VIP propagation partially failed: ${propagateResult.failed}/${propagateResult.total} peers failed`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                success: true, 
                message: `VIP ${data.action} applied, but propagation had ${propagateResult.failed} failures`,
                propagateResult 
              }));
            }
          } catch (err: any) {
            logger.error(`P2P: Error handling forward-vip-change: ${err.message}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
      
      // ===== POST /sync-vips =====
      // Synchronise les VIPs depuis le leader vers ce nœud
      if (req.method === 'POST' && req.url === '/sync-vips') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body) as { 
              authKey?: string;
              vips: Array<{ name: string; ip: string; cidr: number; interface: string }>;
            };
            
            const mesh = getMeshManager();
            const meshConfig = mesh.getConfig();
            
            if (!meshConfig) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'No mesh configured' }));
              return;
            }
            
            if (!data.authKey || data.authKey !== meshConfig.authKey) {
              res.writeHead(404);
              res.end('Not Found');
              return;
            }
            
            logger.info(`P2P: Syncing ${data.vips.length} VIPs from leader`);
            
            // Read current config
            const configPath = '/etc/sfha/config.yml';
            if (!existsSync(configPath)) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Config file not found' }));
              return;
            }
            
            const configContent = readFileSync(configPath, 'utf-8');
            const config = yamlParse(configContent);
            
            // Update vips
            config.vips = data.vips;
            
            // Write back
            writeFileSync(configPath, yamlStringify(config, { indent: 2 }));
            logger.info(`P2P: VIPs synced, scheduling reload...`);
            
            // Send response FIRST, then reload asynchronously
            // This avoids blocking the socket during reload
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Synced ${data.vips.length} VIPs` }));
            
            // Reload sfha after response is sent (async)
            // Use systemctl to send SIGHUP which triggers reload
            setTimeout(() => {
              try {
                execSync('systemctl kill -s SIGHUP sfha', { stdio: 'pipe', timeout: 5000 });
                logger.info(`P2P: sfha reloaded via SIGHUP after VIP sync`);
              } catch (reloadErr: any) {
                logger.warn(`P2P: sfha reload failed: ${reloadErr.message}`);
              }
            }, 100);
          } catch (err: any) {
            logger.error(`P2P: Error syncing VIPs: ${err.message}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        });
        return;
      }
      
      res.writeHead(404);
      res.end('Not Found');
    });
    
    this.server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`P2P State: port ${this.config.port} déjà utilisé`);
      } else {
        logger.error(`P2P State: erreur serveur: ${err.message}`);
      }
    });
    
    const bindAddr = this.config.bindAddress || '127.0.0.1';
    this.server.listen(this.config.port, bindAddr);
    logger.info(`P2P State: écoute sur ${bindAddr}:${this.config.port}`);
  }

  /**
   * Démarre le polling des autres nœuds
   */
  private startPolling(): void {
    // Premier poll immédiat
    this.pollAllNodes();
    
    // Puis périodiquement
    this.pollInterval = setInterval(() => {
      this.pollAllNodes();
    }, this.config.pollIntervalMs);
  }

  /**
   * Poll tous les nœuds du cluster
   */
  private async pollAllNodes(): Promise<void> {
    const nodes = getClusterNodes();
    let changed = false;
    
    for (const node of nodes) {
      // Skip le nœud local
      if (node.name === this.localNodeName) continue;
      
      // Skip les nœuds offline
      if (!node.online) {
        if (this.remoteStates.has(node.ip)) {
          this.remoteStates.delete(node.ip);
          changed = true;
        }
        continue;
      }
      
      try {
        const state = await this.fetchNodeState(node.ip);
        if (state) {
          const oldState = this.remoteStates.get(node.ip);
          if (!oldState || oldState.standby !== state.standby || oldState.isLeader !== state.isLeader) {
            changed = true;
            logger.debug(`P2P State: ${node.name} standby=${state.standby} leader=${state.isLeader}`);
          }
          this.remoteStates.set(node.ip, state);
        }
      } catch (err) {
        // Nœud injoignable, supprimer son état
        if (this.remoteStates.has(node.ip)) {
          this.remoteStates.delete(node.ip);
          changed = true;
        }
      }
    }
    
    if (changed) {
      logger.info(`P2P State: changement détecté, ${this.remoteStates.size} nœuds distants`);
      for (const [ip, state] of this.remoteStates) {
        logger.info(`  - ${state.name} (${ip}): standby=${state.standby}, leader=${state.isLeader}`);
      }
      if (this.onStateChangeCallback) {
        this.onStateChangeCallback(this.remoteStates);
      }
    }
  }

  /**
   * Récupère l'état d'un nœud via HTTP
   */
  private fetchNodeState(ip: string): Promise<NodeState | null> {
    return new Promise((resolve) => {
      const url = `http://${ip}:${this.config.port}/state`;
      
      // Timeout manuel car http.get n'a pas de timeout simple
      const timeout = setTimeout(() => {
        resolve(null);
      }, REQUEST_TIMEOUT);
      
      const req = http.get(url, (res) => {
          let data = '';
          
          res.on('data', (chunk) => {
            data += chunk;
          });
          
          res.on('end', () => {
            clearTimeout(timeout);
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });
        });
        
        req.on('error', () => {
          clearTimeout(timeout);
          resolve(null);
        });
        
        req.on('timeout', () => {
          req.destroy();
          clearTimeout(timeout);
          resolve(null);
        });
    });
  }
}

// ============================================
// Helper functions
// ============================================


/**
 * Attend que le handshake WireGuard soit établi avec un peer
 * @param peerPublicKey Clé publique du peer
 * @param maxWaitMs Temps max d'attente (défaut: 30s)
 * @param pollIntervalMs Intervalle de polling (défaut: 500ms)
 * @returns true si handshake établi, false si timeout
 */
export async function waitForWgHandshake(
  peerPublicKey: string,
  maxWaitMs: number = 30000,
  pollIntervalMs: number = 500
): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const output = execSync('wg show wg-sfha', { encoding: 'utf-8', timeout: 5000 });
      
      // Chercher le peer et vérifier s'il a un "latest handshake"
      const lines = output.split('\n');
      let foundPeer = false;
      
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`peer: ${peerPublicKey}`)) {
          foundPeer = true;
        }
        if (foundPeer && lines[i].includes('latest handshake:')) {
          logger.debug(`WireGuard handshake established with peer ${peerPublicKey.substring(0, 8)}...`);
          return true;
        }
        // Reset si on trouve un autre peer
        if (foundPeer && lines[i].includes('peer:') && !lines[i].includes(peerPublicKey)) {
          foundPeer = false;
        }
      }
    } catch {
      // wg show failed, retry
    }
    
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  
  logger.warn(`WireGuard handshake timeout for peer ${peerPublicKey.substring(0, 8)}... after ${maxWaitMs}ms`);
  return false;
}

/**
 * Helper HTTP POST avec timeout configurable
 */
function httpPost(
  host: string,
  port: number,
  path: string,
  data: object,
  timeoutMs: number
): Promise<{ success: boolean; error?: string; data?: any }> {
  return new Promise((resolve) => {
    const postData = JSON.stringify(data);
    const options = {
      hostname: host,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(responseData);
          resolve({ success: response.success, error: response.error, data: response });
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
 * Helper HTTP GET avec timeout configurable
 */
function httpGet(
  host: string,
  port: number,
  path: string,
  timeoutMs: number
): Promise<{ success: boolean; error?: string; data?: any }> {
  return new Promise((resolve) => {
    const options = {
      hostname: host,
      port,
      path,
      method: 'GET',
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(responseData);
          resolve({ success: true, data: response });
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

    req.end();
  });
}

/**
 * Propage un nouveau peer vers un nœud existant
 * Hybrid bootstrap: essaie d'abord l'IP mesh (2s), puis fallback sur IP publique (5s)
 * Utilisé pour que tous les nœuds connaissent tous les peers WireGuard
 */
export async function propagatePeerToNode(
  meshIp: string,
  publicIp: string | undefined,
  peerData: AddPeerRequest & { authKey: string; propagated: boolean }
): Promise<{ success: boolean; error?: string }> {
  // Étape 1: Essayer via l'IP mesh (timeout court car tunnel peut ne pas être établi)
  const meshResult = await httpPost(meshIp, 7777, '/add-peer', peerData, 2000);
  if (meshResult.success) {
    return { success: true };
  }

  // Étape 2: Fallback sur IP publique si disponible
  if (publicIp) {
    logger.info(`P2P: Fallback to public IP ${publicIp} (mesh ${meshIp} failed: ${meshResult.error})`);
    const publicResult = await httpPost(publicIp, 7777, '/add-peer', peerData, 5000);
    if (publicResult.success) {
      return { success: true };
    }
    return { success: false, error: `mesh: ${meshResult.error}, public: ${publicResult.error}` };
  }

  return { success: false, error: meshResult.error };
}

/**
 * Synchronise la config Corosync vers un peer distant
 */
export function syncCorosyncToPeer(
  peerIp: string, 
  nodes: MeshNode[], 
  authKey: string,
  clusterName: string,
  corosyncPort: number = 5405
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      authKey,
      clusterName,
      corosyncPort,
      nodes,
    });
    
    const options = {
      hostname: peerIp,
      port: 7777,
      path: '/sync-corosync',
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
 * Récupère la liste des nœuds Corosync depuis un peer distant
 */
export function fetchCorosyncNodesFromPeer(
  peerIp: string, 
  authKey: string,
  timeoutMs: number = 5000
): Promise<{ success: boolean; nodes?: MeshNode[]; clusterName?: string; corosyncPort?: number; error?: string }> {
  return new Promise((resolve) => {
    const url = `http://${peerIp}:7777/corosync-nodes?authKey=${encodeURIComponent(authKey)}`;
    
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Timeout' });
    }, timeoutMs);
    
    const req = http.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data);
          if (response.success) {
            resolve({ 
              success: true, 
              nodes: response.nodes,
              clusterName: response.clusterName,
              corosyncPort: response.corosyncPort,
            });
          } else {
            resolve({ success: false, error: response.error || 'Unknown error' });
          }
        } catch {
          resolve({ success: false, error: 'Invalid response' });
        }
      });
    });
    
    req.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      resolve({ success: false, error: 'Timeout' });
    });
  });
}

// ============================================
// Mesh Peers Sync
// ============================================

export interface MeshPeerInfo {
  name: string;
  publicKey: string;
  endpoint: string;
  meshIp: string;
}

/**
 * Récupère la liste des peers WireGuard depuis un peer distant
 */
export function fetchMeshPeersFromPeer(
  peerIp: string, 
  authKey: string
): Promise<{ success: boolean; peers?: MeshPeerInfo[]; error?: string }> {
  return new Promise((resolve) => {
    const url = `http://${peerIp}:7777/mesh-peers?authKey=${encodeURIComponent(authKey)}`;
    
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Timeout' });
    }, 5000);
    
    const req = http.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data);
          if (response.success) {
            resolve({ success: true, peers: response.peers });
          } else {
            resolve({ success: false, error: response.error || 'Unknown error' });
          }
        } catch {
          resolve({ success: false, error: 'Invalid response' });
        }
      });
    });
    
    req.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      resolve({ success: false, error: 'Timeout' });
    });
  });
}

/**
 * Synchronise les peers WireGuard manquants depuis l'initiateur
 * Appelé au démarrage du daemon pour s'assurer d'avoir tous les peers
 */
export async function syncMeshPeersFromInitiator(): Promise<{ success: boolean; added: number; error?: string }> {
  const mesh = getMeshManager();
  const meshConfig = mesh.getConfig();
  
  if (!meshConfig) {
    return { success: false, added: 0, error: 'No mesh configured' };
  }
  
  // === STABILISATION ===
  // Après un join, attendre 30 secondes avant de sync
  // Cela laisse le temps au mesh WireGuard et à Corosync de converger
  const STABILIZATION_MS = 30000;
  const timeSinceLastJoin = Date.now() - lastJoinReceived;
  if (lastJoinReceived > 0 && timeSinceLastJoin < STABILIZATION_MS) {
    logger.debug(`P2P: Sync skipped (stabilization: ${Math.round((STABILIZATION_MS - timeSinceLastJoin) / 1000)}s remaining)`);
    return { success: true, added: 0 };
  }
  
  // Trouver l'initiateur (premier peer, généralement nommé "initiator" ou le premier dans la liste)
  const initiatorPeer = meshConfig.peers.find(p => p.name === 'initiator') || meshConfig.peers[0];
  if (!initiatorPeer) {
    return { success: false, added: 0, error: 'No initiator peer found' };
  }
  
  const initiatorMeshIp = initiatorPeer.allowedIps?.split('/')[0];
  if (!initiatorMeshIp) {
    return { success: false, added: 0, error: 'No initiator mesh IP' };
  }
  
  logger.info(`P2P: Syncing mesh peers from initiator ${initiatorMeshIp}...`);
  
  // Récupérer les peers depuis l'initiateur
  const result = await fetchMeshPeersFromPeer(initiatorMeshIp, meshConfig.authKey);
  if (!result.success || !result.peers) {
    return { success: false, added: 0, error: result.error || 'Failed to fetch peers' };
  }
  
  // Ajouter les peers manquants
  let added = 0;
  for (const remotePeer of result.peers) {
    // Vérifier si on a déjà ce peer
    const exists = meshConfig.peers.some(p => p.publicKey === remotePeer.publicKey);
    if (exists) continue;
    
    // Vérifier que ce n'est pas nous-même
    if (remotePeer.publicKey === meshConfig.publicKey) continue;
    
    // Ajouter le peer
    const addResult = mesh.addPeer({
      name: remotePeer.name,
      publicKey: remotePeer.publicKey,
      endpoint: remotePeer.endpoint,
      allowedIps: `${remotePeer.meshIp}/32`,
    });
    
    if (addResult.success) {
      logger.info(`P2P: Added missing peer ${remotePeer.name} from initiator`);
      added++;
    } else {
      logger.warn(`P2P: Failed to add peer ${remotePeer.name}: ${addResult.error}`);
    }
  }
  
  if (added > 0) {
    logger.info(`P2P: Synced ${added} missing peer(s) from initiator`);
  }
  
  // ===== Synchroniser la config Corosync depuis l'initiateur =====
  // NOTE: On NE RESTART PAS Corosync automatiquement.
  // Corosync converge naturellement via ses propres mécanismes.
  // Un restart automatique cause des cascades de déconnexions.
  try {
    const corosyncResult = await fetchCorosyncNodesFromPeer(initiatorMeshIp, meshConfig.authKey);
    if (corosyncResult.success && corosyncResult.nodes) {
      const localNodes = getCorosyncNodes();
      
      // Si l'initiateur a plus de nodes, mettre à jour la config
      if (corosyncResult.nodes.length > localNodes.length) {
        logger.info(`P2P: Initiator has ${corosyncResult.nodes.length} corosync nodes, local has ${localNodes.length}. Syncing config...`);
        updateCorosyncForMesh(meshConfig.clusterName, corosyncResult.nodes, meshConfig.corosyncPort || 5405);
        
        // Soft reload - ne PAS restart Corosync
        // Le reload via cfgtool suffit pour que Corosync voie les nouveaux nœuds
        try {
          execSync('corosync-cfgtool -R 2>/dev/null || true', { stdio: 'pipe', timeout: 5000 });
          logger.debug('P2P: Corosync config reloaded (soft)');
        } catch {
          // Ignorer les erreurs de reload - Corosync convergera naturellement
        }
      }
    }
  } catch (corosyncErr: any) {
    logger.debug(`P2P: Failed to sync corosync config: ${corosyncErr.message}`);
  }
  
  return { success: true, added };
}

// ============================================
// Stabilisation après join
// ============================================

// Timestamp du dernier join reçu - utilisé pour éviter les sync trop rapides
let lastJoinReceived = 0;

// ============================================
// VIP-only Propagation (hot reload, no Corosync touch)
// ============================================

export interface VipPropagateResult {
  success: boolean;
  total: number;
  succeeded: number;
  failed: number;
  error?: string;
}

/**
 * Propage UNIQUEMENT les VIPs à tous les peers.
 * Ne touche PAS à Corosync - utilisé pour les modifications de VIPs à chaud.
 * 
 * @param timeoutMs Timeout par nœud (défaut: 5s)
 * @returns Résultat de la propagation
 */
export async function propagateVipsToAllPeers(timeoutMs: number = 5000): Promise<VipPropagateResult> {
  const mesh = getMeshManager();
  const meshConfig = mesh.getConfig();
  
  if (!meshConfig) {
    return { success: false, total: 0, succeeded: 0, failed: 0, error: 'Aucun mesh configuré' };
  }
  
  // Charger les VIPs depuis la config locale
  const sfhaConfig = loadConfig('/etc/sfha/config.yml');
  const vips = sfhaConfig.vips || [];
  
  logger.info(`Propagation des VIPs: ${vips.length} VIP(s) vers ${meshConfig.peers.length} peer(s)`);
  
  if (meshConfig.peers.length === 0) {
    return { success: true, total: 0, succeeded: 0, failed: 0 };
  }
  
  let succeeded = 0;
  let failed = 0;
  
  for (const peer of meshConfig.peers) {
    const peerMeshIp = peer.allowedIps?.split('/')[0];
    if (!peerMeshIp) continue;
    
    logger.debug(`Sync VIPs vers ${peer.name} (${peerMeshIp})...`);
    
    const result = await httpPost(peerMeshIp, 7777, '/sync-vips', {
      authKey: meshConfig.authKey,
      vips: vips,
    }, timeoutMs);
    
    if (result.success) {
      logger.debug(`  ✓ ${peer.name} VIPs synchronized`);
      succeeded++;
    } else {
      logger.warn(`  ✗ ${peer.name}: ${result.error}`);
      failed++;
    }
  }
  
  const total = meshConfig.peers.length;
  
  return {
    success: failed === 0,
    total,
    succeeded,
    failed,
  };
}

// ============================================
// Propagation manuelle (sfha propagate)
// ============================================

export interface PropagateResult {
  success: boolean;
  total: number;
  succeeded: number;
  failed: number;
  error?: string;
  errors?: Array<{ node: string; error: string }>;
}

/**
 * Découvre les peers WireGuard connectés via `wg show`
 */
function discoverWireGuardPeers(): Array<{ publicKey: string; endpoint: string; allowedIps: string; lastHandshake: number }> {
  try {
    const output = execSync('wg show wg-sfha', { encoding: 'utf-8', timeout: 5000 });
    const peers: Array<{ publicKey: string; endpoint: string; allowedIps: string; lastHandshake: number }> = [];
    
    const lines = output.split('\n');
    let currentPeer: any = null;
    
    for (const line of lines) {
      if (line.startsWith('peer:')) {
        if (currentPeer) peers.push(currentPeer);
        currentPeer = { publicKey: line.split(':')[1].trim(), endpoint: '', allowedIps: '', lastHandshake: 0 };
      } else if (currentPeer && line.includes('endpoint:')) {
        currentPeer.endpoint = line.split(':').slice(1).join(':').trim();
      } else if (currentPeer && line.includes('allowed ips:')) {
        currentPeer.allowedIps = line.split(':')[1].trim();
      } else if (currentPeer && line.includes('latest handshake:')) {
        // Parse "X minutes, Y seconds ago" ou "X seconds ago"
        currentPeer.lastHandshake = Date.now(); // Simplifié: présence = récent
      }
    }
    if (currentPeer) peers.push(currentPeer);
    
    return peers;
  } catch {
    return [];
  }
}

/**
 * Propage la configuration complète (WireGuard + Corosync) à tous les peers.
 * À exécuter sur le leader/initiateur uniquement.
 * 
 * NOUVEAU FLOW:
 * 1. Découvre les peers via `wg show` (ceux qui ont fait joinSimple)
 * 2. Génère la config full-mesh WireGuard pour tous
 * 3. Génère la config Corosync avec tous les nœuds
 * 4. Pousse les configs à chaque peer via /full-config
 * 5. Démarre les services sur chaque peer
 * 
 * @param timeoutMs Timeout par nœud (défaut: 10s)
 * @returns Résultat de la propagation
 */
export async function propagateConfigToAllPeers(timeoutMs: number = 10000): Promise<PropagateResult> {
  const mesh = getMeshManager();
  const meshConfig = mesh.getConfig();
  
  if (!meshConfig) {
    return { success: false, total: 0, succeeded: 0, failed: 0, error: 'Aucun mesh configuré' };
  }
  
  // 1. Découvrir les peers connectés via WireGuard
  const discoveredPeers = discoverWireGuardPeers();
  logger.info(`Découverte: ${discoveredPeers.length} peer(s) WireGuard connecté(s)`);
  
  if (discoveredPeers.length === 0) {
    return { success: false, total: 0, succeeded: 0, failed: 0, error: 'Aucun peer WireGuard connecté. Les nœuds ont-ils fait "sfha join" ?' };
  }
  
  // 2. Construire la liste complète des nœuds (moi + peers découverts)
  const myMeshIp = meshConfig.meshIp.split('/')[0];
  const myHostname = os.hostname();
  
  interface NodeInfo {
    name: string;
    publicKey: string;
    endpoint: string;
    meshIp: string;
    nodeId: number;
  }
  
  const allNodes: NodeInfo[] = [{
    name: myHostname,
    publicKey: meshConfig.publicKey,
    endpoint: '', // Le leader n'a pas besoin d'endpoint pour lui-même
    meshIp: myMeshIp,
    nodeId: 1,
  }];
  
  // Ajouter les peers découverts - récupérer leur vrai hostname d'abord
  let nodeId = 2;
  for (const peer of discoveredPeers) {
    const peerMeshIp = peer.allowedIps.split('/')[0];
    
    // Récupérer le vrai hostname du peer via /info
    let peerHostname = `node-${nodeId}`; // Fallback si /info échoue
    try {
      const infoResult = await httpGet(peerMeshIp, 7777, '/info', 3000);
      if (infoResult.success && infoResult.data?.hostname) {
        peerHostname = infoResult.data.hostname;
        logger.info(`  Peer ${peerMeshIp}: hostname="${peerHostname}"`);
      } else {
        logger.warn(`  Peer ${peerMeshIp}: /info failed, using fallback name "${peerHostname}"`);
      }
    } catch (err: any) {
      logger.warn(`  Peer ${peerMeshIp}: /info error (${err.message}), using fallback name "${peerHostname}"`);
    }
    
    allNodes.push({
      name: peerHostname,
      publicKey: peer.publicKey,
      endpoint: peer.endpoint,
      meshIp: peerMeshIp,
      nodeId: nodeId,
    });
    nodeId++;
  }
  
  logger.info(`Cluster: ${allNodes.length} nœud(s) au total`);
  
  // 3. Générer la config Corosync
  const corosyncNodes: MeshNode[] = allNodes.map(n => ({
    name: n.name,
    ip: n.meshIp,
    nodeId: n.nodeId,
  }));
  
  // Mettre à jour la config Corosync locale
  updateCorosyncForMesh(meshConfig.clusterName, corosyncNodes, meshConfig.corosyncPort || 5405);
  
  // Démarrer Corosync localement si pas déjà fait
  try {
    execSync('systemctl enable corosync 2>/dev/null || true', { stdio: 'pipe' });
    execSync('systemctl start corosync 2>/dev/null || true', { stdio: 'pipe' });
  } catch {}
  
  const errors: Array<{ node: string; error: string }> = [];
  let succeeded = 0;
  
  // 4. Propager à chaque peer
  for (const peer of discoveredPeers) {
    const peerMeshIp = peer.allowedIps.split('/')[0];
    const peerNodeId = allNodes.find(n => n.meshIp === peerMeshIp)?.nodeId || 0;
    
    logger.info(`Propagation vers ${peerMeshIp} (node-${peerNodeId})...`);
    
    try {
      // Construire la liste des peers pour ce nœud (tous sauf lui-même)
      const peersForThisNode = allNodes
        .filter(n => n.meshIp !== peerMeshIp)
        .map(n => ({
          name: n.name,
          publicKey: n.publicKey,
          endpoint: n.endpoint || `${n.meshIp}:51820`,
          meshIp: n.meshIp,
        }));
      
      // Charger la config sfha locale pour récupérer VIPs, services, constraints
      const sfhaConfig = loadConfig('/etc/sfha/config.yml');
      
      // Envoyer la config complète
      const configPayload = {
        authKey: meshConfig.authKey,
        clusterName: meshConfig.clusterName,
        corosyncPort: meshConfig.corosyncPort || 5405,
        corosyncNodes: corosyncNodes,
        wgPeers: peersForThisNode,
        nodeId: peerNodeId,
        // Inclure VIPs, services, constraints du leader
        vips: sfhaConfig.vips || [],
        services: sfhaConfig.services || [],
        constraints: sfhaConfig.constraints || [],
      };
      
      const result = await httpPost(peerMeshIp, 7777, '/full-config', configPayload, timeoutMs);
      
      if (result.success) {
        logger.info(`  ✓ ${peerMeshIp} configuré`);
        succeeded++;
      } else {
        logger.warn(`  ✗ ${peerMeshIp}: ${result.error}`);
        errors.push({ node: peerMeshIp, error: result.error || 'Échec configuration' });
      }
      
    } catch (err: any) {
      logger.error(`  ✗ ${peerMeshIp}: ${err.message}`);
      errors.push({ node: peerMeshIp, error: err.message });
    }
  }
  
  const total = discoveredPeers.length;
  const failed = total - succeeded;
  
  // 5. Si TOUS les nœuds ont été configurés, envoyer /reload-services à TOUS
  if (failed === 0 && succeeded > 0) {
    logger.info(`Tous les nœuds configurés. Envoi du signal de reload...`);
    
    // D'abord hot-reload ou start Corosync localement (le leader)
    // IMPORTANT: On utilise corosync-cfgtool -R pour hot-reload, PAS restart
    try {
      const corosyncRunning = execSync('systemctl is-active corosync 2>/dev/null || echo inactive', { encoding: 'utf-8' }).trim();
      if (corosyncRunning === 'active') {
        execSync('corosync-cfgtool -R 2>/dev/null || true', { stdio: 'pipe' });
        logger.info(`Corosync local: hot-reload (cfgtool -R)`);
      } else {
        execSync('systemctl enable corosync 2>/dev/null || true', { stdio: 'pipe' });
        execSync('systemctl start corosync 2>/dev/null || true', { stdio: 'pipe' });
        logger.info(`Corosync local: started`);
      }
    } catch {}
    
    // Puis envoyer /reload-services à tous les peers
    for (const peer of discoveredPeers) {
      const peerMeshIp = peer.allowedIps.split('/')[0];
      try {
        await httpPost(peerMeshIp, 7777, '/reload-services', { authKey: meshConfig.authKey }, timeoutMs);
        logger.info(`  ✓ ${peerMeshIp} reload OK`);
      } catch (err: any) {
        logger.warn(`  ⚠ ${peerMeshIp} reload failed: ${err.message}`);
      }
    }
    
    logger.info(`Signal de reload envoyé à tous les nœuds.`);
  }
  
  return {
    success: failed === 0,
    total,
    succeeded,
    failed,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ============================================
// Forward VIP Change to Leader
// ============================================

export interface ForwardVipChangeRequest {
  action: 'add' | 'remove';
  vip?: { name: string; ip: string; cidr: number; interface: string };
  vipName?: string;
}

/**
 * Find the leader's mesh IP.
 * Uses cluster-state.json first, then falls back to election.
 */
export function findLeaderMeshIp(): string | null {
  // Method 1: Check cluster-state.json (created by sfha init on leader)
  try {
    const stateFile = '/etc/sfha/cluster-state.json';
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (state.leaderIp) {
        return state.leaderIp;
      }
    }
  } catch {}
  
  // Method 2: Check mesh config for initiator peer (leader is usually the initiator)
  const mesh = getMeshManager();
  const meshConfig = mesh.getConfig();
  if (meshConfig?.peers) {
    const initiator = meshConfig.peers.find(p => p.name === 'initiator');
    if (initiator?.allowedIps) {
      return initiator.allowedIps.split('/')[0];
    }
    // Fallback: first peer is likely the leader
    if (meshConfig.peers.length > 0 && meshConfig.peers[0].allowedIps) {
      return meshConfig.peers[0].allowedIps.split('/')[0];
    }
  }
  
  return null;
}

/**
 * Check if this node is the leader.
 * Returns true if we are the leader, false otherwise.
 */
export function isLocalNodeLeader(): boolean {
  // Method 1: Check if daemon reports we are leader via socket
  try {
    const socketPath = '/run/sfha.sock';
    if (existsSync(socketPath)) {
      // Can't do sync socket call easily, skip this method
    }
  } catch {}
  
  // Method 2: Check cluster-state.json - if we created it, we're likely the leader
  try {
    const stateFile = '/etc/sfha/cluster-state.json';
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      const meshConfig = getMeshManager().getConfig();
      if (meshConfig?.meshIp && state.leaderIp) {
        const localMeshIp = meshConfig.meshIp.split('/')[0];
        return localMeshIp === state.leaderIp;
      }
    }
  } catch {}
  
  // Method 3: Check if we have peers - if we have no initiator peer, we might be the leader
  const mesh = getMeshManager();
  const meshConfig = mesh.getConfig();
  if (meshConfig?.peers) {
    const hasInitiator = meshConfig.peers.some(p => p.name === 'initiator');
    // If we don't have an "initiator" peer, we ARE the initiator (leader)
    return !hasInitiator;
  }
  
  // Default: assume we're not the leader (safer)
  return false;
}

/**
 * Forward a VIP change request to the leader node.
 * The leader will apply the change and propagate to all nodes.
 * 
 * @param request The VIP change request (add or remove)
 * @param timeoutMs Timeout in ms (default: 10s)
 * @returns Result of the operation
 */
export async function forwardVipChangeToLeader(
  request: ForwardVipChangeRequest,
  timeoutMs: number = 10000
): Promise<{ success: boolean; message?: string; error?: string }> {
  const mesh = getMeshManager();
  const meshConfig = mesh.getConfig();
  
  if (!meshConfig) {
    return { success: false, error: 'No mesh configured' };
  }
  
  const leaderIp = findLeaderMeshIp();
  if (!leaderIp) {
    return { success: false, error: 'Could not find leader mesh IP' };
  }
  
  logger.info(`Forwarding VIP ${request.action} to leader at ${leaderIp}...`);
  
  const payload = {
    authKey: meshConfig.authKey,
    ...request,
  };
  
  return httpPost(leaderIp, 7777, '/forward-vip-change', payload, timeoutMs);
}

// ============================================
// Peer Health Check (sfha daemon running detection)
// ============================================

/**
 * Check if the sfha daemon is running on a remote node
 * by pinging its P2P HTTP server.
 * 
 * @param meshIp The mesh IP address of the peer
 * @param timeoutMs Timeout in milliseconds (default: 2s)
 * @returns true if sfha daemon is responding, false otherwise
 */
export function checkPeerHealth(meshIp: string, timeoutMs: number = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `http://${meshIp}:7777/ping`;
    
    const timeout = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    
    const req = http.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data);
          resolve(response.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    
    req.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
    
    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Check health of all peers in the mesh
 * Returns a map of meshIp -> sfhaRunning
 * 
 * @param timeoutMs Timeout per peer in ms (default: 2s)
 * @returns Map of peer mesh IP to health status
 */
export async function checkAllPeersHealth(timeoutMs: number = 2000): Promise<Map<string, boolean>> {
  const mesh = getMeshManager();
  const meshConfig = mesh.getConfig();
  const results = new Map<string, boolean>();
  
  if (!meshConfig) {
    return results;
  }
  
  const checks = meshConfig.peers.map(async (peer) => {
    const meshIp = peer.allowedIps?.split('/')[0];
    if (meshIp) {
      const healthy = await checkPeerHealth(meshIp, timeoutMs);
      results.set(meshIp, healthy);
    }
  });
  
  await Promise.all(checks);
  return results;
}

// ============================================
// Singleton
// ============================================

let instance: P2PStateManager | null = null;

export function getP2PStateManager(): P2PStateManager {
  if (!instance) {
    instance = new P2PStateManager();
  }
  return instance;
}

export function initP2PStateManager(config?: Partial<P2PStateConfig>): P2PStateManager {
  instance = new P2PStateManager(config);
  return instance;
}
