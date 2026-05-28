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
  'row-3': 'metadata-col metadata-col--third',
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

/**
 * Renders the field list of a leaf section (one with `fields`, not
 * `subsections`). Handles per-field `visibleWhen` filtering and the
 * column-layout primitive.
 */
function SpecFieldRow({ section, formState }) {
  const colClass = colClassForLayout(section.layout);
  const visibleFields = (section.fields || []).filter((f) => isVisible(f.visibleWhen, formState));
  if (visibleFields.length === 0) return null;
  return (
    <div className="metadata-row metadata-row--split spec-section__row">
      {visibleFields.map((field) => (
        <div key={field.id} className={colClass}>
          <SpecField field={field} />
        </div>
      ))}
    </div>
  );
}

/**
 * Renders one subsection inside a parent tile. h5 heading + optional
 * helperText, then the field row. Subsections can also have their own
 * `visibleWhen` so an entire subsection can be hidden based on a
 * sibling field (e.g. "Right Y-axis range" subsection only when
 * Dual Y-axis is on).
 */
function SpecSubsection({ subsection, formState }) {
  if (!isVisible(subsection.visibleWhen, formState)) return null;
  return (
    <div className="spec-subsection">
      <h5 className="spec-subsection__heading">
        {subsection.label}
        {subsection.helperText && (
          <span className="spec-subsection__helper"> — {subsection.helperText}</span>
        )}
      </h5>
      <SpecFieldRow section={subsection} formState={formState} />
    </div>
  );
}

/**
 * Top-level section renderer. Two shapes:
 *
 *   Leaf (legacy): `fields[]` → one h4 + field row.
 *   Parent (Stage 2 reorg): `subsections[]` → one h4 tile that
 *   contains multiple h5-headed subsections.
 *
 * Either way the outer .mapping-section gives the section its tile
 * treatment (border, padding, max-width cap).
 */
function SpecSection({ section, formState }) {
  if (!isVisible(section.visibleWhen, formState)) return null;
  const isParent = Array.isArray(section.subsections) && section.subsections.length > 0;
  if (isParent) {
    return (
      <div className="mapping-section spec-section">
        <h4>{section.label}</h4>
        {section.subsections.map((sub) => (
          <SpecSubsection key={sub.id} subsection={sub} formState={formState} />
        ))}
      </div>
    );
  }
  return (
    <div className="mapping-section spec-section">
      <h4>{section.label}</h4>
      <SpecFieldRow section={section} formState={formState} />
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
