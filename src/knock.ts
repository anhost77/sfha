/**
 * @file knock.ts
 * @description Port-knocking sécurisé pour sfha (sans iptables)
 * 
 * Protocole :
 * 1. Le nouveau nœud envoie un paquet UDP sur le port 51820 : "SFHA_KNOCK:<authKey>"
 * 2. Le daemon sfha écoute ces paquets sur 0.0.0.0
 * 3. Si authKey valide → l'IP est ajoutée à la liste des IPs autorisées (30s)
 * 4. Le serveur HTTP vérifie cette liste avant d'accepter les connexions
 */

import { createSocket, Socket } from 'dgram';
import { logger } from './utils/logger.js';
import { getMeshManager } from './mesh/manager.js';

const KNOCK_PREFIX = 'SFHA_KNOCK:';
const KNOCK_PORT = 51821; // Port différent de WireGuard (51820)
const KNOCK_TIMEOUT_MS = 30000; // 30 secondes

let knockServer: Socket | null = null;

// Liste des IPs autorisées temporairement (après un knock valide)
const authorizedIps = new Map<string, NodeJS.Timeout>();

// Liste des IPs autorisées en permanence (mesh + peers)
const permanentIps = new Set<string>();

/**
 * Vérifie si une IP est autorisée à accéder à l'API
 */
export function isIpAuthorized(ip: string): boolean {
  // Localhost toujours OK
  if (ip === '127.0.0.1' || ip === '::1') return true;
  
  // IPs privées (LAN) toujours OK pour permettre le join initial
  // Les appels API sont protégés par l'authKey dans le body, pas par l'IP
  if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) return true;
  
  // IPs permanentes (mesh, peers)
  if (permanentIps.has(ip)) return true;
  
  // IPs temporaires (après knock)
  if (authorizedIps.has(ip)) return true;
  
  // Vérifier si l'IP est dans le réseau mesh
  const mesh = getMeshManager();
  const meshConfig = mesh.getConfig();
  if (meshConfig?.meshNetwork) {
    if (isIpInNetwork(ip, meshConfig.meshNetwork)) return true;
  }
  
  return false;
}

/**
 * Vérifie si une IP est dans un réseau CIDR
 */
function isIpInNetwork(ip: string, network: string): boolean {
  const [netAddr, cidrStr] = network.split('/');
  const cidr = parseInt(cidrStr, 10) || 24;
  
  const ipNum = ipToNumber(ip);
  const netNum = ipToNumber(netAddr);
  const mask = (~0 << (32 - cidr)) >>> 0;
  
  return (ipNum & mask) === (netNum & mask);
}

function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Autorise une IP temporairement (après un knock valide)
 */
export function authorizeTemporarily(ip: string, durationMs: number = KNOCK_TIMEOUT_MS): void {
  // Annuler le timeout précédent si existe
  const existing = authorizedIps.get(ip);
  if (existing) clearTimeout(existing);
  
  // Programmer la révocation
  const timeout = setTimeout(() => {
    authorizedIps.delete(ip);
    logger.info(`🔒 IP ${ip} révoquée (timeout)`);
  }, durationMs);
  
  authorizedIps.set(ip, timeout);
  logger.info(`🔓 IP ${ip} autorisée temporairement (${durationMs / 1000}s)`);
}

/**
 * Autorise une IP en permanence (peers du cluster)
 */
export function authorizePermanently(ip: string): void {
  permanentIps.add(ip);
  logger.debug(`🔓 IP ${ip} autorisée (permanent)`);
}

/**
 * Démarre le serveur de knock (écoute UDP sur 51820, 0.0.0.0)
 */
export function startKnockServer(): void {
  if (knockServer) return;

  try {
    knockServer = createSocket('udp4');

    knockServer.on('message', (msg, rinfo) => {
      handleKnockPacket(msg.toString(), rinfo.address);
    });

    knockServer.on('error', (err) => {
      logger.debug(`Knock server error: ${err.message}`);
    });

    knockServer.bind({
      port: KNOCK_PORT,
      exclusive: false,
    }, () => {
      logger.info(`🔔 Knock server: écoute UDP 0.0.0.0:${KNOCK_PORT}`);
    });

  } catch (err: any) {
    logger.warn(`⚠️ Knock server: impossible de démarrer: ${err.message}`);
  }
}

/**
 * Arrête le serveur de knock
 */
export function stopKnockServer(): void {
  if (knockServer) {
    knockServer.close();
    knockServer = null;
    logger.info('🔔 Knock server: arrêté');
  }
  
  // Nettoyer les timeouts
  for (const timeout of authorizedIps.values()) {
    clearTimeout(timeout);
  }
  authorizedIps.clear();
  permanentIps.clear();
}

/**
 * Traite un paquet knock reçu
 */
function handleKnockPacket(data: string, sourceIp: string): void {
  if (!data.startsWith(KNOCK_PREFIX)) {
    return; // Pas un paquet knock
  }

  const authKey = data.substring(KNOCK_PREFIX.length).trim();
  
  const mesh = getMeshManager();
  const meshConfig = mesh.getConfig();
  
  if (!meshConfig) {
    logger.warn(`🔔 Knock: reçu de ${sourceIp} mais pas de mesh configuré`);
    return;
  }

  if (authKey !== meshConfig.authKey) {
    logger.warn(`🔔 Knock: authKey invalide de ${sourceIp}`);
    return;
  }

  logger.info(`🔔 Knock: authKey valide de ${sourceIp}`);
  authorizeTemporarily(sourceIp, KNOCK_TIMEOUT_MS);
}

/**
 * Envoie un paquet knock à un serveur distant
 */
export function sendKnock(targetIp: string, authKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = createSocket('udp4');
    const message = Buffer.from(`${KNOCK_PREFIX}${authKey}`);

    client.send(message, KNOCK_PORT, targetIp, (err) => {
      client.close();
      if (err) {
        reject(err);
      } else {
        logger.info(`🔔 Knock envoyé à ${targetIp}:${KNOCK_PORT}`);
        resolve();
      }
    });
  });
}
