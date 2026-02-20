/**
 * @file corosync.ts
 * @description Intégration Corosync (quorum, membership)
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { EventEmitter } from 'events';
import { t } from './i18n.js';

// ============================================
// Types
// ============================================

export interface QuorumStatus {
  quorate: boolean;
  totalVotes: number;
  expectedVotes: number;
  highestExpected: number;
}

export interface ClusterNode {
  nodeId: number;
  name: string;
  ip: string;
  online: boolean;
}

export interface CorosyncState {
  running: boolean;
  quorum: QuorumStatus;
  nodes: ClusterNode[];
}

// ============================================
// Logging
// ============================================

// Logger configurable pour debug de parsing
let debugLog: ((msg: string) => void) | null = null;

export function setDebugLogger(logger: (msg: string) => void): void {
  debugLog = logger;
}

function logParseWarning(context: string, details: string): void {
  const msg = `[corosync] Parse warning in ${context}: ${details}`;
  if (debugLog) {
    debugLog(msg);
  } else if (process.env.SFHA_DEBUG) {
    console.warn(msg);
  }
}

// ============================================
// Helpers
// ============================================

function runCommand(cmd: string, args: string[] = []): string {
  try {
    return execSync(`${cmd} ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    throw new Error(t('error.commandFailed', { cmd: `${cmd} ${args.join(' ')}` }));
  }
}

function runCommandSafe(cmd: string, args: string[] = []): string | null {
  try {
    return runCommand(cmd, args);
  } catch {
    return null;
  }
}

function extractNumber(text: string, pattern: string): number {
  const regex = new RegExp(`${pattern}\\s*(\\d+)`);
  const match = text.match(regex);
  return match ? parseInt(match[1], 10) : 0;
}

// ============================================
// Corosync Functions
// ============================================

/**
 * Vérifie si Corosync est en cours d'exécution
 */
export function isCorosyncRunning(): boolean {
  try {
    const output = execSync('systemctl is-active corosync', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output === 'active';
  } catch {
    return false;
  }
}

/**
 * Récupère le statut du quorum
 * 
 * Formats supportés (corosync-quorumtool -s):
 * - Corosync 2.x/3.x: "Quorate:          Yes" ou "Quorate:          No"
 * - Variations d'espacement: "Quorate: Yes", "Quorate:Yes"
 * - Booléens alternatifs: "Quorate: true" (certaines versions)
 */
export function getQuorumStatus(): QuorumStatus {
  try {
    const output = runCommand('corosync-quorumtool', ['-s']);
    
    // Patterns pour détecter le quorum (multi-versions)
    // Pattern 1: "Quorate:          Yes" (format standard)
    // Pattern 2: "Quorate: Yes" (espacement réduit)
    // Pattern 3: "Quorate:Yes" (pas d'espace)
    // Pattern 4: "Quorate: true" (certaines configs)
    const quoratePatterns = [
      /Quorate:\s*Yes/i,
      /Quorate:\s*true/i,
      /Quorate:\s*1\s*$/m,
    ];
    
    let quorate = false;
    for (const pattern of quoratePatterns) {
      if (pattern.test(output)) {
        quorate = true;
        break;
      }
    }
    
    // Vérification de cohérence
    if (!quorate && output.includes('Quorate:')) {
      // Quorate: est présent mais on n'a pas matché - log pour debug
      const quorateLine = output.split('\n').find(l => l.includes('Quorate:'));
      if (quorateLine && !quorateLine.toLowerCase().includes('no')) {
        logParseWarning('getQuorumStatus', `Unrecognized Quorate format: "${quorateLine.trim()}"`);
      }
    }
    
    return {
      quorate,
      totalVotes: extractNumber(output, 'Total votes:'),
      expectedVotes: extractNumber(output, 'Expected votes:'),
      highestExpected: extractNumber(output, 'Highest expected:'),
    };
  } catch (error) {
    logParseWarning('getQuorumStatus', `Command failed: ${error}`);
    return {
      quorate: false,
      totalVotes: 0,
      expectedVotes: 0,
      highestExpected: 0,
    };
  }
}

/**
 * Parse le fichier corosync.conf pour extraire les nœuds
 */
export function parseCorosyncConfig(): ClusterNode[] {
  const nodes: ClusterNode[] = [];
  const configPath = '/etc/corosync/corosync.conf';
  
  if (!existsSync(configPath)) {
    return nodes;
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    
    // Trouver la section nodelist
    const nodelistMatch = content.match(/nodelist\s*\{([\s\S]*?)\n\}/);
    if (!nodelistMatch) {
      return nodes;
    }
    
    const nodelistContent = nodelistMatch[1];
    
    // Parser chaque bloc node
    const nodeBlocks = nodelistContent.matchAll(/node\s*\{([^}]+)\}/g);
    
    for (const block of nodeBlocks) {
      const blockContent = block[1];
      
      const ipMatch = blockContent.match(/ring0_addr\s*:\s*([^\s\n]+)/);
      const nameMatch = blockContent.match(/name\s*:\s*([^\s\n]+)/);
      const nodeidMatch = blockContent.match(/nodeid\s*:\s*(\d+)/);
      
      if (ipMatch && nameMatch && nodeidMatch) {
        nodes.push({
          nodeId: parseInt(nodeidMatch[1], 10),
          name: nameMatch[1].trim(),
          ip: ipMatch[1].trim(),
          online: false, // Sera mis à jour par getClusterNodes()
        });
      }
    }
  } catch {
    // Ignorer les erreurs de parsing
  }
  
  return nodes;
}

/**
 * Récupère les nœuds du cluster avec leur statut en ligne
 * 
 * Méthodes de détection (par ordre de fiabilité):
 * 1. corosync-cmapctl runtime.members.*.status = joined
 * 2. corosync-quorumtool -l (liste des membres actifs)
 * 3. corosync-cfgtool -s (status des liens, moins fiable)
 * 
 * Formats supportés:
 * - cmapctl: "runtime.members.1.status (str) = joined"
 * - quorumtool: "   1   nodename" ou "   1   nodename (local)"
 */
export function getClusterNodes(): ClusterNode[] {
  const nodes = parseCorosyncConfig();
  let methodUsed = 'none';
  
  // Méthode 1: corosync-cmapctl (plus fiable, disponible Corosync 2.x+)
  const cmapOutput = runCommandSafe('corosync-cmapctl', []);
  if (cmapOutput) {
    const lines = cmapOutput.split('\n');
    const onlineNodeIds = new Set<number>();
    
    // Patterns pour runtime.members.*.status
    // Format 1: "runtime.members.1.status (str) = joined"
    // Format 2: "runtime.members.1.status = joined" (certaines versions)
    const statusPatterns = [
      /runtime\.members\.(\d+)\.status\s*\([^)]*\)\s*=\s*joined/i,
      /runtime\.members\.(\d+)\.status\s*=\s*joined/i,
    ];
    
    for (const line of lines) {
      for (const pattern of statusPatterns) {
        const match = line.match(pattern);
        if (match) {
          onlineNodeIds.add(parseInt(match[1], 10));
          break;
        }
      }
    }
    
    if (onlineNodeIds.size > 0) {
      for (const node of nodes) {
        node.online = onlineNodeIds.has(node.nodeId);
      }
      methodUsed = 'cmapctl';
    } else {
      logParseWarning('getClusterNodes', 'cmapctl: No runtime.members.*.status entries found');
    }
  }
  
  // Méthode 2: corosync-quorumtool -l (fallback)
  if (methodUsed === 'none') {
    const quorumOutput = runCommandSafe('corosync-quorumtool', ['-l']);
    if (quorumOutput) {
      const lines = quorumOutput.split('\n');
      const onlineNodeIds = new Set<number>();
      
      // Patterns pour la liste des membres
      // Format 1: "   1          1 sfha-node1 (local)"
      // Format 2: "   1   sfha-node1"
      // Format 3: "         1   1   nodename" (certains Corosync 2.x)
      // La première colonne numérique est généralement le nodeId
      const memberPatterns = [
        /^\s*(\d+)\s+\d+\s+\S+/,  // "NodeId Votes Name"
        /^\s*(\d+)\s+\S+/,         // "NodeId Name" (format simplifié)
      ];
      
      for (const line of lines) {
        // Ignorer les lignes d'en-tête
        if (line.includes('Nodeid') || line.includes('----') || line.trim() === '') {
          continue;
        }
        
        for (const pattern of memberPatterns) {
          const match = line.match(pattern);
          if (match) {
            onlineNodeIds.add(parseInt(match[1], 10));
            break;
          }
        }
      }
      
      if (onlineNodeIds.size > 0) {
        for (const node of nodes) {
          node.online = onlineNodeIds.has(node.nodeId);
        }
        methodUsed = 'quorumtool';
      } else {
        logParseWarning('getClusterNodes', 'quorumtool: No member entries found in output');
      }
    }
  }
  
  // Méthode 3: corosync-cfgtool -s (dernier recours, moins fiable)
  if (methodUsed === 'none') {
    const cfgOutput = runCommandSafe('corosync-cfgtool', ['-s']);
    if (cfgOutput) {
      // Cette méthode ne donne que les IPs connectées, pas les nodeIds
      // Patterns: "nodeid: 1: connected" ou "nodeid:          2:	connected"
      const connectedPattern = /nodeid:\s*(\d+):\s*connected/gi;
      let match;
      const connectedNodeIds = new Set<number>();
      
      while ((match = connectedPattern.exec(cfgOutput)) !== null) {
        connectedNodeIds.add(parseInt(match[1], 10));
      }
      
      // Le nœud local est toujours "localhost"
      const localMatch = cfgOutput.match(/nodeid:\s*(\d+):\s*localhost/i);
      if (localMatch) {
        connectedNodeIds.add(parseInt(localMatch[1], 10));
      }
      
      if (connectedNodeIds.size > 0) {
        for (const node of nodes) {
          node.online = connectedNodeIds.has(node.nodeId);
        }
        methodUsed = 'cfgtool';
      } else {
        logParseWarning('getClusterNodes', 'cfgtool: Could not parse node status');
      }
    }
  }
  
  if (methodUsed === 'none') {
    logParseWarning('getClusterNodes', 'All detection methods failed, nodes marked offline');
  }
  
  return nodes;
}

/**
 * Récupère l'état complet de Corosync
 */
export function getCorosyncState(): CorosyncState {
  const running = isCorosyncRunning();
  
  if (!running) {
    return {
      running: false,
      quorum: { quorate: false, totalVotes: 0, expectedVotes: 0, highestExpected: 0 },
      nodes: [],
    };
  }
  
  return {
    running: true,
    quorum: getQuorumStatus(),
    nodes: getClusterNodes(),
  };
}

/**
 * Récupère le nodeId local
 * 
 * Méthodes de détection (par ordre de fiabilité):
 * 1. corosync-cmapctl runtime.votequorum.this_node_id
 * 2. corosync-quorumtool -l (chercher "local" ou "(local)")
 * 3. corosync-quorumtool -s (chercher "Node ID:")
 * 4. corosync-cmapctl nodelist.local_node_pos + lookup
 * 
 * Formats supportés:
 * - cmapctl: "runtime.votequorum.this_node_id (u32) = 1"
 * - quorumtool: "   1   nodename (local)" ou "   1   nodename   local"
 */
export function getLocalNodeId(): number | null {
  // Méthode 1: corosync-cmapctl runtime.votequorum.this_node_id (plus fiable)
  const cmapOutput = runCommandSafe('corosync-cmapctl', ['runtime.votequorum.this_node_id']);
  if (cmapOutput) {
    // Patterns: "= 1" ou "= 1 " ou "(u32) = 1"
    const match = cmapOutput.match(/=\s*(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
    logParseWarning('getLocalNodeId', `cmapctl: Unexpected format: "${cmapOutput}"`);
  }
  
  // Méthode 2: corosync-quorumtool -l (chercher "local")
  const quorumListOutput = runCommandSafe('corosync-quorumtool', ['-l']);
  if (quorumListOutput) {
    const lines = quorumListOutput.split('\n');
    for (const line of lines) {
      // Patterns pour détecter le nœud local:
      // Format 1: "   1          1 sfha-node1 (local)"
      // Format 2: "   1   sfha-node1   local"
      // Format 3: "   1   1   nodename (local)"
      if (/\blocal\b/i.test(line)) {
        // Extraire le premier nombre (nodeId)
        const match = line.match(/^\s*(\d+)/);
        if (match) {
          return parseInt(match[1], 10);
        }
      }
    }
    logParseWarning('getLocalNodeId', 'quorumtool -l: No line with "local" found');
  }
  
  // Méthode 3: corosync-quorumtool -s (chercher "Node ID:")
  const quorumStatusOutput = runCommandSafe('corosync-quorumtool', ['-s']);
  if (quorumStatusOutput) {
    // Pattern: "Node ID:          1" ou "Node ID: 1"
    const match = quorumStatusOutput.match(/Node ID:\s*(\d+)/i);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  
  // Méthode 4: corosync-cmapctl nodelist.local_node_pos + lookup (fallback)
  const posOutput = runCommandSafe('corosync-cmapctl', ['nodelist.local_node_pos']);
  if (posOutput) {
    const posMatch = posOutput.match(/=\s*(\d+)/);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      
      // Essayer de lire le nodeId à cette position
      const nodeIdOutput = runCommandSafe('corosync-cmapctl', [`nodelist.node.${pos}.nodeid`]);
      if (nodeIdOutput) {
        const nodeIdMatch = nodeIdOutput.match(/=\s*(\d+)/);
        if (nodeIdMatch) {
          return parseInt(nodeIdMatch[1], 10);
        }
      }
      
      // Dernier recours: pos + 1 (convention par défaut)
      logParseWarning('getLocalNodeId', `Using position-based fallback: pos=${pos}, nodeId=${pos + 1}`);
      return pos + 1;
    }
  }
  
  logParseWarning('getLocalNodeId', 'All detection methods failed');
  return null;
}

// ============================================
// Watcher
// ============================================

export interface CorosyncWatcherEvents {
  nodeStateChange: (node: ClusterNode) => void;
  quorumChange: (quorate: boolean) => void;
  poll: (state: CorosyncState) => void;
}

/**
 * Watcher pour les changements Corosync
 */
export class CorosyncWatcher extends EventEmitter {
  private interval: NodeJS.Timeout | null = null;
  private lastNodeStates: Map<string, boolean> = new Map();
  private lastQuorate: boolean | null = null;
  private pollMs: number;

  constructor(pollMs: number = 5000) {
    super();
    this.pollMs = pollMs;
  }

  start(): void {
    if (this.interval) return;

    // Premier poll immédiat
    this.poll();

    this.interval = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private poll(): void {
    const state = getCorosyncState();

    // Détecter les changements de nœuds
    for (const node of state.nodes) {
      const wasOnline = this.lastNodeStates.get(node.name);
      if (wasOnline !== undefined && wasOnline !== node.online) {
        // Émettre avec l'info complète du nœud incluant le nouvel état
        this.emit('nodeStateChange', { 
          name: node.name, 
          online: node.online,
          previousState: wasOnline 
        });
        
        // Émettre aussi un event spécifique pour les nœuds qui quittent
        if (wasOnline && !node.online) {
          this.emit('memberLeft', node.name);
        }
        // Et pour ceux qui reviennent
        if (!wasOnline && node.online) {
          this.emit('memberJoined', node.name);
        }
      }
      this.lastNodeStates.set(node.name, node.online);
    }

    // Détecter les changements de quorum
    if (this.lastQuorate !== null && this.lastQuorate !== state.quorum.quorate) {
      this.emit('quorumChange', state.quorum.quorate);
    }
    this.lastQuorate = state.quorum.quorate;

    // Émettre l'état complet
    this.emit('poll', state);
  }
}
