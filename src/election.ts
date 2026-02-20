/**
 * @file election.ts
 * @description Élection du leader (plus petit nodeId online)
 */

import { ClusterNode, getClusterNodes, getLocalNodeId, getQuorumStatus } from './corosync.js';
import { t } from './i18n.js';

// ============================================
// Types
// ============================================

export interface ElectionResult {
  leaderId: number;
  leaderName: string;
  isLocalLeader: boolean;
  onlineNodes: ClusterNode[];
  quorate: boolean;
}

// ============================================
// Election
// ============================================

/**
 * Élit le leader du cluster
 * Règle: le nœud avec le plus petit nodeId parmi les nœuds en ligne devient leader
 * 
 * @param requireQuorum Si true, retourne null si pas de quorum (défaut: false pour compatibilité)
 */
export function electLeader(requireQuorum: boolean = false): ElectionResult | null {
  const nodes = getClusterNodes();
  const localNodeId = getLocalNodeId();
  const quorum = getQuorumStatus();
  
  // BUG FIX #2: Option pour exiger le quorum
  if (requireQuorum && !quorum.quorate) {
    return null;
  }
  
  // Filtrer les nœuds en ligne
  const onlineNodes = nodes.filter(n => n.online);
  
  if (onlineNodes.length === 0) {
    return null;
  }
  
  // Trier par nodeId (plus petit d'abord)
  onlineNodes.sort((a, b) => a.nodeId - b.nodeId);
  
  const leader = onlineNodes[0];
  
  return {
    leaderId: leader.nodeId,
    leaderName: leader.name,
    isLocalLeader: leader.nodeId === localNodeId,
    onlineNodes,
    quorate: quorum.quorate,
  };
}

/**
 * Vérifie si ce nœud est le leader
 */
export function isLocalNodeLeader(): boolean {
  const result = electLeader();
  return result?.isLocalLeader ?? false;
}

/**
 * Récupère le nom du leader actuel
 */
export function getLeaderName(): string | null {
  const result = electLeader();
  return result?.leaderName ?? null;
}

// ============================================
// Election Manager
// ============================================

type ElectionCallback = (isLeader: boolean, leaderName: string) => void;

/**
 * Gestionnaire d'élection
 * Suit les changements de leadership
 */
export class ElectionManager {
  private wasLeader: boolean | null = null;
  private lastLeaderName: string | null = null;
  private callbacks: ElectionCallback[] = [];
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  /**
   * Enregistre un callback pour les changements de leadership
   */
  onLeaderChange(callback: ElectionCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Effectue une élection et notifie si changement
   */
  checkElection(): ElectionResult | null {
    const result = electLeader();
    
    if (!result) {
      // Pas de nœuds en ligne
      if (this.wasLeader !== null) {
        this.log('⚠️ Aucun nœud en ligne');
        this.wasLeader = null;
        this.lastLeaderName = null;
      }
      return null;
    }
    
    const isLeader = result.isLocalLeader;
    const leaderName = result.leaderName;
    
    // Détecter les changements
    if (this.wasLeader !== isLeader || this.lastLeaderName !== leaderName) {
      if (isLeader) {
        this.log(t('daemon.electionWon'));
      } else {
        this.log(t('daemon.electionLost', { node: leaderName }));
      }
      
      // Notifier les callbacks
      for (const callback of this.callbacks) {
        try {
          callback(isLeader, leaderName);
        } catch {
          // Ignorer les erreurs des callbacks
        }
      }
      
      this.wasLeader = isLeader;
      this.lastLeaderName = leaderName;
    }
    
    return result;
  }

  /**
   * Récupère l'état actuel
   */
  getState(): { isLeader: boolean; leaderName: string | null } {
    return {
      isLeader: this.wasLeader ?? false,
      leaderName: this.lastLeaderName,
    };
  }

  /**
   * Force une re-élection
   */
  forceElection(): ElectionResult | null {
    this.wasLeader = null;
    this.lastLeaderName = null;
    return this.checkElection();
  }
}
