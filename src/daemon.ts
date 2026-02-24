/**
 * @file daemon.ts
 * @description Démon principal sfha
 */

import { EventEmitter } from 'events';
import { SfhaConfig, loadConfig } from './config.js';
import { CorosyncWatcher, CorosyncState, isCorosyncRunning, getQuorumStatus, getClusterNodes, getLocalNodeId, publishStandbyState, clearStandbyState } from './corosync.js';
import { activateAllVips, deactivateAllVips, getVipsState, isAnyVipReachable, syncVips, VipState } from './vip.js';
import { HealthManager, HealthResult } from './health.js';
import { ResourceManager, ResourceState, restartService, isServiceActive } from './resources.js';
import { ElectionManager, ElectionResult, electLeader, getNextLeaderCandidate } from './election.js';
import { ControlServer, ControlCommand, ControlResponse } from './control.js';
import { FenceCoordinator, createFenceCoordinator, StonithStatus, FenceHistoryEntry } from './stonith/index.js';
import { t, initI18n } from './i18n.js';
import { logger, setLogLevel, createSimpleLogger } from './utils/logger.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { getMeshManager } from './mesh/index.js';
import { P2PStateManager, initP2PStateManager, syncMeshPeersFromInitiator, propagateVipsToAllPeers, checkAllPeersHealth } from './p2p-state.js';
import { startKnockServer, stopKnockServer, authorizePermanently } from './knock.js';

// ============================================
// Types
// ============================================

export interface ClusterNode {
  name: string;
  ip: string;
  online: boolean;
  isLeader: boolean;
  isLocal: boolean;
}

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
  nodes: ClusterNode[];
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
  /** Token pour ajouter des nœuds au cluster (si mesh configuré) */
  joinToken?: string;
  /** Interface réseau du mesh WireGuard (ex: wg1) */
  meshInterface?: string;
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
const VERSION = '1.0.70';

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
  private p2pStateManager: P2PStateManager | null = null;
  
  // Tracking des nœuds morts pour STONITH
  private deadNodePolls: Map<string, number> = new Map();
  // Timers de délai avant fencing (pour annuler si le nœud revient)
  private pendingFenceTimers: Map<string, NodeJS.Timeout> = new Map();
  // Intervalle de synchronisation périodique des peers mesh
  private meshSyncInterval: NodeJS.Timeout | null = null;
  
  /** Fonction de log pour compatibilité avec les sous-modules */
  private log: (msg: string) => void;
  private debugMode: boolean;
  private pollsWithoutVip: number = 0;
  private pollsAsSecondary: number = 0;
  private startupGracePeriod: boolean = true;
  private previousOnlineNodes: Set<string> = new Set();

  constructor(options: DaemonOptions = {}) {
    super();
    this.configPath = options.configPath || '/etc/sfha/config.yml';
    this.debugMode = options.debug || false;
    
    // Initialiser i18n
    initI18n(options.lang);
    
    // Configurer le logger
    if (this.debugMode) {
      setLogLevel('debug');
    }
    
    // Créer une fonction de log compatible pour les sous-modules
    this.log = createSimpleLogger('info');
  }

  /**
   * Charge la configuration
   */
  loadConfiguration(): void {
    this.config = loadConfig(this.configPath);
    logger.info(`Configuration chargée: ${this.config.cluster.name}`);
    logger.info(`[DEBUG] Services chargés: ${JSON.stringify(this.config.services)}`);
  }

  /**
   * Recharge la configuration à chaud
   */
  reload(): void {
    logger.info(t('action.reload'));
    
    // Recharger la config
    const newConfig = loadConfig(this.configPath);
    
    // Mettre à jour les managers si nécessaire
    if (this.running && this.config) {
      // Pour l'instant, on ne supporte que le rechargement simple
      this.config = newConfig;
      
      // Recréer le health manager avec les nouveaux services et health checks
      if (this.healthManager) {
        this.healthManager.stop();
        this.healthManager = new HealthManager(
          this.config.services,
          this.log,
          this.config.healthChecks
        );
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
      
      // Si leader, synchroniser les VIPs et propager aux autres nœuds
      // IMPORTANT: On propage UNIQUEMENT les VIPs, pas la config complète
      // La config complète (Corosync) est propagée uniquement via 'sfha propagate'
      // lors de l'ajout/suppression de nœuds
      if (this.isLeader) {
        // Synchroniser les VIPs (ajoute les nouvelles, supprime les zombies)
        logger.info('Synchronisation des VIPs après rechargement...');
        const syncResult = syncVips(this.config.vips, this.log);
        if (syncResult.added > 0 || syncResult.removed > 0) {
          logger.info(`VIPs sync: ${syncResult.added} ajoutées, ${syncResult.removed} supprimées`);
        } else if (this.config.vips.length === 0) {
          logger.info('Aucune VIP configurée');
        }
        
        // Propager UNIQUEMENT les VIPs aux autres nœuds (même si liste vide)
        // Ceci synchronise la suppression de VIPs sur tous les nœuds
        logger.info('Propagation des VIPs aux autres nœuds...');
        propagateVipsToAllPeers(5000).then(result => {
          if (result.success) {
            logger.info(`VIPs propagées: ${result.succeeded}/${result.total} nœuds mis à jour`);
          } else if (result.total > 0) {
            logger.warn(`Propagation VIPs partielle: ${result.succeeded}/${result.total}`);
          }
          // Si total=0, pas de peers, on ignore silencieusement
        }).catch(err => {
          logger.warn(`Propagation VIPs échouée: ${err.message}`);
        });
      }
    } else {
      this.config = newConfig;
    }
    
    logger.info(t('action.reloaded'));
  }

  /**
   * Démarre le démon
   */
  async start(): Promise<void> {
    if (this.running) return;
    
    logger.info(t('daemon.starting'));
    
    // Créer le fichier PID
    this.writePidFile();
    
    // Charger la configuration si pas déjà fait
    if (!this.config) {
      this.loadConfiguration();
    }
    
    // Vérifier si Corosync est en cours - si non, mode "attente de config"
    const corosyncActive = isCorosyncRunning();
    if (!corosyncActive) {
      logger.info('Corosync non démarré - mode attente de configuration via propagate');
    }
    
    // Démarrer le serveur de contrôle
    this.controlServer = new ControlServer(
      (cmd) => this.handleControlCommand(cmd),
      this.log
    );
    this.controlServer.start();
    
    // ===== IMPORTANT: Démarrer P2P AVANT d'attendre le quorum =====
    // Le serveur P2P permet aux nœuds de se synchroniser et de propager les peers.
    // Sans lui, les nouveaux nœuds ne peuvent pas recevoir les propagations.
    const meshManager = getMeshManager();
    const meshConfig = meshManager.getConfig();
    if (meshConfig?.meshNetwork) {
      // Autoriser les IPs publiques ET mesh des peers existants
      // Les IPs mesh sont nécessaires car les communications P2P passent par WireGuard
      for (const peer of meshConfig.peers || []) {
        if (peer.endpoint) {
          const peerIp = peer.endpoint.split(':')[0];
          authorizePermanently(peerIp);
        }
        // Autoriser aussi l'IP mesh
        if (peer.allowedIps) {
          const meshIp = peer.allowedIps.split('/')[0];
          authorizePermanently(meshIp);
        }
      }
      // Démarrer le serveur de knock pour accepter les nouveaux nœuds
      startKnockServer();
    }
    
    // Initialiser le P2P state manager pour la coordination entre nœuds
    const meshIp = this.getMeshBindAddress();
    this.p2pStateManager = initP2PStateManager({
      port: 7777,
      pollIntervalMs: this.config!.cluster.pollIntervalMs || 5000,
      bindAddress: meshIp,
    });
    this.p2pStateManager.start(this.config!.node.name);
    this.p2pStateManager.onStateChange(() => {
      // Quand un état distant change, re-vérifier l'élection
      logger.debug('P2P: État distant changé, re-élection...');
      this.checkElection();
    });
    
    // Synchroniser les peers manquants depuis l'initiateur
    // Cela garantit que tous les nodes ont la liste complète des peers
    // NOTE: Pas de sync automatique depuis l'initiateur.
    // La propagation est manuelle via 'sfha propagate' sur le leader.
    // Cela évite les race conditions et les cascades de restart.
    
    // Attendre le quorum si requis
    if (this.config!.cluster.quorumRequired) {
      await this.waitForQuorum();
    }
    
    // Initialiser les managers
    this.electionManager = new ElectionManager(this.log);
    this.healthManager = new HealthManager(
      this.config!.services,
      this.log,
      this.config!.healthChecks
    );
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
          logger.info('STONITH initialisé et prêt');
        } else {
          logger.warn('STONITH configuré mais initialisation échouée');
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
    logger.info(t('daemon.started'));
    
    // Première élection
    this.checkElection();
    
    // Grace period de démarrage - ne pas essayer de prendre le leadership
    // si on voit que la VIP est absente pendant les premières 10 secondes
    // (le leader légitime a besoin de temps pour s'activer)
    this.startupGracePeriod = true;
    setTimeout(() => {
      this.startupGracePeriod = false;
      logger.info('Période de grâce de démarrage terminée');
    }, 10000);
  }

  /**
   * Arrête le démon
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    
    logger.info(t('daemon.stopping'));
    
    // Arrêter le serveur de contrôle
    this.controlServer?.stop();
    
    // Arrêter le P2P state manager
    this.p2pStateManager?.stop();
    
    // Arrêter la synchro périodique des peers
    if (this.meshSyncInterval) {
      clearInterval(this.meshSyncInterval);
      this.meshSyncInterval = null;
    }
    
    // Arrêter le serveur de knock
    stopKnockServer();
    
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
    
    logger.info(t('daemon.stopped'));
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
    logger.info(t('daemon.waitingQuorum'));
    
    while (true) {
      const quorum = getQuorumStatus();
      if (quorum.quorate) {
        logger.info(t('daemon.quorumAcquired'));
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
    
    // Récupérer les nœuds en standby depuis le P2P state manager
    const p2pStandbyNodes = this.p2pStateManager?.getStandbyNodes() || new Set<string>();
    
    if (p2pStandbyNodes.size > 0) {
      logger.info(`checkElection: ${p2pStandbyNodes.size} nœuds P2P en standby: ${Array.from(p2pStandbyNodes).join(', ')}`);
    }
    
    // Si en standby, ne pas participer à l'élection en tant que leader potentiel
    if (this.standby) {
      // Mais vérifier quand même qui est le leader pour les logs
      const result = this.electionManager.checkElection(p2pStandbyNodes);
      if (result?.isLocalLeader) {
        // On est le leader élu mais en standby - on refuse le leadership
        this.isLeader = false;
        logger.warn('Élu leader mais en standby - ressources non activées');
      }
      return;
    }
    
    const result = this.electionManager.checkElection(p2pStandbyNodes);
    if (result) {
      logger.info(`checkElection: résultat = leader=${result.leaderName}, isLocalLeader=${result.isLocalLeader}`);
      
      // Si on est élu leader mais pas encore marqué comme tel, activer les ressources
      if (result.isLocalLeader && !this.isLeader) {
        logger.info('checkElection: devenu leader, activation des ressources');
        this.handleLeaderChange(true, result.leaderName);
      }
      // Si on n'est plus leader mais encore marqué comme tel, désactiver
      else if (!result.isLocalLeader && this.isLeader) {
        logger.info('checkElection: perte du leadership, désactivation des ressources');
        this.handleLeaderChange(false, result.leaderName);
      }
    }
  }

  /**
   * Vérifie si le cluster a le quorum
   * BUG FIX #2: Méthode utilitaire pour vérifier le quorum avant toute action critique
   * 
   * @returns true si le cluster est quorate, false sinon
   */
  async hasQuorum(): Promise<boolean> {
    const quorum = getQuorumStatus();
    return quorum.quorate;
  }

  /**
   * Force ce nœud à devenir leader
   * Utilisé quand on détecte que le leader actuel ne fonctionne plus (VIP absente)
   * 
   * IMPORTANT: Vérifie le quorum ET que ce nœud devrait être leader selon l'élection
   * 
   * @param force Si true, bypass la vérification d'élection (pour failsafe après VIP absente longtemps)
   */
  private becomeLeader(force: boolean = false): void {
    if (this.isLeader || this.standby) return;
    
    // BUG FIX #2: Vérifier le quorum AVANT de devenir leader
    const quorum = getQuorumStatus();
    if (!quorum.quorate) {
      logger.warn('Pas de quorum - impossible de devenir leader');
      return;
    }
    
    // BUG FIX #3: Vérifier que ce nœud DEVRAIT être leader selon l'élection
    // Sauf si force=true (VIP absente trop longtemps, le leader est probablement mort)
    if (!force) {
      const election = electLeader();
      if (!election?.isLocalLeader) {
        logger.warn(`Ce nœud n'est pas éligible au leadership (leader élu: ${election?.leaderName || 'aucun'})`);
        return;
      }
    } else {
      logger.warn('Force takeover activé - bypass de la vérification d\'élection');
    }
    
    logger.info('Ce nœud devient leader (prise de relai)');
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
      logger.warn('Perte du leadership - désactivation immédiate des ressources');
      this.pollsAsSecondary = 0;
      this.isLeader = false;
      this.deactivateResources();
      // Mettre à jour le P2P state
      if (this.p2pStateManager) {
        this.p2pStateManager.setLocalState(this.standby, false);
      }
      this.emit('leaderChange', false, leaderName);
      return;
    }
    
    this.pollsAsSecondary = 0;
    this.isLeader = isLeader;
    
    if (isLeader && !wasLeader) {
      // Devenu leader - vérifier le quorum avant d'activer
      logger.info(`handleLeaderChange: devenu leader, vérification quorum...`);
      const quorum = getQuorumStatus();
      logger.info(`handleLeaderChange: quorum.quorate=${quorum.quorate}, config.quorumRequired=${this.config?.cluster.quorumRequired}`);
      if (!quorum.quorate && this.config?.cluster.quorumRequired) {
        logger.warn('Élu leader mais pas de quorum - ressources non activées');
        this.isLeader = false;
        return;
      }
      logger.info('handleLeaderChange: activation des ressources...');
      this.activateResources();
      // Mettre à jour le P2P state
      if (this.p2pStateManager) {
        this.p2pStateManager.setLocalState(this.standby, true);
      }
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
      logger.warn('Tentative d\'activation des ressources sans être leader - ignorée');
      return;
    }
    
    // BUG FIX #2: Vérifier le quorum avant d'activer
    const quorum = getQuorumStatus();
    if (!quorum.quorate && this.config.cluster.quorumRequired) {
      logger.warn('Tentative d\'activation des ressources sans quorum - ignorée');
      this.isLeader = false;
      return;
    }
    
    logger.info('Activation des ressources...');
    
    // Activer les VIPs
    const vipSuccess = activateAllVips(this.config.vips, this.log);
    if (!vipSuccess) {
      logger.error('Échec activation VIP - vérifiez les logs pour le détail');
    }
    
    // Démarrer les services
    this.resourceManager?.startAll();
    
    // Démarrer les health checks
    this.healthManager?.start();
    
    logger.info('Ressources activées');
  }

  /**
   * Désactive les ressources
   */
  private deactivateResources(): void {
    if (!this.config) return;
    
    logger.info('Désactivation des ressources...');
    
    // Arrêter les health checks
    this.healthManager?.stop();
    
    // Arrêter les services
    this.resourceManager?.stopAll();
    
    // Désactiver les VIPs
    deactivateAllVips(this.config.vips, this.log);
    
    logger.info('Ressources désactivées');
  }

  /**
   * Gère les polls Corosync
   */
  private handlePoll(state: CorosyncState): void {
    logger.debug(`Poll: ${state.nodes.filter(n => n.online).length}/${state.nodes.length} nœuds, quorum=${state.quorum.quorate}`);
    
    // BUG FIX #2: Vérification du quorum à chaque poll
    // Si pas de quorum et qu'on a des ressources actives, les désactiver
    if (!state.quorum.quorate && this.config?.cluster.quorumRequired) {
      if (this.isLeader) {
        logger.warn('Perte de quorum détectée - désactivation des ressources');
        this.isLeader = false;
        this.deactivateResources();
      }
      // BUG FIX #3: Watchdog - même si on n'est pas leader, vérifier qu'on n'a pas la VIP
      this.ensureNoVipOnFollower();
      logger.debug('[DEBUG] Reset pollsWithoutVip (no quorum)');
      this.pollsWithoutVip = 0;
      this.emit('poll', state);
      return;
    }
    
    // BUG FIX #3: Watchdog - si on n'est pas leader, on ne doit JAMAIS avoir la VIP
    if (!this.isLeader && this.config) {
      this.ensureNoVipOnFollower();
    }
    
    // DISABLED: Force takeover based on VIP detection
    // This caused split-brain where all nodes took the VIP simultaneously
    // because arping responds to local VIP too.
    // 
    // The proper failover mechanism is:
    // 1. Leader goes down (corosync detects via heartbeat)
    // 2. Corosync triggers new election
    // 3. New leader is elected via electLeader() (lowest nodeId)
    // 4. handleLeaderChange() activates resources on new leader
    //
    // If a service fails on the leader, sfha should:
    // 1. Try to restart the service (restart_service: true)
    // 2. If restart fails, put the node in standby
    // 3. This triggers a leadership change via Corosync
    this.pollsWithoutVip = 0;
    
    // STONITH - Détecter les nœuds morts et déclencher le fencing
    // Seulement si on est leader et qu'on a le quorum
    if (this.isLeader && this.fenceCoordinator && state.quorum.quorate) {
      this.checkDeadNodesForFencing(state);
    }
    
    // Détecter les nœuds qui reviennent online (sfha running) et propager les VIPs
    if (this.isLeader && state.quorum.quorate) {
      this.checkNodesRejoining().catch(err => {
        logger.warn(`Erreur checkNodesRejoining: ${err.message}`);
      });
    }
    
    this.emit('poll', state);
  }
  
  /**
   * Détecte les nœuds qui reviennent online (sfha daemon running) et propage les VIPs
   * Utilise le ping P2P (sfhaRunning) au lieu de Corosync (qui reste actif même si sfha est arrêté)
   */
  private async checkNodesRejoining(): Promise<void> {
    if (!this.config || this.config.vips.length === 0) return;
    
    // Vérifier la santé de tous les peers via P2P ping
    const healthMap = await checkAllPeersHealth(3000);
    
    // Trouver notre IP mesh
    const mesh = getMeshManager();
    const meshConfig = mesh?.getConfig();
    const myIp = meshConfig?.meshIp?.split('/')[0] || '';
    
    // Construire le set des IPs où sfha est running
    const currentRunning = new Set<string>();
    for (const [ip, running] of healthMap) {
      if (running) {
        currentRunning.add(ip);
      }
    }
    
    // Trouver les nœuds qui viennent de revenir (pas dans previous, mais dans current)
    const rejoiningIps: string[] = [];
    for (const ip of currentRunning) {
      if (!this.previousOnlineNodes.has(ip) && ip !== myIp) {
        rejoiningIps.push(ip);
      }
    }
    
    // Mettre à jour l'état précédent
    this.previousOnlineNodes = currentRunning;
    
    // Si des nœuds reviennent
    if (rejoiningIps.length > 0) {
      logger.info(`🔄 Nœuds sfha de retour (IPs): ${rejoiningIps.join(', ')} - propagation des VIPs...`);
      
      // Propager les VIPs avec un petit délai pour laisser le nœud se stabiliser
      setTimeout(() => {
        propagateVipsToAllPeers(10000).then(result => {
          if (result.success) {
            logger.info(`✅ VIPs propagées aux nœuds de retour: ${result.succeeded}/${result.total}`);
          } else {
            logger.warn(`⚠️ Propagation partielle: ${result.succeeded}/${result.total}`);
          }
        }).catch(err => {
          logger.warn(`❌ Propagation échouée: ${err.message}`);
        });
      }, 2000); // 2s de délai
    }
  }
  
  /**
   * BUG FIX #3: Watchdog - s'assure qu'un follower n'a JAMAIS la VIP
   * Appelé à chaque poll pour garantir la cohérence
   */
  private ensureNoVipOnFollower(): void {
    logger.debug(`WATCHDOG check: isLeader=${this.isLeader}, standby=${this.standby}`);
    if (this.isLeader || !this.config) return;
    
    const vipStates = getVipsState(this.config.vips);
    const activeVips = vipStates.filter(v => v.active);
    
    if (activeVips.length > 0) {
      // IMPORTANT: Vérifier d'abord si on ne devrait pas être leader
      const p2pStandbyNodes = this.p2pStateManager?.getStandbyNodes() || new Set<string>();
      const freshElection = electLeader(false, p2pStandbyNodes);
      
      if (freshElection?.isLocalLeader) {
        // On est bien censé être leader ! Ne pas supprimer la VIP.
        logger.warn(`WATCHDOG: VIP active mais élection dit qu'on est leader - correction isLeader`);
        this.isLeader = true;
        return;
      }
      
      logger.error('WATCHDOG: VIP active sur un follower ! Désactivation immédiate...');
      logger.error(`Election says: leader=${freshElection?.leaderName}, isLocalLeader=${freshElection?.isLocalLeader}`);
      for (const vip of activeVips) {
        logger.error(`Suppression de la VIP ${vip.ip} (ne devrait pas être là)`);
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
          logger.warn(`[BACKUP] Nœud ${node.name} offline depuis ${pollCount} polls - programmation du fencing`);
          this.scheduleFence(node.name);
        }
      } else if (pollCount === 1) {
        logger.debug(`Nœud ${node.name} offline (premier poll)`);
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
      logger.warn(t('status.noQuorum'));
      // En cas de perte de quorum, désactiver les ressources
      if (this.isLeader) {
        this.deactivateResources();
        this.isLeader = false;
      }
      // Annuler tous les fencings en attente (on n'a plus le quorum)
      this.cancelAllPendingFences('perte de quorum');
    } else if (quorate) {
      logger.info(t('status.quorumOk'));
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
      logger.warn(`Nœud ${node.name} n'est plus dans le cluster`);
      
      // IMPORTANT: D'abord re-élire un nouveau leader
      // Le nouveau leader sera responsable du fencing
      this.checkElection();
      
      // Ensuite, si on est maintenant le leader, programmer le fencing
      if (this.shouldFenceNode(node.name)) {
        this.scheduleFence(node.name);
      }
      
      return;
      
    } else if (node.online && node.previousState === false) {
      // === NŒUD REVIENT EN LIGNE ===
      logger.info(`Nœud ${node.name} est de retour dans le cluster`);
      
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
      logger.debug(`STONITH désactivé - pas de fencing pour ${nodeName}`);
      return false;
    }
    
    // 2. FenceCoordinator prêt ?
    if (!this.fenceCoordinator) {
      logger.warn(`FenceCoordinator non initialisé - pas de fencing pour ${nodeName}`);
      return false;
    }
    
    // 3. Quorum ? (seul le cluster majoritaire peut fence)
    const quorum = getQuorumStatus();
    if (!quorum.quorate && this.config.stonith.safety.requireQuorum) {
      logger.warn(`Pas de quorum - pas de fencing pour ${nodeName}`);
      return false;
    }
    
    // 4. On est leader ? (éviter que tous les nœuds fencent en même temps)
    if (!this.isLeader) {
      logger.debug(`Pas leader - le leader va fence ${nodeName}`);
      return false;
    }
    
    // 5. Le nœud est-il configuré dans STONITH ?
    if (!this.config.stonith.nodes[nodeName]) {
      logger.warn(`Nœud ${nodeName} non configuré dans STONITH - pas de fencing`);
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
    logger.info(`Fencing de ${nodeName} programmé dans ${fenceDelay}s (délai de grâce)`);
    
    const timer = setTimeout(async () => {
      // Supprimer le timer de la map
      this.pendingFenceTimers.delete(nodeName);
      
      // Re-vérifier que le nœud est toujours absent
      const nodes = getClusterNodes();
      const nodeStillOffline = !nodes.find(n => n.name === nodeName && n.online);
      
      if (!nodeStillOffline) {
        logger.info(`Nœud ${nodeName} est revenu - fencing annulé`);
        return;
      }
      
      // Re-vérifier toutes les conditions
      if (!this.shouldFenceNode(nodeName)) {
        return;
      }
      
      // FENCE !
      logger.warn(`STONITH: Fencing du nœud ${nodeName} (absent depuis ${fenceDelay}s)`);
      try {
        const result = await this.fenceCoordinator!.fence(nodeName, false);
        if (result.success) {
          logger.info(`STONITH: ${nodeName} fencé avec succès`);
        } else if (result.action === 'skipped') {
          logger.warn(`STONITH skipped pour ${nodeName}: ${result.reason}`);
        } else {
          logger.error(`STONITH: Échec du fence de ${nodeName}: ${result.reason}`);
        }
      } catch (error: any) {
        logger.error(`Erreur STONITH sur ${nodeName}: ${error.message}`);
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
      logger.info(`Fencing de ${nodeName} annulé (nœud revenu)`);
    }
  }

  /**
   * Annule tous les fencings en attente
   */
  private cancelAllPendingFences(reason: string): void {
    if (this.pendingFenceTimers.size > 0) {
      logger.warn(`Annulation de ${this.pendingFenceTimers.size} fencing(s) en attente: ${reason}`);
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
   * 
   * Si un health check standalone critique devient défaillant:
   * 1. Si restartService configuré, tentative de restart
   * 2. Si échec ou pas de restartService, déclenchement du failover
   */
  private async handleHealthChange(name: string, healthy: boolean, result: HealthResult): Promise<void> {
    if (!healthy) {
      logger.warn(t('health.failed', { resource: name, error: result.lastError || 'inconnu' }));
      logger.info(`[DEBUG] handleHealthChange: name=${name}, consecutiveFailures=${result.consecutiveFailures}`);
      
      // Chercher d'abord dans les services
      const service = this.config?.services.find(s => s.name === name);
      
      // Sinon chercher dans les health checks standalone
      const standaloneCheck = this.config?.healthChecks.find(h => h.name === name);
      logger.info(`[DEBUG] service=${!!service}, standaloneCheck=${!!standaloneCheck}, critical=${service?.critical ?? standaloneCheck?.critical}`);
      if (service) {
        logger.info(`[DEBUG] service.critical=${service.critical}, type=${typeof service.critical}`);
        logger.info(`[DEBUG] service keys: ${Object.keys(service).join(', ')}`);
      }
      
      if (service) {
        // === Logique pour les services ===
        // Dès que le service est détecté comme défaillant (3 échecs par défaut),
        // on tente un restart immédiat
        logger.warn(`Service ${name} défaillant après ${result.consecutiveFailures} échecs`);
        
        // Tentative de redémarrage du service
        logger.info(`Tentative de redémarrage de ${service.unit}...`);
        
        const restartResult = restartService(service.unit);
        
        if (restartResult.ok) {
          // Attendre un peu et vérifier
          await new Promise(resolve => setTimeout(resolve, 3000));
          if (isServiceActive(service.unit)) {
            logger.info(`✅ ${service.name} redémarré avec succès`);
            return;
          }
        }
        
        // Échec du redémarrage - déclencher le failover si service critique
        logger.error(`❌ Échec du redémarrage de ${service.name}`);
        if (service.critical || service.restartService) {
          logger.error(t('health.failoverTriggered', { resource: name }));
          
          try {
            await this.failover();
          } catch (error: any) {
            logger.error(`Échec du failover: ${error.message}`);
          }
        }
      } else if (standaloneCheck?.critical) {
        // === Nouvelle logique pour les health checks standalone critiques ===
        const criticalThreshold = (standaloneCheck.failuresBeforeUnhealthy || 3) + 2;
        
        if (result.consecutiveFailures >= criticalThreshold) {
          logger.error(`Health check critique ${name} a dépassé le seuil (${result.consecutiveFailures} échecs)`);
          
          // Tenter restart si restartService configuré
          if (standaloneCheck.restartService) {
            logger.info(`Tentative de redémarrage de ${standaloneCheck.restartService}...`);
            
            const restartResult = restartService(standaloneCheck.restartService);
            
            if (restartResult.ok) {
              // Attendre un peu et vérifier
              await new Promise(resolve => setTimeout(resolve, 3000));
              if (isServiceActive(standaloneCheck.restartService)) {
                logger.info(`${standaloneCheck.restartService} redémarré avec succès`);
                return;
              }
            }
            
            logger.error(`Échec du redémarrage de ${standaloneCheck.restartService}`);
          }
          
          // Failover (pas de restart configuré ou restart échoué)
          logger.error(t('health.failoverTriggered', { resource: name }));
          
          try {
            await this.failover();
          } catch (error: any) {
            logger.error(`Échec du failover: ${error.message}`);
          }
        }
      }
      // Health checks standalone non-critiques: juste le warning déjà logué
    } else {
      logger.info(t('health.passed', { resource: name }));
    }
    
    this.emit('healthChange', name, healthy, result);
  }

  /**
   * Met le nœud en standby
   */
  setStandby(standby: boolean): void {
    if (this.standby === standby) return;
    
    this.standby = standby;
    const nodeName = this.config?.node.name || 'unknown';
    
    // Mettre à jour le P2P state pour que les autres nœuds le voient
    if (this.p2pStateManager) {
      this.p2pStateManager.setLocalState(standby, this.isLeader);
    }
    
    if (standby) {
      logger.info(t('action.standbyOn', { node: nodeName }));
      // Publier l'état standby dans Corosync (local, pour compatibilité)
      publishStandbyState(nodeName, true);
      // Si leader, désactiver les ressources
      if (this.isLeader) {
        this.deactivateResources();
        this.isLeader = false;
        // Update P2P state again with isLeader=false
        if (this.p2pStateManager) {
          this.p2pStateManager.setLocalState(standby, false);
        }
      }
    } else {
      logger.info(t('action.standbyOff', { node: nodeName }));
      // Nettoyer l'état standby dans Corosync
      clearStandbyState(nodeName);
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
    
    logger.info(t('action.failoverInitiated', { node: targetNode || 'suivant' }));
    
    // Désactiver les ressources locales
    this.deactivateResources();
    this.isLeader = false;
    
    // Se mettre en standby pour forcer l'élection d'un autre
    this.standby = true;
    
    // Mettre à jour le P2P state pour que les autres nœuds le voient immédiatement
    if (this.p2pStateManager) {
      this.p2pStateManager.setLocalState(true, false);
      logger.info('État standby publié via P2P');
    }
    
    // Publier aussi l'état standby dans Corosync (local, pour compatibilité)
    const nodeName = this.config?.node.name || 'unknown';
    if (publishStandbyState(nodeName, true)) {
      logger.info(`État standby publié dans Corosync (${nodeName})`);
    }
    
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
    
    const localNodeName = this.config?.node.name || '';
    
    // FIX: Toujours faire une élection fraîche pour avoir des données cohérentes
    // Le cache de l'election manager peut être désynchronisé
    // IMPORTANT: Inclure les standby nodes P2P pour que l'élection soit correcte
    const p2pStandbyNodes = this.p2pStateManager?.getStandbyNodes() || new Set<string>();
    const freshElection = electLeader(false, p2pStandbyNodes);
    const leaderName = freshElection?.leaderName ?? null;
    const actualIsLeader = freshElection?.isLocalLeader ?? false;
    
    // Synchroniser this.isLeader si désynchronisé (cas de race condition)
    if (this.isLeader !== actualIsLeader) {
      logger.debug(`getStatus: sync isLeader ${this.isLeader} -> ${actualIsLeader}`);
      this.isLeader = actualIsLeader;
    }
    const localNodeId = getLocalNodeId();
    
    return {
      version: VERSION,
      running: this.running,
      isLeader: this.isLeader,
      standby: this.standby,
      leaderName,
      corosync: {
        running: isCorosyncRunning(),
        quorate: quorum.quorate,
        nodesOnline: nodes.filter((n) => n.online).length,
        nodesTotal: nodes.length,
      },
      nodes: nodes.map((n) => ({
        name: n.name,
        ip: n.ip,
        online: n.online,
        isLeader: n.name === leaderName,
        isLocal: n.nodeId === localNodeId,
      })),
      vips: this.config ? getVipsState(this.config.vips) : [],
      services: (this.resourceManager?.getState() || []).map(svc => ({
        ...svc,
        healthy: healthData[svc.name]?.healthy ?? undefined,
      })),
      health: healthData,
      stonith: {
        enabled: this.config?.stonith?.enabled || false,
        provider: this.config?.stonith?.provider,
        connected: this.fenceCoordinator !== null,
      },
      config: {
        clusterName: this.config?.cluster.name || '',
        nodeName: localNodeName,
      },
      joinToken: this.getJoinToken(),
      meshInterface: this.getMeshInterface(),
    };
  }

  /**
   * Récupère l'interface mesh WireGuard
   */
  private getMeshInterface(): string | undefined {
    try {
      const mesh = getMeshManager();
      const status = mesh.getStatus();
      return status.active ? status.interface : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Génère le token pour ajouter des nœuds (si mesh configuré)
   */
  private getJoinToken(): string | undefined {
    try {
      const mesh = getMeshManager();
      const result = mesh.generateToken();
      return result.success ? result.token : undefined;
    } catch {
      return undefined;
    }
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
   * Récupère l'IP de l'interface mesh (wg1) pour le binding P2P sécurisé
   * Fallback sur localhost si pas de mesh
   */
  private getMeshBindAddress(): string {
    // Écouter sur 0.0.0.0 pour accepter les connexions :
    // - Via l'IP mesh (pour le polling P2P normal entre nœuds)
    // - Via l'IP LAN (pour les notifications de join avant que le mesh soit bidirectionnel)
    // 
    // SÉCURITÉ: L'endpoint /add-peer requiert l'authKey du cluster
    // Les autres endpoints (/state, /health) ne leakent que des infos basiques
    // Pour une sécurité renforcée, configurer un firewall sur le port 7777
    logger.info(`P2P: écoute sur 0.0.0.0:7777 (protégé par authKey)`);
    return '0.0.0.0';
  }

  /**
   * Synchronise les peers manquants depuis l'initiateur
   */
  private async syncPeersFromInitiator(): Promise<void> {
    try {
      const result = await syncMeshPeersFromInitiator();
      if (result.added > 0) {
        logger.info(`P2P: Synced ${result.added} peer(s) from initiator`);
      }
    } catch (err: any) {
      logger.info(`P2P: Sync from initiator failed: ${err.message}`);
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
