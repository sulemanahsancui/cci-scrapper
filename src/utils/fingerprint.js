/**
 * Browser fingerprint utilities — used by the anti-detection layer.
 */

import UserAgent from 'user-agents';

const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
];

const LANGUAGES = ['en-US', 'en-GB', 'en-CA', 'en-AU'];

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'Europe/London', 'Europe/Berlin',
  'Asia/Tokyo', 'Australia/Sydney',
];

export function randomUserAgent(deviceType = 'desktop') {
  const ua = new UserAgent({ deviceCategory: deviceType });
  return ua.toString();
}

export function randomScreenResolution() {
  return SCREEN_RESOLUTIONS[Math.floor(Math.random() * SCREEN_RESOLUTIONS.length)];
}

export function randomLanguage() {
  return LANGUAGES[Math.floor(Math.random() * LANGUAGES.length)];
}

export function randomTimezone() {
  return TIMEZONES[Math.floor(Math.random() * TIMEZONES.length)];
}

export function generateFingerprint(overrides = {}) {
  return {
    userAgent: randomUserAgent(),
    screen: randomScreenResolution(),
    language: randomLanguage(),
    timezone: randomTimezone(),
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    ...overrides,
  };
}
