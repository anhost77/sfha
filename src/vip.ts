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
