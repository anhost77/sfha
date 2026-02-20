/**
 * @file control.ts
 * @description Socket Unix pour contrôle du daemon sfha
 * 
 * Permet d'envoyer des commandes au daemon en cours d'exécution:
 * - standby: mettre le nœud en standby
 * - unstandby: sortir du standby
 * - failover: forcer un basculement
 * - status: obtenir le statut complet
 * - health: obtenir l'état des health checks
 * - reload: recharger la configuration
 */

import { createServer, createConnection, Server, Socket } from 'net';
import { existsSync, unlinkSync } from 'fs';
import { t } from './i18n.js';

// ============================================
// Types
// ============================================

export interface ControlCommand {
  action: 
    | 'standby' 
    | 'unstandby' 
    | 'failover' 
    | 'status' 
    | 'health' 
    | 'reload' 
    | 'resources'
    | 'stonith-status'
    | 'stonith-fence'
    | 'stonith-unfence'
    | 'stonith-history';
  params?: {
    targetNode?: string;
    node?: string;  // Pour les commandes STONITH
  };
}

export interface ControlResponse {
  success: boolean;
  message?: string;
  data?: any;
  error?: string;
}

export type CommandHandler = (cmd: ControlCommand) => Promise<ControlResponse>;

// ============================================
// Constants
// ============================================

const SOCKET_PATH = '/var/run/sfha.sock';
const SOCKET_TIMEOUT = 30000;

// ============================================
// Control Server (côté daemon)
// ============================================

/**
 * Serveur de contrôle Unix socket
 */
export class ControlServer {
  private server: Server | null = null;
  private handler: CommandHandler;
  private log: (msg: string) => void;

  constructor(handler: CommandHandler, log: (msg: string) => void = console.log) {
    this.handler = handler;
    this.log = log;
  }

  /**
   * Démarre le serveur
   */
  start(): void {
    // Supprimer le socket existant
    if (existsSync(SOCKET_PATH)) {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // Ignorer
      }
    }

    this.server = createServer((socket: Socket) => {
      this.handleConnection(socket);
    });

    this.server.on('error', (err) => {
      this.log(`⚠️ Erreur socket: ${err.message}`);
    });

    this.server.listen(SOCKET_PATH, () => {
      this.log(`🔌 Socket de contrôle actif: ${SOCKET_PATH}`);
    });
  }

  /**
   * Arrête le serveur
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Nettoyer le socket
    if (existsSync(SOCKET_PATH)) {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // Ignorer
      }
    }
  }

  /**
   * Gère une connexion entrante
   */
  private handleConnection(socket: Socket): void {
    let data = '';
    let processed = false;

    socket.setTimeout(SOCKET_TIMEOUT);

    const processCommand = async () => {
      if (processed || !data.trim()) return;
      
      try {
        // Chercher une commande JSON complète
        const trimmed = data.trim();
        if (!trimmed.startsWith('{')) return;
        
        const cmd: ControlCommand = JSON.parse(trimmed);
        processed = true;
        
        const response = await this.handler(cmd);
        socket.write(JSON.stringify(response) + '\n');
        socket.end();
      } catch (error: any) {
        if (error instanceof SyntaxError) {
          // JSON incomplet, attendre plus de données
          return;
        }
        processed = true;
        const response: ControlResponse = {
          success: false,
          error: `Commande invalide: ${error.message}`,
        };
        socket.write(JSON.stringify(response) + '\n');
        socket.end();
      }
    };

    socket.on('data', (chunk) => {
      data += chunk.toString();
      processCommand();
    });

    socket.on('end', () => {
      processCommand();
    });

    socket.on('timeout', () => {
      socket.destroy();
    });

    socket.on('error', () => {
      socket.destroy();
    });
  }
}

// ============================================
// Control Client (côté CLI)
// ============================================

/**
 * Envoie une commande au daemon
 */
export async function sendCommand(cmd: ControlCommand): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    // Vérifier si le socket existe
    if (!existsSync(SOCKET_PATH)) {
      resolve({
        success: false,
        error: t('error.daemonNotRunning'),
      });
      return;
    }

    const socket = createConnection(SOCKET_PATH);
    let response = '';

    socket.setTimeout(SOCKET_TIMEOUT);

    socket.on('connect', () => {
      socket.write(JSON.stringify(cmd));
    });

    socket.on('data', (chunk) => {
      response += chunk.toString();
    });

    socket.on('end', () => {
      try {
        resolve(JSON.parse(response.trim()));
      } catch {
        resolve({
          success: false,
          error: 'Réponse invalide du daemon',
        });
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({
        success: false,
        error: 'Timeout',
      });
    });

    socket.on('error', (err) => {
      resolve({
        success: false,
        error: err.message,
      });
    });
  });
}

/**
 * Vérifie si le daemon est en cours d'exécution
 */
export function isDaemonRunning(): boolean {
  return existsSync(SOCKET_PATH);
}
