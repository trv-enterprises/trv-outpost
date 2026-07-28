// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useRef, useState, useEffect } from 'react';
import { Button } from '@carbon/react';
import { ChevronDown, Edit, Catalog } from '@carbon/icons-react';
import AiIcon from './icons/AiIcon';
import { useAIAvailability } from '../context/AIAvailabilityContext';
import './CreateMenu.scss';

/**
 * CreateMenu Component
 *
 * Create control for an entity, with up to three options:
 * - Create: opens the editor for a blank entity
 * - Create with AI: opens the AI pre-flight modal — only rendered when an
 *   onCreateWithAI handler is supplied AND the deployment has an AI key.
 *   (Omit the handler for entities with no AI builder, e.g. connections.)
 * - From Existing: opens the matching picker modal — only rendered when an
 *   onSelectExisting handler is supplied.
 *
 * Components and connections no longer pass onSelectExisting: the per-row
 * duplicate action on their list/tile views replaced it and needs no extra
 * selector (issue #203). The ts-store alert rules list still uses it — its
 * rules aren't a first-class list entity with row actions.
 *
 * When only "Create" is available the dropdown collapses to a plain primary
 * button — a one-item menu is pure friction.
 *
 * @param {Function} onCreate         - Handler for creating a new entity manually
 * @param {Function} [onCreateWithAI]  - Handler for creating with AI; omit to hide the item
 * @param {Function} [onSelectExisting] - Handler for cloning an existing entity; omit to hide the item
 */
function CreateMenu({
  onCreate,
  onCreateWithAI,
  onSelectExisting
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  // Hide "Create with AI" when the deployment has no Anthropic key.
  // Hide-while-loading (the default) avoids a flash of the item.
  const { enabled: aiEnabled } = useAIAvailability();

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
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
    action();
  };

  const showAI = Boolean(onCreateWithAI) && aiEnabled;
  const showExisting = Boolean(onSelectExisting);

  // Single-action case: no menu, just the button.
  if (!showAI && !showExisting) {
    return (
      <Button kind="primary" size="md" onClick={onCreate}>
        Create
      </Button>
    );
  }

  return (
    <div className="create-menu" ref={menuRef}>
      <Button
        kind="primary"
        size="md"
        onClick={() => setIsOpen(!isOpen)}
        renderIcon={() => <ChevronDown size={16} className={`create-menu-chevron ${isOpen ? 'open' : ''}`} />}
      >
        Create
      </Button>

      {isOpen && (
        <div className="create-menu-dropdown">
          <button
            className="create-menu-item"
            onClick={() => handleAction(onCreate)}
          >
            <Edit size={16} />
            <span>Create</span>
          </button>
          {showAI && (
            <button
              className="create-menu-item"
              onClick={() => handleAction(onCreateWithAI)}
            >
              <AiIcon size={16} />
              <span>Create with AI</span>
            </button>
          )}
          {showExisting && (
            <button
              className="create-menu-item"
              onClick={() => handleAction(onSelectExisting)}
            >
              <Catalog size={16} />
              <span>From Existing</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default CreateMenu;
