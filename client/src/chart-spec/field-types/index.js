// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import ColumnSelectField from './ColumnSelect';
import EnumSelectField from './EnumSelect';
import NumberField from './NumberField';
import TextField from './TextField';
import BooleanField from './BooleanField';
import SliderField from './SliderField';

const FIELD_RENDERERS = {
  column_select: ColumnSelectField,
  enum: EnumSelectField,
  number: NumberField,
  text: TextField,
  boolean: BooleanField,
  slider: SliderField,
  // column_multi_select + code defer to PR 2; the spec schema permits
  // them but PR 1's gauge spec doesn't use them.
};

export function getFieldRenderer(type) {
  return FIELD_RENDERERS[type] || null;
}
