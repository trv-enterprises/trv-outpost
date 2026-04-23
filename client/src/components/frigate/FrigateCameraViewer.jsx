// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef, useCallback } from 'react';
import { Dropdown, Button } from '@carbon/react';
import { VideoPlayer } from '@carbon/icons-react';
import JSMpeg from 'jsmpeg-player';
import apiClient from '../../api/client';
import './FrigateCameraViewer.scss';

/**
 * FrigateCameraViewer Component
 *
 * Displays a Frigate NVR camera feed with two modes:
 * - idle: Polls latest.jpg snapshot every N seconds
 * - live: go2rtc MSE live stream via WebSocket
 *
 * Alerts are intentionally NOT handled here — that is the FrigateAlertsGrid
 * component's responsibility. This widget is purely a camera viewer.
 */
function FrigateCameraViewer({ config }) {
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(config?.default_camera || '');
  const [mode, setMode] = useState('idle'); // 'idle' | 'live'
  const [snapshotUrl, setSnapshotUrl] = useState('');
  const [snapshotKey, setSnapshotKey] = useState(0); // Force img reload
  const [error, setError] = useState(null);

  const canvasRef = useRef(null);
  const playerRef = useRef(null);
  const snapshotIntervalRef = useRef(null);

  const connectionId = config?.frigate_connection_id;
  const snapshotInterval = config?.snapshot_interval || 10000;

  // Fetch camera list on mount
  useEffect(() => {
    if (!connectionId) return;

    const fetchCameras = async () => {
      try {
        const data = await apiClient.getFrigateCameras(connectionId);
        const cameraList = data.cameras || [];
        setCameras(cameraList);

        // Auto-select default or first camera
        if (config?.default_camera && cameraList.includes(config.default_camera)) {
          setSelectedCamera(config.default_camera);
        } else if (cameraList.length > 0 && !selectedCamera) {
          setSelectedCamera(cameraList[0]);
        }
      } catch (err) {
        setError(`Failed to load cameras: ${err.message}`);
      }
    };

    fetchCameras();
  }, [connectionId]);


  // Snapshot polling in idle mode
  useEffect(() => {
    if (mode !== 'idle' || !selectedCamera || !connectionId) {
      if (snapshotIntervalRef.current) {
        clearInterval(snapshotIntervalRef.current);
        snapshotIntervalRef.current = null;
      }
      return;
    }

    const updateSnapshot = () => {
      setSnapshotUrl(apiClient.getFrigateSnapshotUrl(connectionId, selectedCamera));
      setSnapshotKey(prev => prev + 1);
    };

    // Immediate first snapshot
    updateSnapshot();

    // Poll at configured interval
    snapshotIntervalRef.current = setInterval(updateSnapshot, snapshotInterval);

    return () => {
      if (snapshotIntervalRef.current) {
        clearInterval(snapshotIntervalRef.current);
        snapshotIntervalRef.current = null;
      }
    };
  }, [mode, selectedCamera, connectionId, snapshotInterval]);

  const cleanupLiveStream = useCallback(() => {
    if (playerRef.current) {
      try {
        // Stop playback and close WebSocket without removing the canvas from DOM
        // (React owns the canvas element — destroy() would cause removeChild errors)
        playerRef.current.stop();
        if (playerRef.current.source) {
          playerRef.current.source.destroy();
        }
      } catch (e) {
        // Ignore cleanup errors (WebGL context may already be lost)
      }
      playerRef.current = null;
    }
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => cleanupLiveStream();
  }, []);

  // Start JSMPEG stream when mode switches to live and canvas is mounted
  useEffect(() => {
    if (mode !== 'live') return;
    if (!selectedCamera || !connectionId) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const wsUrl = apiClient.getFrigateLiveStreamUrl(connectionId, selectedCamera);

    const player = new JSMpeg.Player(wsUrl, {
      canvas: canvas,
      autoplay: true,
      audio: false,
      loop: false,
      disableWebAssembly: false,
      disableGl: false,
    });

    playerRef.current = player;

    return () => {
      cleanupLiveStream();
    };
  }, [mode, selectedCamera, connectionId]);

  const handleCameraChange = ({ selectedItem }) => {
    if (selectedItem) {
      if (mode === 'live') cleanupLiveStream();
      setMode('idle');
      setSelectedCamera(selectedItem);
    }
  };

  const handleLiveToggle = () => {
    if (mode === 'live') {
      cleanupLiveStream();
      setMode('idle');
    } else {
      setMode('live');
    }
  };

  if (!connectionId) {
    return (
      <div className="frigate-camera-viewer frigate-camera-viewer--empty">
        <p>No Frigate connection configured</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="frigate-camera-viewer frigate-camera-viewer--error">
        <p>{error}</p>
        <Button kind="ghost" size="sm" onClick={() => { setError(null); setMode('idle'); }}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="frigate-camera-viewer">
      {/* Header bar */}
      <div className="frigate-camera-viewer__header">
        <Dropdown
          id="frigate-camera-select"
          label="Camera"
          titleText=""
          items={cameras}
          itemToString={(item) => item || ''}
          selectedItem={selectedCamera}
          onChange={handleCameraChange}
          size="sm"
          className="frigate-camera-viewer__camera-dropdown"
        />
        <div className="frigate-camera-viewer__controls">
          {connectionId && (
            <Button
              kind={mode === 'live' ? 'danger' : 'ghost'}
              size="sm"
              renderIcon={VideoPlayer}
              onClick={handleLiveToggle}
              className="frigate-camera-viewer__live-button"
            >
              {mode === 'live' ? 'Stop' : 'Live'}
            </Button>
          )}
        </div>
      </div>

      {/* Main content area */}
      <div className="frigate-camera-viewer__content">
        {/* Idle mode — snapshot */}
        {mode === 'idle' && snapshotUrl && (
          <img
            key={snapshotKey}
            src={`${snapshotUrl}?t=${snapshotKey}`}
            alt={`${selectedCamera} camera`}
            className="frigate-camera-viewer__snapshot"
            onError={() => setError('Failed to load snapshot')}
          />
        )}

        {/* Live mode — canvas for JSMPEG stream */}
        {mode === 'live' && (
          <canvas
            ref={canvasRef}
            className="frigate-camera-viewer__canvas"
          />
        )}
      </div>
    </div>
  );
}

export default FrigateCameraViewer;
