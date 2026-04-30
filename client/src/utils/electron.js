// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Electron Environment Detection and Helpers
 *
 * This module provides utilities for detecting when the app is running
 * in an Electron environment and interacting with Electron-specific APIs.
 */

/**
 * Check if the app is running in an Electron environment
 * @returns {boolean} True if running in Electron
 */
export const isElectron = () => {
  // Check for Electron-specific window property (set by preload script)
  if (typeof window !== 'undefined' && window.electron !== undefined) {
    return true;
  }

  // Check for Electron in user agent (fallback)
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')) {
    return true;
  }

  // Check for Node.js process in renderer (older Electron versions).
  // `process` is a Node global; in pure-browser contexts it's undefined,
  // which is why we typeof-check before touching it. ESLint doesn't
  // know about that runtime guard, so silence its no-undef warning.
  // eslint-disable-next-line no-undef
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
    return true;
  }

  return false;
};

/**
 * Get the Electron API object (exposed by preload script)
 * @returns {object|null} Electron API object or null if not in Electron
 */
export const getElectronAPI = () => {
  if (isElectron() && typeof window !== 'undefined') {
    return window.electron || null;
  }
  return null;
};

/**
 * Get stored configuration from Electron's secure storage
 * @returns {Promise<object|null>} Configuration object or null
 */
export const getElectronConfig = async () => {
  const api = getElectronAPI();
  if (api && typeof api.getConfig === 'function') {
    try {
      return await api.getConfig();
    } catch (err) {
      console.error('Failed to get Electron config:', err);
      return null;
    }
  }
  return null;
};

/**
 * Save configuration to Electron's secure storage
 * @param {object} config - Configuration to save
 * @returns {Promise<boolean>} True if successful
 */
export const saveElectronConfig = async (config) => {
  const api = getElectronAPI();
  if (api && typeof api.saveConfig === 'function') {
    try {
      await api.saveConfig(config);
      return true;
    } catch (err) {
      console.error('Failed to save Electron config:', err);
      return false;
    }
  }
  return false;
};

/**
 * Clear configuration from Electron's secure storage
 * @returns {Promise<boolean>} True if successful
 */
export const clearElectronConfig = async () => {
  const api = getElectronAPI();
  if (api && typeof api.clearConfig === 'function') {
    try {
      await api.clearConfig();
      return true;
    } catch (err) {
      console.error('Failed to clear Electron config:', err);
      return false;
    }
  }
  return false;
};

/**
 * Get the app version (Electron only)
 * @returns {string|null} App version or null
 */
export const getAppVersion = () => {
  const api = getElectronAPI();
  if (api && api.version) {
    return api.version;
  }
  return null;
};

/**
 * Get the platform (Electron only)
 * @returns {string|null} Platform (darwin, win32, linux) or null
 */
export const getPlatform = () => {
  const api = getElectronAPI();
  if (api && api.platform) {
    return api.platform;
  }
  return null;
};

export default {
  isElectron,
  getElectronAPI,
  getElectronConfig,
  saveElectronConfig,
  clearElectronConfig,
  getAppVersion,
  getPlatform,
};
