/**
 * @file token.ts
 * @description Génération et parsing des tokens de join
 */

import { JoinToken } from './types.js';

const TOKEN_VERSION = 2;

/**
 * Crée un token de join encodé
 */
export function createJoinToken(options: {
  cluster: string;
  endpoint: string;
  pubkey: string;
  authkey: string;
  meshNetwork: string;
  meshIp: string;
  corosyncPort: number;
  assignedIp?: string;
  usedIps?: string[];
}): string {
  const token: JoinToken = {
    v: TOKEN_VERSION,
    cluster: options.cluster,
    endpoint: options.endpoint,
    pubkey: options.pubkey,
    authkey: options.authkey,
    meshNetwork: options.meshNetwork,
    meshIp: options.meshIp,
    corosyncPort: options.corosyncPort,
    assignedIp: options.assignedIp,
    usedIps: options.usedIps,
  };

  // Encoder en base64url (safe pour copier-coller)
  const json = JSON.stringify(token);
  const base64 = Buffer.from(json).toString('base64url');

  return base64;
}

/**
 * Parse un token de join
 */
export function parseJoinToken(tokenStr: string): JoinToken {
  try {
    // Nettoyer le token (enlever préfixe si présent)
    let cleaned = tokenStr.trim();
    if (cleaned.startsWith('sfha-join://')) {
      cleaned = cleaned.slice(12);
    }

    // Décoder base64url
    const json = Buffer.from(cleaned, 'base64url').toString('utf-8');
    const token = JSON.parse(json) as JoinToken;

    // Valider la version (accepter v1 et v2)
    if (token.v !== 1 && token.v !== 2) {
      throw new Error(`Version de token non supportée: ${token.v}`);
    }

    // Valider les champs requis
    const required: (keyof JoinToken)[] = [
      'cluster',
      'endpoint',
      'pubkey',
      'authkey',
      'meshNetwork',
      'meshIp',
      'corosyncPort',
    ];

    for (const field of required) {
      if (!token[field]) {
        throw new Error(`Champ manquant dans le token: ${field}`);
      }
    }

    return token;
  } catch (error: any) {
    if (error.message.includes('JSON')) {
      throw new Error('Token invalide: format incorrect');
    }
    throw error;
  }
}

/**
 * Extrait l'IP du réseau mesh (sans CIDR)
 */
export function extractMeshIp(meshIpWithCidr: string): string {
  return meshIpWithCidr.split('/')[0];
}

/**
 * Extrait le CIDR du réseau mesh
 */
export function extractCidr(meshIpWithCidr: string): number {
  const parts = meshIpWithCidr.split('/');
  return parts.length > 1 ? parseInt(parts[1], 10) : 24;
}

/**
 * Calcule le réseau à partir d'une IP avec CIDR
 */
export function calculateNetwork(ipWithCidr: string): string {
  const [ip, cidrStr] = ipWithCidr.split('/');
  const cidr = parseInt(cidrStr, 10);

  const octets = ip.split('.').map(Number);
  const mask = ~((1 << (32 - cidr)) - 1) >>> 0;

  const networkOctets = [
    (octets[0] & (mask >>> 24)) & 255,
    (octets[1] & (mask >>> 16)) & 255,
    (octets[2] & (mask >>> 8)) & 255,
    (octets[3] & mask) & 255,
  ];

  return `${networkOctets.join('.')}/${cidr}`;
}

/**
 * Alloue la prochaine IP disponible dans le réseau
 */
export function allocateNextIp(network: string, usedIps: string[]): string {
  const [networkAddr, cidrStr] = network.split('/');
  const cidr = parseInt(cidrStr, 10);

  const octets = networkAddr.split('.').map(Number);
  const networkNum =
    (octets[0] << 24) + (octets[1] << 16) + (octets[2] << 8) + octets[3];

  const hostBits = 32 - cidr;
  const maxHosts = (1 << hostBits) - 2; // -2 pour network et broadcast

  // Extraire les numéros des IPs utilisées
  const usedNums = usedIps.map((ip) => {
    const parts = ip.split('/')[0].split('.').map(Number);
    return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  });

  // Trouver la première IP disponible
  for (let i = 1; i <= maxHosts; i++) {
    const candidateNum = networkNum + i;
    if (!usedNums.includes(candidateNum)) {
      const candidateOctets = [
        (candidateNum >>> 24) & 255,
        (candidateNum >>> 16) & 255,
        (candidateNum >>> 8) & 255,
        candidateNum & 255,
      ];
      return `${candidateOctets.join('.')}/${cidr}`;
    }
  }

  throw new Error('Plus d\'adresses IP disponibles dans le réseau mesh');
}
