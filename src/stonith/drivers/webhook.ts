/**
 * @file stonith/drivers/webhook.ts
 * @description Driver STONITH générique via Webhook HTTP
 * 
 * Permet d'intégrer sfha avec n'importe quelle API externe pour le fencing.
 * Supporte les templates avec {{node}} et {{action}}.
 */

import https from 'https';
import http from 'http';
import { BaseStonithDriver } from './base.js';
import { NodeStonithConfig, NodePowerState, WebhookStonithConfig } from '../types.js';

/**
 * Driver STONITH via Webhook HTTP
 */
export class WebhookStonithDriver extends BaseStonithDriver {
  readonly name = 'webhook';

  private config: WebhookStonithConfig;

  constructor(
    config: WebhookStonithConfig,
    log: (msg: string) => void = console.log
  ) {
    super(log, { 
      timeout: (config.timeout || 30) * 1000, 
      retries: 3, 
      retryDelay: 5000 
    });
    this.config = config;
  }

  /**
   * Remplace les placeholders dans une chaîne
   */
  private replacePlaceholders(
    template: string, 
    vars: { node?: string; action?: string }
  ): string {
    let result = template;
    if (vars.node !== undefined) {
      result = result.replace(/\{\{node\}\}/g, vars.node);
    }
    if (vars.action !== undefined) {
      result = result.replace(/\{\{action\}\}/g, vars.action);
    }
    return result;
  }

  /**
   * Effectue une requête HTTP/HTTPS
   */
  private async httpRequest(
    urlStr: string,
    method: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const requestHeaders: Record<string, string> = { ...headers };
      if (body) {
        requestHeaders['Content-Length'] = Buffer.byteLength(body).toString();
        // Défaut à application/json si non spécifié
        if (!requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
          requestHeaders['Content-Type'] = 'application/json';
        }
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: requestHeaders,
        timeout: this.timeout,
      };

      // Gérer les certificats auto-signés si configuré
      if (isHttps && !this.config.verifySsl) {
        (options as https.RequestOptions).rejectUnauthorized = false;
      }

      const req = httpModule.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: data,
          });
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Erreur réseau: ${e.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  /**
   * Exécute un webhook avec les variables données
   */
  private async executeWebhook(
    url: string,
    vars: { node: string; action: string }
  ): Promise<boolean> {
    const finalUrl = this.replacePlaceholders(url, vars);
    const headers = { ...this.config.headers };
    
    let body: string | undefined;
    if (this.config.bodyTemplate && this.config.method !== 'GET') {
      body = this.replacePlaceholders(this.config.bodyTemplate, vars);
    }

    this.log(`🌐 Webhook ${this.config.method} ${finalUrl}`);

    const response = await this.httpRequest(
      finalUrl,
      this.config.method,
      headers,
      body
    );

    // Succès si HTTP 2xx
    const success = response.statusCode >= 200 && response.statusCode < 300;
    
    if (success) {
      this.log(`✅ Webhook OK (${response.statusCode})`);
    } else {
      this.log(`❌ Webhook échoué: HTTP ${response.statusCode} - ${response.body.slice(0, 200)}`);
    }

    return success;
  }

  /**
   * Teste la connectivité (vérifie juste que l'URL est atteignable)
   */
  async test(): Promise<boolean> {
    try {
      // On teste avec le status_url si disponible, sinon fence_url
      const testUrl = this.config.statusUrl || this.config.fenceUrl;
      const url = new URL(this.replacePlaceholders(testUrl, { node: 'test', action: 'test' }));
      
      // Juste vérifier que l'URL est valide et que le host répond
      const response = await this.httpRequest(
        `${url.protocol}//${url.host}`,
        'GET',
        {},
        undefined
      );

      // On accepte n'importe quelle réponse, même 404 - ça veut dire que le serveur répond
      this.log(`✅ Webhook connecté (${url.host})`);
      return true;
    } catch (error: any) {
      this.log(`❌ Échec connexion Webhook: ${error.message}`);
      return false;
    }
  }

  /**
   * Récupère l'état d'un nœud via webhook
   */
  async status(nodeConfig: NodeStonithConfig): Promise<NodePowerState> {
    if (!this.config.statusUrl) {
      // Pas d'URL status configurée, on retourne unknown
      return 'unknown';
    }

    try {
      const url = this.replacePlaceholders(this.config.statusUrl, { 
        node: nodeConfig.name 
      });
      
      const response = await this.httpRequest(
        url,
        'GET',
        this.config.headers || {},
        undefined
      );

      if (response.statusCode >= 200 && response.statusCode < 300) {
        // Essayer de parser la réponse pour déterminer l'état
        const body = response.body.toLowerCase();
        
        if (body.includes('"status":"on"') || 
            body.includes('"power":"on"') ||
            body.includes('"state":"running"') ||
            body.includes('"running":true') ||
            body === 'on' ||
            body === 'running') {
          return 'on';
        }
        
        if (body.includes('"status":"off"') || 
            body.includes('"power":"off"') ||
            body.includes('"state":"stopped"') ||
            body.includes('"running":false') ||
            body === 'off' ||
            body === 'stopped') {
          return 'off';
        }
      }

      return 'unknown';
    } catch (error: any) {
      this.log(`⚠️ Impossible de récupérer le statut de ${nodeConfig.name}: ${error.message}`);
      return 'unknown';
    }
  }

  /**
   * Éteint un nœud via webhook (fence)
   */
  async powerOff(nodeConfig: NodeStonithConfig): Promise<boolean> {
    return this.withRetry(async () => {
      this.log(`🔴 STONITH Webhook: Fence de ${nodeConfig.name}...`);
      
      return await this.executeWebhook(this.config.fenceUrl, {
        node: nodeConfig.name,
        action: 'fence',
      });
    }, `powerOff ${nodeConfig.name}`);
  }

  /**
   * Allume un nœud via webhook (unfence)
   */
  async powerOn(nodeConfig: NodeStonithConfig): Promise<boolean> {
    return this.withRetry(async () => {
      this.log(`🟢 STONITH Webhook: Unfence de ${nodeConfig.name}...`);
      
      return await this.executeWebhook(this.config.unfenceUrl, {
        node: nodeConfig.name,
        action: 'unfence',
      });
    }, `powerOn ${nodeConfig.name}`);
  }
}
