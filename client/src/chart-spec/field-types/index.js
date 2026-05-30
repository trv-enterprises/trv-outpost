// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import ColumnSelectField from './ColumnSelect';
import EnumSelectField from './EnumSelect';
import NumberField from './NumberField';
import TextField from './TextField';
import BooleanField from './BooleanField';
import SliderField from './SliderField';
import NullableNumberField from './NullableNumber';
import YAxisColumnsListField from './YAxisColumnsList';
import ThresholdListField from './ThresholdList';
import ColumnManagerField from './ColumnManager';

const FIELD_RENDERERS = {
  // Stage 1
  column_select: ColumnSelectField,
  enum: EnumSelectField,
  number: NumberField,
  text: TextField,
  boolean: BooleanField,
  slider: SliderField,
  // Stage 2
  nullable_number: NullableNumberField,
  y_axis_columns_list: YAxisColumnsListField,
  threshold_list: ThresholdListField,
  column_manager: ColumnManagerField,
  // column_multi_select + code stay deferred — no current spec uses
  // either. The schema validator permits them; renderers land when
  // a spec needs them.
};

export function getFieldRenderer(type) {
  return FIELD_RENDERERS[type] || null;
}
