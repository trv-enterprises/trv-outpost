// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ErrorFilled } from '@carbon/icons-react';
import './NameErrorBadge.scss';

/**
 * NameErrorBadge
 *
 * Inline red error icon that shows the full error message in a
 * tooltip on hover. The tooltip is rendered via portal to document.body
 * so it can escape any ancestor `overflow: hidden` (e.g., the dashboard
 * toolbar's container clips its own children, which would otherwise
 * crop the tooltip popover).
 *
 * Used for compact form-validation surfaces where there isn't vertical
 * room for an inline error message — header strips, list-row badges.
 *
 * Props:
 *   message — string error to display in the tooltip
 */
export default function NameErrorBadge({ message }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);

  const show = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 6,
        left: rect.left,
      });
    }
    setOpen(true);
  };
  const hide = () => setOpen(false);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="name-error-badge__icon"
        aria-label={message}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <ErrorFilled size={20} />
      </button>
      {open && createPortal(
        <span
          className="name-error-badge__tip"
          role="tooltip"
          style={{ top: pos.top, left: pos.left }}
        >
          {message}
        </span>,
        document.body
      )}
    </>
  );
}
