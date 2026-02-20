/**
 * @file index.ts
 * @description Exports du module mesh
 */

export * from './types.js';
export { generateKeyPair, loadKeys, saveKeys, isWireGuardInstalled, generateAuthKey } from './keys.js';
export { createJoinToken, parseJoinToken, extractMeshIp, extractCidr, calculateNetwork, allocateNextIp } from './token.js';
export {
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
export { MeshManager, getMeshManager } from './manager.js';
export {
  updateCorosyncForMesh,
  generateCorosyncConfig,
  addNodeToCorosync,
  removeNodeFromCorosync,
  getNextNodeId,
  reloadCorosync,
  isCorosyncInstalled,
} from './corosync-mesh.js';
export {
  validateMeshIp,
  checkIpConflict,
  checkSubnetOverlap,
  findFreeIp,
  isArpingAvailable,
  detectMainInterface,
  getSystemRoutes,
  isIpAssignedLocally,
} from './ip-conflict.js';
