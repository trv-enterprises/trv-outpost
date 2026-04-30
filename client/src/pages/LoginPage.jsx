// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
import {
  Button,
  TextInput,
  InlineNotification,
  Loading,
  Tile
} from '@carbon/react';
import { Login, ConnectionSignal } from '@carbon/icons-react';
import apiClient from '../api/client';
import { saveCredentials } from '../utils/secureStorage';
import { isElectron } from '../utils/electron';
import './LoginPage.scss';

/**
 * LoginPage Component
 *
 * Displays a login form for entering server URL and user key.
 * Used primarily in Electron mode, but can also work in browser mode
 * for remote server connections.
 */
function LoginPage({ onLoginSuccess }) {
  const [serverUrl, setServerUrl] = useState('http://localhost:3001');
  const [userKey, setUserKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [serverError, setServerError] = useState('');
  const [keyError, setKeyError] = useState('');

  // Validate server URL format
  const validateServerUrl = (url) => {
    if (!url) {
      return 'Server URL is required';
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'URL must start with http:// or https://';
      }
      return '';
    } catch {
      return 'Invalid URL format';
    }
  };

  // Validate API key format. Real keys are `trve_<base32>`; tolerate
  // anything that starts with the prefix and has a reasonable length.
  const validateKey = (key) => {
    if (!key) {
      return 'API key is required';
    }
    if (!key.startsWith('trve_')) {
      return 'Key must start with "trve_"';
    }
    if (key.length < 20) {
      return 'Key is too short';
    }
    return '';
  };

  const handleServerUrlChange = (e) => {
    const value = e.target.value;
    setServerUrl(value);
    setServerError(validateServerUrl(value));
    setError(null);
  };

  const handleKeyChange = (e) => {
    const value = e.target.value;
    setUserKey(value);
    setKeyError(validateKey(value));
    setError(null);
  };

  const handleConnect = async () => {
    // Validate inputs
    const urlError = validateServerUrl(serverUrl);
    const keyValidationError = validateKey(userKey);

    setServerError(urlError);
    setKeyError(keyValidationError);

    if (urlError || keyValidationError) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Set the server URL in the API client
      apiClient.setServerUrl(serverUrl);

      // Stamp the API key so subsequent requests carry
      // Authorization: Bearer trve_…, then validate by calling
      // /api/auth/me. If the key is bad, getCurrentUser throws 401.
      apiClient.setApiKey(userKey);
      let response;
      try {
        response = await apiClient.getCurrentUser();
      } catch (validateErr) {
        // Roll back the stored key on a failed validate so the next
        // attempt starts clean.
        apiClient.clearApiKey();
        throw validateErr;
      }

      // Save credentials for future sessions
      await saveCredentials(serverUrl, userKey, response.name);

      // Notify parent of successful login
      if (onLoginSuccess) {
        onLoginSuccess({
          serverUrl,
          key: userKey,
          user: response,
        });
      }
    } catch (err) {
      console.error('Login failed:', err);

      // Determine error type
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('Server unreachable') || err.message.includes('Request timed out')) {
        setError('Cannot connect to server. Check the URL and ensure the server is running.');
      } else if (err.message.includes('Invalid API key') || err.message.includes('Invalid key') || err.message.includes('401')) {
        setError('Invalid API key. Please check the key and try again.');
      } else if (err.message.includes('inactive')) {
        setError('Your account is inactive. Contact an administrator.');
      } else {
        setError(err.message || 'Connection failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !loading) {
      handleConnect();
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <Tile className="login-tile">
          <div className="login-header">
            <ConnectionSignal size={32} />
            <h1>Connect to Dashboard</h1>
            <p className="login-subtitle">
              {isElectron()
                ? 'Enter your server URL and API key to connect'
                : 'Enter server credentials to connect'}
            </p>
          </div>

          {error && (
            <InlineNotification
              kind="error"
              title="Connection Failed"
              subtitle={error}
              lowContrast
              hideCloseButton
              className="login-error"
            />
          )}

          <div className="login-form">
            <TextInput
              id="server-url"
              labelText="Server URL"
              placeholder="http://localhost:3001"
              value={serverUrl}
              onChange={handleServerUrlChange}
              onKeyDown={handleKeyDown}
              invalid={!!serverError}
              invalidText={serverError}
              disabled={loading}
              autoComplete="url"
            />

            <TextInput
              id="user-key"
              labelText="API Key"
              placeholder="trve_…"
              value={userKey}
              onChange={handleKeyChange}
              onKeyDown={handleKeyDown}
              invalid={!!keyError}
              invalidText={keyError}
              disabled={loading}
              autoComplete="off"
              type="password"
              helperText="Generate an API key from Manage → API Keys in the dashboard"
            />

            <Button
              kind="primary"
              onClick={handleConnect}
              disabled={loading || !!serverError || !!keyError || !serverUrl || !userKey}
              renderIcon={loading ? null : Login}
              className="login-button"
            >
              {loading ? (
                <>
                  <Loading small withOverlay={false} />
                  <span style={{ marginLeft: '0.5rem' }}>Connecting...</span>
                </>
              ) : (
                'Connect'
              )}
            </Button>
          </div>

          <div className="login-footer">
            <p>
              Need an API key? Open the dashboard in a browser, sign
              in, and visit <strong>Manage → API Keys → New</strong>.
            </p>
          </div>
        </Tile>
      </div>
    </div>
  );
}

export default LoginPage;
