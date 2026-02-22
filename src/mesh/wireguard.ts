/**
 * @file wireguard.ts
 * @description Wrapper pour les commandes WireGuard
 */

import { execSync, spawnSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { MeshPeer, WgInterfaceStatus, WgPeerStatus } from './types.js';

const WG_INTERFACE = 'wg-sfha';
const WG_CONFIG_DIR = '/etc/wireguard';

/**
 * Crée et configure l'interface WireGuard
 */
export function createInterface(
  name: string,
  ip: string,
  privateKey: string,
  listenPort: number
): void {
  // Supprimer l'interface si elle existe
  try {
    execSync(`ip link show ${name}`, { stdio: 'pipe' });
    execSync(`ip link delete ${name}`, { stdio: 'pipe' });
  } catch {
    // Interface n'existe pas, c'est OK
  }

  // Créer l'interface
  execSync(`ip link add ${name} type wireguard`);

  // Configurer la clé privée via fichier temporaire
  const tmpKeyFile = `/tmp/wg-${Date.now()}.key`;
  try {
    writeFileSync(tmpKeyFile, privateKey, { mode: 0o600 });
    execSync(`wg set ${name} private-key ${tmpKeyFile} listen-port ${listenPort}`);
  } finally {
    try {
      unlinkSync(tmpKeyFile);
    } catch {
      // Ignorer
    }
  }

  // Assigner l'IP
  execSync(`ip addr add ${ip} dev ${name}`);

  // Activer l'interface
  execSync(`ip link set ${name} up`);
}

/**
 * Supprime l'interface WireGuard
 */
export function deleteInterface(name: string): void {
  try {
    execSync(`ip link show ${name}`, { stdio: 'pipe' });
    execSync(`ip link set ${name} down`);
    execSync(`ip link delete ${name}`);
  } catch {
    // Interface n'existe pas, c'est OK
  }
}

/**
 * Vérifie si l'interface existe et est active
 */
export function isInterfaceUp(name: string): boolean {
  try {
    const output = execSync(`ip link show ${name}`, { encoding: 'utf-8' });
    return output.includes('state UP') || output.includes(',UP');
  } catch {
    return false;
  }
}

/**
 * Ajoute un peer à l'interface WireGuard
 */
export function addPeer(
  interfaceName: string,
  peer: MeshPeer
): void {
  let cmd = `wg set ${interfaceName} peer ${peer.publicKey}`;

  if (peer.endpoint) {
    cmd += ` endpoint ${peer.endpoint}`;
  }

  cmd += ` allowed-ips ${peer.allowedIps}`;

  if (peer.persistentKeepalive) {
    cmd += ` persistent-keepalive ${peer.persistentKeepalive}`;
  }

  execSync(cmd);
}

/**
 * Supprime un peer de l'interface WireGuard
 */
export function removePeer(interfaceName: string, publicKey: string): void {
  execSync(`wg set ${interfaceName} peer ${publicKey} remove`);
}

/**
 * Récupère le statut de l'interface WireGuard
 */
export function getInterfaceStatus(name: string): WgInterfaceStatus | null {
  if (!isInterfaceUp(name)) {
    return null;
  }

  try {
    // Format dump: private-key, public-key, listen-port, fwmark
    const output = execSync(`wg show ${name} dump`, { encoding: 'utf-8' });
    const lines = output.trim().split('\n');

    if (lines.length === 0) {
      return null;
    }

    // Première ligne = interface
    const [privateKey, publicKey, listenPort, fwmark] = lines[0].split('\t');

    const peers: WgPeerStatus[] = [];

    // Lignes suivantes = peers
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length >= 4) {
        const [peerPubKey, psk, endpoint, allowedIps, latestHandshake, txBytes, rxBytes, keepalive] =
          parts;

        peers.push({
          publicKey: peerPubKey,
          endpoint: endpoint !== '(none)' ? endpoint : undefined,
          allowedIps: allowedIps.split(','),
          latestHandshake:
            latestHandshake !== '0' ? parseInt(latestHandshake, 10) : undefined,
          transferTx: parseInt(txBytes, 10) || 0,
          transferRx: parseInt(rxBytes, 10) || 0,
        });
      }
    }

    return {
      name,
      publicKey,
      listenPort: parseInt(listenPort, 10),
      peers,
    };
  } catch {
    return null;
  }
}

/**
 * Génère le fichier de configuration WireGuard pour wg-quick
 */
export function generateWgQuickConfig(
  privateKey: string,
  address: string,
  listenPort: number,
  peers: MeshPeer[]
): string {
  let config = `[Interface]
PrivateKey = ${privateKey}
Address = ${address}
ListenPort = ${listenPort}
SaveConfig = false

`;

  for (const peer of peers) {
    config += `[Peer]
PublicKey = ${peer.publicKey}
AllowedIPs = ${peer.allowedIps}
`;
    if (peer.endpoint) {
      config += `Endpoint = ${peer.endpoint}\n`;
    }
    if (peer.persistentKeepalive) {
      config += `PersistentKeepalive = ${peer.persistentKeepalive}\n`;
    }
    config += '\n';
  }

  return config;
}

/**
 * Sauvegarde la configuration WireGuard pour wg-quick
 */
export function saveWgQuickConfig(interfaceName: string, config: string): void {
  if (!existsSync(WG_CONFIG_DIR)) {
    mkdirSync(WG_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  const configPath = `${WG_CONFIG_DIR}/${interfaceName}.conf`;
  writeFileSync(configPath, config, { mode: 0o600 });
}

/**
 * Active wg-quick au boot
 */
export function enableWgQuickService(interfaceName: string): void {
  try {
    execSync(`systemctl enable wg-quick@${interfaceName}`, { stdio: 'pipe' });
  } catch (error: any) {
    // Ignorer si systemctl n'est pas disponible
    if (!error.message?.includes('not found')) {
      throw error;
    }
  }
}

/**
 * Désactive wg-quick au boot
 */
export function disableWgQuickService(interfaceName: string): void {
  try {
    execSync(`systemctl disable wg-quick@${interfaceName}`, { stdio: 'pipe' });
  } catch {
    // Ignorer
  }
}

/**
 * Démarre l'interface via wg-quick
 */
export function wgQuickUp(interfaceName: string): void {
  execSync(`wg-quick up ${interfaceName}`);
}

/**
 * Arrête l'interface via wg-quick
 */
export function wgQuickDown(interfaceName: string): void {
  try {
    execSync(`wg-quick down ${interfaceName}`, { stdio: 'pipe' });
  } catch {
    // Ignorer si l'interface n'est pas active
  }
}

/**
 * Récupère l'IP publique/externe du serveur
 */
export function detectPublicEndpoint(port: number): string | null {
  // D'abord essayer l'IP locale (plus fiable pour les clusters LAN)
  try {
    const output = execSync(
      "ip -4 route get 1 | head -1 | awk '{print $7}'",
      { encoding: 'utf-8', shell: '/bin/bash' }
    ).trim();
    if (output && output !== '' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(output)) {
      return `${output}:${port}`;
    }
  } catch {
    // Ignorer
  }

  // Fallback: IP publique via services externes
  const methods = [
    'curl -4 -s --connect-timeout 3 ifconfig.me',
    'curl -4 -s --connect-timeout 3 icanhazip.com',
    'curl -4 -s --connect-timeout 3 api.ipify.org',
  ];

  for (const cmd of methods) {
    try {
      const ip = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (ip && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        return `${ip}:${port}`;
      }
    } catch {
      continue;
    }
  }

  return null;
}
