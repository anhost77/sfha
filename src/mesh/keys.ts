/**
 * @file keys.ts
 * @description Génération et gestion des clés WireGuard
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

/**
 * Génère une paire de clés WireGuard
 */
export function generateKeyPair(): KeyPair {
  const privateKey = execSync('wg genkey', { encoding: 'utf-8' }).trim();
  const publicKey = execSync(`echo "${privateKey}" | wg pubkey`, {
    encoding: 'utf-8',
    shell: '/bin/bash',
  }).trim();

  return { privateKey, publicKey };
}

/**
 * Sauvegarde les clés sur le disque
 */
export function saveKeys(keys: KeyPair, dir: string): void {
  // Créer le répertoire si nécessaire
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const privateKeyPath = `${dir}/private.key`;
  const publicKeyPath = `${dir}/public.key`;

  // Clé privée: lecture seule pour root
  writeFileSync(privateKeyPath, keys.privateKey + '\n', { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);

  // Clé publique: lisible
  writeFileSync(publicKeyPath, keys.publicKey + '\n', { mode: 0o644 });
}

/**
 * Charge les clés depuis le disque
 */
export function loadKeys(dir: string): KeyPair | null {
  const privateKeyPath = `${dir}/private.key`;
  const publicKeyPath = `${dir}/public.key`;

  if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
    return null;
  }

  return {
    privateKey: readFileSync(privateKeyPath, 'utf-8').trim(),
    publicKey: readFileSync(publicKeyPath, 'utf-8').trim(),
  };
}

/**
 * Vérifie si WireGuard est installé
 */
export function isWireGuardInstalled(): boolean {
  try {
    execSync('which wg', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Génère une authkey pour Corosync
 */
export function generateAuthKey(): string {
  return randomBytes(128).toString('base64');
}

/**
 * Sauvegarde l'authkey Corosync
 */
export function saveAuthKey(authKey: string, path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Format authkey Corosync (binaire 128 bytes)
  const buffer = Buffer.from(authKey, 'base64');
  writeFileSync(path, buffer, { mode: 0o400 });
}

/**
 * Charge l'authkey Corosync
 */
export function loadAuthKey(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }

  const buffer = readFileSync(path);
  return buffer.toString('base64');
}

/**
 * Dérive la clé publique d'une clé privée
 */
export function derivePublicKey(privateKey: string): string {
  return execSync(`echo "${privateKey}" | wg pubkey`, {
    encoding: 'utf-8',
    shell: '/bin/bash',
  }).trim();
}
