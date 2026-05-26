// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useState } from 'react';

const STORAGE_KEY = 'assistant.prefs';

const DEFAULTS = {
  // When true, the AssistantToolCallCard mounts in its expanded
  // state. False (default) keeps tool calls collapsed until the
  // user clicks one — matches the design doc's stance that
  // "configure 6 things" turns are unreadable with everything inline.
  expandToolCalls: false,
  // When true, surface per-conversation input/output token counts
  // at the bottom of the sidecard. Off by default to avoid
  // crowding the chrome; power users opt in.
  showTokenUsage: false,
};

function readStored() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

/**
 * useAssistantPreferences — small browser-local store for the
 * assistant's UI preferences. These aren't server-synced because
 * they're cosmetic per-device choices; the server doesn't care
 * about expand-tool-calls or token-usage visibility.
 *
 * Adding a new pref:
 *   1. Add to DEFAULTS above.
 *   2. Expose the corresponding boolean + setter via the hook's
 *      return value.
 *   3. The consumer flips it via toggle<X>().
 */
export default function useAssistantPreferences() {
  const [prefs, setPrefs] = useState(readStored);

  const update = useCallback((patch) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable — keep the in-memory value
      }
      return next;
    });
  }, []);

  const toggleExpandToolCalls = useCallback(
    () => update({ expandToolCalls: !prefs.expandToolCalls }),
    [prefs.expandToolCalls, update]
  );
  const toggleShowTokenUsage = useCallback(
    () => update({ showTokenUsage: !prefs.showTokenUsage }),
    [prefs.showTokenUsage, update]
  );

  return {
    ...prefs,
    toggleExpandToolCalls,
    toggleShowTokenUsage,
  };
}
