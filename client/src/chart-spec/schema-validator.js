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
 * @property {boolean} [has_series_column]
 * @property {boolean} [has_axis_labels]
 * @property {boolean} [has_x_axis_format]
 * @property {boolean} [has_time_bucket]
 * @property {boolean} [has_sort_limit]
 * @property {boolean} [has_visible_columns]
 * @property {boolean} [has_filters]
 * @property {boolean} [has_aggregation]
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
 * @property {'column_select'|'column_multi_select'|'enum'|'text'|'number'|'boolean'|'slider'|'code'} type
 * @property {string} label
 * @property {boolean} [required]
 * @property {string} [helperText]
 * @property {string} [placeholder]
 * @property {*} [default]
 * @property {FieldSpecEnumOption[]} [options]   for enum
 * @property {number} [min]                       for number / slider
 * @property {number} [max]                       for number / slider
 * @property {number} [step]                      for number / slider
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
 * @property {string} template_id        registry key for the template module
 * @property {Object<string,*>} template_bindings
 */

/**
 * @typedef {Object} ChartTypeSpec
 * @property {string} schema_version
 * @property {string} chart_type
 * @property {string} library
 * @property {ChartTypeSpecDisplay} display
 * @property {ChartTypeSpecCapabilities} [capabilities]
 * @property {SectionSpec[]} sections
 * @property {CodegenSpec} codegen
 */

// Validator. Hand-rolled — keeps PR 1 dependency-free; AJV (~30KB) can
// land later if validation needs grow. Errors are collected and returned
// as a list so a single bad spec doesn't mask others.

const SUPPORTED_SCHEMA_VERSIONS = new Set(['1']);
const SUPPORTED_LIBRARIES = new Set(['echarts']);
const SUPPORTED_FIELD_TYPES = new Set([
  'column_select',
  'column_multi_select',
  'enum',
  'text',
  'number',
  'boolean',
  'slider',
  'code',
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

function validateSection(section, path, errors, allFieldIds) {
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
  if (!Array.isArray(section.fields) || section.fields.length === 0) {
    pushErr(errors, `${path}.fields`, 'must be a non-empty array');
    return;
  }
  section.fields.forEach((field, i) => {
    validateField(field, `${path}.fields[${i}]`, errors, allFieldIds);
  });
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
  }
  if (!spec.codegen || typeof spec.codegen !== 'object') {
    pushErr(errors, 'codegen', 'missing or not an object');
  } else {
    if (!SUPPORTED_LIBRARIES.has(spec.codegen.library)) {
      pushErr(errors, 'codegen.library', `unsupported library "${spec.codegen.library}"`);
    }
    if (typeof spec.codegen.template_id !== 'string' || !spec.codegen.template_id) {
      pushErr(errors, 'codegen.template_id', 'missing or empty');
    }
    if (!spec.codegen.template_bindings || typeof spec.codegen.template_bindings !== 'object') {
      pushErr(errors, 'codegen.template_bindings', 'must be an object');
    }
  }
  return errors;
}

/**
 * Validates and throws in dev mode if invalid. In production, logs the
 * errors but doesn't throw — broken specs would already have been
 * caught at PR merge time, and a throw would crash the editor.
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
