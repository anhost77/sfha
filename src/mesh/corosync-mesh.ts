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

  // Dédupliquer les nœuds (par nom et par IP)
  const seenNames = new Set<string>();
  const seenIps = new Set<string>();
  const uniqueNodes = nodes.filter(node => {
    if (seenNames.has(node.name) || seenIps.has(node.ip)) {
      return false;
    }
    seenNames.add(node.name);
    seenIps.add(node.ip);
    return true;
  });

  const config = generateCorosyncConfig(clusterName, uniqueNodes, corosyncPort);
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
 * Ne fait rien si le nœud existe déjà (évite les doublons)
 */
export function addNodeToCorosync(node: MeshNode): void {
  if (!existsSync(COROSYNC_CONF_PATH)) {
    throw new Error('Configuration Corosync introuvable');
  }

  // Vérifier si le nœud existe déjà (par nom ou par IP)
  const currentNodes = getCorosyncNodes();
  const alreadyExists = currentNodes.some(
    n => n.name === node.name || n.ip === node.ip
  );
  
  if (alreadyExists) {
    // Node déjà présent, ne pas ajouter de doublon
    // Log pour debug
    console.log(`[corosync-mesh] Node ${node.name} (${node.ip}) already exists, skipping`);
    return;
  }
  
  console.log(`[corosync-mesh] Adding node ${node.name} (${node.ip}) with nodeId ${node.nodeId}`);

  let content = readFileSync(COROSYNC_CONF_PATH, 'utf-8');
  
  // Compter le nombre de nœuds existants
  const existingNodes = (content.match(/ring0_addr:/g) || []).length;
  const newTotalNodes = existingNodes + 1;
  
  // Pour 2 nœuds, ajouter two_node: 1 dans la section quorum si pas déjà présent
  if (newTotalNodes === 2 && !content.includes('two_node:')) {
    content = content.replace(
      /quorum\s*\{([^}]*provider:\s*corosync_votequorum)/,
      'quorum {\n    two_node: 1\n$1'
    );
  }
  
  // Pour >2 nœuds, retirer two_node si présent
  if (newTotalNodes > 2 && content.includes('two_node:')) {
    content = content.replace(/\s*two_node:\s*1\n?/g, '\n');
  }
  
  const lines = content.split('\n');
  const newLines: string[] = [];
  
  let inNodelist = false;
  let braceDepth = 0;
  let inserted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Détecter l'entrée dans nodelist
    if (trimmed === 'nodelist {' || trimmed.startsWith('nodelist {')) {
      inNodelist = true;
      braceDepth = 1;
      newLines.push(line);
      continue;
    }
    
    if (inNodelist) {
      // Compter les accolades
      for (const char of line) {
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
      }
      
      // Si on sort de nodelist (braceDepth == 0), insérer le nouveau nœud AVANT cette ligne
      if (braceDepth === 0 && !inserted) {
        newLines.push(`    node {`);
        newLines.push(`        ring0_addr: ${node.ip}`);
        newLines.push(`        name: ${node.name}`);
        newLines.push(`        nodeid: ${node.nodeId}`);
        newLines.push(`    }`);
        inserted = true;
        inNodelist = false;
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

/**
 * Récupère la liste complète des nœuds depuis corosync.conf
 */
export function getCorosyncNodes(): MeshNode[] {
  if (!existsSync(COROSYNC_CONF_PATH)) {
    return [];
  }

  const content = readFileSync(COROSYNC_CONF_PATH, 'utf-8');
  const nodes: MeshNode[] = [];
  
  // Parser la nodelist avec une approche simple
  const nodeBlocks = content.match(/node\s*\{[^}]+\}/g) || [];
  
  for (const block of nodeBlocks) {
    const ipMatch = block.match(/ring0_addr:\s*(\S+)/);
    const nameMatch = block.match(/name:\s*(\S+)/);
    const nodeIdMatch = block.match(/nodeid:\s*(\d+)/);
    
    if (ipMatch && nameMatch && nodeIdMatch) {
      nodes.push({
        name: nameMatch[1],
        ip: ipMatch[1],
        nodeId: parseInt(nodeIdMatch[1], 10),
      });
    }
  }
  
  // Trier par nodeId pour cohérence
  nodes.sort((a, b) => a.nodeId - b.nodeId);
  
  return nodes;
}
