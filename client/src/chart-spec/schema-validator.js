// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * @typedef {Object} ChartTypeSpecDisplay
 * @property {string} label
 * @property {string} icon
 * @property {string} [description]
 */

/**
 * @typedef {Object} ChartTypeSpecCapabilities
 * @property {boolean} [requires_x_axis]
 * @property {boolean} [requires_y_axis]
 * @property {boolean} [multiple_y_axis]
 * @property {boolean} [single_axis_n_columns]
 * @property {boolean} [has_pivot_series]
 * @property {boolean} [has_series_column]
 * @property {boolean} [has_axis_labels]
 * @property {boolean} [has_x_axis_format]
 * @property {boolean} [has_time_bucket]
 * @property {boolean} [has_sort_limit]
 * @property {boolean} [has_visible_columns]
 * @property {boolean} [has_filters]
 * @property {boolean} [has_aggregation]
 * @property {boolean} [has_sliding_window]
 * @property {boolean} [has_legend_config]
 * @property {boolean} [has_tooltip_config]
 * @property {boolean} [has_axis_range]
 * @property {boolean} [has_thresholds]
 */

/**
 * @typedef {Object} VisibleWhen
 * @property {string} field
 * @property {'eq'|'neq'|'in'|'not_in'|'truthy'|'falsy'|'not_empty'} operator
 * @property {*} [value]
 */

/**
 * @typedef {Object} FieldSpecEnumOption
 * @property {*} value
 * @property {string} label
 */

/**
 * @typedef {Object} FieldSpec
 * @property {string} id
 * @property {string} binds         dot-path into the saved component shape
 * @property {'column_select'|'column_multi_select'|'enum'|'text'|'number'|'boolean'|'slider'|'code'|'nullable_number'|'y_axis_columns_list'|'threshold_list'} type
 * @property {string} label
 * @property {boolean} [required]
 * @property {string} [helperText]
 * @property {string} [placeholder]
 * @property {*} [default]
 * @property {FieldSpecEnumOption[]} [options]   for enum
 * @property {number} [min]                       for number / slider / nullable_number
 * @property {number} [max]                       for number / slider / nullable_number
 * @property {number} [step]                      for number / slider / nullable_number
 * @property {VisibleWhen} [visibleWhen]
 */

/**
 * @typedef {Object} SectionSpec
 * @property {string} id
 * @property {string} label
 * @property {'single-column'|'row-2'|'row-3'|'row-4'|'full-width'|'inset-card'} [layout]
 * @property {boolean} [library_specific]
 * @property {FieldSpec[]} fields
 */

/**
 * @typedef {Object} CodegenSpec
 * @property {string} library            "echarts" today; "d3" / "vis-network" later
 * @property {string} [template_id]      legacy Stage-1 string-emitter dispatch key. Optional in Stage 2+ — specs that ship a buildOption render path don't need it.
 * @property {Object<string,*>} [template_bindings]
 */

/**
 * @typedef {Object} ChartTypeSpec
 * @property {string} schema_version
 * @property {string} chart_type
 * @property {string} library
 * @property {ChartTypeSpecDisplay} display
 * @property {ChartTypeSpecCapabilities} [capabilities]
 * @property {SectionSpec[]} sections
 * @property {CodegenSpec} [codegen]   Optional in Stage 2+. Stage 1 specs (gauge) still ship a codegen block with template_id; Stage 2+ specs use the spec_name → buildOption registry instead.
 */

// Validator. Hand-rolled — keeps the editor dep-free; AJV (~30KB) can
// land later if validation needs grow. Errors are collected and
// returned as a list so a single bad spec doesn't mask others.

const SUPPORTED_SCHEMA_VERSIONS = new Set(['1']);
// 'echarts' = buildOption returns an ECharts option (the common case).
// 'react'   = buildOption returns a tagged { render, props } view
//             descriptor rendered by a registered non-ECharts React view
//             (number, dataview, …). See
//             docs/design-notes/spec-driven-non-echarts-views.md.
const SUPPORTED_LIBRARIES = new Set(['echarts', 'react']);
const SUPPORTED_FIELD_TYPES = new Set([
  // Stage 1
  'column_select',
  'column_multi_select',
  'enum',
  'text',
  'number',
  'boolean',
  'slider',
  'code',
  // Stage 2 additions
  'nullable_number',     // Carbon checkbox-inline-with-NumberInput; null = auto, number = manual
  'y_axis_columns_list', // free list of { column, stack, axis? } entries
  'threshold_list',      // free list of { value, color, label? } entries
  'column_manager',      // dataview: visible-columns checklist + reorder + per-column alias
  'band_scheme',         // banded_bar: scheme selector + per-scheme band-column mappings
]);
const SUPPORTED_LAYOUTS = new Set([
  'single-column',
  'row-2',
  'row-3',
  'row-4',
  'full-width',
  'inset-card',
]);
const SUPPORTED_VW_OPERATORS = new Set([
  'eq',
  'neq',
  'in',
  'not_in',
  'truthy',
  'falsy',
  'not_empty',
]);

function pushErr(errors, path, msg) {
  errors.push(`${path}: ${msg}`);
}

function validateField(field, path, errors, sectionFieldIds) {
  if (!field || typeof field !== 'object') {
    pushErr(errors, path, 'must be an object');
    return;
  }
  if (typeof field.id !== 'string' || !field.id) {
    pushErr(errors, path, 'missing "id"');
  } else if (sectionFieldIds.has(field.id)) {
    pushErr(errors, path, `duplicate field id "${field.id}" within spec`);
  } else {
    sectionFieldIds.add(field.id);
  }
  if (typeof field.binds !== 'string' || !field.binds) {
    pushErr(errors, path, 'missing "binds" (dot-path into saved record)');
  }
  if (!SUPPORTED_FIELD_TYPES.has(field.type)) {
    pushErr(errors, path, `unsupported field type "${field.type}"`);
  }
  if (typeof field.label !== 'string' || !field.label) {
    pushErr(errors, path, 'missing "label"');
  }
  if (field.type === 'enum') {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      pushErr(errors, path, 'enum field must have non-empty options[]');
    } else {
      field.options.forEach((opt, i) => {
        if (!opt || typeof opt !== 'object') {
          pushErr(errors, `${path}.options[${i}]`, 'must be { value, label }');
        } else if (typeof opt.label !== 'string') {
          pushErr(errors, `${path}.options[${i}]`, 'missing "label"');
        }
      });
    }
  }
  if (field.visibleWhen) {
    if (typeof field.visibleWhen !== 'object') {
      pushErr(errors, `${path}.visibleWhen`, 'must be an object');
    } else {
      const vw = field.visibleWhen;
      if (typeof vw.field !== 'string') {
        pushErr(errors, `${path}.visibleWhen.field`, 'missing or not a string');
      }
      if (!SUPPORTED_VW_OPERATORS.has(vw.operator)) {
        pushErr(errors, `${path}.visibleWhen.operator`, `unsupported operator "${vw.operator}"`);
      }
    }
  }
}

function validateSection(section, path, errors, allFieldIds, depth = 0) {
  if (!section || typeof section !== 'object') {
    pushErr(errors, path, 'must be an object');
    return;
  }
  if (typeof section.id !== 'string' || !section.id) {
    pushErr(errors, path, 'missing "id"');
  }
  if (typeof section.label !== 'string' || !section.label) {
    pushErr(errors, path, 'missing "label"');
  }
  if (section.layout && !SUPPORTED_LAYOUTS.has(section.layout)) {
    pushErr(errors, `${path}.layout`, `unsupported layout "${section.layout}"`);
  }
  // section.visibleWhen on subsections lets a whole subsection be
  // gated on a sibling field (e.g. right-y-range subsection appears
  // only when multipleYAxis is on).
  if (section.visibleWhen) {
    if (typeof section.visibleWhen !== 'object') {
      pushErr(errors, `${path}.visibleWhen`, 'must be an object');
    } else {
      const vw = section.visibleWhen;
      if (typeof vw.field !== 'string') {
        pushErr(errors, `${path}.visibleWhen.field`, 'missing or not a string');
      }
      if (!SUPPORTED_VW_OPERATORS.has(vw.operator)) {
        pushErr(errors, `${path}.visibleWhen.operator`, `unsupported operator "${vw.operator}"`);
      }
    }
  }
  const hasFields = Array.isArray(section.fields) && section.fields.length > 0;
  const hasSubsections = Array.isArray(section.subsections) && section.subsections.length > 0;
  if (hasFields && hasSubsections) {
    pushErr(errors, path, 'must have either "fields" or "subsections", not both');
    return;
  }
  if (!hasFields && !hasSubsections) {
    pushErr(errors, path, 'must have a non-empty "fields" or "subsections" array');
    return;
  }
  if (depth > 1) {
    pushErr(errors, path, 'subsection nesting limited to one level (h4 → h5)');
    return;
  }
  if (hasFields) {
    section.fields.forEach((field, i) => {
      validateField(field, `${path}.fields[${i}]`, errors, allFieldIds);
    });
  } else {
    section.subsections.forEach((sub, i) => {
      validateSection(sub, `${path}.subsections[${i}]`, errors, allFieldIds, depth + 1);
    });
  }
}

/**
 * Cross-field check: visibleWhen.field must reference a field id
 * that exists somewhere in the spec. Walks sections + subsections
 * after every field has been collected so forward references work.
 */
function collectFieldIds(section, out) {
  if (Array.isArray(section.fields)) section.fields.forEach((f) => f.id && out.add(f.id));
  if (Array.isArray(section.subsections)) section.subsections.forEach((s) => collectFieldIds(s, out));
}

function checkVisibleWhen(section, path, known, errors) {
  if (section.visibleWhen && typeof section.visibleWhen.field === 'string' && !known.has(section.visibleWhen.field)) {
    pushErr(errors, `${path}.visibleWhen.field`, `references unknown field id "${section.visibleWhen.field}" — must match an existing field in this spec`);
  }
  if (Array.isArray(section.fields)) {
    section.fields.forEach((field, fi) => {
      const vw = field.visibleWhen;
      if (vw && typeof vw.field === 'string' && !known.has(vw.field)) {
        pushErr(errors, `${path}.fields[${fi}].visibleWhen.field`, `references unknown field id "${vw.field}" — must match an existing field in this spec`);
      }
    });
  }
  if (Array.isArray(section.subsections)) {
    section.subsections.forEach((s, si) => checkVisibleWhen(s, `${path}.subsections[${si}]`, known, errors));
  }
}

function validateVisibleWhenRefs(spec, errors) {
  if (!Array.isArray(spec.sections)) return;
  const known = new Set();
  spec.sections.forEach((s) => collectFieldIds(s, known));
  spec.sections.forEach((section, si) => checkVisibleWhen(section, `sections[${si}]`, known, errors));
}

/**
 * Validate a ChartTypeSpec object. Returns an array of error strings —
 * empty array means the spec is valid. Caller decides what to do with
 * errors (throw in dev, log in prod).
 *
 * @param {ChartTypeSpec} spec
 * @returns {string[]}
 */
export function validateChartTypeSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') {
    return ['spec: must be an object'];
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(spec.schema_version)) {
    pushErr(errors, 'schema_version', `unsupported version "${spec.schema_version}" (expected one of: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')})`);
  }
  if (typeof spec.chart_type !== 'string' || !spec.chart_type) {
    pushErr(errors, 'chart_type', 'missing or empty');
  }
  if (!SUPPORTED_LIBRARIES.has(spec.library)) {
    pushErr(errors, 'library', `unsupported library "${spec.library}" (expected one of: ${[...SUPPORTED_LIBRARIES].join(', ')})`);
  }
  if (!spec.display || typeof spec.display !== 'object') {
    pushErr(errors, 'display', 'missing or not an object');
  } else {
    if (typeof spec.display.label !== 'string') pushErr(errors, 'display.label', 'must be a string');
    if (typeof spec.display.icon !== 'string') pushErr(errors, 'display.icon', 'must be a string');
  }
  if (!Array.isArray(spec.sections) || spec.sections.length === 0) {
    pushErr(errors, 'sections', 'must be a non-empty array');
  } else {
    const allFieldIds = new Set();
    spec.sections.forEach((section, i) => {
      validateSection(section, `sections[${i}]`, errors, allFieldIds);
    });
    validateVisibleWhenRefs(spec, errors);
  }
  // codegen block is OPTIONAL in Stage 2+. Stage 1 specs (gauge)
  // still ship a string-emitter template_id; Stage 2+ specs use the
  // spec_name → buildOption registry under chart-spec/specs/<type>.js
  // and don't need this block. When present, validate its shape.
  if (spec.codegen !== undefined) {
    if (typeof spec.codegen !== 'object' || spec.codegen === null) {
      pushErr(errors, 'codegen', 'must be an object when present');
    } else {
      if (!SUPPORTED_LIBRARIES.has(spec.codegen.library)) {
        pushErr(errors, 'codegen.library', `unsupported library "${spec.codegen.library}"`);
      }
      if (spec.codegen.template_id !== undefined && (typeof spec.codegen.template_id !== 'string' || !spec.codegen.template_id)) {
        pushErr(errors, 'codegen.template_id', 'must be a non-empty string when present');
      }
      if (spec.codegen.template_bindings !== undefined && (typeof spec.codegen.template_bindings !== 'object' || spec.codegen.template_bindings === null)) {
        pushErr(errors, 'codegen.template_bindings', 'must be an object when present');
      }
    }
  }
  return errors;
}

/**
 * Validates and throws in dev mode if invalid. In production, logs the
 * errors but doesn't throw — broken specs would already have been
 * caught at merge time, and a throw would crash the editor.
 *
 * @param {ChartTypeSpec} spec
 * @param {string} sourceLabel  e.g. "gauge.json" — included in errors
 * @returns {ChartTypeSpec}
 */
export function assertValidChartTypeSpec(spec, sourceLabel = 'spec') {
  const errors = validateChartTypeSpec(spec);
  if (errors.length === 0) return spec;
  const isDev = import.meta?.env?.DEV ?? false;
  const msg = `Invalid ChartTypeSpec (${sourceLabel}):\n  - ${errors.join('\n  - ')}`;
  if (isDev) {
    // eslint-disable-next-line no-console
    console.error(msg);
    throw new Error(msg);
  }
  // eslint-disable-next-line no-console
  console.error(msg);
  return spec;
}
