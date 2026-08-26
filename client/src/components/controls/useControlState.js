// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef, useCallback } from 'react';
import StreamConnectionManager from '../../utils/streamConnectionManager';
import { deriveStateTopic, extractStateValue, SUPPRESS_DURATION_MS } from './controlUtils';

// Sentinel for "no deferred value", distinct from a device value of undefined.
const NOTHING_PENDING = Symbol('nothing-pending');

/**
 * useControlState Hook
 *
 * Subscribes to MQTT state updates for a control component.
 * Handles topic derivation, field extraction, and suppression of stale
 * messages after sending commands.
 *
 * @param {object} options
 * @param {string} options.connectionId - Connection ID for MQTT broker
 * @param {string} options.target - Command target topic (e.g., "zigbee2mqtt/device/set")
 * @param {string} options.stateField - Primary field name to extract from records
 * @param {string[]} options.fallbackFields - Additional field names to try
 * @param {function} options.transform - Transform raw value before setting state (optional)
 * @param {*} options.initialValue - Initial state value
 * @param {object} [options.sharedSuppressRef] - Share ONE suppression window
 *   across several useControlState calls in the same control. A control that
 *   reads more than one field (a color light reads state + brightness +
 *   color) otherwise gets an independent window per field, and only the hook
 *   whose `suppress` is wired to the command actually suppresses. The others
 *   keep accepting post-command messages, so the fields drift apart and two
 *   views of the same device disagree.
 * @returns {{ value, connected, suppressRef, stateTopic }}
 */
export function useControlState({
  connectionId,
  target,
  stateField = 'state',
  fallbackFields = [],
  transform,
  initialValue = undefined,
  sharedSuppressRef
}) {
  const [value, setValue] = useState(initialValue);
  const [connected, setConnected] = useState(false);
  const ownSuppressRef = useRef(0);

  // Callers pass `transform` as an inline arrow, so its identity changes on
  // every render. With it in the effect's dependency array the subscription
  // tore down and re-subscribed continuously — a device message arriving
  // mid-teardown landed on a callback that was about to be discarded, so the
  // value silently stopped updating. Hold it in a ref and read through that,
  // so the effect depends only on what actually identifies the subscription.
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Latest device value seen while suppressed, applied when the window ends.
  // A dedicated sentinel because `undefined` is a legitimate device value.
  const pendingRef = useRef(NOTHING_PENDING);
  const flushTimerRef = useRef(null);
  // Callers that pass a shared ref suppress as one unit; everyone else keeps
  // a private window, which is the historical behaviour.
  const suppressRef = sharedSuppressRef || ownSuppressRef;

  const stateTopic = deriveStateTopic(target);

  // Suppress state updates temporarily (called before sending commands)
  const suppress = useCallback(() => {
    suppressRef.current = Date.now() + SUPPRESS_DURATION_MS;
  }, []);

  const clearSuppress = useCallback(() => {
    suppressRef.current = 0;
    // The command failed, so the optimistic value is wrong — apply whatever
    // the device last told us right away rather than waiting out the window.
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (pendingRef.current !== NOTHING_PENDING) {
      setValue(pendingRef.current);
      pendingRef.current = NOTHING_PENDING;
    }
  }, []);

  useEffect(() => {
    if (!connectionId || !stateTopic) return undefined;

    const manager = StreamConnectionManager.getInstance();
    const unsubscribe = manager.subscribe(connectionId, (record) => {
      // Filter to our topic
      if (record.topic && record.topic !== stateTopic) return;

      const raw = extractStateValue(record, stateField, fallbackFields);
      if (raw === undefined) return;

      const fn = transformRef.current;
      const final = fn ? fn(raw) : raw;

      // While suppressing (we just sent a command), DEFER rather than drop.
      //
      // Dropping meant the control that issued the write went blind for the
      // whole window and then only recovered on the NEXT message — so a
      // control the user had just interacted with lagged visibly behind a
      // passive one watching the same device, which is backwards. Keeping the
      // latest value and applying it when the window closes preserves the
      // optimistic update (no flicker back to the old value mid-round-trip)
      // and still converges promptly.
      if (Date.now() < suppressRef.current) {
        pendingRef.current = final;
        if (!flushTimerRef.current) {
          const wait = Math.max(0, suppressRef.current - Date.now());
          flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null;
            if (pendingRef.current !== NOTHING_PENDING) {
              setValue(pendingRef.current);
              pendingRef.current = NOTHING_PENDING;
            }
          }, wait);
        }
        return;
      }

      // A live message supersedes anything queued.
      pendingRef.current = NOTHING_PENDING;
      setValue(final);
    }, {
      topics: stateTopic,
      onConnect: () => setConnected(true),
      onDisconnect: () => setConnected(false)
    });

    return () => {
      unsubscribe();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current = NOTHING_PENDING;
    };
    // `transform` is deliberately NOT a dependency — see transformRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, stateTopic, stateField, fallbackFields.join(',')]);

  return { value, setValue, connected, suppress, clearSuppress, stateTopic };
}

export default useControlState;
