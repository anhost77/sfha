/**
 * @file stonith/drivers/proxmox.ts
 * @description Driver STONITH pour Proxmox VE
 * 
 * Utilise l'API REST Proxmox pour contrôler les VMs et containers.
 * Documentation API: https://pve.proxmox.com/pve-docs/api-viewer/
 */

import { readFileSync, existsSync } from 'fs';
import https from 'https';
import { BaseStonithDriver } from './base.js';
import { NodeStonithConfig, NodePowerState, ProxmoxStonithConfig } from '../types.js';

/**
 * Driver STONITH pour Proxmox VE
 */
export class ProxmoxStonithDriver extends BaseStonithDriver {
  readonly name = 'proxmox';

  private config: ProxmoxStonithConfig;
  private tokenSecret: string;

  constructor(
    config: ProxmoxStonithConfig,
    log: (msg: string) => void = console.log
  ) {
    super(log, { timeout: 60000, retries: 3, retryDelay: 5000 });
    this.config = config;
    this.tokenSecret = this.loadTokenSecret();
  }

  /**
   * Charge le secret du token depuis fichier ou config
   */
  private loadTokenSecret(): string {
    if (this.config.tokenSecretFile) {
      if (!existsSync(this.config.tokenSecretFile)) {
        throw new Error(`Fichier secret STONITH introuvable: ${this.config.tokenSecretFile}`);
      }
      return readFileSync(this.config.tokenSecretFile, 'utf-8').trim();
    }
    
    if (this.config.tokenSecret) {
      return this.config.tokenSecret;
    }
    
    throw new Error('STONITH Proxmox: token_secret ou token_secret_file requis');
  }

  /**
   * Construit les headers d'authentification Proxmox
   */
  private getAuthHeaders(): Record<string, string> {
    // Format: PVEAPIToken=user@realm!tokenid=secret
    return {
      'Authorization': `PVEAPIToken=${this.config.tokenId}=${this.tokenSecret}`,
    };
  }

  /**
   * Effectue une requête vers l'API Proxmox
   * Utilise https.request natif pour gérer correctement les certificats auto-signés
   */
  private async apiRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    body?: Record<string, any>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.config.apiUrl}/api2/json${endpoint}`);
      const postData = body ? new URLSearchParams(body as Record<string, string>).toString() : '';
      
      const headers: Record<string, string> = {
        ...this.getAuthHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      
      if (body && (method === 'POST' || method === 'PUT')) {
        headers['Content-Length'] = Buffer.byteLength(postData).toString();
      }
      
      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 8006,
        path: url.pathname + url.search,
        method,
        headers,
        rejectUnauthorized: this.config.verifySsl,
        timeout: this.timeout,
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = JSON.parse(data) as { data: T };
              resolve(json.data);
            } catch (e) {
              reject(new Error(`Réponse JSON invalide: ${data.slice(0, 100)}`));
            }
          } else {
            reject(new Error(`API Proxmox ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on('error', (e) => {
        reject(new Error(`Erreur réseau: ${e.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      
      if (body && (method === 'POST' || method === 'PUT')) {
        req.write(postData);
      }
      
      req.end();
    });
  }

  /**
   * Teste la connexion à l'API Proxmox
   */
  async test(): Promise<boolean> {
    try {
      // GET /version est un endpoint simple qui ne nécessite pas de permissions spéciales
      const version = await this.apiRequest<{ version: string }>('GET', '/version');
      this.log(`✅ API Proxmox connectée (version ${version.version})`);
      return true;
    } catch (error: any) {
      this.log(`❌ Échec connexion API Proxmox: ${error.message}`);
      return false;
    }
  }

  /**
   * Récupère l'état d'un VM/CT
   */
  async status(nodeConfig: NodeStonithConfig): Promise<NodePowerState> {
    try {
      const endpoint = nodeConfig.type === 'lxc'
        ? `/nodes/${this.config.pveNode}/lxc/${nodeConfig.vmid}/status/current`
        : `/nodes/${this.config.pveNode}/qemu/${nodeConfig.vmid}/status/current`;
      
      const status = await this.apiRequest<{ status: string }>('GET', endpoint);
      
      if (status.status === 'running') {
        return 'on';
      } else if (status.status === 'stopped') {
        return 'off';
      } else {
        return 'unknown';
      }
    } catch (error: any) {
      this.log(`⚠️ Impossible de récupérer le statut de ${nodeConfig.name}: ${error.message}`);
      return 'unknown';
    }
  }

  /**
   * Éteint un VM/CT (force stop)
   */
  async powerOff(nodeConfig: NodeStonithConfig): Promise<boolean> {
    const startTime = Date.now();
    
    return this.withRetry(async () => {
      this.log(`🔴 STONITH: Arrêt forcé de ${nodeConfig.name} (${nodeConfig.type}/${nodeConfig.vmid})...`);
      
      const endpoint = nodeConfig.type === 'lxc'
        ? `/nodes/${this.config.pveNode}/lxc/${nodeConfig.vmid}/status/stop`
        : `/nodes/${this.config.pveNode}/qemu/${nodeConfig.vmid}/status/stop`;
      
      // POST - forceStop n'est supporté que pour QEMU, pas pour LXC
      const params = nodeConfig.type === 'qemu' ? { forceStop: '1' } : {};
      await this.apiRequest<string>('POST', endpoint, Object.keys(params).length ? params : undefined);
      
      // Attendre que le VM/CT soit vraiment arrêté
      const maxWait = 30000; // 30 secondes max
      const checkInterval = 2000;
      let elapsed = 0;
      
      while (elapsed < maxWait) {
        await this.sleep(checkInterval);
        elapsed += checkInterval;
        
        const currentStatus = await this.status(nodeConfig);
        if (currentStatus === 'off') {
          const duration = Date.now() - startTime;
          this.log(`✅ ${nodeConfig.name} arrêté en ${duration}ms`);
          return true;
        }
      }
      
      throw new Error(`Timeout: ${nodeConfig.name} n'est pas arrêté après ${maxWait}ms`);
    }, `powerOff ${nodeConfig.name}`);
  }

  /**
   * Allume un VM/CT
   */
  async powerOn(nodeConfig: NodeStonithConfig): Promise<boolean> {
    const startTime = Date.now();
    
    return this.withRetry(async () => {
      this.log(`🟢 STONITH: Démarrage de ${nodeConfig.name} (${nodeConfig.type}/${nodeConfig.vmid})...`);
      
      const endpoint = nodeConfig.type === 'lxc'
        ? `/nodes/${this.config.pveNode}/lxc/${nodeConfig.vmid}/status/start`
        : `/nodes/${this.config.pveNode}/qemu/${nodeConfig.vmid}/status/start`;
      
      await this.apiRequest<string>('POST', endpoint);
      
      // Attendre que le VM/CT soit vraiment démarré
      const maxWait = 60000; // 60 secondes max pour démarrage
      const checkInterval = 3000;
      let elapsed = 0;
      
      while (elapsed < maxWait) {
        await this.sleep(checkInterval);
        elapsed += checkInterval;
        
        const currentStatus = await this.status(nodeConfig);
        if (currentStatus === 'on') {
          const duration = Date.now() - startTime;
          this.log(`✅ ${nodeConfig.name} démarré en ${duration}ms`);
          return true;
        }
      }
      
      throw new Error(`Timeout: ${nodeConfig.name} n'est pas démarré après ${maxWait}ms`);
    }, `powerOn ${nodeConfig.name}`);
  }
}
