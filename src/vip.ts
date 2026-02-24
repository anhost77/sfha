/**
 * @file vip.ts
 * @description Gestion des VIP (ip addr add/del, arping)
 */

import { execSync } from 'child_process';
import { VipConfig } from './config.js';
import { t } from './i18n.js';

// ============================================
// Types
// ============================================

export interface VipState {
  name: string;
  ip: string;
  cidr: number;
  interface: string;
  active: boolean;
}

// ============================================
// Helpers
// ============================================

interface CommandResult {
  success: boolean;
  stderr: string;
}

function runCommand(cmd: string): CommandResult {
  try {
    execSync(cmd, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, stderr: '' };
  } catch (error: any) {
    return { success: false, stderr: error.stderr || error.message || 'Unknown error' };
  }
}

function runCommandOutput(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// ============================================
// VIP Functions
// ============================================

/**
 * Liste les IPs secondaires présentes sur une interface
 * (exclut l'IP principale)
 */
export function getSecondaryIpsOnInterface(iface: string): Array<{ ip: string; cidr: number }> {
  const output = runCommandOutput(`ip -4 addr show dev ${iface}`);
  const ips: Array<{ ip: string; cidr: number }> = [];
  
  // Match lines like "inet 192.168.1.200/24 scope global secondary eth0"
  const regex = /inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+).*secondary/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    ips.push({ ip: match[1], cidr: parseInt(match[2], 10) });
  }
  return ips;
}

/**
 * Synchronise les VIPs sur l'interface avec la config
 * - Supprime les VIPs qui ne sont plus dans la config
 * - Ajoute les VIPs qui manquent
 */
export function syncVips(vips: VipConfig[], log?: (msg: string) => void): { added: number; removed: number } {
  const logFn = log || console.log;
  const result = { added: 0, removed: 0 };
  
  // Get all interfaces mentioned in config (default to eth0)
  const interfaces = new Set(vips.map(v => v.interface || 'eth0'));
  if (interfaces.size === 0) interfaces.add('eth0');
  
  // For each interface, sync VIPs
  for (const iface of interfaces) {
    const currentIps = getSecondaryIpsOnInterface(iface);
    const configIps = vips.filter(v => (v.interface || 'eth0') === iface).map(v => v.ip);
    
    // Remove IPs that are not in config
    for (const current of currentIps) {
      if (!configIps.includes(current.ip)) {
        logFn(`🧹 Nettoyage VIP zombie: ${current.ip}/${current.cidr} sur ${iface}`);
        const delResult = runCommand(`ip addr del ${current.ip}/${current.cidr} dev ${iface}`);
        if (delResult.success) {
          result.removed++;
        }
      }
    }
    
    // Add IPs that are missing
    const currentIpSet = new Set(currentIps.map(c => c.ip));
    for (const vip of vips.filter(v => (v.interface || 'eth0') === iface)) {
      if (!currentIpSet.has(vip.ip)) {
        if (addVip(vip, logFn)) {
          result.added++;
        }
      }
    }
  }
  
  return result;
}

/**
 * Vérifie si une VIP est présente sur l'interface
 */
export function hasVip(vip: VipConfig): boolean {
  const output = runCommandOutput(`ip addr show dev ${vip.interface}`);
  return output.includes(vip.ip);
}

/**
 * Ajoute une VIP sur l'interface
 */
export function addVip(vip: VipConfig, log: (msg: string) => void = console.log): boolean {
  // Vérifier si déjà présente
  if (hasVip(vip)) {
    log(t('vip.alreadyPresent', { ip: vip.ip }));
    return true;
  }

  log(t('vip.adding', { ip: vip.ip, iface: vip.interface }));

  // Ajouter l'IP
  const addCmd = `ip addr add ${vip.ip}/${vip.cidr} dev ${vip.interface}`;
  const result = runCommand(addCmd);
  if (!result.success) {
    log(`Erreur: échec de la commande '${addCmd}'`);
    log(`Détail: ${result.stderr}`);
    return false;
  }

  // Vérifier que l'IP a bien été ajoutée
  if (!hasVip(vip)) {
    const errorMsg = `Erreur: VIP ${vip.ip} n'est pas présente sur ${vip.interface} après ajout`;
    log(errorMsg);
    throw new Error(errorMsg);
  }

  log(`VIP ${vip.ip} vérifiée présente sur ${vip.interface}`);

  // Envoyer des gratuitous ARP pour annoncer la VIP
  sendGratuitousArp(vip);

  log(t('vip.added', { ip: vip.ip }));
  return true;
}

/**
 * Supprime une VIP de l'interface
 */
export function removeVip(vip: VipConfig, log: (msg: string) => void = console.log): boolean {
  // Vérifier si présente
  if (!hasVip(vip)) {
    log(t('vip.notPresent', { ip: vip.ip }));
    return true;
  }

  log(t('vip.removing', { ip: vip.ip }));

  const delCmd = `ip addr del ${vip.ip}/${vip.cidr} dev ${vip.interface}`;
  const result = runCommand(delCmd);
  if (!result.success) {
    log(`Erreur suppression VIP: ${result.stderr}`);
    return false;
  }

  log(t('vip.removed', { ip: vip.ip }));
  return true;
}

/**
 * Envoie des gratuitous ARP pour annoncer la VIP
 * Permet aux autres machines de mettre à jour leur table ARP
 */
export function sendGratuitousArp(vip: VipConfig): void {
  // arping -c 3 -U -I eth0 192.168.1.250
  // -c 3 : envoyer 3 paquets
  // -U : unsolicited ARP (gratuitous)
  // -I : interface source
  // Note: On ignore les erreurs car arping peut échouer sans gravité
  runCommand(`arping -c 3 -U -I ${vip.interface} ${vip.ip}`);
  
  // Aussi avec -A pour les systèmes qui l'attendent
  runCommand(`arping -c 3 -A -I ${vip.interface} ${vip.ip}`);
}

/**
 * Récupère l'état de toutes les VIPs configurées
 */
export function getVipsState(vips: VipConfig[]): VipState[] {
  return vips.map(vip => ({
    name: vip.name,
    ip: vip.ip,
    cidr: vip.cidr,
    interface: vip.interface,
    active: hasVip(vip),
  }));
}

/**
 * Vérifie si une VIP est joignable sur le réseau via arping
 * Utilisé par les followers pour détecter si le leader a la VIP active
 * 
 * @param vip Configuration de la VIP
 * @param timeoutSec Timeout en secondes (default: 1)
 * @returns true si la VIP répond aux ARP requests
 */
export function isVipReachable(vip: VipConfig, timeoutSec: number = 1): boolean {
  // arping -c 1 -w <timeout> -I <interface> <ip>
  // -c 1 : envoyer 1 paquet
  // -w <timeout> : timeout en secondes
  // -I : interface source
  // Retourne 0 si une réponse est reçue, 1 sinon
  const result = runCommand(`arping -c 1 -w ${timeoutSec} -I ${vip.interface} ${vip.ip}`);
  return result.success;
}

/**
 * Vérifie si au moins une VIP est joignable sur le réseau
 * 
 * @param vips Liste des VIPs à vérifier
 * @param timeoutSec Timeout par VIP en secondes (default: 1)
 * @returns true si au moins une VIP répond
 */
export function isAnyVipReachable(vips: VipConfig[], timeoutSec: number = 1): boolean {
  for (const vip of vips) {
    if (isVipReachable(vip, timeoutSec)) {
      return true;
    }
  }
  return false;
}

/**
 * Active toutes les VIPs
 */
export function activateAllVips(vips: VipConfig[], log?: (msg: string) => void): boolean {
  let success = true;
  for (const vip of vips) {
    if (!addVip(vip, log)) {
      success = false;
    }
  }
  return success;
}

/**
 * Désactive toutes les VIPs
 */
export function deactivateAllVips(vips: VipConfig[], log?: (msg: string) => void): boolean {
  let success = true;
  for (const vip of vips) {
    if (!removeVip(vip, log)) {
      success = false;
    }
  }
  return success;
}
