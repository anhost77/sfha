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
import { isIpAuthorized, authorizePermanently, sendKnock } from './knock.js';
import { getCorosyncNodes, updateCorosyncForMesh, reloadCorosync, MeshNode } from './mesh/corosync-mesh.js';

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
              
              // Autoriser l'IP de ce peer de façon permanente
              if (peerData.endpoint) {
                const peerIp = peerData.endpoint.split(':')[0];
                authorizePermanently(peerIp);
              }
              
              // ===== Propager le nouveau peer aux autres nœuds existants via WireGuard =====
              // Cela permet à node2 de connaître node3 quand node3 rejoint via node1
              if (!peerData.propagated && meshConfig.peers.length > 0) {
                logger.info(`P2P: Propagating new peer ${peerData.name} to ${meshConfig.peers.length} existing peers`);
                
                for (const existingPeer of meshConfig.peers) {
                  // Ne pas propager au peer qu'on vient d'ajouter
                  if (existingPeer.publicKey === peerData.publicKey) continue;
                  
                  const existingPeerEndpoint = existingPeer.endpoint?.split(':')[0];
                  if (!existingPeerEndpoint) continue;
                  
                  try {
                    // Knock pour ouvrir le port
                    await sendKnock(existingPeerEndpoint, meshConfig.authKey);
                    await new Promise(resolve => setTimeout(resolve, 300));
                    
                    // Propager le nouveau peer via POST /add-peer
                    const propagationData = {
                      name: peerData.name,
                      publicKey: peerData.publicKey,
                      endpoint: peerData.endpoint,
                      meshIp: peerData.meshIp,
                      authKey: meshConfig.authKey,
                      propagated: true, // Marquer comme propagation pour éviter les boucles
                    };
                    
                    await propagatePeerToNode(existingPeerEndpoint, propagationData);
                    logger.info(`P2P: Propagated ${peerData.name} to ${existingPeer.name}`);
                  } catch (err: any) {
                    logger.warn(`P2P: Failed to propagate ${peerData.name} to ${existingPeer.name}: ${err.message}`);
                  }
                }
              }
              
              // ===== Synchroniser la config Corosync sur TOUS les autres nœuds =====
              // L'initiateur (ce nœud) a la config complète, on la pousse aux autres
              const corosyncNodes = getCorosyncNodes();
              if (corosyncNodes.length > 1 && meshConfig.peers.length > 0) {
                const syncPromises: Promise<void>[] = [];
                
                for (const peer of meshConfig.peers) {
                  const peerMeshIp = peer.allowedIps.split('/')[0];
                  const peerEndpoint = peer.endpoint?.split(':')[0];
                  
                  // Ne pas se synchroniser avec soi-même ni avec le nouveau nœud (il va fetch depuis nous)
                  if (peerMeshIp === cleanMeshIp) continue;
                  
                  syncPromises.push((async () => {
                    try {
                      // Knock pour ouvrir le port si nécessaire
                      if (peerEndpoint) {
                        await sendKnock(peerEndpoint, meshConfig.authKey);
                        await new Promise(resolve => setTimeout(resolve, 300));
                      }
                      
                      // Appeler sync-corosync sur ce peer
                      await syncCorosyncToPeer(peerMeshIp, corosyncNodes, meshConfig.authKey, meshConfig.clusterName);
                      logger.info(`P2P: Synced corosync config to ${peer.name}`);
                    } catch (err: any) {
                      logger.warn(`P2P: Failed to sync corosync to ${peer.name}: ${err.message}`);
                    }
                  })());
                }
                
                // Attendre toutes les synchros (avec timeout)
                await Promise.race([
                  Promise.allSettled(syncPromises),
                  new Promise(resolve => setTimeout(resolve, 10000)),
                ]);
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
 * Propage un nouveau peer vers un nœud existant
 * Utilisé pour que tous les nœuds connaissent tous les peers WireGuard
 */
export function propagatePeerToNode(
  nodeIp: string,
  peerData: AddPeerRequest & { authKey: string; propagated: boolean }
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const postData = JSON.stringify(peerData);
    
    const options = {
      hostname: nodeIp,
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
  authKey: string
): Promise<{ success: boolean; nodes?: MeshNode[]; clusterName?: string; corosyncPort?: number; error?: string }> {
  return new Promise((resolve) => {
    const url = `http://${peerIp}:7777/corosync-nodes?authKey=${encodeURIComponent(authKey)}`;
    
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
