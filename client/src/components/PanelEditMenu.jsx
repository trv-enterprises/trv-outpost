// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@carbon/react';
import { ChevronDown, Edit, Add, Catalog, TextFont } from '@carbon/icons-react';
import AiIcon from './icons/AiIcon';
import { useAIAvailability } from '../context/AIAvailabilityContext';
import './PanelEditMenu.scss';

/**
 * PanelEditMenu Component
 *
 * Single-column dropdown menu for editing panel contents.
 * Shows unified options for components (displays and controls):
 * - Edit Component (if hasExisting)
 * - Edit with AI (if hasExisting)
 * - New Component
 * - New with AI
 * - Select Existing
 *
 * @param {string} buttonLabel - Label for the menu button (default: "Edit")
 * @param {string} buttonKind - Kind for the menu button (default: "secondary")
 * @param {string} buttonSize - Size for the menu button (default: "sm")
 * @param {boolean} hasExisting - Whether the panel already has a component assigned
 * @param {Function} onEdit - Handler for editing the existing component (only when hasExisting=true)
 * @param {Function} onEditWithAI - Handler for editing with AI (only when hasExisting=true)
 * @param {Function} onNew - Handler for creating a new component manually
 * @param {Function} onNewWithAI - Handler for creating a component with AI (opens pre-flight modal)
 * @param {Function} onSelectExisting - Handler for selecting an existing component
 */
function PanelEditMenu({
  buttonLabel = 'Edit',
  buttonKind = 'secondary',
  buttonSize = 'sm',
  minimal = false,
  minimalIcon = null, // Custom icon for minimal mode (defaults to ChevronDown)
  hasExisting = false,
  onEdit,
  onEditWithAI,
  onNew,
  onNewWithAI,
  onSelectExisting,
  onText
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState({});
  const menuRef = useRef(null);
  const buttonRef = useRef(null);
  const dropdownRef = useRef(null);
  // AI menu items only render when the server reports the agent is
  // available (i.e. ANTHROPIC_API_KEY is set). Hide-while-loading
  // (the useAIAvailability default) avoids a flash of AI items
  // before the boot fetch resolves.
  const { enabled: aiEnabled } = useAIAvailability();

  // Calculate dropdown position when opened
  // Use requestAnimationFrame to ensure we get the correct position after render
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const updatePosition = () => {
        const buttonRect = buttonRef.current.getBoundingClientRect();
        const dropdownWidth = 200; // min-width from CSS
        // Rough item heights for the "would the dropdown overflow
        // below the viewport?" check. Each visible item ≈ 36px.
        // The "Edit with AI" and "New with AI" items disappear when
        // AI is disabled, so trim the estimate accordingly.
        const hiddenAiItems = aiEnabled ? 0 : (hasExisting ? 2 : 1);
        const dropdownHeight = (hasExisting ? 220 : 140) - hiddenAiItems * 36;

        // Position below the button, centered horizontally
        // getBoundingClientRect() returns visual (screen) coordinates, which is what we want for fixed positioning
        let left = buttonRect.left + (buttonRect.width / 2) - (dropdownWidth / 2);
        let top = buttonRect.bottom + 4;

        // Keep dropdown within viewport bounds
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Adjust horizontal position if needed
        if (left < 8) {
          left = 8;
        } else if (left + dropdownWidth > viewportWidth - 8) {
          left = viewportWidth - dropdownWidth - 8;
        }

        // If dropdown would go below viewport, position above button instead
        if (top + dropdownHeight > viewportHeight - 8) {
          top = buttonRect.top - dropdownHeight - 4;
        }

        setDropdownStyle({
          top: `${top}px`,
          left: `${left}px`
        });
      };

      // Update position immediately and on scroll/resize
      updatePosition();

      // Also update if the grid scrolls (the panel-grid-container)
      const handleScroll = () => updatePosition();
      const container = buttonRef.current.closest('.panel-grid-container');
      if (container) {
        container.addEventListener('scroll', handleScroll);
      }
      window.addEventListener('resize', handleScroll);

      return () => {
        if (container) {
          container.removeEventListener('scroll', handleScroll);
        }
        window.removeEventListener('resize', handleScroll);
      };
    }
  }, [isOpen, hasExisting, aiEnabled]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target) &&
          dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleAction = (action) => {
    setIsOpen(false);
    if (action) action();
  };

  // Render dropdown content
  const dropdownContent = isOpen ? (
    <div className="panel-edit-menu-dropdown" ref={dropdownRef} style={dropdownStyle}>
      {/* Edit existing component options (only shown when hasExisting) */}
      {hasExisting && onEdit && (
        <button
          className="panel-edit-menu-item"
          onClick={() => handleAction(onEdit)}
        >
          <Edit size={16} />
          <span>Edit Component</span>
        </button>
      )}
      {aiEnabled && hasExisting && onEditWithAI && (
        <button
          className="panel-edit-menu-item"
          onClick={() => handleAction(onEditWithAI)}
        >
          <AiIcon size={16} />
          <span>Edit with AI</span>
        </button>
      )}

      {/* Divider between edit and create options */}
      {hasExisting && <div className="panel-edit-menu-divider" />}

      {/* Create new component options */}
      <button
        className="panel-edit-menu-item"
        onClick={() => handleAction(onNew)}
      >
        <Add size={16} />
        <span>New Component</span>
      </button>
      {aiEnabled && (
        <button
          className="panel-edit-menu-item"
          onClick={() => handleAction(onNewWithAI)}
        >
          <AiIcon size={16} />
          <span>New with AI</span>
        </button>
      )}
      <button
        className="panel-edit-menu-item"
        onClick={() => handleAction(onSelectExisting)}
      >
        <Catalog size={16} />
        <span>Select Existing</span>
      </button>

      {/* Divider before text option */}
      <div className="panel-edit-menu-divider" />
      <button
        className="panel-edit-menu-item"
        onClick={(e) => { setIsOpen(false); if (onText) onText(e); }}
      >
        <TextFont size={16} />
        <span>Text</span>
      </button>
    </div>
  ) : null;

  return (
    <div className={`panel-edit-menu ${minimal ? 'panel-edit-menu--minimal' : ''}`} ref={menuRef}>
      <div ref={buttonRef}>
        {minimal ? (
          <button
            className={`panel-edit-menu-chevron-btn ${isOpen ? 'open' : ''}`}
            onClick={() => setIsOpen(!isOpen)}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {minimalIcon || <ChevronDown size={16} />}
          </button>
        ) : (
          <Button
            kind={buttonKind}
            size={buttonSize}
            onClick={() => setIsOpen(!isOpen)}
            renderIcon={() => <ChevronDown size={16} className={`panel-edit-menu-chevron ${isOpen ? 'open' : ''}`} />}
          >
            {buttonLabel}
          </Button>
        )}
      </div>

      {/* Render dropdown via portal to escape transformed parents */}
      {dropdownContent && createPortal(dropdownContent, document.body)}
    </div>
  );
}

export default PanelEditMenu;
