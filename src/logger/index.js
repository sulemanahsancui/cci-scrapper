/**
 * Structured logger — Winston with daily log rotation.
 *
 * Usage:
 *   import logger from './logger/index.js';
 *   logger.info('message', { meta: 'data' });
 *   logger.child({ scraper: 'ZillowScraper' }).debug('page loaded');
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import config from '../config/index.js';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

// Human-readable format for console
const consoleFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level}] ${message}${extras}`;
});

// Shared file transport options
const fileTransportBase = {
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
  format: combine(timestamp(), errors({ stack: true }), json()),
};

const transports = [
  new winston.transports.Console({
    format: combine(
      colorize(),
      timestamp({ format: 'HH:mm:ss' }),
      errors({ stack: true }),
      consoleFormat,
    ),
  }),

  new DailyRotateFile({
    ...fileTransportBase,
    dirname: config.logging.dir,
    filename: 'combined-%DATE%.log',
  }),

  new DailyRotateFile({
    ...fileTransportBase,
    dirname: config.logging.dir,
    filename: 'error-%DATE%.log',
    level: 'error',
  }),
];

const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: 'scraping-framework', env: config.env },
  transports,
  exitOnError: false,
});

export default logger;
