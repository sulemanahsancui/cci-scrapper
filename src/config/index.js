/**
 * Configuration loader — merges base defaults with environment-specific overrides.
 * All secrets are pulled from environment variables; config files only hold
 * structural defaults that are safe to commit.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env.NODE_ENV || 'development';

// Windows requires file:// URLs for absolute-path dynamic imports
const envConfigUrl = pathToFileURL(path.join(__dirname, `${env}.js`)).href;
const { default: envConfig } = await import(envConfigUrl);

const base = {
  env,
  port: parseInt(process.env.PORT || '3000', 10),

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'scraping_framework',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    pool: {
      min: parseInt(process.env.DB_POOL_MIN || '2', 10),
      max: parseInt(process.env.DB_POOL_MAX || '20', 10),
    },
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
    apiKey: process.env.API_KEY || '',
  },

  captcha: {
    twoCaptcha: { apiKey: process.env.TWO_CAPTCHA_API_KEY || '' },
    capSolver:  { apiKey: process.env.CAPSOLVER_API_KEY || '' },
    antiCaptcha: { apiKey: process.env.ANTICAPTCHA_API_KEY || '' },
  },

  proxies: {
    brightData: {
      username: process.env.BRIGHTDATA_USERNAME || '',
      password: process.env.BRIGHTDATA_PASSWORD || '',
      host: process.env.BRIGHTDATA_HOST || 'brd.superproxy.io',
      port: parseInt(process.env.BRIGHTDATA_PORT || '22225', 10),
    },
    oxylabs: {
      username: process.env.OXYLABS_USERNAME || '',
      password: process.env.OXYLABS_PASSWORD || '',
      host: process.env.OXYLABS_HOST || 'pr.oxylabs.io',
      port: parseInt(process.env.OXYLABS_PORT || '7777', 10),
    },
    smartProxy: {
      username: process.env.SMARTPROXY_USERNAME || '',
      password: process.env.SMARTPROXY_PASSWORD || '',
      host: process.env.SMARTPROXY_HOST || 'gate.smartproxy.com',
      port: parseInt(process.env.SMARTPROXY_PORT || '10000', 10),
    },
    webshare: { apiKey: process.env.WEBSHARE_API_KEY || '' },
  },

  kameleo: {
    apiUrl: process.env.KAMELEO_API_URL || 'http://localhost:5050',
    apiKey: process.env.KAMELEO_API_KEY || '',
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir:   process.env.LOG_DIR   || './logs',
  },

  monitoring: {
    enabled: process.env.METRICS_ENABLED === 'true',
    prometheusPort: parseInt(process.env.PROMETHEUS_PORT || '9090', 10),
  },
};

// Deep merge: envConfig values override base
function deepMerge(target, source) {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      output[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      output[key] = source[key];
    }
  }
  return output;
}

export default deepMerge(base, envConfig);
