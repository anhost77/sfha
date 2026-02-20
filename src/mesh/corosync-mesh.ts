/**
 * @file corosync-mesh.ts
 * @description Mise à jour de la configuration Corosync pour le mesh
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';

const COROSYNC_CONF_PATH = '/etc/corosync/corosync.conf';

export interface MeshNode {
  name: string;
  ip: string;
  nodeId: number;
}

/**
 * Met à jour corosync.conf pour utiliser le mesh WireGuard
 */
export function updateCorosyncForMesh(
  clusterName: string,
  nodes: MeshNode[],
  corosyncPort: number = 5405
): void {
  // Backup de la config existante
  if (existsSync(COROSYNC_CONF_PATH)) {
    const backupPath = `${COROSYNC_CONF_PATH}.bak.${Date.now()}`;
    copyFileSync(COROSYNC_CONF_PATH, backupPath);
  }

  const config = generateCorosyncConfig(clusterName, nodes, corosyncPort);
  writeFileSync(COROSYNC_CONF_PATH, config, { mode: 0o644 });
}

/**
 * Génère la configuration Corosync pour le mesh
 */
export function generateCorosyncConfig(
  clusterName: string,
  nodes: MeshNode[],
  corosyncPort: number = 5405
): string {
  // Extraire le réseau du premier nœud pour bindnetaddr
  const firstNodeIp = nodes[0]?.ip || '10.100.0.1';
  const bindnetaddr = calculateBindnetaddr(firstNodeIp);

  let config = `# Configuration Corosync générée par sfha
# Ne pas modifier manuellement - utilisez sfha pour les changements

totem {
    version: 2
    cluster_name: ${clusterName}
    secauth: on
    transport: knet
    crypto_cipher: aes256
    crypto_hash: sha256

    interface {
        ringnumber: 0
        bindnetaddr: ${bindnetaddr}
        mcastport: ${corosyncPort}
    }
}

logging {
    to_logfile: yes
    logfile: /var/log/corosync/corosync.log
    to_syslog: yes
    timestamp: on
}

quorum {
    provider: corosync_votequorum
`;

  // Pour 2 nœuds, permettre le fonctionnement sans quorum
  if (nodes.length === 2) {
    config += `    two_node: 1
`;
  }

  config += `}

nodelist {
`;

  for (const node of nodes) {
    config += `    node {
        ring0_addr: ${node.ip}
        name: ${node.name}
        nodeid: ${node.nodeId}
    }
`;
  }

  config += `}
`;

  return config;
}

/**
 * Calcule le bindnetaddr à partir d'une IP
 */
function calculateBindnetaddr(ip: string): string {
  const parts = ip.split('.');
  // Pour un /24, on prend les 3 premiers octets + .0
  parts[3] = '0';
  return parts.join('.');
}

/**
 * Ajoute un nœud à la configuration Corosync
 */
export function addNodeToCorosync(node: MeshNode): void {
  if (!existsSync(COROSYNC_CONF_PATH)) {
    throw new Error('Configuration Corosync introuvable');
  }

  const content = readFileSync(COROSYNC_CONF_PATH, 'utf-8');

  // Trouver la dernière accolade fermante de nodelist
  const nodelistEndIndex = content.lastIndexOf('}', content.indexOf('nodelist {') + content.length);

  // Trouver la position juste avant la dernière accolade de nodelist
  const insertPosition = content.lastIndexOf('}', nodelistEndIndex - 1);

  const newNodeBlock = `
    node {
        ring0_addr: ${node.ip}
        name: ${node.name}
        nodeid: ${node.nodeId}
    }
`;

  // Parser manuellement pour insérer le nouveau nœud
  const lines = content.split('\n');
  const newLines: string[] = [];
  let inNodelist = false;
  let nodelistBraces = 0;
  let inserted = false;

  for (const line of lines) {
    if (line.includes('nodelist {')) {
      inNodelist = true;
      nodelistBraces = 1;
    }

    if (inNodelist) {
      if (line.includes('{')) {
        nodelistBraces += (line.match(/{/g) || []).length;
      }
      if (line.includes('}')) {
        nodelistBraces -= (line.match(/}/g) || []).length;
        if (nodelistBraces === 0 && !inserted) {
          // Insérer le nouveau nœud avant la dernière accolade
          newLines.push(`    node {`);
          newLines.push(`        ring0_addr: ${node.ip}`);
          newLines.push(`        name: ${node.name}`);
          newLines.push(`        nodeid: ${node.nodeId}`);
          newLines.push(`    }`);
          inserted = true;
          inNodelist = false;
        }
      }
    }

    newLines.push(line);
  }

  writeFileSync(COROSYNC_CONF_PATH, newLines.join('\n'), { mode: 0o644 });
}

/**
 * Supprime un nœud de la configuration Corosync
 */
export function removeNodeFromCorosync(nodeName: string): void {
  if (!existsSync(COROSYNC_CONF_PATH)) {
    throw new Error('Configuration Corosync introuvable');
  }

  const content = readFileSync(COROSYNC_CONF_PATH, 'utf-8');
  const lines = content.split('\n');
  const newLines: string[] = [];

  let skipUntilClosingBrace = false;
  let braceCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Vérifier si cette ligne commence un bloc node pour le nœud à supprimer
    if (line.includes('node {')) {
      // Regarder les lignes suivantes pour voir si c'est le bon nœud
      let isTargetNode = false;
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        if (lines[j].includes(`name: ${nodeName}`)) {
          isTargetNode = true;
          break;
        }
        if (lines[j].includes('}') && !lines[j].includes('{')) {
          break;
        }
      }

      if (isTargetNode) {
        skipUntilClosingBrace = true;
        braceCount = 1;
        continue;
      }
    }

    if (skipUntilClosingBrace) {
      if (line.includes('{')) braceCount++;
      if (line.includes('}')) braceCount--;
      if (braceCount === 0) {
        skipUntilClosingBrace = false;
      }
      continue;
    }

    newLines.push(line);
  }

  writeFileSync(COROSYNC_CONF_PATH, newLines.join('\n'), { mode: 0o644 });
}

/**
 * Récupère le prochain nodeId disponible
 */
export function getNextNodeId(): number {
  if (!existsSync(COROSYNC_CONF_PATH)) {
    return 1;
  }

  const content = readFileSync(COROSYNC_CONF_PATH, 'utf-8');
  const matches = content.matchAll(/nodeid:\s*(\d+)/g);
  let maxId = 0;

  for (const match of matches) {
    const id = parseInt(match[1], 10);
    if (id > maxId) maxId = id;
  }

  return maxId + 1;
}

/**
 * Recharge Corosync
 */
export function reloadCorosync(): void {
  try {
    // Vérifier si Corosync est en cours d'exécution
    execSync('systemctl is-active corosync', { stdio: 'pipe' });
    // Recharger la configuration
    execSync('corosync-cfgtool -R', { stdio: 'pipe' });
  } catch {
    // Corosync n'est pas actif ou la commande a échoué
    // On ne fait rien, Corosync sera démarré manuellement
  }
}

/**
 * Vérifie si Corosync est installé
 */
export function isCorosyncInstalled(): boolean {
  try {
    execSync('which corosync', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
