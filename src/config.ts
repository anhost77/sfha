/**
 * @file config.ts
 * @description Parsing de la configuration YAML pour sfha
 */

import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { t } from './i18n.js';
import {
  StonithConfig,
  StonithSafetyConfig,
  ProxmoxStonithConfig,
  WebhookStonithConfig,
  DEFAULT_STONITH_SAFETY,
} from './stonith/types.js';

// Re-export STONITH types
export type { StonithConfig, StonithSafetyConfig, ProxmoxStonithConfig, WebhookStonithConfig };

// ============================================
// Types
// ============================================

export interface VipConfig {
  name: string;
  ip: string;
  cidr: number;
  interface: string;
}

export interface HealthCheckConfig {
  type: 'http' | 'tcp' | 'systemd';
  target: string;
  intervalMs: number;
  timeoutMs: number;
  failuresBeforeUnhealthy: number;
  successesBeforeHealthy: number;
}

/**
 * Health check standalone (au niveau racine, pas lié à un service)
 */
export interface StandaloneHealthCheck {
  name: string;
  type: 'http' | 'tcp' | 'systemd';
  target: string;
  intervalMs: number;
  timeoutMs: number;
  failuresBeforeUnhealthy: number;
  successesBeforeHealthy: number;
}

export interface ServiceConfig {
  name: string;
  type: 'systemd';
  unit: string;
  healthcheck?: HealthCheckConfig;
}

export interface ColocationConstraint {
  type: 'colocation';
  resource: string;
  with: string;
}

export interface OrderConstraint {
  type: 'order';
  first: string;
  then: string;
}

export type Constraint = ColocationConstraint | OrderConstraint;

export interface SfhaConfig {
  cluster: {
    name: string;
    quorumRequired: boolean;
    failoverDelayMs: number;
    pollIntervalMs: number;
  };
  node: {
    name: string;
    priority: number;
  };
  vips: VipConfig[];
  services: ServiceConfig[];
  healthChecks: StandaloneHealthCheck[];
  constraints: Constraint[];
  stonith?: StonithConfig;
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

// ============================================
// Configuration par défaut
// ============================================

const defaultConfig: Partial<SfhaConfig> = {
  cluster: {
    name: 'sfha-cluster',
    quorumRequired: true,
    failoverDelayMs: 3000,
    pollIntervalMs: 2000,
  },
  node: {
    name: '',
    priority: 100,
  },
  vips: [],
  services: [],
  healthChecks: [],
  constraints: [],
  logging: {
    level: 'info',
  },
};

// ============================================
// Parsing
// ============================================

/**
 * Charge et parse la configuration YAML
 */
export function loadConfig(configPath: string = '/etc/sfha/config.yml'): SfhaConfig {
  if (!existsSync(configPath)) {
    throw new Error(t('error.configNotFound', { path: configPath }));
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const raw = parseYaml(content);
    
    return normalizeConfig(raw);
  } catch (error: any) {
    throw new Error(t('error.configInvalid', { error: error.message }));
  }
}

/**
 * Normalise et valide la configuration
 */
function normalizeConfig(raw: any): SfhaConfig {
  const config: SfhaConfig = {
    cluster: {
      name: raw.cluster?.name || defaultConfig.cluster!.name,
      quorumRequired: raw.cluster?.quorum_required ?? defaultConfig.cluster!.quorumRequired,
      failoverDelayMs: raw.cluster?.failover_delay_ms ?? defaultConfig.cluster!.failoverDelayMs,
      pollIntervalMs: raw.cluster?.poll_interval_ms ?? defaultConfig.cluster!.pollIntervalMs,
    },
    node: {
      name: raw.node?.name || '',
      priority: raw.node?.priority ?? defaultConfig.node!.priority,
    },
    vips: (raw.vips || []).map(normalizeVip),
    services: (raw.services || []).map(normalizeService),
    healthChecks: (raw.health_checks || []).map(normalizeStandaloneHealthCheck),
    constraints: (raw.constraints || []).map(normalizeConstraint),
    stonith: raw.stonith ? normalizeStonith(raw.stonith) : undefined,
    logging: {
      level: raw.logging?.level || defaultConfig.logging!.level,
    },
  };

  validateConfig(config);
  return config;
}

/**
 * Normalise la configuration STONITH
 */
function normalizeStonith(raw: any): StonithConfig {
  const config: StonithConfig = {
    enabled: raw.enabled ?? false,
    provider: raw.provider || 'proxmox',
    nodes: {},
    safety: {
      requireQuorum: raw.safety?.require_quorum ?? DEFAULT_STONITH_SAFETY.requireQuorum,
      minDelayBetweenFence: raw.safety?.min_delay_between_fence ?? DEFAULT_STONITH_SAFETY.minDelayBetweenFence,
      maxFencesPer5Min: raw.safety?.max_fences_per_5min ?? DEFAULT_STONITH_SAFETY.maxFencesPer5Min,
      startupGracePeriod: raw.safety?.startup_grace_period ?? DEFAULT_STONITH_SAFETY.startupGracePeriod,
      fenceDelayOnNodeLeft: raw.safety?.fence_delay_on_node_left ?? DEFAULT_STONITH_SAFETY.fenceDelayOnNodeLeft,
    },
  };

  // Parser la config Proxmox si présente
  if (raw.proxmox) {
    config.proxmox = {
      apiUrl: raw.proxmox.api_url,
      tokenId: raw.proxmox.token_id,
      tokenSecret: raw.proxmox.token_secret,
      tokenSecretFile: raw.proxmox.token_secret_file,
      verifySsl: raw.proxmox.verify_ssl ?? false,
      pveNode: raw.proxmox.pve_node || 'pve',
    };
  }

  // Parser la config Webhook si présente
  if (raw.webhook) {
    config.webhook = {
      fenceUrl: raw.webhook.fence_url,
      unfenceUrl: raw.webhook.unfence_url,
      statusUrl: raw.webhook.status_url,
      method: raw.webhook.method || 'POST',
      headers: raw.webhook.headers || {},
      bodyTemplate: raw.webhook.body_template,
      timeout: raw.webhook.timeout || 30,
      verifySsl: raw.webhook.verify_ssl ?? true,
    };
  }

  // Parser les nœuds
  if (raw.nodes) {
    for (const [name, nodeConfig] of Object.entries(raw.nodes as Record<string, any>)) {
      config.nodes[name] = {
        type: nodeConfig.type || 'lxc',
        vmid: nodeConfig.vmid,
      };
    }
  }

  return config;
}

function normalizeVip(raw: any): VipConfig {
  // Extraire IP et CIDR si l'IP contient déjà le CIDR (ex: "192.168.1.250/24")
  let ip = raw.ip;
  let cidr = raw.cidr || 24;
  
  if (ip && ip.includes('/')) {
    const parts = ip.split('/');
    ip = parts[0];
    // Utiliser le CIDR de l'IP seulement si pas défini explicitement
    if (!raw.cidr) {
      cidr = parseInt(parts[1], 10) || 24;
    }
  }
  
  return {
    name: raw.name,
    ip,
    cidr,
    interface: raw.interface || 'eth0',
  };
}

function normalizeService(raw: any): ServiceConfig {
  const service: ServiceConfig = {
    name: raw.name,
    type: raw.type || 'systemd',
    unit: raw.unit || raw.name,
  };

  if (raw.healthcheck) {
    service.healthcheck = {
      type: raw.healthcheck.type || 'tcp',
      target: raw.healthcheck.target,
      intervalMs: raw.healthcheck.interval_ms || 5000,
      timeoutMs: raw.healthcheck.timeout_ms || 2000,
      failuresBeforeUnhealthy: raw.healthcheck.failures_before_unhealthy || 3,
      successesBeforeHealthy: raw.healthcheck.successes_before_healthy || 2,
    };
  }

  return service;
}

/**
 * Normalise un health check standalone (snake_case -> camelCase)
 */
function normalizeStandaloneHealthCheck(raw: any): StandaloneHealthCheck {
  return {
    name: raw.name,
    type: raw.type || 'tcp',
    target: raw.target,
    // Support interval en secondes (snake_case) ou intervalMs
    intervalMs: raw.interval_ms || (raw.interval ? raw.interval * 1000 : 10000),
    timeoutMs: raw.timeout_ms || (raw.timeout ? raw.timeout * 1000 : 5000),
    failuresBeforeUnhealthy: raw.failures_before_unhealthy || 3,
    successesBeforeHealthy: raw.successes_before_healthy || 2,
  };
}

function normalizeConstraint(raw: any): Constraint {
  if (raw.type === 'colocation') {
    return {
      type: 'colocation',
      resource: raw.resource,
      with: raw.with,
    };
  } else {
    return {
      type: 'order',
      first: raw.first,
      then: raw.then,
    };
  }
}

/**
 * Valide la configuration
 */
function validateConfig(config: SfhaConfig): void {
  // Vérifier que le nom du nœud est défini
  if (!config.node.name) {
    throw new Error(t('error.configInvalid', { error: 'node.name est requis' }));
  }

  // Vérifier les VIPs
  for (const vip of config.vips) {
    if (!vip.name || !vip.ip) {
      throw new Error(t('error.configInvalid', { error: 'VIP invalide: name et ip requis' }));
    }
  }

  // Vérifier les services
  for (const service of config.services) {
    if (!service.name) {
      throw new Error(t('error.configInvalid', { error: 'Service invalide: name requis' }));
    }
  }

  // Vérifier les contraintes
  const resourceNames = new Set([
    ...config.vips.map(v => v.name),
    ...config.services.map(s => s.name),
  ]);

  for (const constraint of config.constraints) {
    if (constraint.type === 'colocation') {
      if (!resourceNames.has(constraint.resource)) {
        throw new Error(t('error.resourceNotFound', { name: constraint.resource }));
      }
      if (!resourceNames.has(constraint.with)) {
        throw new Error(t('error.resourceNotFound', { name: constraint.with }));
      }
    } else {
      if (!resourceNames.has(constraint.first)) {
        throw new Error(t('error.resourceNotFound', { name: constraint.first }));
      }
      if (!resourceNames.has(constraint.then)) {
        throw new Error(t('error.resourceNotFound', { name: constraint.then }));
      }
    }
  }
}

/**
 * Crée un exemple de configuration
 */
export function getExampleConfig(): string {
  return `# Configuration sfha
# Haute disponibilité légère pour Linux

cluster:
  name: mon-cluster
  quorum_required: true
  failover_delay_ms: 3000
  poll_interval_ms: 2000

# Identité de ce nœud (doit correspondre à Corosync)
node:
  name: ns1
  priority: 100

# VIP flottantes
vips:
  - name: vip-main
    ip: 192.168.1.250
    cidr: 24
    interface: eth0

# Services gérés
services:
  - name: nginx
    type: systemd
    unit: nginx
    healthcheck:
      type: http
      target: "http://127.0.0.1/health"
      interval_ms: 5000
      timeout_ms: 2000
      failures_before_unhealthy: 3
      successes_before_healthy: 2

# Contraintes
constraints:
  # nginx suit la VIP
  - type: colocation
    resource: nginx
    with: vip-main

  # VIP démarre avant nginx
  - type: order
    first: vip-main
    then: nginx

# Health checks standalone (pas liés à un service)
# Utile pour surveiller des dépendances externes
health_checks:
  - name: ssh
    type: tcp
    target: 127.0.0.1:22
    interval: 10        # secondes
    timeout: 5          # secondes
    failures_before_unhealthy: 3
    successes_before_healthy: 2
  
  # Exemple HTTP
  # - name: api-backend
  #   type: http
  #   target: "http://192.168.1.10:8080/health"
  #   interval: 15
  #   timeout: 3

# STONITH - Shoot The Other Node In The Head
# Permet d'éteindre un nœud défaillant pour éviter le split-brain
stonith:
  enabled: false  # Activer avec prudence !
  provider: proxmox
  
  proxmox:
    api_url: https://192.168.1.100:8006
    # Token format: user@realm!tokenid
    token_id: root@pam!sfha
    # Secret dans fichier séparé (recommandé)
    token_secret_file: /etc/sfha/proxmox.secret
    # Ou directement (moins secure)
    # token_secret: votre-secret-ici
    # Vérifier SSL (false pour certificats auto-signés)
    verify_ssl: false
    # Nom du nœud Proxmox (pas le guest)
    pve_node: pve
  
  # Alternative: Provider Webhook pour API externe
  # Décommentez et adaptez si vous utilisez webhook au lieu de proxmox
  # webhook:
  #   fence_url: https://api.example.com/fence
  #   unfence_url: https://api.example.com/unfence
  #   status_url: https://api.example.com/status/{{node}}  # optionnel
  #   method: POST
  #   headers:
  #     Authorization: Bearer your-token-here
  #     Content-Type: application/json
  #   body_template: '{"node": "{{node}}", "action": "{{action}}"}'
  #   timeout: 30
  #   verify_ssl: true
  
  # Mapping nœud sfha -> VM/CT Proxmox (requis pour proxmox, optionnel pour webhook)
  nodes:
    ns1:
      type: lxc  # ou qemu
      vmid: 210
    ns2:
      type: lxc
      vmid: 211
    ns3:
      type: lxc
      vmid: 212
  
  # Paramètres de sécurité (CRITIQUE)
  safety:
    # Exiger le quorum avant de fence
    require_quorum: true
    # Délai minimum entre deux fencing du même nœud (secondes)
    min_delay_between_fence: 60
    # Maximum de fencing en 5 minutes (storm detection)
    max_fences_per_5min: 2
    # Période de grâce après démarrage sfha (secondes)
    startup_grace_period: 120
    # Délai avant de fence un nœud qui quitte le cluster (secondes)
    # Permet d'éviter de fence sur un glitch réseau temporaire
    fence_delay_on_node_left: 10

logging:
  level: info
`;
}
