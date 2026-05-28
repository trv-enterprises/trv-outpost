// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { SpecRenderContext } from './SpecContext';
import { getFieldRenderer } from './field-types';
import { isVisible } from './binding';

// Layout primitive → per-field column class. Reuses the existing
// .metadata-col modifiers from ComponentEditor.scss so the spec-
// driven sections visually match the rest of the editor.
const LAYOUT_COL_CLASS = {
  'single-column': 'metadata-col metadata-col--full',
  'row-2': 'metadata-col metadata-col--half',
  'row-3': 'metadata-col metadata-col--third', // see scss extension below
  'row-4': 'metadata-col metadata-col--quarter',
  'full-width': 'metadata-col metadata-col--full',
  'inset-card': 'metadata-col metadata-col--full',
};

function colClassForLayout(layout) {
  return LAYOUT_COL_CLASS[layout || 'single-column'] || 'metadata-col metadata-col--full';
}

function SpecField({ field }) {
  const Renderer = getFieldRenderer(field.type);
  if (!Renderer) {
    // eslint-disable-next-line no-console
    console.warn(`[chart-spec] no renderer for field type "${field.type}" (field ${field.id})`);
    return null;
  }
  return <Renderer field={field} />;
}

function SpecSection({ section, formState }) {
  const colClass = colClassForLayout(section.layout);
  const visibleFields = section.fields.filter((f) => isVisible(f.visibleWhen, formState));
  if (visibleFields.length === 0) return null;
  return (
    <div className="mapping-section spec-section">
      <h4>{section.label}</h4>
      <div className="metadata-row metadata-row--split spec-section__row">
        {visibleFields.map((field) => (
          <div key={field.id} className={colClass}>
            <SpecField field={field} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders all sections of a chart-type spec. Caller provides the
 * SpecRenderContext (availableColumns, formState, onFieldChange).
 *
 * @param {object} props
 * @param {object} props.spec
 * @param {string[]} props.availableColumns
 * @param {object} props.formState
 * @param {function} props.onFieldChange
 */
export default function SpecDrivenSections({ spec, availableColumns, formState, onFieldChange }) {
  if (!spec || !Array.isArray(spec.sections)) return null;
  const ctx = { availableColumns, formState, onFieldChange };
  return (
    <SpecRenderContext.Provider value={ctx}>
      {spec.sections.map((section) => (
        <SpecSection key={section.id} section={section} formState={formState} />
      ))}
    </SpecRenderContext.Provider>
  );
}
