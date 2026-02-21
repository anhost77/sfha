/**
 * @file resources.ts
 * @description Gestion des ressources/services (systemd)
 */

import { execSync } from 'child_process';
import { ServiceConfig, Constraint, OrderConstraint } from './config.js';
import { t } from './i18n.js';

// ============================================
// Types
// ============================================

export interface ResourceState {
  name: string;
  type: 'vip' | 'service';
  active: boolean;
  healthy?: boolean;
  error?: string;
}

// ============================================
// Systemd Functions
// ============================================

/**
 * Démarre un service systemd
 */
export function startService(unit: string): { ok: boolean; error?: string } {
  try {
    execSync(`systemctl start ${unit}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

/**
 * Arrête un service systemd
 */
export function stopService(unit: string): { ok: boolean; error?: string } {
  try {
    execSync(`systemctl stop ${unit}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

/**
 * Vérifie si un service est actif
 */
export function isServiceActive(unit: string): boolean {
  try {
    const output = execSync(`systemctl is-active ${unit}`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output === 'active';
  } catch {
    return false;
  }
}

/**
 * Redémarre un service systemd
 */
export function restartService(unit: string): { ok: boolean; error?: string } {
  try {
    execSync(`systemctl restart ${unit}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

// ============================================
// Constraint Resolution
// ============================================

/**
 * Résout l'ordre de démarrage des ressources selon les contraintes
 * Utilise un tri topologique
 */
export function resolveStartOrder(
  resources: string[],
  constraints: Constraint[]
): string[] {
  // Filtrer les contraintes d'ordre
  const orderConstraints = constraints.filter(
    (c): c is OrderConstraint => c.type === 'order'
  );

  // Construire le graphe
  const graph = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  // Initialiser tous les nœuds
  for (const r of resources) {
    graph.set(r, new Set());
    inDegree.set(r, 0);
  }

  // Ajouter les arêtes
  for (const c of orderConstraints) {
    // S'assurer que les deux ressources existent
    if (!graph.has(c.first) || !graph.has(c.then)) continue;
    
    // first -> then (first doit démarrer avant then)
    graph.get(c.first)!.add(c.then);
    inDegree.set(c.then, (inDegree.get(c.then) || 0) + 1);
  }

  // Tri topologique (algorithme de Kahn)
  const queue: string[] = [];
  const result: string[] = [];

  // Trouver les nœuds sans dépendances (in-degree = 0)
  for (const [r, degree] of inDegree) {
    if (degree === 0) queue.push(r);
  }

  while (queue.length > 0) {
    const r = queue.shift()!;
    result.push(r);

    // Réduire le in-degree des dépendants
    for (const dep of graph.get(r) || []) {
      inDegree.set(dep, (inDegree.get(dep) || 0) - 1);
      if (inDegree.get(dep) === 0) queue.push(dep);
    }
  }

  // Si on n'a pas tous les nœuds, il y a un cycle
  // On ajoute les nœuds manquants à la fin
  for (const r of resources) {
    if (!result.includes(r)) {
      result.push(r);
    }
  }

  return result;
}

/**
 * Résout l'ordre d'arrêt (inverse de l'ordre de démarrage)
 */
export function resolveStopOrder(
  resources: string[],
  constraints: Constraint[]
): string[] {
  return resolveStartOrder(resources, constraints).reverse();
}

// ============================================
// Resource Manager
// ============================================

/**
 * Gestionnaire des ressources
 */
export class ResourceManager {
  private services: ServiceConfig[];
  private constraints: Constraint[];
  private log: (msg: string) => void;

  constructor(
    services: ServiceConfig[],
    constraints: Constraint[],
    log: (msg: string) => void = console.log
  ) {
    this.services = services;
    this.constraints = constraints;
    this.log = log;
  }

  /**
   * Démarre tous les services dans l'ordre des contraintes
   */
  startAll(): { success: boolean; errors: string[] } {
    const errors: string[] = [];
    const serviceNames = this.services.map(s => s.name);
    const ordered = resolveStartOrder(serviceNames, this.constraints);

    this.log(`📋 Ordre de démarrage: ${ordered.join(' → ')}`);

    for (const name of ordered) {
      const service = this.services.find(s => s.name === name);
      if (!service) continue;

      this.log(`▶️ Démarrage de ${service.name} (${service.unit})`);
      const result = startService(service.unit);
      
      if (!result.ok) {
        errors.push(`${service.name}: ${result.error}`);
        this.log(`❌ Échec du démarrage de ${service.name}: ${result.error}`);
      } else {
        this.log(`✅ ${service.name} démarré`);
      }
    }

    return { success: errors.length === 0, errors };
  }

  /**
   * Arrête tous les services dans l'ordre inverse
   */
  stopAll(): { success: boolean; errors: string[] } {
    const errors: string[] = [];
    const serviceNames = this.services.map(s => s.name);
    const ordered = resolveStopOrder(serviceNames, this.constraints);

    this.log(`📋 Ordre d'arrêt: ${ordered.join(' → ')}`);

    for (const name of ordered) {
      const service = this.services.find(s => s.name === name);
      if (!service) continue;

      this.log(`⏹️ Arrêt de ${service.name} (${service.unit})`);
      const result = stopService(service.unit);
      
      if (!result.ok) {
        errors.push(`${service.name}: ${result.error}`);
        this.log(`⚠️ Échec de l'arrêt de ${service.name}: ${result.error}`);
      } else {
        this.log(`✅ ${service.name} arrêté`);
      }
    }

    return { success: errors.length === 0, errors };
  }

  /**
   * Récupère l'état de tous les services
   */
  getState(): ResourceState[] {
    return this.services.map(service => ({
      name: service.name,
      type: 'service' as const,
      active: isServiceActive(service.unit),
    }));
  }

  /**
   * Vérifie si tous les services sont actifs
   */
  isAllActive(): boolean {
    return this.services.every(s => isServiceActive(s.unit));
  }
}
