/**
 * @file types.ts
 * @description Types pour le mesh WireGuard
 */

/**
 * Configuration d'un peer WireGuard
 */
export interface MeshPeer {
  name: string;
  publicKey: string;
  endpoint?: string;
  allowedIps: string;
  persistentKeepalive?: number;
}

/**
 * Configuration stockée du mesh (/etc/sfha/mesh.json)
 */
export interface MeshConfig {
  interface: string;
  listenPort: number;
  privateKey: string;
  publicKey: string;
  meshIp: string;
  meshNetwork: string;
  clusterName: string;
  authKey: string;
  corosyncPort: number;
  peers: MeshPeer[];
}

/**
 * Informations d'un peer dans le token
 */
export interface TokenPeer {
  name: string;
  pubkey: string;
  endpoint: string;
  meshIp: string;
}

/**
 * Token de join (JSON base64)
 */
export interface JoinToken {
  v: number;
  cluster: string;
  endpoint: string;
  pubkey: string;
  authkey: string;
  meshNetwork: string;
  meshIp: string;
  corosyncPort: number;
  /** IP à assigner au nouveau nœud (v2+) */
  assignedIp?: string;
  /** Liste des IPs déjà utilisées dans le mesh (v2+) */
  usedIps?: string[];
  /** Liste des peers existants dans le cluster (v3+) */
  peers?: TokenPeer[];
  /** Nom du nœud initiateur (v3+) */
  initiatorName?: string;
}

/**
 * Status d'un peer WireGuard
 */
export interface WgPeerStatus {
  publicKey: string;
  endpoint?: string;
  allowedIps: string[];
  latestHandshake?: number;
  transferRx?: number;
  transferTx?: number;
}

/**
 * Status de l'interface WireGuard
 */
export interface WgInterfaceStatus {
  name: string;
  publicKey: string;
  listenPort: number;
  peers: WgPeerStatus[];
}

/**
 * État complet du mesh
 */
export interface MeshStatus {
  active: boolean;
  interface: string;
  localIp: string;
  listenPort: number;
  publicKey: string;
  peers: Array<{
    name: string;
    ip: string;
    endpoint?: string;
    connected: boolean;
    latestHandshake?: Date;
    transferRx?: number;
    transferTx?: number;
  }>;
}

/**
 * Options pour init mesh
 */
export interface MeshInitOptions {
  clusterName: string;
  meshIp: string;
  port?: number;
  endpoint?: string;
}

/**
 * Options pour join mesh
 */
export interface MeshJoinOptions {
  token: string;
  endpoint?: string;
  meshIp?: string;
}

/**
 * Résultat d'une opération mesh
 */
export interface MeshOperationResult {
  success: boolean;
  message?: string;
  error?: string;
  token?: string;
}
