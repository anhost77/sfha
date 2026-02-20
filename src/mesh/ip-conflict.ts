/**
 * @file ip-conflict.ts
 * @description Détection des conflits d'IP et chevauchements de subnets
 */

import { execSync, spawnSync } from 'child_process';

/**
 * Vérifie si arping est disponible
 */
export function isArpingAvailable(): boolean {
  try {
    execSync('which arping', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Détecte l'interface réseau principale (non-loopback, non-wireguard)
 */
export function detectMainInterface(): string | null {
  try {
    // Prendre la première interface avec une route par défaut
    const result = execSync(
      "ip route | grep default | head -1 | awk '{print $5}'",
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    
    if (result) return result;
    
    // Fallback: prendre la première interface non-lo, non-wg
    const interfaces = execSync(
      "ip -o link show | grep -v 'lo\\|wg' | head -1 | awk -F': ' '{print $2}'",
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    
    return interfaces || null;
  } catch {
    return null;
  }
}

/**
 * Vérifie si une IP est déjà utilisée sur le réseau local
 * Utilise arping -D (Duplicate Address Detection)
 * 
 * @param ip - Adresse IP à vérifier (sans CIDR)
 * @param iface - Interface réseau à utiliser (optionnel, détecté automatiquement)
 * @returns true si l'IP est en conflit, false sinon
 */
export function checkIpConflict(ip: string, iface?: string): { conflict: boolean; error?: string } {
  // Nettoyer l'IP (enlever CIDR si présent)
  const cleanIp = ip.split('/')[0];
  
  if (!isArpingAvailable()) {
    // Si arping n'est pas disponible, on ne peut pas vérifier
    // On retourne pas d'erreur pour ne pas bloquer, mais on log un warning
    return { conflict: false, error: 'arping non disponible - vérification de conflit IP ignorée' };
  }
  
  const targetIface = iface || detectMainInterface();
  if (!targetIface) {
    return { conflict: false, error: 'Impossible de détecter l\'interface réseau' };
  }
  
  try {
    // arping -D : Duplicate Address Detection
    // -c 2 : 2 essais
    // Retourne 0 si RÉPONSE REÇUE (IP utilisée), 1 si PAS de réponse (IP libre)
    const result = spawnSync('arping', ['-D', '-c', '2', '-I', targetIface, cleanIp], {
      timeout: 5000, // 5 secondes max
      stdio: 'pipe',
    });
    
    // arping -D : Duplicate Address Detection
    // Code retour 0 = PAS de réponse = IP libre
    // Code retour 1 = réponse ARP reçue = conflit
    return { conflict: result.status === 1 };
  } catch (error: any) {
    return { conflict: false, error: `Erreur arping: ${error.message}` };
  }
}

/**
 * Parse une IP en nombre pour comparaison (unsigned 32-bit)
 */
function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  // Utiliser >>> 0 pour forcer un nombre non signé (32-bit unsigned)
  return ((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + parts[3];
}

/**
 * Convertit un nombre en IP
 */
function numberToIp(num: number): string {
  return [
    (num >>> 24) & 255,
    (num >>> 16) & 255,
    (num >>> 8) & 255,
    num & 255,
  ].join('.');
}

/**
 * Parse un subnet en { network: number, mask: number, start: number, end: number }
 */
function parseSubnet(subnet: string): { network: number; mask: number; start: number; end: number; cidr: number } {
  const [networkStr, cidrStr] = subnet.split('/');
  const cidr = parseInt(cidrStr, 10) || 24;
  const mask = cidr === 0 ? 0 : (~0 << (32 - cidr)) >>> 0;
  // Forcer unsigned avec >>> 0 après le AND bitwise
  const network = (ipToNumber(networkStr) & mask) >>> 0;
  const hostBits = 32 - cidr;
  const hostCount = (1 << hostBits) >>> 0;
  
  return {
    network,
    mask,
    start: network,
    end: (network + hostCount - 1) >>> 0,
    cidr,
  };
}

/**
 * Vérifie si deux subnets se chevauchent
 */
export function subnetsOverlap(subnet1: string, subnet2: string): boolean {
  const s1 = parseSubnet(subnet1);
  const s2 = parseSubnet(subnet2);
  
  // Deux réseaux se chevauchent si leurs plages d'adresses s'intersectent
  return s1.start <= s2.end && s2.start <= s1.end;
}

/**
 * Récupère toutes les routes du système
 */
export function getSystemRoutes(): string[] {
  try {
    const output = execSync('ip route show', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    const routes: string[] = [];
    const lines = output.trim().split('\n');
    
    for (const line of lines) {
      // Format: "10.0.0.0/24 dev eth0..." ou "default via..."
      const parts = line.trim().split(/\s+/);
      if (parts[0] && parts[0] !== 'default') {
        // Extraire le réseau (premier élément)
        const network = parts[0];
        // S'assurer qu'il y a un CIDR
        if (network.includes('/')) {
          routes.push(network);
        } else if (network.match(/^\d+\.\d+\.\d+\.\d+$/)) {
          // IP sans CIDR, c'est un /32
          routes.push(`${network}/32`);
        }
      }
    }
    
    return routes;
  } catch {
    return [];
  }
}

/**
 * Vérifie si un subnet chevauche une route système existante
 * 
 * @param subnet - Le subnet à vérifier (ex: "10.200.0.0/24")
 * @param ignoreInterface - Interface à ignorer (pour ne pas détecter notre propre route wg-sfha)
 * @returns { overlap: boolean, conflictingRoute?: string }
 */
export function checkSubnetOverlap(subnet: string, ignoreInterface?: string): { overlap: boolean; conflictingRoute?: string } {
  let routes: Array<{ network: string; iface: string }>;
  
  try {
    const output = execSync('ip route show', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    routes = [];
    const lines = output.trim().split('\n');
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] && parts[0] !== 'default') {
        // Format: "192.168.1.0/24 dev eth0 ..."
        let network = parts[0];
        let iface = '';
        
        // Trouver l'interface (après "dev")
        const devIdx = parts.indexOf('dev');
        if (devIdx !== -1 && parts[devIdx + 1]) {
          iface = parts[devIdx + 1];
        }
        
        // S'assurer qu'il y a un CIDR
        if (!network.includes('/') && network.match(/^\d+\.\d+\.\d+\.\d+$/)) {
          network = `${network}/32`;
        }
        
        if (network.includes('/')) {
          routes.push({ network, iface });
        }
      }
    }
  } catch {
    return { overlap: false };
  }
  
  for (const route of routes) {
    // Ignorer l'interface spécifiée (notre propre interface mesh)
    if (ignoreInterface && route.iface === ignoreInterface) {
      continue;
    }
    
    if (subnetsOverlap(subnet, route.network)) {
      return { overlap: true, conflictingRoute: `${route.network} (${route.iface})` };
    }
  }
  
  return { overlap: false };
}

/**
 * Vérifie si une IP est déjà assignée localement (sur nos interfaces)
 */
export function isIpAssignedLocally(ip: string): boolean {
  const cleanIp = ip.split('/')[0];
  
  try {
    const output = execSync('ip -o addr show', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    // Chercher l'IP dans la sortie
    return output.includes(cleanIp);
  } catch {
    return false;
  }
}

/**
 * Résultat complet de la vérification d'IP
 */
export interface IpValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Vérifie complètement une IP avant de l'utiliser pour le mesh
 * 
 * @param meshIp - IP avec CIDR (ex: "10.200.0.1/24")
 * @param checkNetwork - Aussi vérifier le subnet pour chevauchements
 */
export function validateMeshIp(meshIp: string, checkNetwork: boolean = true): IpValidationResult {
  const result: IpValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };
  
  const cleanIp = meshIp.split('/')[0];
  const cidr = meshIp.split('/')[1] || '24';
  const subnet = `${cleanIp.split('.').slice(0, 3).join('.')}.0/${cidr}`;
  
  // 1. Vérifier si l'IP est déjà assignée localement
  if (isIpAssignedLocally(cleanIp)) {
    result.valid = false;
    result.errors.push(`L'IP ${cleanIp} est déjà assignée sur cette machine`);
  }
  
  // 2. Vérifier conflit ARP sur le réseau
  const arpCheck = checkIpConflict(cleanIp);
  if (arpCheck.error) {
    result.warnings.push(arpCheck.error);
  } else if (arpCheck.conflict) {
    result.valid = false;
    result.errors.push(`L'IP ${cleanIp} est déjà utilisée sur le réseau (détecté via ARP)`);
  }
  
  // 3. Vérifier chevauchement de subnet
  if (checkNetwork) {
    // Calculer le vrai réseau
    const [ipStr] = meshIp.split('/');
    const cidrNum = parseInt(cidr, 10);
    const mask = cidrNum === 0 ? 0 : (~0 << (32 - cidrNum)) >>> 0;
    const networkNum = (ipToNumber(ipStr) & mask) >>> 0;
    const networkStr = `${numberToIp(networkNum)}/${cidr}`;
    
    // Ignorer l'interface wg-sfha si elle existe déjà (cas de up/down)
    const subnetCheck = checkSubnetOverlap(networkStr, 'wg-sfha');
    if (subnetCheck.overlap) {
      result.valid = false;
      result.errors.push(
        `Le subnet ${networkStr} chevauche une route existante ${subnetCheck.conflictingRoute}`
      );
    }
  }
  
  return result;
}

/**
 * Trouve une IP libre dans un subnet donné
 * 
 * @param network - Le réseau (ex: "10.200.0.0/24")
 * @param usedIps - Liste des IPs déjà utilisées
 * @param startFrom - Commencer à partir de ce nombre d'hôte (1 par défaut)
 */
export function findFreeIp(
  network: string,
  usedIps: string[],
  startFrom: number = 1
): string | null {
  const [networkAddr, cidrStr] = network.split('/');
  const cidr = parseInt(cidrStr, 10);
  
  const networkNum = ipToNumber(networkAddr);
  const hostBits = 32 - cidr;
  const maxHosts = (1 << hostBits) - 2; // -2 pour network et broadcast
  
  // Normaliser les IPs utilisées
  const usedSet = new Set(usedIps.map(ip => ip.split('/')[0]));
  
  for (let i = startFrom; i <= maxHosts; i++) {
    const candidateNum = networkNum + i;
    const candidateIp = numberToIp(candidateNum);
    
    // Vérifier si pas dans la liste des utilisées
    if (usedSet.has(candidateIp)) continue;
    
    // Vérifier si pas assignée localement
    if (isIpAssignedLocally(candidateIp)) continue;
    
    // Vérifier pas de conflit ARP (optionnel, peut être lent)
    const arpCheck = checkIpConflict(candidateIp);
    if (!arpCheck.conflict) {
      return `${candidateIp}/${cidr}`;
    }
  }
  
  return null;
}
