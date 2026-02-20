/**
 * @file daemon.ts
 * @description Démon principal sfha
 */

import { EventEmitter } from 'events';
import { SfhaConfig, loadConfig } from './config.js';
import { CorosyncWatcher, CorosyncState, isCorosyncRunning, getQuorumStatus, getClusterNodes } from './corosync.js';
import { activateAllVips, deactivateAllVips, getVipsState, VipState } from './vip.js';
import { HealthManager, HealthResult } from './health.js';
import { ResourceManager, ResourceState, restartService, isServiceActive } from './resources.js';
import { ElectionManager, ElectionResult, electLeader } from './election.js';
import { ControlServer, ControlCommand, ControlResponse } from './control.js';
import { FenceCoordinator, createFenceCoordinator, StonithStatus, FenceHistoryEntry } from './stonith/index.js';
import { t, initI18n } from './i18n.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';

// ============================================
// Types
// ============================================

export interface DaemonStatus {
  version: string;
  running: boolean;
  isLeader: boolean;
  standby: boolean;
  leaderName: string | null;
  corosync: {
    running: boolean;
    quorate: boolean;
    nodesOnline: number;
    nodesTotal: number;
  };
  vips: VipState[];
  services: ResourceState[];
  health: Record<string, HealthResult>;
  stonith: {
    enabled: boolean;
    provider?: string;
    connected?: boolean;
  };
  config: {
    clusterName: string;
    nodeName: string;
  };
}

export interface DaemonOptions {
  configPath?: string;
  lang?: string;
  debug?: boolean;
}

// ============================================
// Constants
// ============================================

const PID_FILE = '/var/run/sfha.pid';
const VERSION = '1.0.0';

// ============================================
// Daemon
// ============================================

/**
 * Démon sfha principal
 */
export class SfhaDaemon extends EventEmitter {
  private config: SfhaConfig | null = null;
  private configPath: string;
  private running = false;
  private isLeader = false;
  private standby = false;
  
  private corosyncWatcher: CorosyncWatcher | null = null;
  private healthManager: HealthManager | null = null;
  private resourceManager: ResourceManager | null = null;
  private electionManager: ElectionManager | null = null;
  private controlServer: ControlServer | null = null;
  private fenceCoordinator: FenceCoordinator | null = null;
  
  // Tracking des nœuds morts pour STONITH
  private deadNodePolls: Map<string, number> = new Map();
  // Timers de délai avant fencing (pour annuler si le nœud revient)
  private pendingFenceTimers: Map<string, NodeJS.Timeout> = new Map();
  
  private log: (msg: string) => void;
  private debug: boolean;
  private pollsWithoutVip: number = 0;
  private pollsAsSecondary: number = 0;
  private startupGracePeriod: boolean = true;

  constructor(options: DaemonOptions = {}) {
    super();
    this.configPath = options.configPath || '/etc/sfha/config.yml';
    this.debug = options.debug || false;
    
    // Initialiser i18n
    initI18n(options.lang);
    
    // Logger
    this.log = (msg: string) => {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] ${msg}`);
    };
  }

  /**
   * Charge la configuration
   */
  loadConfiguration(): void {
    this.config = loadConfig(this.configPath);
    this.log(`📋 Configuration chargée: ${this.config.cluster.name}`);
  }

  /**
   * Recharge la configuration à chaud
   */
  reload(): void {
    this.log(t('action.reload'));
    
    // Recharger la config
    const newConfig = loadConfig(this.configPath);
    
    // Mettre à jour les managers si nécessaire
    if (this.running && this.config) {
      // Pour l'instant, on ne supporte que le rechargement simple
      this.config = newConfig;
      
      // Recréer le health manager avec les nouveaux services
      if (this.healthManager) {
        this.healthManager.stop();
        this.healthManager = new HealthManager(this.config.services, this.log);
        this.healthManager.onHealthChange((name, healthy, result) => {
          this.handleHealthChange(name, healthy, result);
        });
        if (this.isLeader) {
          this.healthManager.start();
        }
      }
      
      // Recréer le resource manager
      this.resourceManager = new ResourceManager(
        this.config.services,
        this.config.constraints,
        this.log
      );
    } else {
      this.config = newConfig;
    }
    
    this.log(t('action.reloaded'));
  }

  /**
   * Démarre le démon
   */
  async start(): Promise<void> {
    if (this.running) return;
    
    this.log(t('daemon.starting'));
    
    // Créer le fichier PID
    this.writePidFile();
    
    // Charger la configuration si pas déjà fait
    if (!this.config) {
      this.loadConfiguration();
    }
    
    // Vérifier Corosync
    if (!isCorosyncRunning()) {
      throw new Error(t('corosync.notRunning'));
    }
    
    // Démarrer le serveur de contrôle
    this.controlServer = new ControlServer(
      (cmd) => this.handleControlCommand(cmd),
      this.log
    );
    this.controlServer.start();
    
    // Attendre le quorum si requis
    if (this.config!.cluster.quorumRequired) {
      await this.waitForQuorum();
    }
    
    // Initialiser les managers
    this.electionManager = new ElectionManager(this.log);
    this.healthManager = new HealthManager(this.config!.services, this.log);
    this.resourceManager = new ResourceManager(
      this.config!.services,
      this.config!.constraints,
      this.log
    );
    
    // Initialiser STONITH si configuré
    if (this.config!.stonith?.enabled) {
      this.fenceCoordinator = createFenceCoordinator(
        this.config!.stonith,
        () => getQuorumStatus().quorate,
        this.log
      );
      if (this.fenceCoordinator) {
        const stonithOk = await this.fenceCoordinator.initialize();
        if (stonithOk) {
          this.log('🔫 STONITH initialisé et prêt');
        } else {
          this.log('⚠️ STONITH configuré mais initialisation échouée');
        }
      }
    }
    
    // Configurer les callbacks
    this.electionManager.onLeaderChange((isLeader, leaderName) => {
      this.handleLeaderChange(isLeader, leaderName);
    });
    
    this.healthManager.onHealthChange((name, healthy, result) => {
      this.handleHealthChange(name, healthy, result);
    });
    
    // Démarrer le watcher Corosync
    this.corosyncWatcher = new CorosyncWatcher(this.config!.cluster.pollIntervalMs);
    this.corosyncWatcher.on('poll', (state: CorosyncState) => this.handlePoll(state));
    this.corosyncWatcher.on('nodeStateChange', (node: { name: string; online: boolean }) => {
      this.handleNodeStateChange(node);
    });
    this.corosyncWatcher.on('quorumChange', (quorate: boolean) => this.handleQuorumChange(quorate));
    this.corosyncWatcher.start();
    
    this.running = true;
    this.log(t('daemon.started'));
    
    // Première élection
    this.checkElection();
    
    // Grace period de démarrage - ne pas essayer de prendre le leadership
    // si on voit que la VIP est absente pendant les premières 30 secondes
    // (le leader légitime a besoin de temps pour s'activer)
    this.startupGracePeriod = true;
    setTimeout(() => {
      this.startupGracePeriod = false;
      this.log('✅ Période de grâce de démarrage terminée');
    }, 30000);
  }

  /**
   * Arrête le démon
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    
    this.log(t('daemon.stopping'));
    
    // Arrêter le serveur de contrôle
    this.controlServer?.stop();
    
    // Désactiver les ressources si leader
    if (this.isLeader) {
      this.deactivateResources();
    }
    
    // Arrêter les managers
    this.corosyncWatcher?.stop();
    this.healthManager?.stop();
    
    // Supprimer le fichier PID
    this.removePidFile();
    
    this.running = false;
    this.isLeader = false;
    
    this.log(t('daemon.stopped'));
  }

  /**
   * Gère les commandes de contrôle
   */
  private async handleControlCommand(cmd: ControlCommand): Promise<ControlResponse> {
    switch (cmd.action) {
      case 'status':
        return {
          success: true,
          data: this.getStatus(),
        };
      
      case 'health':
        const healthState = this.healthManager?.getState() || new Map();
        const healthData: Record<string, HealthResult> = {};
        for (const [key, value] of healthState) {
          healthData[key] = value;
        }
        return {
          success: true,
          data: healthData,
        };
      
      case 'resources':
        return {
          success: true,
          data: {
            vips: this.config ? getVipsState(this.config.vips) : [],
            services: this.resourceManager?.getState() || [],
          },
        };
      
      case 'standby':
        this.setStandby(true);
        return {
          success: true,
          message: t('action.standbyOn', { node: this.config?.node.name || 'local' }),
        };
      
      case 'unstandby':
        this.setStandby(false);
        return {
          success: true,
          message: t('action.standbyOff', { node: this.config?.node.name || 'local' }),
        };
      
      case 'failover':
        try {
          await this.failover(cmd.params?.targetNode);
          return {
            success: true,
            message: t('action.failoverInitiated', { node: cmd.params?.targetNode || 'suivant' }),
          };
        } catch (error: any) {
          return {
            success: false,
            error: error.message,
          };
        }
      
      case 'reload':
        try {
          this.reload();
          return {
            success: true,
            message: t('action.reloaded'),
          };
        } catch (error: any) {
          return {
            success: false,
            error: error.message,
          };
        }
      
      case 'stonith-status':
        if (!this.fenceCoordinator) {
          return {
            success: true,
            data: { enabled: false, reason: 'STONITH non configuré' },
          };
        }
        try {
          const status = await this.fenceCoordinator.getStatus();
          return {
            success: true,
            data: status,
          };
        } catch (error: any) {
          return {
            success: false,
            error: error.message,
          };
        }
      
      case 'stonith-fence':
        if (!this.fenceCoordinator) {
          return {
            success: false,
            error: 'STONITH non configuré',
          };
        }
        if (!cmd.params?.node) {
          return {
            success: false,
            error: 'Nœud cible requis',
          };
        }
        try {
          const result = await this.fenceCoordinator.fence(cmd.params.node, true);
          return {
            success: result.success,
            data: result,
            error: result.reason,
          };
        } catch (error: any) {
          return {
            success: false,
            error: error.message,
          };
        }
      
      case 'stonith-unfence':
        if (!this.fenceCoordinator) {
          return {
            success: false,
            error: 'STONITH non configuré',
          };
        }
        if (!cmd.params?.node) {
          return {
            success: false,
            error: 'Nœud cible requis',
          };
        }
        try {
          const result = await this.fenceCoordinator.unfence(cmd.params.node);
          return {
            success: result.success,
            data: result,
            error: result.reason,
          };
        } catch (error: any) {
          return {
            success: false,
            error: error.message,
          };
        }
      
      case 'stonith-history':
        if (!this.fenceCoordinator) {
          return {
            success: true,
            data: [],
          };
        }
        return {
          success: true,
          data: this.fenceCoordinator.getHistory(),
        };
      
      default:
        return {
          success: false,
          error: `Action inconnue: ${cmd.action}`,
        };
    }
  }

  /**
   * Attend le quorum
   */
  private async waitForQuorum(): Promise<void> {
    this.log(t('daemon.waitingQuorum'));
    
    while (true) {
      const quorum = getQuorumStatus();
      if (quorum.quorate) {
        this.log(t('daemon.quorumAcquired'));
        return;
      }
      
      // Attendre avant de réessayer
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  /**
   * Vérifie l'élection
   * Si ce nœud est en standby, il ne peut pas devenir leader
   */
  private checkElection(): void {
    if (!this.electionManager) return;
    
    // Si en standby, ne pas participer à l'élection en tant que leader potentiel
    if (this.standby) {
      // Mais vérifier quand même qui est le leader pour les logs
      const result = this.electionManager.checkElection();
      if (result?.isLocalLeader) {
        // On est le leader élu mais en standby - on refuse le leadership
        this.isLeader = false;
        this.log('⚠️ Élu leader mais en standby - ressources non activées');
      }
      return;
    }
    
    this.electionManager.checkElection();
  }

  /**
   * Force ce nœud à devenir leader
   * Utilisé quand on détecte que le leader actuel ne fonctionne plus (VIP absente)
   * 
   * IMPORTANT: Vérifie le quorum ET que ce nœud devrait être leader selon l'élection
   */
  private becomeLeader(): void {
    if (this.isLeader || this.standby) return;
    
    // BUG FIX #2: Vérifier le quorum AVANT de devenir leader
    const quorum = getQuorumStatus();
    if (!quorum.quorate) {
      this.log('⚠️ Pas de quorum - impossible de devenir leader');
      return;
    }
    
    // BUG FIX #3: Vérifier que ce nœud DEVRAIT être leader selon l'élection
    const election = electLeader();
    if (!election?.isLocalLeader) {
      this.log(`⚠️ Ce nœud n'est pas éligible au leadership (leader élu: ${election?.leaderName || 'aucun'})`);
      return;
    }
    
    this.log('👑 Ce nœud devient leader (prise de relai)');
    this.isLeader = true;
    this.activateResources();
    
    // Ne PAS appeler forceElection() car cela élirait le nœud avec le plus petit nodeId
    // et nous désactiverait immédiatement. On garde notre leadership forcé.
    
    this.emit('leaderChange', true, this.config?.node.name || 'local');
  }

  /**
   * Gère le changement de leadership
   * 
   * BUG FIX #1: Quand on perd le leadership, TOUJOURS désactiver les VIPs immédiatement
   * pour éviter les VIPs dupliquées sur plusieurs nœuds.
   */
  private handleLeaderChange(isLeader: boolean, leaderName: string): void {
    const wasLeader = this.isLeader;
    
    // BUG FIX #1: Si on perd le leadership, désactiver les ressources IMMÉDIATEMENT
    // Pas de délai, pas de compteur - la VIP doit être supprimée tout de suite
    if (wasLeader && !isLeader) {
      this.log(`⚠️ Perte du leadership - désactivation immédiate des ressources`);
      this.pollsAsSecondary = 0;
      this.isLeader = false;
      this.deactivateResources();
      this.emit('leaderChange', false, leaderName);
      return;
    }
    
    this.pollsAsSecondary = 0;
    this.isLeader = isLeader;
    
    if (isLeader && !wasLeader) {
      // Devenu leader - vérifier le quorum avant d'activer
      const quorum = getQuorumStatus();
      if (!quorum.quorate && this.config?.cluster.quorumRequired) {
        this.log('⚠️ Élu leader mais pas de quorum - ressources non activées');
        this.isLeader = false;
        return;
      }
      this.activateResources();
    }
    
    this.emit('leaderChange', isLeader, leaderName);
  }

  /**
   * Active les ressources (VIPs + services)
   * 
   * BUG FIX #3: Vérifie qu'on est bien leader et qu'on a le quorum avant d'activer
   */
  private activateResources(): void {
    if (!this.config) return;
    
    // BUG FIX #3: Double vérification - seul le leader peut activer les VIPs
    if (!this.isLeader) {
      this.log('⚠️ Tentative d\'activation des ressources sans être leader - ignorée');
      return;
    }
    
    // BUG FIX #2: Vérifier le quorum avant d'activer
    const quorum = getQuorumStatus();
    if (!quorum.quorate && this.config.cluster.quorumRequired) {
      this.log('⚠️ Tentative d\'activation des ressources sans quorum - ignorée');
      this.isLeader = false;
      return;
    }
    
    this.log('🚀 Activation des ressources...');
    
    // Activer les VIPs
    activateAllVips(this.config.vips, this.log);
    
    // Démarrer les services
    this.resourceManager?.startAll();
    
    // Démarrer les health checks
    this.healthManager?.start();
    
    this.log('✅ Ressources activées');
  }

  /**
   * Désactive les ressources
   */
  private deactivateResources(): void {
    if (!this.config) return;
    
    this.log('🛑 Désactivation des ressources...');
    
    // Arrêter les health checks
    this.healthManager?.stop();
    
    // Arrêter les services
    this.resourceManager?.stopAll();
    
    // Désactiver les VIPs
    deactivateAllVips(this.config.vips, this.log);
    
    this.log('✅ Ressources désactivées');
  }

  /**
   * Gère les polls Corosync
   */
  private handlePoll(state: CorosyncState): void {
    if (this.debug) {
      this.log(`🔄 Poll: ${state.nodes.filter(n => n.online).length}/${state.nodes.length} nœuds, quorum=${state.quorum.quorate}`);
    }
    
    // BUG FIX #2: Vérification du quorum à chaque poll
    // Si pas de quorum et qu'on a des ressources actives, les désactiver
    if (!state.quorum.quorate && this.config?.cluster.quorumRequired) {
      if (this.isLeader) {
        this.log('⚠️ Perte de quorum détectée - désactivation des ressources');
        this.isLeader = false;
        this.deactivateResources();
      }
      // BUG FIX #3: Watchdog - même si on n'est pas leader, vérifier qu'on n'a pas la VIP
      this.ensureNoVipOnFollower();
      this.pollsWithoutVip = 0;
      this.emit('poll', state);
      return;
    }
    
    // BUG FIX #3: Watchdog - si on n'est pas leader, on ne doit JAMAIS avoir la VIP
    if (!this.isLeader && this.config) {
      this.ensureNoVipOnFollower();
    }
    
    // Si on n'est pas leader et pas en standby, vérifier si le leader actuel a la VIP
    // Si non, on peut potentiellement prendre le relai
    // MAIS PAS pendant la période de grâce de démarrage (le leader légitime peut être en train de démarrer)
    if (!this.isLeader && !this.standby && !this.startupGracePeriod && this.config) {
      const vipStates = getVipsState(this.config.vips);
      const anyVipActive = vipStates.some(v => v.active);
      
      // Si aucune VIP n'est active nulle part, c'est peut-être que le leader est down
      if (!anyVipActive) {
        // BUG FIX #2: Vérifier le quorum AVANT de considérer la prise de leadership
        if (!state.quorum.quorate) {
          this.log('⚠️ VIP absente mais pas de quorum - pas de prise de leadership');
          this.pollsWithoutVip = 0;
          this.emit('poll', state);
          return;
        }
        
        // Incrémenter le compteur de polls sans VIP
        this.pollsWithoutVip = (this.pollsWithoutVip || 0) + 1;
        
        // Après 3 polls sans VIP (15s par défaut), forcer la prise de leadership
        if (this.pollsWithoutVip >= 3) {
          this.log('🚨 VIP absente depuis 3 polls - tentative de prise de leadership');
          this.becomeLeader(); // becomeLeader() vérifie maintenant le quorum et l'éligibilité
          this.pollsWithoutVip = 0;
        } else {
          this.log(`⚠️ Aucune VIP active détectée (${this.pollsWithoutVip}/3)...`);
        }
      } else {
        this.pollsWithoutVip = 0;
      }
    }
    
    // STONITH - Détecter les nœuds morts et déclencher le fencing
    // Seulement si on est leader et qu'on a le quorum
    if (this.isLeader && this.fenceCoordinator && state.quorum.quorate) {
      this.checkDeadNodesForFencing(state);
    }
    
    this.emit('poll', state);
  }
  
  /**
   * BUG FIX #3: Watchdog - s'assure qu'un follower n'a JAMAIS la VIP
   * Appelé à chaque poll pour garantir la cohérence
   */
  private ensureNoVipOnFollower(): void {
    if (this.isLeader || !this.config) return;
    
    const vipStates = getVipsState(this.config.vips);
    const activeVips = vipStates.filter(v => v.active);
    
    if (activeVips.length > 0) {
      this.log('🚨 WATCHDOG: VIP active sur un follower ! Désactivation immédiate...');
      for (const vip of activeVips) {
        this.log(`🚨 Suppression de la VIP ${vip.ip} (ne devrait pas être là)`);
      }
      deactivateAllVips(this.config.vips, this.log);
    }
  }

  /**
   * Vérifie les nœuds morts et déclenche le fencing si nécessaire
   * BACKUP METHOD: Utilise le polling pour détecter les nœuds qui sont offline
   * mais qui n'ont pas été détectés par l'event nodeStateChange
   * (ex: nœud déjà offline au démarrage du daemon)
   */
  private async checkDeadNodesForFencing(state: CorosyncState): Promise<void> {
    const myNodeName = this.config?.node.name;
    
    // Nœuds actuellement offline
    const offlineNodes = state.nodes.filter(n => !n.online && n.name !== myNodeName);
    
    for (const node of offlineNodes) {
      // Si un timer est déjà programmé pour ce nœud, ne rien faire
      if (this.pendingFenceTimers.has(node.name)) {
        continue;
      }
      
      // Incrémenter le compteur
      const currentCount = this.deadNodePolls.get(node.name) || 0;
      this.deadNodePolls.set(node.name, currentCount + 1);
      
      const pollCount = currentCount + 1;
      
      // Après 2 polls consécutifs, programmer le fencing si pas déjà fait
      // (le fencing event-driven devrait normalement l'avoir fait avant)
      if (pollCount === 2) {
        if (this.shouldFenceNode(node.name)) {
          this.log(`⚠️ [BACKUP] Nœud ${node.name} offline depuis ${pollCount} polls - programmation du fencing`);
          this.scheduleFence(node.name);
        }
      } else if (pollCount === 1 && this.debug) {
        this.log(`⚠️ Nœud ${node.name} offline (premier poll)`);
      }
    }
    
    // Reset les compteurs pour les nœuds qui sont revenus online
    const onlineNodeNames = new Set(state.nodes.filter(n => n.online).map(n => n.name));
    for (const [nodeName] of this.deadNodePolls) {
      if (onlineNodeNames.has(nodeName)) {
        this.deadNodePolls.delete(nodeName);
      }
    }
  }

  /**
   * Gère les changements de quorum
   */
  private handleQuorumChange(quorate: boolean): void {
    if (!quorate && this.config?.cluster.quorumRequired) {
      this.log('⚠️ ' + t('status.noQuorum'));
      // En cas de perte de quorum, désactiver les ressources
      if (this.isLeader) {
        this.deactivateResources();
        this.isLeader = false;
      }
      // Annuler tous les fencings en attente (on n'a plus le quorum)
      this.cancelAllPendingFences('perte de quorum');
    } else if (quorate) {
      this.log('✅ ' + t('status.quorumOk'));
      // Quorum restauré, re-élection
      this.checkElection();
    }
    this.emit('quorumChange', quorate);
  }

  /**
   * Gère les changements d'état de nœud (détection immédiate)
   * C'est le point d'entrée principal pour le STONITH automatique
   */
  private handleNodeStateChange(node: { name: string; online: boolean; previousState?: boolean }): void {
    const myNodeName = this.config?.node.name;
    
    // Ignorer les changements sur notre propre nœud
    if (node.name === myNodeName) return;
    
    if (!node.online && node.previousState === true) {
      // === NŒUD VIENT DE DISPARAÎTRE ===
      this.log(`⚠️ Nœud ${node.name} n'est plus dans le cluster`);
      
      // Vérifier les conditions pour le fencing
      if (!this.shouldFenceNode(node.name)) {
        return;
      }
      
      // Programmer le fencing avec délai de grâce
      this.scheduleFence(node.name);
      
    } else if (node.online && node.previousState === false) {
      // === NŒUD REVIENT EN LIGNE ===
      this.log(`✅ Nœud ${node.name} est de retour dans le cluster`);
      
      // Annuler le fencing en attente
      this.cancelPendingFence(node.name);
      
      // Reset le compteur de polls
      this.deadNodePolls.delete(node.name);
    }
    
    // Re-élection si nécessaire
    this.checkElection();
  }

  /**
   * Vérifie si on doit tenter de fence un nœud
   */
  private shouldFenceNode(nodeName: string): boolean {
    // 1. STONITH activé ?
    if (!this.config?.stonith?.enabled) {
      this.log(`ℹ️ STONITH désactivé - pas de fencing pour ${nodeName}`);
      return false;
    }
    
    // 2. FenceCoordinator prêt ?
    if (!this.fenceCoordinator) {
      this.log(`⚠️ FenceCoordinator non initialisé - pas de fencing pour ${nodeName}`);
      return false;
    }
    
    // 3. Quorum ? (seul le cluster majoritaire peut fence)
    const quorum = getQuorumStatus();
    if (!quorum.quorate && this.config.stonith.safety.requireQuorum) {
      this.log(`⚠️ Pas de quorum - pas de fencing pour ${nodeName}`);
      return false;
    }
    
    // 4. On est leader ? (éviter que tous les nœuds fencent en même temps)
    if (!this.isLeader) {
      this.log(`ℹ️ Pas leader - le leader va fence ${nodeName}`);
      return false;
    }
    
    // 5. Le nœud est-il configuré dans STONITH ?
    if (!this.config.stonith.nodes[nodeName]) {
      this.log(`⚠️ Nœud ${nodeName} non configuré dans STONITH - pas de fencing`);
      return false;
    }
    
    return true;
  }

  /**
   * Programme un fencing avec délai de grâce
   */
  private scheduleFence(nodeName: string): void {
    // Annuler un éventuel timer existant
    this.cancelPendingFence(nodeName);
    
    const fenceDelay = this.config?.stonith?.safety?.fenceDelayOnNodeLeft || 10;
    this.log(`⏳ Fencing de ${nodeName} programmé dans ${fenceDelay}s (délai de grâce)`);
    
    const timer = setTimeout(async () => {
      // Supprimer le timer de la map
      this.pendingFenceTimers.delete(nodeName);
      
      // Re-vérifier que le nœud est toujours absent
      const nodes = getClusterNodes();
      const nodeStillOffline = !nodes.find(n => n.name === nodeName && n.online);
      
      if (!nodeStillOffline) {
        this.log(`✅ Nœud ${nodeName} est revenu - fencing annulé`);
        return;
      }
      
      // Re-vérifier toutes les conditions
      if (!this.shouldFenceNode(nodeName)) {
        return;
      }
      
      // FENCE !
      this.log(`🔴 STONITH: Fencing du nœud ${nodeName} (absent depuis ${fenceDelay}s)`);
      try {
        const result = await this.fenceCoordinator!.fence(nodeName, false);
        if (result.success) {
          this.log(`✅ STONITH: ${nodeName} fencé avec succès`);
        } else if (result.action === 'skipped') {
          this.log(`⚠️ STONITH skipped pour ${nodeName}: ${result.reason}`);
        } else {
          this.log(`❌ STONITH: Échec du fence de ${nodeName}: ${result.reason}`);
        }
      } catch (error: any) {
        this.log(`❌ Erreur STONITH sur ${nodeName}: ${error.message}`);
      }
    }, fenceDelay * 1000);
    
    this.pendingFenceTimers.set(nodeName, timer);
  }

  /**
   * Annule un fencing en attente pour un nœud
   */
  private cancelPendingFence(nodeName: string): void {
    const timer = this.pendingFenceTimers.get(nodeName);
    if (timer) {
      clearTimeout(timer);
      this.pendingFenceTimers.delete(nodeName);
      this.log(`✅ Fencing de ${nodeName} annulé (nœud revenu)`);
    }
  }

  /**
   * Annule tous les fencings en attente
   */
  private cancelAllPendingFences(reason: string): void {
    if (this.pendingFenceTimers.size > 0) {
      this.log(`🚫 Annulation de ${this.pendingFenceTimers.size} fencing(s) en attente: ${reason}`);
      for (const [nodeName, timer] of this.pendingFenceTimers) {
        clearTimeout(timer);
      }
      this.pendingFenceTimers.clear();
    }
  }

  /**
   * Gère les changements de santé
   * 
   * Si un service devient défaillant:
   * 1. Tentative de redémarrage du service
   * 2. Si échec après N tentatives, déclenchement du failover
   */
  private async handleHealthChange(name: string, healthy: boolean, result: HealthResult): Promise<void> {
    if (!healthy) {
      this.log(`⚠️ ${t('health.failed', { resource: name, error: result.lastError || 'inconnu' })}`);
      
      // Trouver le service concerné
      const service = this.config?.services.find(s => s.name === name);
      if (!service) return;
      
      // Vérifier le nombre d'échecs consécutifs
      const maxFailures = service.healthcheck?.failuresBeforeUnhealthy || 3;
      const criticalThreshold = maxFailures + 2; // Échecs supplémentaires avant failover
      
      if (result.consecutiveFailures >= criticalThreshold) {
        this.log(`🔴 ${name} a dépassé le seuil critique (${result.consecutiveFailures} échecs)`);
        
        // Tentative de redémarrage du service
        // Import statique en haut du fichier
        this.log(`🔄 Tentative de redémarrage de ${service.unit}...`);
        
        const restartResult = restartService(service.unit);
        
        if (restartResult.ok) {
          // Attendre un peu et vérifier
          await new Promise(resolve => setTimeout(resolve, 3000));
          if (isServiceActive(service.unit)) {
            this.log(`✅ ${service.name} redémarré avec succès`);
            return;
          }
        }
        
        // Échec du redémarrage - déclencher le failover
        this.log(`🚨 ${t('health.failoverTriggered', { resource: name })}`);
        
        try {
          await this.failover();
        } catch (error: any) {
          this.log(`❌ Échec du failover: ${error.message}`);
        }
      }
    } else {
      this.log(`✅ ${t('health.passed', { resource: name })}`);
    }
    
    this.emit('healthChange', name, healthy, result);
  }

  /**
   * Met le nœud en standby
   */
  setStandby(standby: boolean): void {
    if (this.standby === standby) return;
    
    this.standby = standby;
    
    if (standby) {
      this.log(t('action.standbyOn', { node: this.config?.node.name || 'local' }));
      // Si leader, désactiver les ressources
      if (this.isLeader) {
        this.deactivateResources();
        this.isLeader = false;
      }
    } else {
      this.log(t('action.standbyOff', { node: this.config?.node.name || 'local' }));
      // Re-élection
      this.checkElection();
    }
    
    this.emit('standbyChange', standby);
  }

  /**
   * Force un failover vers un autre nœud
   * 
   * Le nœud reste en standby jusqu'à ce qu'on appelle unstandby manuellement.
   * Pour un failover temporaire, utiliser setStandby(true) puis setStandby(false).
   */
  async failover(targetNode?: string): Promise<void> {
    if (!this.isLeader) {
      throw new Error(t('error.notLeader'));
    }
    
    this.log(t('action.failoverInitiated', { node: targetNode || 'suivant' }));
    
    // Désactiver les ressources locales
    this.deactivateResources();
    this.isLeader = false;
    
    // Se mettre en standby pour forcer l'élection d'un autre
    this.standby = true;
    
    this.emit('failover', targetNode);
    
    // Note: Pour réactiver ce nœud, utiliser 'sfha unstandby'
  }

  /**
   * Récupère le statut complet
   */
  getStatus(): DaemonStatus {
    const quorum = getQuorumStatus();
    const nodes = getClusterNodes();
    
    // Convertir la Map en objet pour la sérialisation
    const healthState = this.healthManager?.getState() || new Map();
    const healthData: Record<string, HealthResult> = {};
    for (const [key, value] of healthState) {
      healthData[key] = value;
    }
    
    return {
      version: VERSION,
      running: this.running,
      isLeader: this.isLeader,
      standby: this.standby,
      leaderName: this.electionManager?.getState().leaderName ?? null,
      corosync: {
        running: isCorosyncRunning(),
        quorate: quorum.quorate,
        nodesOnline: nodes.filter((n) => n.online).length,
        nodesTotal: nodes.length,
      },
      vips: this.config ? getVipsState(this.config.vips) : [],
      services: this.resourceManager?.getState() || [],
      health: healthData,
      stonith: {
        enabled: this.config?.stonith?.enabled || false,
        provider: this.config?.stonith?.provider,
        connected: this.fenceCoordinator !== null,
      },
      config: {
        clusterName: this.config?.cluster.name || '',
        nodeName: this.config?.node.name || '',
      },
    };
  }

  /**
   * Écrit le fichier PID
   */
  private writePidFile(): void {
    try {
      writeFileSync(PID_FILE, process.pid.toString());
    } catch {
      // Ignorer si on ne peut pas écrire (permissions)
    }
  }

  /**
   * Supprime le fichier PID
   */
  private removePidFile(): void {
    try {
      if (existsSync(PID_FILE)) {
        unlinkSync(PID_FILE);
      }
    } catch {
      // Ignorer
    }
  }

  /**
   * Vérifie si le démon tourne
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Vérifie si ce nœud est leader
   */
  isCurrentLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Vérifie si ce nœud est en standby
   */
  isInStandby(): boolean {
    return this.standby;
  }
}
