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
import { getClusterNodes } from './corosync.js';
import { logger } from './utils/logger.js';
import { getMeshManager } from './mesh/manager.js';
import { isIpAuthorized, authorizePermanently } from './knock.js';

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
      
      // Add peer endpoint - called by joining nodes to register themselves
      // SECURITY: Requires valid cluster authKey in request
      if (req.method === 'POST' && req.url === '/add-peer') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
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
            const result = mesh.addPeer({
              name: peerData.name,
              publicKey: peerData.publicKey,
              endpoint: peerData.endpoint,
              allowedIps: `${peerData.meshIp}/32`,
            });
            
            if (result.success) {
              logger.info(`P2P: Added peer ${peerData.name} (${peerData.meshIp}) via API`);
              
              // Autoriser l'IP de ce peer de façon permanente
              if (peerData.endpoint) {
                const peerIp = peerData.endpoint.split(':')[0];
                authorizePermanently(peerIp);
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
