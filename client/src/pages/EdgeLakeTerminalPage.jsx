// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Select,
  SelectItem,
  TextInput,
  Button,
  ComboBox,
  InlineNotification,
  Loading,
  NumberInput,
  Tag,
} from '@carbon/react';
import { Play, TrashCan, RecordingFilled, Stop, Close, SidePanelClose, SidePanelOpen } from '@carbon/icons-react';
import apiClient from '../api/client';
import useExtensions from '../hooks/useExtensions';
import SnippetsPanel from '../components/snippets/SnippetsPanel';
import './EdgeLakeTerminalPage.scss';

/**
 * EdgeLake Terminal extension — interactive AnyLog/EdgeLake command
 * shell against any EdgeLake connection in the deployment. Sends the
 * raw command as-is to the chosen node (no syntax assistance yet); the
 * response body is rendered verbatim in the transcript.
 *
 * Recording: optional per-session capture of (command, response) pairs.
 * Prefers the File System Access API (Chrome/Edge) for live streaming
 * to a user-chosen file; falls back to in-memory accumulation +
 * download-on-stop for browsers without it (Firefox/Safari).
 */

const PROMPT_PLACEHOLDER = 'AnyLog command (e.g. "get status", "blockchain get table")';

// Per-call timeout — interactive terminal default. EdgeLake's heavier
// diagnostics (`test network`, `test cluster setup`, distributed-fan-
// out SQL) routinely need more than the chart-tuned 20s connection
// default. Server clamps to [1, 300].
const DEFAULT_TIMEOUT_SECONDS = 30;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 300;

const RECENT_DESTINATIONS_KEY = 'edgelake-terminal:recent-destinations';
const SNIPPETS_OPEN_PREF_KEY = 'edgelake_terminal.snippets_panel_open';
const SNIPPETS_OPEN_LOCAL_KEY = 'edgelake-terminal:snippets-open';
const SNIPPETS_CONTEXT = 'edgelake-terminal';
const MAX_RECENT_DESTINATIONS = 12;
// Always-offered destinations.
//   ""           → connection node (the EdgeLake node this connection
//                  points at — we're not running on the node itself,
//                  we're reaching it through the connection)
//   "network"    → fan out across the cluster
//   "master"     → route to the master/blockchain node
//   templates with `isTemplate: true` populate the input field with
//   their `id` as editable text rather than committing it as the
//   destination value — used to seed `ip:port, ip:port` so the user
//   can overwrite with real addresses.
const BUILTIN_DESTINATIONS = [
  { id: '', label: '(connection node)' },
  { id: 'network', label: 'network (fan out)' },
  { id: 'master', label: 'master (blockchain node)' },
  { id: '<ip>:<port>, <ip>:<port>', label: 'peer list… (edit to your nodes)', isTemplate: true },
];

// Builtin destination IDs that should never appear in the "recent"
// list — they already have their own row in the dropdown. Keep this
// in sync with BUILTIN_DESTINATIONS (templates are excluded since
// their id is placeholder text the user replaces anyway).
const BUILTIN_DESTINATION_IDS = new Set(['', 'network', 'master']);

function loadRecentDestinations() {
  try {
    const raw = window.localStorage.getItem(RECENT_DESTINATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter to strings, drop anything that's now a builtin (handles
    // the case where a value was saved before it became a builtin).
    return parsed.filter((x) => typeof x === 'string' && !BUILTIN_DESTINATION_IDS.has(x));
  } catch {
    return [];
  }
}

function saveRecentDestination(value) {
  if (!value || BUILTIN_DESTINATION_IDS.has(value)) return;
  try {
    const current = loadRecentDestinations().filter((x) => x !== value);
    const next = [value, ...current].slice(0, MAX_RECENT_DESTINATIONS);
    window.localStorage.setItem(RECENT_DESTINATIONS_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — silently drop, the field still works.
  }
}

function formatTimestamp(d = new Date()) {
  // Local time, 24h, with millis. Cheap, no Intl overhead.
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

// Render-only placeholder when EdgeLake returns 200 with an empty
// body — common for POST commands (`run blockchain sync`, `set …`)
// where success carries no payload. Without this the transcript
// looked blank and felt broken. The recorded transcript file uses the
// same substitution so the log reads "(POST 200 — no response body)"
// rather than a silent blank line. The server response itself stays
// honest (empty body remains empty) so a direct curl/Postman call
// against the endpoint still sees what EdgeLake actually said.
function emptyBodyPlaceholder(entry) {
  return `(${entry.method || 'GET'} 200 — no response body)`;
}

function entryDisplayBody(entry) {
  if (entry.error) return `ERROR: ${entry.error}`;
  if (entry.response && entry.response.length > 0) return entry.response;
  return emptyBodyPlaceholder(entry);
}

function entryToTranscriptText(entry) {
  // Stable plain-text serialization shared by the screen view and the
  // recording sink. Keeps the recorded file legible (no JSON wrapping,
  // no ANSI). Errors are flagged inline with a leading marker.
  const ts = formatTimestamp(new Date(entry.ts));
  const methodTag = entry.method && entry.method !== 'GET' ? ` [${entry.method}]` : '';
  const destTag = entry.destination ? ` [→ ${entry.destination}]` : '';
  const lines = [
    `── ${ts}${methodTag}${destTag} ─────────────────────────────────────`,
    `$ ${entry.command}`,
    entryDisplayBody(entry),
  ];
  if (typeof entry.durationMs === 'number') {
    lines.push(`(took ${entry.durationMs} ms)`);
  }
  lines.push('');
  return lines.join('\n');
}

function EdgeLakeTerminalPage() {
  const { isEnabled, loading: extLoading } = useExtensions();

  const [connections, setConnections] = useState([]);
  const [connectionId, setConnectionId] = useState('');
  const [connectionsError, setConnectionsError] = useState(null);

  const [command, setCommand] = useState('');
  const [destination, setDestination] = useState('');
  const [methodMode, setMethodMode] = useState(''); // "" = Auto, "GET", "POST"
  const [timeoutSeconds, setTimeoutSeconds] = useState(DEFAULT_TIMEOUT_SECONDS);
  const [recentDestinations, setRecentDestinations] = useState(() => loadRecentDestinations());
  const [history, setHistory] = useState([]); // entries: { ts, command, response, error, durationMs, destination }
  const [historyCursor, setHistoryCursor] = useState(-1); // -1 = current draft
  const [busy, setBusy] = useState(false);
  const abortControllerRef = useRef(null);

  // Recording state. When `recording` is true, every completed entry
  // is also forwarded to either the file writer (FS Access API) or the
  // in-memory buffer (fallback).
  const [recording, setRecording] = useState(false);
  const [recordingError, setRecordingError] = useState(null);
  const writableRef = useRef(null); // FileSystemWritableFileStream
  const recordedBufferRef = useRef([]); // strings, for fallback download
  const recordedFilenameRef = useRef(null);

  const transcriptRef = useRef(null);
  const inputRef = useRef(null);
  // Last successfully-executed command — used to seed the snippets-
  // panel "+" modal when the input field is empty.
  const lastSuccessfulCommandRef = useRef('');

  // Snippets-panel state. Seeded from localStorage for instant render;
  // server-side user-pref is loaded async and overrides when present.
  const [snippetsOpen, setSnippetsOpen] = useState(() => {
    try {
      const v = window.localStorage.getItem(SNIPPETS_OPEN_LOCAL_KEY);
      if (v === 'false') return false;
      return true;
    } catch {
      return true;
    }
  });
  const [canManage, setCanManage] = useState(false);

  // Load EdgeLake-type connections. Use TypeID match where present,
  // fall back to legacy `type`.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await apiClient.getConnections({ page_size: 500 });
        if (cancelled) return;
        const list = Array.isArray(result) ? result : (result?.connections || []);
        const edgelake = list.filter(
          (c) => c.type === 'edgelake' || c.type_id === 'api.edgelake',
        );
        setConnections(edgelake);
        if (edgelake.length > 0) {
          setConnectionId(edgelake[0].id);
        }
      } catch (err) {
        if (!cancelled) setConnectionsError(err.message || String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-scroll the transcript on new entries.
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [history]);

  // Bootstrap: capabilities (for Global checkbox gate) and persisted
  // panel-open preference. Both are best-effort — failures fall back
  // to safe defaults (can_manage=false, localStorage preference).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await apiClient.getCurrentUser();
        if (!cancelled) setCanManage(!!me?.can_manage);
      } catch { /* leave canManage=false */ }
    })();
    (async () => {
      const userGuid = apiClient.getCurrentUserGuid?.();
      if (!userGuid) return;
      try {
        const cfg = await apiClient.getUserConfig?.(userGuid);
        const v = cfg?.settings?.[SNIPPETS_OPEN_PREF_KEY];
        if (!cancelled && typeof v === 'boolean') {
          setSnippetsOpen(v);
        }
      } catch { /* keep local default */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist panel-open changes: localStorage for instant next-render,
  // user-config for cross-device. User-config write is best-effort.
  const toggleSnippetsPanel = () => {
    setSnippetsOpen((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(SNIPPETS_OPEN_LOCAL_KEY, String(next)); } catch { /* ignore */ }
      const userGuid = apiClient.getCurrentUserGuid?.();
      if (userGuid && apiClient.updateUserConfig) {
        apiClient.updateUserConfig(userGuid, { [SNIPPETS_OPEN_PREF_KEY]: next })
          .catch(() => { /* best-effort */ });
      }
      return next;
    });
  };

  const getPrefillCommand = () => {
    const draft = command.trim();
    if (draft) return draft;
    return lastSuccessfulCommandRef.current || '';
  };

  const pasteToInput = (text) => {
    setCommand(text);
    inputRef.current?.focus?.();
  };

  const pasteAndSubmit = (text) => {
    setCommand(text);
    // Submit on the next tick so React applies the setCommand first.
    setTimeout(() => {
      if (!busy && connectionId) {
        // Mirror handleSubmit, but with the snippet command rather than
        // whatever's in state (which may not have applied yet).
        const cmd = text.trim();
        if (cmd) submitCommand(cmd);
      }
    }, 0);
  };

  const supportsFSAccess = useMemo(
    () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function',
    [],
  );

  const appendEntry = async (entry) => {
    setHistory((prev) => [...prev, entry]);
    if (recording) {
      const chunk = entryToTranscriptText(entry);
      if (writableRef.current) {
        try {
          await writableRef.current.write(chunk);
        } catch (err) {
          setRecordingError(`Recording write failed: ${err.message || err}`);
        }
      } else {
        recordedBufferRef.current.push(chunk);
      }
    }
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    const cmd = command.trim();
    if (!cmd || !connectionId || busy) return;
    await submitCommand(cmd);
  };

  // Run a specific command string. Called by both the form submit and
  // the snippets panel (double-click / Run button). The form-submit
  // path passes the trimmed command-field text; the snippets path
  // passes the snippet command directly.
  const submitCommand = async (cmd) => {
    if (!cmd || !connectionId || busy) return;

    setBusy(true);
    const started = Date.now();
    const ts = Date.now();
    const dest = (destination || '').trim();
    const ctl = new AbortController();
    abortControllerRef.current = ctl;
    let entry;
    let succeeded = false;
    try {
      const result = await apiClient.executeEdgeLakeCommand({
        connectionId,
        command: cmd,
        destination: dest,
        method: methodMode,
        timeoutSeconds,
        signal: ctl.signal,
      });
      entry = {
        ts,
        command: cmd,
        response: result?.response ?? '',
        durationMs: result?.duration_ms ?? (Date.now() - started),
        destination: dest,
        method: result?.method || '',
      };
      succeeded = true;
    } catch (err) {
      const message = ctl.signal.aborted
        ? 'Cancelled by user.'
        : (err.message || String(err));
      entry = {
        ts,
        command: cmd,
        error: message,
        durationMs: Date.now() - started,
        destination: dest,
        method: methodMode,
      };
    }
    abortControllerRef.current = null;
    if (succeeded) {
      lastSuccessfulCommandRef.current = cmd;
    }

    // Remember user-typed peer destinations (not builtins) for the
    // ComboBox dropdown in future sessions.
    if (dest && dest !== 'network') {
      saveRecentDestination(dest);
      setRecentDestinations(loadRecentDestinations());
    }

    await appendEntry(entry);
    setCommand('');
    setHistoryCursor(-1);
    setBusy(false);
    // Re-focus the input so the user can keep typing.
    inputRef.current?.focus?.();
  };

  // Up/Down arrow command history. -1 means "back to live draft".
  const navigateHistory = (direction) => {
    if (history.length === 0) return;
    if (direction === 'up') {
      const next = historyCursor === -1
        ? history.length - 1
        : Math.max(0, historyCursor - 1);
      setHistoryCursor(next);
      setCommand(history[next].command);
    } else {
      if (historyCursor === -1) return;
      const next = historyCursor + 1;
      if (next >= history.length) {
        setHistoryCursor(-1);
        setCommand('');
      } else {
        setHistoryCursor(next);
        setCommand(history[next].command);
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateHistory('up');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateHistory('down');
    }
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
  };

  const handleClear = () => {
    setHistory([]);
    setHistoryCursor(-1);
  };

  const startRecording = async () => {
    setRecordingError(null);
    recordedBufferRef.current = [];
    const defaultName = `edgelake-terminal-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    recordedFilenameRef.current = defaultName;

    // Header line so the file is self-describing.
    const conn = connections.find((c) => c.id === connectionId);
    const header =
      `# EdgeLake Terminal session\n` +
      `# Started: ${formatTimestamp()}\n` +
      `# Connection: ${conn?.name || connectionId}\n\n`;

    if (supportsFSAccess) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName,
          types: [{
            description: 'Text file',
            accept: { 'text/plain': ['.txt', '.log'] },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(header);
        writableRef.current = writable;
      } catch (err) {
        // User cancelled the picker — silently abort, leave recording off.
        if (err?.name === 'AbortError') return;
        setRecordingError(err.message || String(err));
        return;
      }
    } else {
      recordedBufferRef.current.push(header);
    }
    setRecording(true);
  };

  const stopRecording = async () => {
    setRecording(false);
    if (writableRef.current) {
      try {
        await writableRef.current.close();
      } catch (err) {
        setRecordingError(`Recording close failed: ${err.message || err}`);
      }
      writableRef.current = null;
      return;
    }
    // Fallback: trigger a download of the accumulated buffer.
    const blob = new Blob(recordedBufferRef.current, { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = recordedFilenameRef.current || 'edgelake-terminal.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    recordedBufferRef.current = [];
  };

  // Close the open writable on unmount so we don't leak a file handle.
  useEffect(() => {
    return () => {
      if (writableRef.current) {
        writableRef.current.close().catch(() => {});
      }
    };
  }, []);

  if (extLoading) {
    return <div className="edgelake-terminal-page edgelake-terminal-page--loading">Loading…</div>;
  }
  if (!isEnabled('edgelake_terminal')) {
    return <Navigate to="/design" replace />;
  }

  const noConnections = connections.length === 0;

  return (
    <div className="edgelake-terminal-page">
      <div className="page-header">
        <h1>EdgeLake Terminal</h1>
        <p>
          Send raw AnyLog/EdgeLake commands to any EdgeLake connection.
          Responses are printed verbatim. Use the record toggle to
          capture this session to a local file.
        </p>
      </div>

      {connectionsError && (
        <InlineNotification
          kind="error"
          title="Failed to load connections"
          subtitle={connectionsError}
          hideCloseButton
        />
      )}
      {recordingError && (
        <InlineNotification
          kind="warning"
          title="Recording issue"
          subtitle={recordingError}
          onCloseButtonClick={() => setRecordingError(null)}
        />
      )}
      {noConnections && !connectionsError && (
        <InlineNotification
          kind="info"
          title="No EdgeLake connections"
          subtitle="Create an EdgeLake connection under Design → Connections to use this terminal."
          hideCloseButton
        />
      )}

      <div className="terminal-toolbar">
        <Select
          id="edgelake-terminal-connection"
          labelText="Connection"
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          disabled={noConnections || recording}
          size="md"
        >
          {connections.map((c) => (
            <SelectItem key={c.id} value={c.id} text={c.name || c.id} />
          ))}
        </Select>

        <ComboBox
          id="edgelake-terminal-destination"
          titleText="Destination"
          allowCustomValue
          items={[
            ...BUILTIN_DESTINATIONS,
            ...recentDestinations.map((d) => ({ id: d, label: d })),
          ]}
          // Display rule: builtins render by their label ("(connected
          // node)"), everything else renders verbatim. Without this
          // the input would show "(connected node)" when destination
          // is "" and never let the user back into the field cleanly.
          itemToString={(item) => {
            if (!item) return '';
            const builtin = BUILTIN_DESTINATIONS.find((d) => d.id === item.id && !d.isTemplate);
            if (builtin) return builtin.label;
            return item.id;
          }}
          selectedItem={
            BUILTIN_DESTINATIONS.find((d) => !d.isTemplate && d.id === destination) ||
            (destination ? { id: destination, label: destination } : BUILTIN_DESTINATIONS[0])
          }
          // Single onChange handler — using onInputChange alongside
          // caused a feedback loop where picking the template made
          // ComboBox repeatedly re-resolve label↔id. ComboBox calls
          // onChange both on dropdown selection (`selectedItem` set)
          // and on free typing (`selectedItem === null`, `inputValue`
          // set), so this one place handles everything.
          onChange={({ selectedItem, inputValue }) => {
            if (selectedItem) {
              // Picking any builtin or recent entry sets destination
              // to its id. Templates work identically — the id is
              // the editable seed text the user then overwrites.
              setDestination(selectedItem.id);
              return;
            }
            // Free-typed text. Carbon strips out the selected item
            // when the input no longer matches it.
            setDestination(typeof inputValue === 'string' ? inputValue : '');
          }}
          size="md"
        />

        <Select
          id="edgelake-terminal-method"
          labelText="Method"
          value={methodMode}
          onChange={(e) => setMethodMode(e.target.value)}
          size="md"
          className="terminal-toolbar__method"
        >
          <SelectItem value="" text="Auto" />
          <SelectItem value="GET" text="GET" />
          <SelectItem value="POST" text="POST" />
        </Select>

        <NumberInput
          id="edgelake-terminal-timeout"
          label="Timeout (s)"
          value={timeoutSeconds}
          min={MIN_TIMEOUT_SECONDS}
          max={MAX_TIMEOUT_SECONDS}
          step={5}
          hideSteppers={false}
          allowEmpty={false}
          invalid={
            !Number.isInteger(timeoutSeconds) ||
            timeoutSeconds < MIN_TIMEOUT_SECONDS ||
            timeoutSeconds > MAX_TIMEOUT_SECONDS
          }
          invalidText={`Must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}.`}
          onChange={(_, { value }) => {
            const n = parseInt(value, 10);
            setTimeoutSeconds(Number.isNaN(n) ? DEFAULT_TIMEOUT_SECONDS : n);
          }}
          size="md"
          className="terminal-toolbar__timeout"
        />

        <div className="terminal-toolbar__actions">
          {!recording ? (
            <Button
              kind="tertiary"
              size="md"
              renderIcon={RecordingFilled}
              onClick={startRecording}
              disabled={noConnections}
            >
              Record session
            </Button>
          ) : (
            <Button
              kind="danger--tertiary"
              size="md"
              renderIcon={Stop}
              onClick={stopRecording}
            >
              Stop recording
            </Button>
          )}
          <Button
            kind="ghost"
            size="md"
            renderIcon={TrashCan}
            onClick={handleClear}
            disabled={history.length === 0}
          >
            Clear
          </Button>
          <Button
            kind="ghost"
            size="md"
            renderIcon={snippetsOpen ? SidePanelClose : SidePanelOpen}
            onClick={toggleSnippetsPanel}
            iconDescription={snippetsOpen ? 'Hide snippets' : 'Show snippets'}
            hasIconOnly
            tooltipAlignment="end"
          />
        </div>

        {recording && (
          <Tag type="red" className="terminal-toolbar__rec-tag">
            ● REC
          </Tag>
        )}
      </div>

      <div className="terminal-body">
        <div className="terminal-body__main">
        <div className="terminal-transcript" ref={transcriptRef}>
        {history.length === 0 ? (
          <div className="terminal-transcript__empty">
            No commands yet. Type a command below and press Enter.
          </div>
        ) : (
          history.map((entry, idx) => (
            <div key={idx} className={`transcript-entry${entry.error ? ' transcript-entry--error' : ''}`}>
              <div className="transcript-entry__meta">
                <span className="transcript-entry__ts">{formatTimestamp(new Date(entry.ts))}</span>
                {entry.method && entry.method !== 'GET' && (
                  <span className="transcript-entry__method">{entry.method}</span>
                )}
                {entry.destination && (
                  <span className="transcript-entry__dest">→ {entry.destination}</span>
                )}
                {typeof entry.durationMs === 'number' && (
                  <span className="transcript-entry__took">{entry.durationMs} ms</span>
                )}
              </div>
              <div className="transcript-entry__cmd">
                <span className="transcript-entry__prompt">$</span> {entry.command}
              </div>
              <pre
                className={`transcript-entry__body${
                  !entry.error && !entry.response ? ' transcript-entry__body--placeholder' : ''
                }`}
              >
                {entryDisplayBody(entry)}
              </pre>
            </div>
          ))
        )}
      </div>

      <form className="terminal-input" onSubmit={handleSubmit}>
        <TextInput
          id="edgelake-terminal-input"
          ref={inputRef}
          labelText=""
          hideLabel
          placeholder={noConnections ? 'Create an EdgeLake connection first…' : PROMPT_PLACEHOLDER}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={noConnections || busy}
          autoComplete="off"
          spellCheck={false}
        />
        {busy ? (
          <Button
            type="button"
            kind="danger"
            renderIcon={Close}
            onClick={handleCancel}
          >
            Cancel
          </Button>
        ) : (
          <Button
            type="submit"
            kind="primary"
            renderIcon={Play}
            disabled={noConnections || !command.trim()}
          >
            Send
          </Button>
        )}
      </form>

      {busy && <Loading description="Sending command…" small withOverlay={false} />}
        </div>

        {snippetsOpen && (
          <SnippetsPanel
            context={SNIPPETS_CONTEXT}
            canCreateGlobal={canManage}
            onPaste={pasteToInput}
            onActivate={pasteAndSubmit}
            getPrefillCommand={getPrefillCommand}
            onRequestClose={toggleSnippetsPanel}
          />
        )}
      </div>
    </div>
  );
}

export default EdgeLakeTerminalPage;
