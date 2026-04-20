// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useRef, useState } from 'react';
import { TextInput } from '@carbon/react';

// Backend sentinel returned on GET for "a secret is set but not exposed".
// Must match server-go/internal/models/datasource.go `SecretMaskedValue`.
export const SECRET_MASKED_VALUE = '********';

// Visible placeholder in the input when the stored value is the backend
// sentinel. Longer than the sentinel on purpose — makes it obvious the
// field is populated without leaking length. The client never sends this
// visible string; on save we send the 8-char SECRET_MASKED_VALUE to
// signal "keep existing" to the server.
const VISIBLE_MASK = '****************************';

/**
 * SecretTextInput
 *
 * Password-manager-style editor for server-masked secrets.
 *
 * - If `value === SECRET_MASKED_VALUE`, the field renders `VISIBLE_MASK`
 *   so users see a populated field instead of an empty one.
 * - On focus, the masked sentinel is cleared internally so the user
 *   types fresh. If they blur without typing, we restore the sentinel
 *   and call onChange('********') so the caller can round-trip it to
 *   the server to preserve the current secret.
 * - Any typed value (including a single space) replaces the secret.
 * - The only way to actually clear a secret is to type something
 *   non-sentinel (e.g. a space) — clearing the field back to empty
 *   preserves the existing secret, matching the user's requested UX.
 *
 * Props mirror Carbon's TextInput (id, labelText, placeholder).
 */
export default function SecretTextInput({
  value,
  onChange,
  placeholder,
  ...rest
}) {
  const wasMaskedRef = useRef(value === SECRET_MASKED_VALUE);
  const [focused, setFocused] = useState(false);

  const isMasked = value === SECRET_MASKED_VALUE;

  const displayValue = isMasked && !focused
    ? VISIBLE_MASK
    : (value || '');

  const handleFocus = () => {
    setFocused(true);
    if (isMasked) {
      wasMaskedRef.current = true;
      // Clear the underlying state so the user types fresh.
      onChange({ target: { value: '' } });
    }
  };

  const handleBlur = (e) => {
    setFocused(false);
    if (wasMaskedRef.current && (value === '' || value == null)) {
      // User focused, typed nothing — restore the sentinel so the save
      // path keeps the existing secret.
      onChange({ target: { value: SECRET_MASKED_VALUE } });
    }
    wasMaskedRef.current = (e.target.value === SECRET_MASKED_VALUE);
  };

  const handleChange = (e) => {
    // Real user input — mark that we're no longer in masked state.
    wasMaskedRef.current = false;
    onChange(e);
  };

  return (
    <TextInput
      {...rest}
      type="password"
      value={displayValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      placeholder={placeholder || ''}
      autoComplete="new-password"
    />
  );
}
