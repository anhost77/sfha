/**
 * @file stonith/drivers/base.ts
 * @description Interface abstraite pour les drivers STONITH
 */

import { NodeStonithConfig, NodePowerState } from '../types.js';

/**
 * Interface commune pour tous les drivers STONITH
 */
export interface StonithDriver {
  /** Nom du driver */
  readonly name: string;

  /**
   * Vérifie que le driver peut contacter l'API/backend
   * @returns true si connexion OK
   */
  test(): Promise<boolean>;

  /**
   * Éteint un nœud (force stop)
   * @param nodeConfig Configuration du nœud à éteindre
   * @returns true si l'opération a réussi
   */
  powerOff(nodeConfig: NodeStonithConfig): Promise<boolean>;

  /**
   * Allume un nœud
   * @param nodeConfig Configuration du nœud à allumer
   * @returns true si l'opération a réussi
   */
  powerOn(nodeConfig: NodeStonithConfig): Promise<boolean>;

  /**
   * Vérifie l'état d'alimentation d'un nœud
   * @param nodeConfig Configuration du nœud
   * @returns 'on', 'off', ou 'unknown'
   */
  status(nodeConfig: NodeStonithConfig): Promise<NodePowerState>;

  /**
   * Ferme les connexions et libère les ressources
   */
  destroy?(): Promise<void>;
}

/**
 * Classe abstraite de base pour les drivers STONITH
 * Fournit des implémentations par défaut et des utilitaires
 */
export abstract class BaseStonithDriver implements StonithDriver {
  abstract readonly name: string;

  protected log: (msg: string) => void;
  protected timeout: number;
  protected retries: number;
  protected retryDelay: number;

  constructor(
    log: (msg: string) => void = console.log,
    options: { timeout?: number; retries?: number; retryDelay?: number } = {}
  ) {
    this.log = log;
    this.timeout = options.timeout ?? 60000; // 60s par défaut
    this.retries = options.retries ?? 3;
    this.retryDelay = options.retryDelay ?? 5000; // 5s entre retries
  }

  abstract test(): Promise<boolean>;
  abstract powerOff(nodeConfig: NodeStonithConfig): Promise<boolean>;
  abstract powerOn(nodeConfig: NodeStonithConfig): Promise<boolean>;
  abstract status(nodeConfig: NodeStonithConfig): Promise<NodePowerState>;

  /**
   * Exécute une opération avec retry et backoff exponentiel
   */
  protected async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        this.log(
          `⚠️ ${operationName} - tentative ${attempt}/${this.retries} échouée: ${error.message}`
        );

        if (attempt < this.retries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1); // Backoff exponentiel
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error(`${operationName} échoué après ${this.retries} tentatives`);
  }

  /**
   * Attend un certain délai
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Crée un AbortController avec timeout
   */
  protected createTimeoutController(): { controller: AbortController; clear: () => void } {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    return {
      controller,
      clear: () => clearTimeout(timeoutId),
    };
  }

  /**
   * Cleanup (à surcharger si nécessaire)
   */
  async destroy(): Promise<void> {
    // Par défaut, rien à faire
  }
}
