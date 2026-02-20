/**
 * @file stonith/types.ts
 * @description Types pour le module STONITH
 */

// ============================================
// Types de configuration
// ============================================

export interface NodeStonithConfig {
  /** Nom du nœud sfha */
  name: string;
  /** Type de guest: lxc ou qemu */
  type: 'lxc' | 'qemu';
  /** ID du VM/CT sur Proxmox */
  vmid: number;
}

export interface StonithSafetyConfig {
  /** Exiger le quorum avant de fence */
  requireQuorum: boolean;
  /** Délai minimum entre deux fencing du même nœud (secondes) */
  minDelayBetweenFence: number;
  /** Maximum de fencing en 5 minutes (storm detection) */
  maxFencesPer5Min: number;
  /** Période de grâce après démarrage sfha (secondes) */
  startupGracePeriod: number;
  /** Délai avant de fence un nœud qui quitte le cluster (secondes) - défaut 10 */
  fenceDelayOnNodeLeft: number;
}

export interface ProxmoxStonithConfig {
  /** URL de l'API Proxmox */
  apiUrl: string;
  /** Token ID (format: user@realm!tokenid) */
  tokenId: string;
  /** Secret du token (ou chemin vers fichier) */
  tokenSecret?: string;
  /** Chemin vers fichier contenant le secret */
  tokenSecretFile?: string;
  /** Vérifier le certificat SSL */
  verifySsl: boolean;
  /** Nom du nœud Proxmox (PVE node, pas le guest) */
  pveNode: string;
}

export interface StonithConfig {
  /** STONITH activé */
  enabled: boolean;
  /** Provider (proxmox pour l'instant) */
  provider: 'proxmox';
  /** Config spécifique Proxmox */
  proxmox?: ProxmoxStonithConfig;
  /** Mapping nœud sfha -> config VM/CT */
  nodes: Record<string, Omit<NodeStonithConfig, 'name'>>;
  /** Paramètres de sécurité */
  safety: StonithSafetyConfig;
}

// ============================================
// Types de résultats
// ============================================

export type NodePowerState = 'on' | 'off' | 'unknown';

export interface FenceResult {
  success: boolean;
  node: string;
  action: 'power_off' | 'power_on' | 'skipped';
  reason?: string;
  timestamp: Date;
  duration?: number;
}

export interface FenceHistoryEntry {
  node: string;
  action: 'power_off' | 'power_on';
  success: boolean;
  reason: string;
  timestamp: Date;
  duration: number;
  initiatedBy: 'automatic' | 'manual';
}

export interface StonithStatus {
  enabled: boolean;
  provider: string;
  apiConnected: boolean;
  lastApiCheck?: Date;
  nodes: {
    name: string;
    vmid: number;
    type: 'lxc' | 'qemu';
    powerState: NodePowerState;
    lastFence?: Date;
  }[];
  safety: {
    requireQuorum: boolean;
    inStartupGrace: boolean;
    recentFences: number;
  };
}

// ============================================
// Default config
// ============================================

export const DEFAULT_STONITH_SAFETY: StonithSafetyConfig = {
  requireQuorum: true,
  minDelayBetweenFence: 60,
  maxFencesPer5Min: 2,
  startupGracePeriod: 120,
  fenceDelayOnNodeLeft: 10,
};
