/**
 * @file health.ts
 * @description Health checks (HTTP, TCP, systemd)
 */

import { execSync } from 'child_process';
import { createConnection, Socket } from 'net';
import { HealthCheckConfig, ServiceConfig, StandaloneHealthCheck } from './config.js';
import { t } from './i18n.js';

// ============================================
// Types
// ============================================

export interface HealthResult {
  name: string;
  healthy: boolean;
  lastCheck: Date;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastError?: string;
}

export interface HealthState {
  results: Map<string, HealthResult>;
}

// ============================================
// Checkers
// ============================================

/**
 * Health check HTTP
 */
async function checkHttp(url: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    const response = await fetch(url, {
      signal: controller.signal,
      method: 'GET',
    });
    
    clearTimeout(timeout);
    
    if (response.ok) {
      return { ok: true };
    } else {
      return { ok: false, error: `HTTP ${response.status}` };
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: error.message };
  }
}

/**
 * Health check TCP
 */
async function checkTcp(target: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // Parser host:port
    const [host, portStr] = target.split(':');
    const port = parseInt(portStr, 10);
    
    if (!host || isNaN(port)) {
      resolve({ ok: false, error: 'format invalide (attendu: host:port)' });
      return;
    }
    
    const socket: Socket = createConnection({ host, port });
    
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true });
    });
    
    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: false, error: err.message });
    });
  });
}

/**
 * Health check systemd
 */
function checkSystemd(unit: string): { ok: boolean; error?: string } {
  try {
    const output = execSync(`systemctl is-active ${unit}`, {
      encoding: 'utf-8',
      timeout: 5000,
      killSignal: 'SIGKILL',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    
    return { ok: output === 'active' };
  } catch (error: any) {
    // is-active retourne un code d'erreur si le service n'est pas actif
    const output = error.stdout?.trim() || error.message;
    return { ok: false, error: output };
  }
}

/**
 * Exécute un health check selon son type
 */
export async function runHealthCheck(
  config: HealthCheckConfig
): Promise<{ ok: boolean; error?: string }> {
  switch (config.type) {
    case 'http':
      return checkHttp(config.target, config.timeoutMs);
    case 'tcp':
      return checkTcp(config.target, config.timeoutMs);
    case 'systemd':
      return checkSystemd(config.target);
    default:
      return { ok: false, error: `type inconnu: ${config.type}` };
  }
}

// ============================================
// Health Manager
// ============================================

type HealthCallback = (name: string, healthy: boolean, result: HealthResult) => void;

/**
 * Gestionnaire de health checks
 */
export class HealthManager {
  private services: ServiceConfig[];
  private standaloneChecks: StandaloneHealthCheck[];
  private state: HealthState;
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private callbacks: HealthCallback[] = [];
  private log: (msg: string) => void;

  constructor(
    services: ServiceConfig[],
    log: (msg: string) => void = console.log,
    standaloneChecks: StandaloneHealthCheck[] = []
  ) {
    this.services = services;
    this.standaloneChecks = standaloneChecks;
    this.state = { results: new Map() };
    this.log = log;
    
    // Initialiser l'état pour les services avec healthcheck
    for (const service of services) {
      if (service.healthcheck) {
        this.state.results.set(service.name, {
          name: service.name,
          healthy: true, // Présumé sain au démarrage
          lastCheck: new Date(),
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
        });
      }
    }
    
    // Initialiser l'état pour les health checks standalone
    for (const check of standaloneChecks) {
      this.state.results.set(check.name, {
        name: check.name,
        healthy: true, // Présumé sain au démarrage
        lastCheck: new Date(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      });
    }
  }

  /**
   * Enregistre un callback pour les changements de santé
   */
  onHealthChange(callback: HealthCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Démarre tous les health checks
   */
  start(): void {
    // Health checks liés aux services
    for (const service of this.services) {
      if (!service.healthcheck) continue;
      
      const config = service.healthcheck;
      
      // Premier check immédiat
      this.checkService(service);
      
      // Checks périodiques
      const interval = setInterval(
        () => this.checkService(service),
        config.intervalMs
      );
      this.intervals.set(service.name, interval);
    }
    
    // Health checks standalone
    for (const check of this.standaloneChecks) {
      // Premier check immédiat
      this.checkStandalone(check);
      
      // Checks périodiques
      const interval = setInterval(
        () => this.checkStandalone(check),
        check.intervalMs
      );
      this.intervals.set(check.name, interval);
    }
  }

  /**
   * Arrête tous les health checks
   */
  stop(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }

  /**
   * Vérifie un service
   */
  private async checkService(service: ServiceConfig): Promise<void> {
    if (!service.healthcheck) return;
    
    const config = service.healthcheck;
    const result = this.state.results.get(service.name)!;
    
    this.log(t('health.checking', { resource: service.name }));
    
    const check = await runHealthCheck(config);
    
    result.lastCheck = new Date();
    
    if (check.ok) {
      result.consecutiveFailures = 0;
      result.consecutiveSuccesses++;
      result.lastError = undefined;
      
      // Passer à sain après N succès consécutifs
      if (!result.healthy && result.consecutiveSuccesses >= config.successesBeforeHealthy) {
        result.healthy = true;
        this.log(t('health.passed', { resource: service.name }));
        this.notifyCallbacks(service.name, true, result);
      }
    } else {
      result.consecutiveSuccesses = 0;
      result.consecutiveFailures++;
      result.lastError = check.error;
      
      // Passer à défaillant après N échecs consécutifs
      if (result.healthy && result.consecutiveFailures >= config.failuresBeforeUnhealthy) {
        result.healthy = false;
        this.log(t('health.failed', { resource: service.name, error: check.error || 'inconnu' }));
        this.notifyCallbacks(service.name, false, result);
      } else if (!result.healthy && service.critical) {
        // Pour les services critiques, notifier à chaque échec après le seuil initial
        // pour permettre le déclenchement du failover
        this.notifyCallbacks(service.name, false, result);
      }
    }
  }

  /**
   * Vérifie un health check standalone
   */
  private async checkStandalone(check: StandaloneHealthCheck): Promise<void> {
    const result = this.state.results.get(check.name)!;
    
    this.log(t('health.checking', { resource: check.name }));
    
    // Construire un HealthCheckConfig compatible pour runHealthCheck
    const healthCheckConfig: HealthCheckConfig = {
      type: check.type,
      target: check.target,
      intervalMs: check.intervalMs,
      timeoutMs: check.timeoutMs,
      failuresBeforeUnhealthy: check.failuresBeforeUnhealthy,
      successesBeforeHealthy: check.successesBeforeHealthy,
    };
    
    const checkResult = await runHealthCheck(healthCheckConfig);
    
    result.lastCheck = new Date();
    
    if (checkResult.ok) {
      result.consecutiveFailures = 0;
      result.consecutiveSuccesses++;
      result.lastError = undefined;
      
      // Passer à sain après N succès consécutifs
      if (!result.healthy && result.consecutiveSuccesses >= check.successesBeforeHealthy) {
        result.healthy = true;
        this.log(t('health.passed', { resource: check.name }));
        this.notifyCallbacks(check.name, true, result);
      }
    } else {
      result.consecutiveSuccesses = 0;
      result.consecutiveFailures++;
      result.lastError = checkResult.error;
      
      // Passer à défaillant après N échecs consécutifs
      if (result.healthy && result.consecutiveFailures >= check.failuresBeforeUnhealthy) {
        result.healthy = false;
        this.log(t('health.failed', { resource: check.name, error: checkResult.error || 'inconnu' }));
        this.notifyCallbacks(check.name, false, result);
      } else if (!result.healthy && check.critical) {
        // Pour les checks critiques, notifier à chaque échec après le seuil initial
        // pour permettre le déclenchement du failover
        this.notifyCallbacks(check.name, false, result);
      }
    }
  }

  /**
   * Notifie les callbacks
   */
  private notifyCallbacks(name: string, healthy: boolean, result: HealthResult): void {
    for (const callback of this.callbacks) {
      try {
        callback(name, healthy, result);
      } catch {
        // Ignorer les erreurs des callbacks
      }
    }
  }

  /**
   * Récupère l'état actuel
   */
  getState(): Map<string, HealthResult> {
    return new Map(this.state.results);
  }

  /**
   * Vérifie si tous les services sont sains
   */
  isAllHealthy(): boolean {
    for (const result of this.state.results.values()) {
      if (!result.healthy) return false;
    }
    return true;
  }

  /**
   * Récupère les services défaillants
   */
  getUnhealthyServices(): string[] {
    const unhealthy: string[] = [];
    for (const result of this.state.results.values()) {
      if (!result.healthy) {
        unhealthy.push(result.name);
      }
    }
    return unhealthy;
  }
}
