// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef, useCallback } from 'react';
import { Dropdown, Button, Tag, IconButton } from '@carbon/react';
import { VideoPlayer, ViewOff, Renew } from '@carbon/icons-react';
import JSMpeg from 'jsmpeg-player';
import apiClient from '../../api/client';
import './FrigateCameraViewer.scss';

/**
 * FrigateCameraViewer Component
 *
 * Displays a Frigate NVR camera feed with three modes:
 * - idle: Polls latest.jpg snapshot every N seconds
 * - live: go2rtc MSE live stream via WebSocket
 * - alert: Shows alert event snapshot with "Play Clip" option
 *
 * This is explicitly a Frigate-specific component — not a generic camera viewer.
 */
function FrigateCameraViewer({ config }) {
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(config?.default_camera || '');
  const [mode, setMode] = useState('idle'); // 'idle' | 'live' | 'alert'
  const [snapshotUrl, setSnapshotUrl] = useState('');
  const [snapshotKey, setSnapshotKey] = useState(0); // Force img reload
  const [alertEvent, setAlertEvent] = useState(null);
  const [playingClip, setPlayingClip] = useState(false);
  const [error, setError] = useState(null);

  const canvasRef = useRef(null);
  const playerRef = useRef(null);
  const snapshotIntervalRef = useRef(null);
  const mqttCleanupRef = useRef(null);

  const connectionId = config?.frigate_connection_id;
  const mqttConnectionId = config?.mqtt_connection_id;
  const alertTopic = config?.alert_topic || 'frigate/reviews';
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

  // MQTT alert subscription
  useEffect(() => {
    if (!mqttConnectionId || !selectedCamera) return;

    // Dynamic import to avoid circular dependencies.
    const setupMqtt = async () => {
      try {
        const { default: StreamConnectionManager } = await import('../../utils/streamConnectionManager');
        const manager = StreamConnectionManager.getInstance();

        const handleMessage = (record) => {
          try {
            // Manager emits SSE records with { topic, data, ... }; unwrap
            // to the Frigate review event payload.
            const payload = record?.data != null
              ? (typeof record.data === 'string' ? JSON.parse(record.data) : record.data)
              : record;

            if (payload?.type === 'new' && payload.after) {
              const event = payload.after;
              if (event.camera === selectedCamera && event.severity === 'alert') {
                setAlertEvent({
                  id: event.id,
                  camera: event.camera,
                  startTime: event.start_time,
                  objects: event.data?.objects || [],
                  label: (event.data?.objects || []).join(', ') || 'motion'
                });
                setMode('alert');
                setPlayingClip(false);
              }
            }
          } catch {
            // Ignore unparseable messages
          }
        };

        mqttCleanupRef.current = manager.subscribe(
          mqttConnectionId,
          handleMessage,
          { topics: alertTopic }
        );
      } catch (err) {
        console.warn('Failed to subscribe to MQTT alerts:', err);
      }
    };

    setupMqtt();

    return () => {
      if (mqttCleanupRef.current) {
        mqttCleanupRef.current();
        mqttCleanupRef.current = null;
      }
    };
  }, [mqttConnectionId, selectedCamera, alertTopic]);

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
      setAlertEvent(null);
      setPlayingClip(false);
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

  const handleBackToIdle = () => {
    cleanupLiveStream();
    setMode('idle');
    setAlertEvent(null);
    setPlayingClip(false);
  };

  const handlePlayClip = () => {
    if (!alertEvent?.id || !connectionId) return;
    setPlayingClip(true);
  };

  const formatTimestamp = (ts) => {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    const now = new Date();
    const diffSec = Math.floor((now - date) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    return date.toLocaleTimeString();
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
          {mode === 'alert' && (
            <Button kind="ghost" size="sm" onClick={handleBackToIdle}>
              Back
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

        {/* Alert mode — event snapshot or clip */}
        {mode === 'alert' && alertEvent && (
          <>
            {playingClip ? (
              <video
                src={apiClient.getFrigateEventClipUrl(connectionId, alertEvent.id)}
                className="frigate-camera-viewer__video"
                autoPlay
                controls
                playsInline
              />
            ) : (
              <img
                src={apiClient.getFrigateEventSnapshotUrl(connectionId, alertEvent.id)}
                alt={`Alert: ${alertEvent.label}`}
                className="frigate-camera-viewer__snapshot"
              />
            )}
          </>
        )}
      </div>

      {/* Alert bar */}
      {mode === 'alert' && alertEvent && (
        <div className="frigate-camera-viewer__alert-bar">
          <Tag type="red" size="sm">{alertEvent.label}</Tag>
          <span className="frigate-camera-viewer__alert-time">
            {formatTimestamp(alertEvent.startTime)}
          </span>
          {!playingClip && (
            <Button kind="ghost" size="sm" onClick={handlePlayClip}>
              Play Clip
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default FrigateCameraViewer;
