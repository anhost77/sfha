/**
 * @file cluster-state.ts
 * @description Gestion de l'état du cluster via un fichier JSON sur le leader.
 * 
 * Phases:
 * - initializing: sfha init fait, aucun peer
 * - collecting: peers ont rejoint via join, en attente de propagate
 * - propagating: propagate en cours
 * - active: cluster opérationnel
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';

const STATE_FILE = '/etc/sfha/cluster-state.json';

export type ClusterPhase = 'initializing' | 'collecting' | 'propagating' | 'active';

export interface PeerInfo {
  name: string;
  ip: string;      // IP mesh (10.200.x.x)
  publicIp?: string; // IP publique
  joinedAt: string;
}

export interface ClusterState {
  phase: ClusterPhase;
  clusterName: string;
  leaderNode: string;
  leaderIp: string;       // IP mesh du leader
  leaderPublicIp?: string; // IP publique du leader
  peers: PeerInfo[];      // Liste complète des peers avec IPs
  createdAt: string;
  propagatedAt: string | null;
}

/**
 * Lit l'état du cluster depuis le fichier
 */
export function getClusterState(): ClusterState | null {
  if (!existsSync(STATE_FILE)) {
    return null;
  }
  
  try {
    const content = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(content) as ClusterState;
  } catch {
    return null;
  }
}

/**
 * Sauvegarde l'état du cluster
 */
export function saveClusterState(state: ClusterState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Crée l'état initial (appelé par sfha init)
 */
export function initClusterState(clusterName: string, leaderNode: string, leaderIp: string, leaderPublicIp?: string): ClusterState {
  const state: ClusterState = {
    phase: 'initializing',
    clusterName,
    leaderNode,
    leaderIp,
    leaderPublicIp,
    peers: [],
    createdAt: new Date().toISOString(),
    propagatedAt: null,
  };
  saveClusterState(state);
  return state;
}

/**
 * Ajoute un peer (appelé quand un nœud fait join et notifie le leader)
 */
export function addPeerToState(peerName: string, peerIp: string, peerPublicIp?: string): ClusterState | null {
  const state = getClusterState();
  if (!state) return null;
  
  // Éviter les doublons (par nom)
  const existingPeer = state.peers.find(p => p.name === peerName);
  if (!existingPeer) {
    state.peers.push({
      name: peerName,
      ip: peerIp,
      publicIp: peerPublicIp,
      joinedAt: new Date().toISOString(),
    });
  } else {
    // Mettre à jour les IPs si le peer existe déjà
    existingPeer.ip = peerIp;
    if (peerPublicIp) existingPeer.publicIp = peerPublicIp;
  }
  
  // Passer en phase collecting si on était en initializing
  if (state.phase === 'initializing') {
    state.phase = 'collecting';
  }
  
  saveClusterState(state);
  return state;
}

/**
 * Retire un peer (si leave)
 */
export function removePeerFromState(peerName: string): ClusterState | null {
  const state = getClusterState();
  if (!state) return null;
  
  state.peers = state.peers.filter(p => p.name !== peerName);
  
  // Si plus de peers et pas encore propagé, retour à initializing
  if (state.peers.length === 0 && state.phase === 'collecting') {
    state.phase = 'initializing';
  }
  
  saveClusterState(state);
  return state;
}

/**
 * Marque le début de la propagation
 */
export function startPropagation(): ClusterState | null {
  const state = getClusterState();
  if (!state) return null;
  
  state.phase = 'propagating';
  saveClusterState(state);
  return state;
}

/**
 * Marque la fin de la propagation (cluster actif)
 */
export function completePropagation(): ClusterState | null {
  const state = getClusterState();
  if (!state) return null;
  
  state.phase = 'active';
  state.propagatedAt = new Date().toISOString();
  saveClusterState(state);
  return state;
}

/**
 * Supprime l'état (appelé par leave/destroy)
 */
export function deleteClusterState(): void {
  if (existsSync(STATE_FILE)) {
    const fs = require('fs');
    fs.unlinkSync(STATE_FILE);
  }
}
