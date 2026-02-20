#!/usr/bin/env node
/**
 * @file cli.ts
 * @description CLI sfha avec Commander.js
 */

import { Command } from 'commander';
import { SfhaDaemon } from './daemon.js';
import { loadConfig, getExampleConfig } from './config.js';
import { getCorosyncState, getClusterNodes } from './corosync.js';
import { electLeader } from './election.js';
import { getVipsState } from './vip.js';
import { sendCommand, isDaemonRunning } from './control.js';
import { initI18n, t } from './i18n.js';
import { getMeshManager, isWireGuardInstalled } from './mesh/index.js';
import { isServiceActive } from './resources.js';
import { logger } from './utils/logger.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline';
import { execSync, spawn } from 'child_process';

// ============================================
// Version
// ============================================

const VERSION = '1.0.0';

function getVersion(): string {
  return VERSION;
}

// ============================================
// Helpers
// ============================================

function box(lines: string[], width = 40): string {
  const top = '╭' + '─'.repeat(width - 2) + '╮';
  const bottom = '╰' + '─'.repeat(width - 2) + '╯';
  const middle = lines.map(line => {
    const padded = line.padEnd(width - 4);
    return '│ ' + padded.slice(0, width - 4) + ' │';
  });
  return [top, ...middle, bottom].join('\n');
}

function colorize(text: string, color: 'green' | 'red' | 'yellow' | 'blue' | 'gray' | 'cyan' | 'bold'): string {
  const colors: Record<string, string> = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    gray: '\x1b[90m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
  };
  return `${colors[color]}${text}\x1b[0m`;
}

function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('fr-FR');
}

// ============================================
// Commands
// ============================================

async function statusCommand(options: { json?: boolean; config?: string; lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  try {
    // Si le daemon tourne, récupérer le statut via socket
    if (isDaemonRunning()) {
      const response = await sendCommand({ action: 'status' });
      
      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }
      
      if (response.success && response.data) {
        displayDaemonStatus(response.data);
        return;
      }
    }
    
    // Sinon, afficher le statut basique via Corosync
    const config = loadConfig(options.config);
    const corosync = getCorosyncState();
    const election = electLeader();
    const vips = getVipsState(config.vips);
    
    if (options.json) {
      console.log(JSON.stringify({
        cluster: config.cluster.name,
        node: config.node.name,
        daemonRunning: false,
        corosync: {
          running: corosync.running,
          quorate: corosync.quorum.quorate,
          nodes: corosync.nodes,
        },
        leader: election?.leaderName,
        isLeader: election?.isLocalLeader,
        vips,
      }, null, 2));
      return;
    }
    
    // Affichage formaté
    const version = getVersion();
    const daemonStatus = colorize('⚠️ daemon non actif', 'yellow');
    const state = corosync.running && corosync.quorum.quorate ? 
      colorize(t('status.active'), 'green') : 
      colorize(t('status.inactive'), 'red');
    const localRole = election?.isLocalLeader ? 
      colorize(t('status.leader'), 'green') : 
      colorize(t('status.standby'), 'yellow');
    const quorumStatus = corosync.quorum.quorate ? 
      colorize(t('status.quorumOk'), 'green') : 
      colorize(t('status.noQuorum'), 'red');
    
    console.log(box([
      `sfha v${version} - ${t('status.title')}`,
      '─'.repeat(36),
      `${t('status.cluster')}: ${config.cluster.name}`,
      `Daemon: ${daemonStatus}`,
      `${t('status.localNode')}: ${config.node.name} (${localRole})`,
      `${t('status.quorum')}: ${quorumStatus} (${corosync.nodes.filter(n => n.online).length}/${corosync.nodes.length} ${t('status.nodes')})`,
    ], 44));
    
    // Nœuds
    console.log('\n' + colorize('Nœuds:', 'blue'));
    for (const node of corosync.nodes) {
      const status = node.online ? 
        colorize('●', 'green') + ' ' + t('status.online') : 
        colorize('○', 'red') + ' ' + t('status.offline');
      const leader = election?.leaderName === node.name ? colorize(' (leader)', 'yellow') : '';
      console.log(`  ${status} ${node.name} (${node.ip})${leader}`);
    }
    
    // VIPs
    if (vips.length > 0) {
      console.log('\n' + colorize(t('status.vip') + ':', 'blue'));
      for (const vip of vips) {
        const status = vip.active ? 
          colorize('●', 'green') + ' ' + t('status.active') : 
          colorize('○', 'gray') + ' ' + t('status.inactive');
        console.log(`  ${status} ${vip.name}: ${vip.ip}/${vip.cidr} sur ${vip.interface}`);
      }
    }
    
    // Services
    if (config.services.length > 0) {
      console.log('\n' + colorize('Services:', 'blue'));
      for (const service of config.services) {
        // Import statique en haut du fichier
        const active = isServiceActive(service.unit);
        const status = active ? 
          colorize('●', 'green') + ' ' + t('status.active') : 
          colorize('○', 'red') + ' ' + t('status.inactive');
        console.log(`  ${status} ${service.name} (${service.unit})`);
      }
    }
    
  } catch (error: any) {
    console.error(colorize('Erreur:', 'red'), error.message);
    process.exit(1);
  }
}

function displayDaemonStatus(data: any): void {
  const version = data.version || getVersion();
  const daemonStatus = colorize('✓ daemon actif', 'green');
  const state = data.isLeader ? 
    colorize(t('status.leader'), 'green') : 
    data.standby ?
      colorize('standby', 'yellow') :
      colorize(t('status.standby'), 'gray');
  const quorumStatus = data.corosync.quorate ? 
    colorize(t('status.quorumOk'), 'green') : 
    colorize(t('status.noQuorum'), 'red');
  
  console.log(box([
    `sfha v${version} - ${t('status.title')}`,
    '─'.repeat(36),
    `${t('status.cluster')}: ${data.config.clusterName}`,
    `Daemon: ${daemonStatus}`,
    `${t('status.localNode')}: ${data.config.nodeName} (${state})`,
    `${t('status.quorum')}: ${quorumStatus} (${data.corosync.nodesOnline}/${data.corosync.nodesTotal} ${t('status.nodes')})`,
    `Leader: ${data.leaderName || 'aucun'}`,
  ], 44));
  
  // VIPs
  if (data.vips && data.vips.length > 0) {
    console.log('\n' + colorize('VIPs:', 'blue'));
    for (const vip of data.vips) {
      const status = vip.active ? 
        colorize('●', 'green') + ' ' + t('status.active') : 
        colorize('○', 'gray') + ' ' + t('status.inactive');
      console.log(`  ${status} ${vip.name}: ${vip.ip}/${vip.cidr} sur ${vip.interface}`);
    }
  }
  
  // Services
  if (data.services && data.services.length > 0) {
    console.log('\n' + colorize('Services:', 'blue'));
    for (const service of data.services) {
      const status = service.active ? 
        colorize('●', 'green') + ' ' + t('status.active') : 
        colorize('○', 'red') + ' ' + t('status.inactive');
      console.log(`  ${status} ${service.name}`);
    }
  }
  
  // Health checks
  if (data.health && Object.keys(data.health).length > 0) {
    console.log('\n' + colorize('Health Checks:', 'blue'));
    for (const [name, result] of Object.entries(data.health) as [string, any][]) {
      const status = result.healthy ? 
        colorize('●', 'green') + ' ' + t('status.healthy') : 
        colorize('●', 'red') + ' ' + t('status.unhealthy');
      const lastCheck = result.lastCheck ? ` (${formatDate(result.lastCheck)})` : '';
      const error = result.lastError ? colorize(` - ${result.lastError}`, 'red') : '';
      console.log(`  ${status} ${name}${lastCheck}${error}`);
    }
  }
}

async function runCommand(options: { config?: string; lang?: string; debug?: boolean }): Promise<void> {
  initI18n(options.lang);
  
  const daemon = new SfhaDaemon({
    configPath: options.config,
    lang: options.lang,
    debug: options.debug,
  });
  
  // Gestion des signaux
  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });
  
  process.on('SIGHUP', () => {
    daemon.reload();
  });
  
  process.on('SIGUSR1', () => {
    daemon.setStandby(true);
  });
  
  process.on('SIGUSR2', () => {
    daemon.setStandby(false);
  });
  
  try {
    await daemon.start();
    
    // Garder le processus en vie
    await new Promise(() => {});
  } catch (error: any) {
    console.error(colorize('Erreur:', 'red'), error.message);
    process.exit(1);
  }
}

function configCheckCommand(options: { config?: string; lang?: string }): void {
  initI18n(options.lang);
  
  try {
    const config = loadConfig(options.config);
    console.log(colorize('✓', 'green'), 'Configuration valide');
    console.log(`  Cluster: ${config.cluster.name}`);
    console.log(`  Nœud: ${config.node.name}`);
    console.log(`  VIPs: ${config.vips.length}`);
    console.log(`  Services: ${config.services.length}`);
    console.log(`  Contraintes: ${config.constraints.length}`);
  } catch (error: any) {
    console.error(colorize('✗', 'red'), 'Configuration invalide:', error.message);
    process.exit(1);
  }
}

function configExampleCommand(): void {
  console.log(getExampleConfig());
}

function constraintsCommand(options: { config?: string; lang?: string }): void {
  initI18n(options.lang);
  
  try {
    const config = loadConfig(options.config);
    
    const colocations = config.constraints.filter(c => c.type === 'colocation');
    const orders = config.constraints.filter(c => c.type === 'order');
    
    if (colocations.length > 0) {
      console.log(colorize('Colocation:', 'blue'));
      for (const c of colocations) {
        if (c.type === 'colocation') {
          console.log(`  ${c.resource} → ${c.with}`);
        }
      }
    }
    
    if (orders.length > 0) {
      console.log(colorize('Ordre:', 'blue'));
      const chain: string[] = [];
      for (const c of orders) {
        if (c.type === 'order') {
          if (chain.length === 0 || chain[chain.length - 1] === c.first) {
            if (!chain.includes(c.first)) chain.push(c.first);
            chain.push(c.then);
          }
        }
      }
      if (chain.length > 0) {
        console.log(`  ${chain.join(' → ')}`);
      }
    }
    
    if (config.constraints.length === 0) {
      console.log(colorize('Aucune contrainte configurée', 'gray'));
    }
  } catch (error: any) {
    console.error(colorize('Erreur:', 'red'), error.message);
    process.exit(1);
  }
}

async function resourcesCommand(options: { json?: boolean; config?: string; lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  try {
    // Via socket si daemon actif
    if (isDaemonRunning()) {
      const response = await sendCommand({ action: 'resources' });
      
      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }
      
      if (response.success && response.data) {
        console.log(colorize('VIPs:', 'blue'));
        for (const vip of response.data.vips) {
          const status = vip.active ? 
            colorize('●', 'green') + ' actif' : 
            colorize('○', 'gray') + ' inactif';
          console.log(`  ${status} ${vip.name}: ${vip.ip}/${vip.cidr} sur ${vip.interface}`);
        }
        
        console.log('\n' + colorize('Services:', 'blue'));
        for (const svc of response.data.services) {
          const status = svc.active ? 
            colorize('●', 'green') + ' actif' : 
            colorize('○', 'red') + ' inactif';
          console.log(`  ${status} ${svc.name}`);
        }
        return;
      }
    }
    
    // Sinon via config
    const config = loadConfig(options.config);
    const vips = getVipsState(config.vips);
    
    if (options.json) {
      // Import statique en haut du fichier
      const services = config.services.map(s => ({
        name: s.name,
        unit: s.unit,
        active: isServiceActive(s.unit),
      }));
      console.log(JSON.stringify({ vips, services }, null, 2));
      return;
    }
    
    console.log(colorize('VIPs:', 'blue'));
    for (const vip of vips) {
      const status = vip.active ? 
        colorize('●', 'green') + ' actif' : 
        colorize('○', 'gray') + ' inactif';
      console.log(`  ${status} ${vip.name}: ${vip.ip}/${vip.cidr} sur ${vip.interface}`);
    }
    
    console.log('\n' + colorize('Services:', 'blue'));
    // Import statique en haut du fichier
    for (const service of config.services) {
      const active = isServiceActive(service.unit);
      const status = active ? 
        colorize('●', 'green') + ' actif' : 
        colorize('○', 'red') + ' inactif';
      console.log(`  ${status} ${service.name} (${service.unit})`);
    }
    
  } catch (error: any) {
    console.error(colorize('Erreur:', 'red'), error.message);
    process.exit(1);
  }
}

async function healthCommand(options: { json?: boolean; lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  if (!isDaemonRunning()) {
    console.error(colorize('Erreur:', 'red'), 'Le daemon sfha n\'est pas en cours d\'exécution');
    process.exit(1);
  }
  
  const response = await sendCommand({ action: 'health' });
  
  if (options.json) {
    console.log(JSON.stringify(response.data, null, 2));
    return;
  }
  
  if (response.success && response.data) {
    const health = response.data;
    
    if (Object.keys(health).length === 0) {
      console.log(colorize('Aucun health check configuré', 'gray'));
      return;
    }
    
    console.log(colorize('Health Checks:', 'blue'));
    for (const [name, result] of Object.entries(health) as [string, any][]) {
      const status = result.healthy ? 
        colorize('●', 'green') + ' sain' : 
        colorize('●', 'red') + ' défaillant';
      console.log(`\n  ${status} ${colorize(name, 'bold')}`);
      console.log(`    Dernier check: ${formatDate(result.lastCheck)}`);
      console.log(`    Échecs consécutifs: ${result.consecutiveFailures}`);
      console.log(`    Succès consécutifs: ${result.consecutiveSuccesses}`);
      if (result.lastError) {
        console.log(`    Dernière erreur: ${colorize(result.lastError, 'red')}`);
      }
    }
  } else {
    console.error(colorize('Erreur:', 'red'), response.error);
    process.exit(1);
  }
}

async function standbyCommand(options: { lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  if (!isDaemonRunning()) {
    console.error(colorize('Erreur:', 'red'), 'Le daemon sfha n\'est pas en cours d\'exécution');
    console.log('Utilisez: systemctl start sfha');
    process.exit(1);
  }
  
  const response = await sendCommand({ action: 'standby' });
  
  if (response.success) {
    console.log(colorize('✓', 'green'), response.message);
  } else {
    console.error(colorize('✗', 'red'), response.error);
    process.exit(1);
  }
}

async function unstandbyCommand(options: { lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  if (!isDaemonRunning()) {
    console.error(colorize('Erreur:', 'red'), 'Le daemon sfha n\'est pas en cours d\'exécution');
    console.log('Utilisez: systemctl start sfha');
    process.exit(1);
  }
  
  const response = await sendCommand({ action: 'unstandby' });
  
  if (response.success) {
    console.log(colorize('✓', 'green'), response.message);
  } else {
    console.error(colorize('✗', 'red'), response.error);
    process.exit(1);
  }
}

async function failoverCommand(options: { to?: string; lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  if (!isDaemonRunning()) {
    console.error(colorize('Erreur:', 'red'), 'Le daemon sfha n\'est pas en cours d\'exécution');
    console.log('Utilisez: systemctl start sfha');
    process.exit(1);
  }
  
  const response = await sendCommand({
    action: 'failover',
    params: { targetNode: options.to },
  });
  
  if (response.success) {
    console.log(colorize('✓', 'green'), response.message);
  } else {
    console.error(colorize('✗', 'red'), response.error);
    process.exit(1);
  }
}

async function reloadCommand(options: { lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  if (!isDaemonRunning()) {
    console.error(colorize('Erreur:', 'red'), 'Le daemon sfha n\'est pas en cours d\'exécution');
    console.log('Utilisez: systemctl start sfha');
    process.exit(1);
  }
  
  const response = await sendCommand({ action: 'reload' });
  
  if (response.success) {
    console.log(colorize('✓', 'green'), response.message);
  } else {
    console.error(colorize('✗', 'red'), response.error);
    process.exit(1);
  }
}

// ============================================
// STONITH Commands
// ============================================

async function stonithStatusCommand(options: { json?: boolean; lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  if (!isDaemonRunning()) {
    console.error(colorize('Erreur:', 'red'), 'Le daemon sfha n\'est pas en cours d\'exécution');
    process.exit(1);
  }
  
  const response = await sendCommand({ action: 'stonith-status' });
  
  if (options.json) {
    console.log(JSON.stringify(response.data, null, 2));
    return;
  }
  
  if (response.success && response.data) {
    const status = response.data;
    
    if (!status.enabled) {
      console.log(colorize('STONITH désactivé', 'gray'));
      if (status.reason) {
        console.log(`  Raison: ${status.reason}`);
      }
      return;
    }
    
    console.log(box([
      'STONITH Status',
      '─'.repeat(36),
      `Provider: ${status.provider}`,
      `API: ${status.apiConnected ? colorize('connectée', 'green') : colorize('déconnectée', 'red')}`,
      `Quorum requis: ${status.safety.requireQuorum ? 'oui' : 'non'}`,
      `En grâce: ${status.safety.inStartupGrace ? colorize('oui', 'yellow') : 'non'}`,
      `Fences récents: ${status.safety.recentFences}`,
    ], 44));
    
    // Nœuds
    if (status.nodes && status.nodes.length > 0) {
      console.log('\n' + colorize('Nœuds configurés:', 'blue'));
      for (const node of status.nodes) {
        const powerIcon = node.powerState === 'on' ? colorize('●', 'green') :
                          node.powerState === 'off' ? colorize('○', 'red') :
                          colorize('?', 'yellow');
        const lastFence = node.lastFence ? ` (dernier fence: ${new Date(node.lastFence).toLocaleString('fr-FR')})` : '';
        console.log(`  ${powerIcon} ${node.name} (${node.type}/${node.vmid})${lastFence}`);
      }
    }
  } else {
    console.error(colorize('Erreur:', 'red'), response.error);
    process.exit(1);
  }
}

async function stonithFenceCommand(node: string, options: { yes?: boolean; lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  if (!isDaemonRunning()) {
    console.error(colorize('Erreur:', 'red'), 'Le daemon sfha n\'est pas en cours d\'exécution');
    process.exit(1);
  }
  
  // Confirmation si pas --yes
  if (!options.yes) {
    console.log(colorize('⚠️  ATTENTION', 'red'));
    console.log(`Vous êtes sur le point d'éteindre de force le nœud: ${colorize(node, 'bold')}`);
    console.log('Cette action est IRRÉVERSIBLE et peut causer une perte de données.\n');
    
    // Import statique en haut du fichier
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Tapez "${node}" pour confirmer: `, resolve);
    });
    rl.close();
    
    if (answer !== node) {
      console.log('Opération annulée.');
      process.exit(0);
    }
  }
  
  console.log(`🔴 Fencing de ${node}...`);
  
  const response = await sendCommand({
    action: 'stonith-fence',
    params: { node },
  });
  
  if (response.success && response.data) {
    const result = response.data;
    if (result.success) {
      console.log(colorize('✓', 'green'), `${node} a été fencé avec succès`);
      if (result.duration) {
        console.log(`  Durée: ${result.duration}ms`);
      }
    } else {
      console.log(colorize('⚠️', 'yellow'), `Fence skipped: ${result.reason}`);
    }
  } else {
    console.error(colorize('✗', 'red'), response.error);
    process.exit(1);
  }
}

async function stonithUnfenceCommand(node: string, options: { lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  if (!isDaemonRunning()) {
    console.error(colorize('Erreur:', 'red'), 'Le daemon sfha n\'est pas en cours d\'exécution');
    process.exit(1);
  }
  
  console.log(`🟢 Démarrage de ${node}...`);
  
  const response = await sendCommand({
    action: 'stonith-unfence',
    params: { node },
  });
  
  if (response.success && response.data) {
    const result = response.data;
    if (result.success) {
      console.log(colorize('✓', 'green'), `${node} a été démarré avec succès`);
      if (result.duration) {
        console.log(`  Durée: ${result.duration}ms`);
      }
    } else {
      console.log(colorize('✗', 'red'), `Échec: ${result.reason}`);
    }
  } else {
    console.error(colorize('✗', 'red'), response.error);
    process.exit(1);
  }
}

async function stonithHistoryCommand(options: { json?: boolean; limit?: number; lang?: string }): Promise<void> {
  initI18n(options.lang);
  
  if (!isDaemonRunning()) {
    console.error(colorize('Erreur:', 'red'), 'Le daemon sfha n\'est pas en cours d\'exécution');
    process.exit(1);
  }
  
  const response = await sendCommand({ action: 'stonith-history' });
  
  if (options.json) {
    console.log(JSON.stringify(response.data, null, 2));
    return;
  }
  
  if (response.success && response.data) {
    const history = response.data as any[];
    
    if (history.length === 0) {
      console.log(colorize('Aucun historique de fencing', 'gray'));
      return;
    }
    
    const limit = options.limit || 20;
    const entries = history.slice(-limit).reverse();
    
    console.log(colorize('Historique STONITH:', 'blue'));
    console.log('');
    
    for (const entry of entries) {
      const icon = entry.action === 'power_off' ? '🔴' : '🟢';
      const status = entry.success ? colorize('✓', 'green') : colorize('✗', 'red');
      const time = new Date(entry.timestamp).toLocaleString('fr-FR');
      const initiator = entry.initiatedBy === 'manual' ? colorize('[manuel]', 'cyan') : '[auto]';
      
      console.log(`${icon} ${status} ${entry.node} - ${entry.action} ${initiator}`);
      console.log(`   ${colorize(time, 'gray')} - ${entry.reason} (${entry.duration}ms)`);
    }
    
    if (history.length > limit) {
      console.log(colorize(`\n... ${history.length - limit} entrées plus anciennes non affichées`, 'gray'));
    }
  } else {
    console.error(colorize('Erreur:', 'red'), response.error);
    process.exit(1);
  }
}

// ============================================
// Main
// ============================================

const program = new Command();

program
  .name('sfha')
  .description('Système de haute disponibilité léger')
  .version(getVersion(), '-v, --version', 'Afficher la version')
  .option('--lang <lang>', 'Langue (fr/en)', 'fr')
  .option('--verbose', 'Activer les logs de debug')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) {
      logger.setLevel('debug');
    }
  });

program
  .command('status')
  .description('Afficher le statut du cluster')
  .option('-j, --json', 'Sortie JSON')
  .option('-c, --config <path>', 'Chemin de la configuration', '/etc/sfha/config.yml')
  .action(statusCommand);

program
  .command('run')
  .description('Démarrer le démon sfha (foreground)')
  .option('-c, --config <path>', 'Chemin de la configuration', '/etc/sfha/config.yml')
  .option('-d, --debug', 'Mode debug')
  .action(runCommand);

program
  .command('config-check')
  .description('Vérifier la configuration')
  .option('-c, --config <path>', 'Chemin de la configuration', '/etc/sfha/config.yml')
  .action(configCheckCommand);

program
  .command('config-example')
  .description('Afficher un exemple de configuration')
  .action(configExampleCommand);

program
  .command('constraints')
  .description('Afficher les contraintes configurées')
  .option('-c, --config <path>', 'Chemin de la configuration', '/etc/sfha/config.yml')
  .action(constraintsCommand);

program
  .command('resources')
  .description('Lister les ressources')
  .option('-j, --json', 'Sortie JSON')
  .option('-c, --config <path>', 'Chemin de la configuration', '/etc/sfha/config.yml')
  .action(resourcesCommand);

program
  .command('health')
  .description('Afficher l\'état des health checks')
  .option('-j, --json', 'Sortie JSON')
  .action(healthCommand);

program
  .command('standby')
  .description('Mettre ce nœud en standby')
  .action(standbyCommand);

program
  .command('unstandby')
  .description('Sortir ce nœud du mode standby')
  .action(unstandbyCommand);

program
  .command('failover')
  .description('Forcer un basculement')
  .option('--to <node>', 'Nœud cible')
  .action(failoverCommand);

program
  .command('reload')
  .description('Recharger la configuration')
  .action(reloadCommand);

// ============================================
// STONITH Subcommands
// ============================================

const stonith = program
  .command('stonith')
  .description('Gestion STONITH (Shoot The Other Node In The Head)');

stonith
  .command('status')
  .description('État du STONITH et test de connexion API')
  .option('-j, --json', 'Sortie JSON')
  .action(stonithStatusCommand);

stonith
  .command('fence <node>')
  .description('Éteindre un nœud de force (DANGEREUX)')
  .option('-y, --yes', 'Pas de confirmation')
  .action(stonithFenceCommand);

stonith
  .command('unfence <node>')
  .description('Rallumer un nœud')
  .action(stonithUnfenceCommand);

stonith
  .command('history')
  .description('Historique des opérations STONITH')
  .option('-j, --json', 'Sortie JSON')
  .option('-n, --limit <n>', 'Nombre d\'entrées', '20')
  .action((options) => stonithHistoryCommand({ ...options, limit: parseInt(options.limit) }));

// ============================================
// Init Command
// ============================================

program
  .command('init')
  .description('Initialiser un nouveau cluster')
  .requiredOption('--name <name>', 'Nom du cluster')
  .option('--mesh', 'Activer le mesh WireGuard')
  .option('--ip <ip>', 'IP mesh locale avec CIDR (ex: 10.100.0.1/24)')
  .option('--port <port>', 'Port WireGuard (défaut: 51820)', '51820')
  .option('--endpoint <endpoint>', 'Endpoint public (auto-détecté si absent)')
  .action(initCommand);

async function initCommand(options: {
  name: string;
  mesh?: boolean;
  ip?: string;
  port?: string;
  endpoint?: string;
  lang?: string;
}): Promise<void> {
  initI18n(options.lang);

  if (options.mesh) {
    // Initialisation avec mesh WireGuard
    if (!options.ip) {
      console.error(colorize('Erreur:', 'red'), '--ip est requis avec --mesh (ex: --ip 10.100.0.1/24)');
      process.exit(1);
    }

    if (!isWireGuardInstalled()) {
      console.error(colorize('Erreur:', 'red'), 'WireGuard n\'est pas installé.');
      console.error('  Installez-le avec: apt install wireguard-tools');
      process.exit(1);
    }

    const mesh = getMeshManager();
    const result = await mesh.init({
      clusterName: options.name,
      meshIp: options.ip,
      port: parseInt(options.port || '51820', 10),
      endpoint: options.endpoint,
    });

    if (!result.success) {
      console.error(colorize('Erreur:', 'red'), result.error);
      process.exit(1);
    }

    console.log(colorize('✓', 'green'), result.message);
    console.log('');
    console.log(colorize('Token de join:', 'blue'));
    console.log('');
    console.log(colorize(result.token!, 'cyan'));
    console.log('');
    console.log('Pour ajouter un nœud au cluster, exécutez sur le nouveau nœud:');
    console.log(`  sfha join ${result.token}`);
    console.log('');
    console.log(colorize('Note:', 'yellow'), 'Configurez /etc/sfha/config.yml puis démarrez sfha.');
  } else {
    // Initialisation sans mesh (juste créer la config)
    console.log(colorize('✓', 'green'), `Cluster "${options.name}" initialisé.`);
    console.log('');
    console.log('Créez /etc/sfha/config.yml avec:');
    console.log('  sfha config-example > /etc/sfha/config.yml');
    console.log('');
    console.log('Puis configurez Corosync manuellement ou utilisez --mesh pour un mesh automatique.');
  }
}

// ============================================
// Join Command
// ============================================

program
  .command('join <token>')
  .description('Rejoindre un cluster existant via token')
  .option('--endpoint <endpoint>', 'Endpoint public (auto-détecté si absent)')
  .option('--ip <ip>', 'IP mesh spécifique (auto-allouée si absent)')
  .action(joinCommand);

async function joinCommand(token: string, options: { endpoint?: string; ip?: string; lang?: string }): Promise<void> {
  initI18n(options.lang);

  if (!isWireGuardInstalled()) {
    console.error(colorize('Erreur:', 'red'), 'WireGuard n\'est pas installé.');
    console.error('  Installez-le avec: apt install wireguard-tools');
    process.exit(1);
  }

  const mesh = getMeshManager();
  const result = await mesh.join({
    token,
    endpoint: options.endpoint,
    meshIp: options.ip,
  });

  if (!result.success) {
    console.error(colorize('Erreur:', 'red'), result.error);
    process.exit(1);
  }

  console.log(colorize('✓', 'green'), result.message);
  console.log('');
  console.log(colorize('Prochaines étapes:', 'blue'));
  console.log('  1. Configurez /etc/sfha/config.yml (copiez du premier nœud)');
  console.log('  2. Sur le premier nœud, ajoutez ce peer:');
  
  const meshConfig = mesh.getConfig();
  if (meshConfig) {
    console.log(`     sfha mesh add-peer --name <nom> --pubkey ${meshConfig.publicKey} --endpoint <votre-ip>:${meshConfig.listenPort} --mesh-ip ${meshConfig.meshIp.split('/')[0]}`);
  }
  
  console.log('  3. Démarrez sfha sur ce nœud');
}

// ============================================
// Mesh Subcommands
// ============================================

const meshCmd = program
  .command('mesh')
  .description('Gestion du mesh WireGuard');

meshCmd
  .command('status')
  .description('Afficher l\'état du mesh')
  .option('-j, --json', 'Sortie JSON')
  .action(meshStatusCommand);

async function meshStatusCommand(options: { json?: boolean; lang?: string }): Promise<void> {
  initI18n(options.lang);

  const mesh = getMeshManager();
  const status = mesh.getStatus();

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!mesh.isConfigured()) {
    console.log(colorize('Aucun mesh configuré', 'gray'));
    console.log('Initialisez avec: sfha init --name <cluster> --mesh --ip <ip/cidr>');
    return;
  }

  const config = mesh.getConfig()!;
  const activeStatus = status.active
    ? colorize('● actif', 'green')
    : colorize('○ inactif', 'red');

  console.log(box([
    `sfha mesh - ${config.clusterName}`,
    '─'.repeat(36),
    `Interface: ${status.interface}`,
    `État: ${activeStatus}`,
    `IP locale: ${status.localIp}`,
    `Port: ${status.listenPort}`,
    `Clé publique: ${status.publicKey.slice(0, 20)}...`,
  ], 44));

  if (status.peers.length === 0) {
    console.log('\n' + colorize('Aucun peer configuré', 'gray'));
    return;
  }

  console.log('\n' + colorize('Peers:', 'blue'));
  for (const peer of status.peers) {
    const connStatus = peer.connected
      ? colorize('●', 'green') + ' connecté'
      : colorize('○', 'red') + ' déconnecté';
    const handshake = peer.latestHandshake
      ? `(dernier handshake: ${formatRelativeTime(peer.latestHandshake)})`
      : '';
    const transfer = peer.transferRx !== undefined
      ? `↓${formatBytes(peer.transferRx)} ↑${formatBytes(peer.transferTx || 0)}`
      : '';

    console.log(`  ${connStatus} ${peer.name} (${peer.ip})`);
    if (peer.endpoint) {
      console.log(`    Endpoint: ${peer.endpoint}`);
    }
    if (handshake) {
      console.log(`    ${colorize(handshake, 'gray')}`);
    }
    if (transfer) {
      console.log(`    Transfert: ${transfer}`);
    }
  }
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  
  if (diffSeconds < 60) return `il y a ${diffSeconds}s`;
  if (diffSeconds < 3600) return `il y a ${Math.floor(diffSeconds / 60)}min`;
  if (diffSeconds < 86400) return `il y a ${Math.floor(diffSeconds / 3600)}h`;
  return `il y a ${Math.floor(diffSeconds / 86400)}j`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

meshCmd
  .command('token')
  .description('Générer un token de join')
  .option('--ip <ip>', 'IP à assigner au nouveau nœud')
  .action(meshTokenCommand);

async function meshTokenCommand(options: { ip?: string; lang?: string }): Promise<void> {
  initI18n(options.lang);

  const mesh = getMeshManager();
  const result = mesh.generateToken(options.ip);

  if (!result.success) {
    console.error(colorize('Erreur:', 'red'), result.error);
    process.exit(1);
  }

  console.log(colorize('Token de join:', 'blue'));
  console.log('');
  console.log(result.token);
  console.log('');
  console.log('Sur le nouveau nœud, exécutez:');
  console.log(`  sfha join ${result.token}`);
}

meshCmd
  .command('up')
  .description('Démarrer l\'interface mesh')
  .action(meshUpCommand);

async function meshUpCommand(options: { lang?: string }): Promise<void> {
  initI18n(options.lang);

  const mesh = getMeshManager();
  const result = mesh.up();

  if (!result.success) {
    console.error(colorize('Erreur:', 'red'), result.error);
    process.exit(1);
  }

  console.log(colorize('✓', 'green'), result.message);
}

meshCmd
  .command('down')
  .description('Arrêter l\'interface mesh')
  .action(meshDownCommand);

async function meshDownCommand(options: { lang?: string }): Promise<void> {
  initI18n(options.lang);

  const mesh = getMeshManager();
  const result = mesh.down();

  if (!result.success) {
    console.error(colorize('Erreur:', 'red'), result.error);
    process.exit(1);
  }

  console.log(colorize('✓', 'green'), result.message);
}

meshCmd
  .command('add-peer')
  .description('Ajouter un peer au mesh')
  .requiredOption('--name <name>', 'Nom du peer')
  .requiredOption('--pubkey <key>', 'Clé publique WireGuard')
  .requiredOption('--endpoint <endpoint>', 'Endpoint (ip:port)')
  .requiredOption('--mesh-ip <ip>', 'IP mesh du peer')
  .action(meshAddPeerCommand);

async function meshAddPeerCommand(options: {
  name: string;
  pubkey: string;
  endpoint: string;
  meshIp: string;
  lang?: string;
}): Promise<void> {
  initI18n(options.lang);

  const mesh = getMeshManager();
  const result = mesh.addPeer({
    name: options.name,
    publicKey: options.pubkey,
    endpoint: options.endpoint,
    allowedIps: options.meshIp.includes('/') ? options.meshIp : `${options.meshIp}/32`,
  });

  if (!result.success) {
    console.error(colorize('Erreur:', 'red'), result.error);
    process.exit(1);
  }

  console.log(colorize('✓', 'green'), result.message);
}

meshCmd
  .command('remove-peer <name>')
  .description('Supprimer un peer du mesh')
  .action(meshRemovePeerCommand);

async function meshRemovePeerCommand(name: string, options: { lang?: string }): Promise<void> {
  initI18n(options.lang);

  const mesh = getMeshManager();
  const result = mesh.removePeerByName(name);

  if (!result.success) {
    console.error(colorize('Erreur:', 'red'), result.error);
    process.exit(1);
  }

  console.log(colorize('✓', 'green'), result.message);
}

// ============================================
// Logs Command
// ============================================

program
  .command('logs')
  .description('Afficher les logs du daemon sfha (via journald)')
  .option('-f, --follow', 'Suivre les logs en temps réel')
  .option('-n, --lines <n>', 'Nombre de lignes à afficher', '50')
  .option('--since <time>', 'Depuis quand (ex: "1h ago", "today")')
  .option('--until <time>', 'Jusqu\'à quand')
  .option('-p, --priority <level>', 'Niveau de priorité (debug, info, warning, err)')
  .option('--no-pager', 'Désactiver le pager')
  .option('-o, --output <format>', 'Format de sortie (short, verbose, json)', 'short')
  .action(logsCommand);

async function logsCommand(options: {
  follow?: boolean;
  lines?: string;
  since?: string;
  until?: string;
  priority?: string;
  pager?: boolean;
  output?: string;
}): Promise<void> {
  // Vérifier que journalctl est disponible
  try {
    execSync('which journalctl', { stdio: 'ignore' });
  } catch {
    console.error(colorize('Erreur:', 'red'), 'journalctl non disponible. Ce système n\'utilise pas systemd.');
    process.exit(1);
  }

  // Construire la commande journalctl
  const args: string[] = ['-u', 'sfha'];

  if (options.follow) {
    args.push('-f');
  }

  if (options.lines && !options.follow) {
    args.push('-n', options.lines);
  }

  if (options.since) {
    args.push('--since', options.since);
  }

  if (options.until) {
    args.push('--until', options.until);
  }

  if (options.priority) {
    // Mapper les niveaux sfha vers syslog
    const priorityMap: Record<string, string> = {
      debug: '7',
      info: '6',
      warning: '4',
      warn: '4',
      error: '3',
      err: '3',
    };
    const prio = priorityMap[options.priority.toLowerCase()] || options.priority;
    args.push('-p', prio);
  }

  if (options.pager === false) {
    args.push('--no-pager');
  }

  if (options.output) {
    args.push('-o', options.output);
  }

  // Exécuter journalctl
  const proc = spawn('journalctl', args, {
    stdio: 'inherit',
  });

  proc.on('error', (err) => {
    console.error(colorize('Erreur:', 'red'), err.message);
    process.exit(1);
  });

  proc.on('exit', (code) => {
    process.exit(code || 0);
  });
}

program.parse();
