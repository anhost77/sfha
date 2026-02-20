/**
 * @file i18n.ts
 * @description Internationalisation FR/EN pour sfha
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Support ESM et CJS
function getCurrentDir(): string {
  // ESM
  try {
    // @ts-ignore - import.meta peut ne pas exister en CJS
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      // @ts-ignore
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {}
  
  // CJS
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  
  // Fallback
  return process.cwd();
}

const __dirname_cjs = getCurrentDir();

type Messages = Record<string, string>;

let currentLang = 'fr';
let messages: Messages = {};

// Messages par défaut (français)
const defaultMessages: Messages = {
  // CLI
  'cli.description': 'Système de haute disponibilité léger',
  'cli.version': 'Afficher la version',
  'cli.lang': 'Langue (fr/en)',
  
  // Status
  'status.title': 'sfha - Haute Disponibilité',
  'status.cluster': 'Cluster',
  'status.state': 'État',
  'status.localNode': 'Nœud local',
  'status.quorum': 'Quorum',
  'status.leader': 'leader',
  'status.standby': 'standby',
  'status.active': 'actif',
  'status.inactive': 'inactif',
  'status.nodes': 'nœuds',
  'status.online': 'en ligne',
  'status.offline': 'hors ligne',
  'status.resources': 'Ressources',
  'status.vip': 'VIP',
  'status.service': 'Service',
  'status.healthy': 'sain',
  'status.unhealthy': 'défaillant',
  'status.noQuorum': 'PAS DE QUORUM',
  'status.quorumOk': 'OK',
  
  // Actions
  'action.failover': 'Basculement',
  'action.failoverTo': 'Basculement vers {node}',
  'action.failoverInitiated': 'Basculement initié vers {node}',
  'action.failoverFailed': 'Échec du basculement: {error}',
  'action.standbyOn': 'Mise en standby du nœud {node}',
  'action.standbyOff': 'Réactivation du nœud {node}',
  'action.reload': 'Rechargement de la configuration',
  'action.reloaded': 'Configuration rechargée',
  
  // Daemon
  'daemon.starting': 'Démarrage du démon sfha...',
  'daemon.started': 'Démon sfha démarré',
  'daemon.stopping': 'Arrêt du démon sfha...',
  'daemon.stopped': 'Démon sfha arrêté',
  'daemon.waitingQuorum': 'En attente du quorum...',
  'daemon.quorumAcquired': 'Quorum acquis',
  'daemon.electionWon': 'Ce nœud est maintenant le leader',
  'daemon.electionLost': 'Leader élu: {node}',
  
  // VIP
  'vip.adding': 'Ajout de la VIP {ip} sur {iface}',
  'vip.added': 'VIP {ip} ajoutée',
  'vip.removing': 'Suppression de la VIP {ip}',
  'vip.removed': 'VIP {ip} supprimée',
  'vip.alreadyPresent': 'VIP {ip} déjà présente',
  'vip.notPresent': 'VIP {ip} non présente',
  
  // Health
  'health.checking': 'Vérification de {resource}',
  'health.passed': '{resource} est sain',
  'health.failed': '{resource} a échoué: {error}',
  'health.failoverTriggered': 'Basculement déclenché suite à l\'échec de {resource}',
  
  // Corosync
  'corosync.notRunning': 'Corosync n\'est pas en cours d\'exécution',
  'corosync.checkingQuorum': 'Vérification du quorum...',
  'corosync.nodesOnline': '{count} nœud(s) en ligne',
  
  // Errors
  'error.configNotFound': 'Fichier de configuration non trouvé: {path}',
  'error.configInvalid': 'Configuration invalide: {error}',
  'error.corosyncUnavailable': 'Corosync non disponible',
  'error.notLeader': 'Ce nœud n\'est pas le leader',
  'error.resourceNotFound': 'Ressource non trouvée: {name}',
  'error.commandFailed': 'Commande échouée: {cmd}',
  'error.daemonNotRunning': 'Le daemon sfha n\'est pas en cours d\'exécution',
};

/**
 * Initialise l'i18n avec la langue spécifiée
 */
export function initI18n(lang?: string): void {
  // Priorité: paramètre > env > défaut (fr)
  currentLang = lang || process.env.SFHA_LANG || 'fr';
  
  // Charger les messages
  try {
    // Chemins possibles pour les locales
    const possiblePaths = [
      // pkg snapshot (binaire standalone)
      '/snapshot/sfha/locales',
      // Installation système
      '/usr/lib/sfha/locales',
      // Variable d'environnement
      process.env.SFHA_LOCALES_DIR,
      // Développement (relatif au répertoire du script)
      join(__dirname_cjs, '..', 'locales'),
      join(__dirname_cjs, 'locales'),
      // Répertoire courant
      join(process.cwd(), 'locales'),
    ].filter(Boolean) as string[];
    
    for (const dir of possiblePaths) {
      const localePath = join(dir, `${currentLang}.json`);
      if (existsSync(localePath)) {
        messages = JSON.parse(readFileSync(localePath, 'utf-8'));
        return;
      }
    }
    
    // Fallback aux messages par défaut
    messages = defaultMessages;
  } catch {
    // En cas d'erreur, utiliser les messages par défaut
    messages = defaultMessages;
  }
}

/**
 * Récupère un message traduit
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let message = messages[key] || defaultMessages[key] || key;
  
  // Remplacer les paramètres {param}
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      message = message.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  
  return message;
}

/**
 * Récupère la langue courante
 */
export function getLang(): string {
  return currentLang;
}

// Initialiser avec les valeurs par défaut
initI18n();
