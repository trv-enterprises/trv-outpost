// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  TextInput,
  TextArea,
  Checkbox,
  Tag,
} from '@carbon/react';
import { Close } from '@carbon/icons-react';

const MAX_TITLE_LEN = 100;
const TITLE_TRUNCATE_AT = 50;

function deriveTitle(command) {
  const oneLine = String(command || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= TITLE_TRUNCATE_AT) return oneLine;
  return oneLine.slice(0, TITLE_TRUNCATE_AT - 1).trimEnd() + '…';
}

function normalizeTag(raw) {
  return String(raw || '').trim();
}

/**
 * Add/edit modal for a snippet. The host is the snippets panel; this
 * file owns nothing about list state or fetching — it just hands the
 * shaped payload back via `onSave`.
 *
 * Props:
 *   - open: boolean
 *   - mode: "add" | "edit"
 *   - initial: { title, command, tags, scope } — required for edit, used as seed for add
 *   - canCreateGlobal: bool — whether the caller has Manage capability
 *   - onClose: () => void
 *   - onSave: ({ scope, title, command, tags }) => Promise<void>
 */
export default function SnippetEditModal({
  open,
  mode,
  initial,
  canCreateGlobal,
  onClose,
  onSave,
}) {
  const isEdit = mode === 'edit';

  const initialTitle = initial?.title ?? '';
  const initialCommand = initial?.command ?? '';
  const initialTags = useMemo(() => initial?.tags ?? [], [initial]);
  const initialScope = initial?.scope ?? 'user';

  const [command, setCommand] = useState(initialCommand);
  const [title, setTitle] = useState(initialTitle);
  // `titleIsDerivative` flips to false the moment the user edits the
  // title manually; once user-edited the title stops auto-syncing to
  // the truncated command. iTerm has the same behavior.
  const [titleIsDerivative, setTitleIsDerivative] = useState(() => {
    if (isEdit) return false;
    return !initialTitle || initialTitle === deriveTitle(initialCommand);
  });
  const [tags, setTags] = useState(initialTags);
  const [pendingTag, setPendingTag] = useState('');
  const [scope, setScope] = useState(initialScope);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Reset all internal state when the modal opens. Without this, the
  // second time the user opens the modal it shows stale fields from
  // last time.
  useEffect(() => {
    if (!open) return;
    setCommand(initialCommand);
    setTitle(initialTitle);
    setTitleIsDerivative(!isEdit && (!initialTitle || initialTitle === deriveTitle(initialCommand)));
    setTags(initialTags);
    setPendingTag('');
    setScope(initialScope);
    setSaving(false);
    setError(null);
  }, [open, isEdit, initialTitle, initialCommand, initialTags, initialScope]);

  // Keep the title in sync with the command while it's still derivative.
  useEffect(() => {
    if (titleIsDerivative) {
      setTitle(deriveTitle(command));
    }
  }, [command, titleIsDerivative]);

  const commitPendingTag = () => {
    const t = normalizeTag(pendingTag);
    if (!t) return;
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setPendingTag('');
      return;
    }
    setTags([...tags, t]);
    setPendingTag('');
  };

  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (pendingTag.trim()) {
        e.preventDefault();
        commitPendingTag();
      }
    } else if (e.key === 'Backspace' && !pendingTag && tags.length > 0) {
      // Backspace on an empty input deletes the last chip — chip-input
      // convention. iTerm has the same behavior.
      setTags(tags.slice(0, -1));
    }
  };

  const removeTag = (idx) => {
    setTags(tags.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    const trimmedTitle = title.trim();
    const trimmedCommand = command.trim();
    if (!trimmedTitle) {
      setError('Title is required');
      return;
    }
    if (!trimmedCommand) {
      setError('Command is required');
      return;
    }
    if (trimmedTitle.length > MAX_TITLE_LEN) {
      setError(`Title must be ${MAX_TITLE_LEN} characters or fewer`);
      return;
    }
    // Commit any pending tag the user typed but didn't press Enter on.
    const finalTags = pendingTag.trim()
      ? [...tags.filter((t) => t.toLowerCase() !== pendingTag.trim().toLowerCase()), pendingTag.trim()]
      : tags;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        scope,
        title: trimmedTitle,
        command: trimmedCommand,
        tags: finalTags,
      });
      // Parent closes on success.
    } catch (err) {
      setSaving(false);
      setError(err?.message || 'Failed to save snippet');
    }
  };

  if (!open) return null;

  return (
    <Modal
      open
      onRequestClose={onClose}
      modalHeading={isEdit ? 'Edit snippet' : 'New snippet'}
      primaryButtonText={saving ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      onRequestSubmit={handleSubmit}
      primaryButtonDisabled={saving || !title.trim() || !command.trim()}
      size="sm"
      preventCloseOnClickOutside
    >
      <div className="snippet-edit-modal__field">
        <TextInput
          id="snippet-edit-title"
          labelText="Title"
          value={title}
          maxLength={MAX_TITLE_LEN}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleIsDerivative(false);
          }}
          autoFocus
        />
      </div>

      <div className="snippet-edit-modal__field snippet-edit-modal__tags-field">
        <label className="cds--label" htmlFor="snippet-edit-tag-input">Tags</label>
        <div className="snippet-edit-modal__tags">
          {tags.map((t, idx) => (
            <Tag key={`${t}-${idx}`} type="cool-gray" filter onClose={() => removeTag(idx)}>
              {t}
            </Tag>
          ))}
          <input
            id="snippet-edit-tag-input"
            className="snippet-edit-modal__tag-input"
            type="text"
            value={pendingTag}
            placeholder={tags.length === 0 ? 'add tag…' : ''}
            onChange={(e) => setPendingTag(e.target.value)}
            onKeyDown={handleTagKeyDown}
            onBlur={() => {
              if (pendingTag.trim()) commitPendingTag();
            }}
            autoComplete="off"
          />
        </div>
        <p className="snippet-edit-modal__hint">
          Tags become folders in the panel. Press Enter, comma, or Tab to add a tag.
        </p>
      </div>

      <div className="snippet-edit-modal__field">
        <TextArea
          id="snippet-edit-command"
          labelText="Command"
          rows={6}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="snippet-edit-modal__field">
        <Checkbox
          id="snippet-edit-global"
          labelText="Global — visible to all users"
          checked={scope === 'global'}
          disabled={!canCreateGlobal || isEdit}
          onChange={(_, { checked }) => setScope(checked ? 'global' : 'user')}
        />
        {!canCreateGlobal && (
          <p className="snippet-edit-modal__hint">
            Global snippets require Manage capability.
          </p>
        )}
        {isEdit && (
          <p className="snippet-edit-modal__hint">
            Scope is immutable. Delete and re-create to change scope.
          </p>
        )}
      </div>

      {error && (
        <div className="snippet-edit-modal__error">
          <Close size={16} /> {error}
        </div>
      )}
    </Modal>
  );
}
