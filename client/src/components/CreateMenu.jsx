// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useRef, useState, useEffect } from 'react';
import { Button } from '@carbon/react';
import { ChevronDown, Edit, Add, Catalog } from '@carbon/icons-react';
import AiIcon from './icons/AiIcon';
import './CreateMenu.scss';

/**
 * CreateMenu Component
 *
 * Simple dropdown menu for creating components with three options:
 * - Create: Opens ComponentEditor (which has ContentSwitcher for Display/Control)
 * - Create with AI: Opens AI Pre-flight modal
 * - From Existing: Opens ComponentPickerModal
 *
 * @param {Function} onCreate - Handler for creating a new component manually
 * @param {Function} onCreateWithAI - Handler for creating with AI (opens pre-flight modal)
 * @param {Function} onSelectExisting - Handler for selecting an existing component
 */
function CreateMenu({
  onCreate,
  onCreateWithAI,
  onSelectExisting
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

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
          <button
            className="create-menu-item"
            onClick={() => handleAction(onCreateWithAI)}
          >
            <AiIcon size={16} />
            <span>Create with AI</span>
          </button>
          <button
            className="create-menu-item"
            onClick={() => handleAction(onSelectExisting)}
          >
            <Catalog size={16} />
            <span>From Existing</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default CreateMenu;
