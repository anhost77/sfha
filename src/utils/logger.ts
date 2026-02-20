/**
 * @file utils/logger.ts
 * @description Logger centralisé pour sfha - compatible journald
 * 
 * Le logger écrit sur stdout/stderr pour que journald capture automatiquement.
 * Pas d'écriture fichier directe pour éviter les I/O inutiles.
 * 
 * Utilisation :
 *   import { logger, setLogLevel } from './utils/logger.js';
 *   logger.info('Démarrage du daemon');
 *   logger.debug('Détail technique');
 *   logger.warn('Attention');
 *   logger.error('Erreur critique');
 */

// ============================================
// Types
// ============================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  /** Niveau de log minimum (défaut: 'info') */
  level?: LogLevel;
  /** Activer les couleurs (défaut: auto-détecté) */
  colors?: boolean;
  /** Préfixe pour tous les messages */
  prefix?: string;
}

// ============================================
// Constants
// ============================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',   // Gris
  info: '\x1b[36m',    // Cyan
  warn: '\x1b[33m',    // Jaune
  error: '\x1b[31m',   // Rouge
};

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// ============================================
// Logger State
// ============================================

let currentLevel: LogLevel = 'info';
let useColors: boolean | null = null; // null = auto-detect
let logPrefix: string = '';

// ============================================
// Helpers
// ============================================

/**
 * Formate la date au format [YYYY-MM-DD HH:mm:ss]
 */
function formatTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Détecte si stdout est un TTY (terminal interactif)
 * Si non TTY, on désactive les couleurs (ex: journald)
 */
function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

/**
 * Vérifie si les couleurs doivent être utilisées
 */
function shouldUseColors(): boolean {
  if (useColors !== null) return useColors;
  
  // Auto-detect: couleurs si TTY et pas de NO_COLOR
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  
  return isTTY();
}

/**
 * Vérifie si un niveau doit être loggé
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/**
 * Formate un message de log
 */
function formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
  const timestamp = formatTimestamp();
  const levelLabel = LEVEL_LABELS[level].padEnd(5);
  const prefix = logPrefix ? `[${logPrefix}] ` : '';
  
  // Formater les arguments additionnels
  let formattedArgs = '';
  if (args.length > 0) {
    formattedArgs = ' ' + args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  }
  
  const fullMessage = `${prefix}${message}${formattedArgs}`;
  
  if (shouldUseColors()) {
    const color = LEVEL_COLORS[level];
    return `${DIM}[${timestamp}]${RESET} ${color}${BOLD}[${levelLabel}]${RESET} ${fullMessage}`;
  }
  
  return `[${timestamp}] [${levelLabel}] ${fullMessage}`;
}

// ============================================
// Logger Functions
// ============================================

/**
 * Log un message de niveau DEBUG
 * Utilisé pour les détails techniques (désactivé par défaut)
 */
function debug(message: string, ...args: unknown[]): void {
  if (!shouldLog('debug')) return;
  console.log(formatMessage('debug', message, ...args));
}

/**
 * Log un message de niveau INFO
 * Utilisé pour les événements normaux
 */
function info(message: string, ...args: unknown[]): void {
  if (!shouldLog('info')) return;
  console.log(formatMessage('info', message, ...args));
}

/**
 * Log un message de niveau WARN
 * Utilisé pour les situations anormales mais non critiques
 */
function warn(message: string, ...args: unknown[]): void {
  if (!shouldLog('warn')) return;
  console.warn(formatMessage('warn', message, ...args));
}

/**
 * Log un message de niveau ERROR
 * Utilisé pour les erreurs critiques
 */
function error(message: string, ...args: unknown[]): void {
  if (!shouldLog('error')) return;
  console.error(formatMessage('error', message, ...args));
}

/**
 * Crée une fonction de log simple pour compatibilité avec le code existant
 * Remplace: (msg: string) => void
 */
function createSimpleLogger(level: LogLevel = 'info'): (msg: string) => void {
  return (msg: string) => {
    switch (level) {
      case 'debug': debug(msg); break;
      case 'info': info(msg); break;
      case 'warn': warn(msg); break;
      case 'error': error(msg); break;
    }
  };
}

// ============================================
// Configuration Functions
// ============================================

/**
 * Configure le niveau de log
 */
function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Récupère le niveau de log actuel
 */
function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Configure l'utilisation des couleurs
 * @param enabled true/false ou null pour auto-detect
 */
function setColors(enabled: boolean | null): void {
  useColors = enabled;
}

/**
 * Configure le préfixe des logs
 */
function setPrefix(prefix: string): void {
  logPrefix = prefix;
}

/**
 * Configure le logger
 */
function configure(options: LoggerOptions): void {
  if (options.level !== undefined) {
    setLogLevel(options.level);
  }
  if (options.colors !== undefined) {
    setColors(options.colors);
  }
  if (options.prefix !== undefined) {
    setPrefix(options.prefix);
  }
}

/**
 * Initialise le logger depuis les options CLI
 */
function initFromCLI(options: { verbose?: boolean; debug?: boolean }): void {
  if (options.debug || options.verbose) {
    setLogLevel('debug');
    debug('Mode debug activé');
  }
}

// ============================================
// Exports
// ============================================

/**
 * Logger principal avec méthodes de log
 */
export const logger = {
  debug,
  info,
  warn,
  error,
  setLevel: setLogLevel,
  getLevel: getLogLevel,
  setColors,
  setPrefix,
  configure,
  initFromCLI,
  createSimpleLogger,
};

// Exports nommés pour utilisation directe
export {
  debug,
  info,
  warn,
  error,
  setLogLevel,
  getLogLevel,
  setColors,
  setPrefix,
  configure,
  initFromCLI,
  createSimpleLogger,
};

// Export par défaut
export default logger;
