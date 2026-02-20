/**
 * @file stonith/index.ts
 * @description Module STONITH principal - FenceCoordinator et exports
 * 
 * STONITH = "Shoot The Other Node In The Head"
 * Mécanisme critique pour éviter le split-brain en HA
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { StonithDriver } from './drivers/base.js';
import { ProxmoxStonithDriver } from './drivers/proxmox.js';
import { WebhookStonithDriver } from './drivers/webhook.js';
import {
  StonithConfig,
  NodeStonithConfig,
  FenceResult,
  FenceHistoryEntry,
  StonithStatus,
  StonithSafetyConfig,
  DEFAULT_STONITH_SAFETY,
} from './types.js';

// Re-exports
export * from './types.js';
export type { StonithDriver } from './drivers/base.js';
export { ProxmoxStonithDriver } from './drivers/proxmox.js';
export { WebhookStonithDriver } from './drivers/webhook.js';

// ============================================
// Constants
// ============================================

const HISTORY_FILE = '/var/lib/sfha/stonith-history.json';
const MAX_HISTORY_ENTRIES = 100;

// ============================================
// FenceCoordinator
// ============================================

/**
 * Coordonnateur de fencing - gère les opérations STONITH avec sécurité
 * 
 * RÈGLES DE SÉCURITÉ CRITIQUES:
 * 1. NE JAMAIS fence sans quorum (si requis)
 * 2. NE JAMAIS fence un nœud récemment fencé (< minDelay)
 * 3. NE JAMAIS fence si trop de fencing récents (storm detection)
 * 4. NE JAMAIS fence pendant la période de grâce au démarrage
 */
export class FenceCoordinator {
  private config: StonithConfig;
  private driver: StonithDriver | null = null;
  private log: (msg: string) => void;
  private history: FenceHistoryEntry[] = [];
  private startTime: Date;
  private getQuorum: () => boolean;

  constructor(
    config: StonithConfig,
    getQuorum: () => boolean,
    log: (msg: string) => void = console.log
  ) {
    this.config = config;
    this.getQuorum = getQuorum;
    this.log = log;
    this.startTime = new Date();
    
    // Charger l'historique
    this.loadHistory();
  }

  /**
   * Initialise le driver STONITH
   */
  async initialize(): Promise<boolean> {
    if (!this.config.enabled) {
      this.log('⚠️ STONITH désactivé dans la configuration');
      return false;
    }

    try {
      // Créer le driver approprié
      switch (this.config.provider) {
        case 'proxmox':
          if (!this.config.proxmox) {
            throw new Error('Configuration Proxmox manquante');
          }
          this.driver = new ProxmoxStonithDriver(this.config.proxmox, this.log);
          break;
        case 'webhook':
          if (!this.config.webhook) {
            throw new Error('Configuration Webhook manquante');
          }
          this.driver = new WebhookStonithDriver(this.config.webhook, this.log);
          break;
        default:
          throw new Error(`Provider STONITH inconnu: ${this.config.provider}`);
      }

      // Tester la connexion
      const connected = await this.driver.test();
      if (!connected) {
        this.log('❌ STONITH: Impossible de se connecter au provider');
        return false;
      }

      this.log(`✅ STONITH initialisé (provider: ${this.config.provider})`);
      return true;
    } catch (error: any) {
      this.log(`❌ Erreur initialisation STONITH: ${error.message}`);
      return false;
    }
  }

  /**
   * FENCE - Éteint un nœud avec toutes les vérifications de sécurité
   */
  async fence(targetNode: string, manual: boolean = false): Promise<FenceResult> {
    const startTime = Date.now();

    // Récupérer la config du nœud
    const nodeConfigRaw = this.config.nodes[targetNode];
    if (!nodeConfigRaw) {
      return {
        success: false,
        node: targetNode,
        action: 'skipped',
        reason: `Nœud ${targetNode} non configuré dans STONITH`,
        timestamp: new Date(),
      };
    }

    const nodeConfig: NodeStonithConfig = {
      name: targetNode,
      ...nodeConfigRaw,
    };

    // === VÉRIFICATIONS DE SÉCURITÉ ===

    // 1. STONITH activé ?
    if (!this.config.enabled || !this.driver) {
      return {
        success: false,
        node: targetNode,
        action: 'skipped',
        reason: 'STONITH désactivé',
        timestamp: new Date(),
      };
    }

    // 2. Quorum requis ?
    if (this.config.safety.requireQuorum && !this.getQuorum()) {
      this.log(`🚫 STONITH REFUSÉ: Pas de quorum pour fence ${targetNode}`);
      return {
        success: false,
        node: targetNode,
        action: 'skipped',
        reason: 'Pas de quorum - fence interdit',
        timestamp: new Date(),
      };
    }

    // 3. Période de grâce au démarrage ?
    const gracePeriodMs = this.config.safety.startupGracePeriod * 1000;
    const elapsed = Date.now() - this.startTime.getTime();
    if (elapsed < gracePeriodMs && !manual) {
      this.log(`🚫 STONITH REFUSÉ: En période de grâce (${Math.round((gracePeriodMs - elapsed) / 1000)}s restantes)`);
      return {
        success: false,
        node: targetNode,
        action: 'skipped',
        reason: `Période de grâce au démarrage (${Math.round((gracePeriodMs - elapsed) / 1000)}s restantes)`,
        timestamp: new Date(),
      };
    }

    // 4. Fencing récent sur ce nœud ?
    const lastFence = this.getLastFence(targetNode);
    if (lastFence) {
      const timeSinceLastFence = (Date.now() - lastFence.timestamp.getTime()) / 1000;
      if (timeSinceLastFence < this.config.safety.minDelayBetweenFence) {
        this.log(`🚫 STONITH REFUSÉ: Fencing récent sur ${targetNode} (il y a ${Math.round(timeSinceLastFence)}s)`);
        return {
          success: false,
          node: targetNode,
          action: 'skipped',
          reason: `Fencing récent (${Math.round(timeSinceLastFence)}s < ${this.config.safety.minDelayBetweenFence}s)`,
          timestamp: new Date(),
        };
      }
    }

    // 5. Storm detection - trop de fencing en 5 minutes ?
    const recentFences = this.getRecentFences(5 * 60 * 1000);
    if (recentFences >= this.config.safety.maxFencesPer5Min && !manual) {
      this.log(`🚫 STONITH REFUSÉ: Storm detection - ${recentFences} fencing en 5 min`);
      return {
        success: false,
        node: targetNode,
        action: 'skipped',
        reason: `Storm detection: ${recentFences} fencing en 5 minutes`,
        timestamp: new Date(),
      };
    }

    // === EXÉCUTION DU FENCE ===
    this.log(`🔴 STONITH: FENCING ${targetNode} (${nodeConfig.type}/${nodeConfig.vmid})...`);

    try {
      const success = await this.driver.powerOff(nodeConfig);
      const duration = Date.now() - startTime;

      // Enregistrer dans l'historique
      const entry: FenceHistoryEntry = {
        node: targetNode,
        action: 'power_off',
        success,
        reason: manual ? 'Fence manuel' : 'Nœud détecté mort',
        timestamp: new Date(),
        duration,
        initiatedBy: manual ? 'manual' : 'automatic',
      };
      this.addHistoryEntry(entry);

      if (success) {
        this.log(`✅ STONITH: ${targetNode} fencé avec succès en ${duration}ms`);
      } else {
        this.log(`❌ STONITH: Échec du fence de ${targetNode}`);
      }

      return {
        success,
        node: targetNode,
        action: 'power_off',
        timestamp: new Date(),
        duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;

      // Enregistrer l'échec
      this.addHistoryEntry({
        node: targetNode,
        action: 'power_off',
        success: false,
        reason: error.message,
        timestamp: new Date(),
        duration,
        initiatedBy: manual ? 'manual' : 'automatic',
      });

      this.log(`❌ STONITH: Erreur lors du fence de ${targetNode}: ${error.message}`);

      return {
        success: false,
        node: targetNode,
        action: 'power_off',
        reason: error.message,
        timestamp: new Date(),
        duration,
      };
    }
  }

  /**
   * Unfence - Rallume un nœud
   */
  async unfence(targetNode: string): Promise<FenceResult> {
    const startTime = Date.now();

    const nodeConfigRaw = this.config.nodes[targetNode];
    if (!nodeConfigRaw) {
      return {
        success: false,
        node: targetNode,
        action: 'skipped',
        reason: `Nœud ${targetNode} non configuré`,
        timestamp: new Date(),
      };
    }

    if (!this.driver) {
      return {
        success: false,
        node: targetNode,
        action: 'skipped',
        reason: 'STONITH non initialisé',
        timestamp: new Date(),
      };
    }

    const nodeConfig: NodeStonithConfig = {
      name: targetNode,
      ...nodeConfigRaw,
    };

    this.log(`🟢 STONITH: Démarrage de ${targetNode}...`);

    try {
      const success = await this.driver.powerOn(nodeConfig);
      const duration = Date.now() - startTime;

      this.addHistoryEntry({
        node: targetNode,
        action: 'power_on',
        success,
        reason: 'Unfence manuel',
        timestamp: new Date(),
        duration,
        initiatedBy: 'manual',
      });

      return {
        success,
        node: targetNode,
        action: 'power_on',
        timestamp: new Date(),
        duration,
      };
    } catch (error: any) {
      return {
        success: false,
        node: targetNode,
        action: 'power_on',
        reason: error.message,
        timestamp: new Date(),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Récupère le statut complet du STONITH
   */
  async getStatus(): Promise<StonithStatus> {
    const nodes = [];

    for (const [name, config] of Object.entries(this.config.nodes)) {
      const nodeConfig: NodeStonithConfig = { name, ...config };
      let powerState: 'on' | 'off' | 'unknown' = 'unknown';

      if (this.driver) {
        try {
          powerState = await this.driver.status(nodeConfig);
        } catch {
          // Ignorer les erreurs
        }
      }

      const lastFence = this.getLastFence(name);

      nodes.push({
        name,
        vmid: config.vmid,
        type: config.type,
        powerState,
        lastFence: lastFence?.timestamp,
      });
    }

    const gracePeriodMs = this.config.safety.startupGracePeriod * 1000;
    const elapsed = Date.now() - this.startTime.getTime();

    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      apiConnected: this.driver !== null,
      nodes,
      safety: {
        requireQuorum: this.config.safety.requireQuorum,
        inStartupGrace: elapsed < gracePeriodMs,
        recentFences: this.getRecentFences(5 * 60 * 1000),
      },
    };
  }

  /**
   * Récupère l'historique des fencing
   */
  getHistory(): FenceHistoryEntry[] {
    return [...this.history];
  }

  // ============================================
  // Méthodes privées
  // ============================================

  /**
   * Récupère le dernier fence d'un nœud
   */
  private getLastFence(node: string): FenceHistoryEntry | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].node === node && this.history[i].action === 'power_off') {
        return this.history[i];
      }
    }
    return undefined;
  }

  /**
   * Compte les fences récents
   */
  private getRecentFences(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.history.filter(
      (h) => h.action === 'power_off' && h.timestamp.getTime() > cutoff
    ).length;
  }

  /**
   * Charge l'historique depuis le fichier
   */
  private loadHistory(): void {
    try {
      if (existsSync(HISTORY_FILE)) {
        const content = readFileSync(HISTORY_FILE, 'utf-8');
        const parsed = JSON.parse(content);
        this.history = parsed.map((h: any) => ({
          ...h,
          timestamp: new Date(h.timestamp),
        }));
      }
    } catch {
      this.history = [];
    }
  }

  /**
   * Sauvegarde l'historique
   */
  private saveHistory(): void {
    try {
      const dir = dirname(HISTORY_FILE);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(HISTORY_FILE, JSON.stringify(this.history, null, 2));
    } catch (error: any) {
      this.log(`⚠️ Impossible de sauvegarder l'historique STONITH: ${error.message}`);
    }
  }

  /**
   * Ajoute une entrée à l'historique
   */
  private addHistoryEntry(entry: FenceHistoryEntry): void {
    this.history.push(entry);
    
    // Limiter la taille
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history = this.history.slice(-MAX_HISTORY_ENTRIES);
    }
    
    this.saveHistory();
  }

  /**
   * Détruit le coordinateur et libère les ressources
   */
  async destroy(): Promise<void> {
    if (this.driver?.destroy) {
      await this.driver.destroy();
    }
    this.driver = null;
  }
}

// ============================================
// Factory function
// ============================================

/**
 * Crée un FenceCoordinator à partir de la configuration
 */
export function createFenceCoordinator(
  config: StonithConfig | undefined,
  getQuorum: () => boolean,
  log: (msg: string) => void = console.log
): FenceCoordinator | null {
  if (!config || !config.enabled) {
    return null;
  }

  // Appliquer les valeurs par défaut pour safety
  const safeConfig: StonithConfig = {
    ...config,
    safety: {
      ...DEFAULT_STONITH_SAFETY,
      ...config.safety,
    },
  };

  return new FenceCoordinator(safeConfig, getQuorum, log);
}
