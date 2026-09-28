import { describe, it, expect } from 'vitest';
import {
  EMPTY_TSSTORE_AGG,
  tsstoreAggFromParams,
  tsstoreAggToParams,
  tsstoreQueryTypeSupportsAgg,
  validateAggWindow,
  validateAggFields,
} from './tsstoreAggregation';

describe('tsstoreAggFromParams', () => {
  it('is disabled when no aggregation key is saved', () => {
    expect(tsstoreAggFromParams({ limit: 10 })).toEqual(EMPTY_TSSTORE_AGG);
    expect(tsstoreAggFromParams(undefined)).toEqual(EMPTY_TSSTORE_AGG);
  });

  it('restores every saved key', () => {
    expect(tsstoreAggFromParams({ agg_window: '5m', agg_default: 'max', agg_fields: 'events:sum' }))
      .toEqual({ enabled: true, window: '5m', func: 'max', fields: 'events:sum' });
  });

  it('enables on a lone agg_window and defaults the function to avg', () => {
    expect(tsstoreAggFromParams({ agg_window: '5m' }))
      .toEqual({ enabled: true, window: '5m', func: 'avg', fields: '' });
  });

  it('keeps a non-standard agg_default verbatim', () => {
    expect(tsstoreAggFromParams({ agg_default: 'avg,max' }).func).toBe('avg,max');
  });
});

describe('tsstoreAggToParams', () => {
  it('emits nothing when disabled', () => {
    expect(tsstoreAggToParams({ ...EMPTY_TSSTORE_AGG, window: '5m' })).toEqual({});
  });

  it('always sends the function when enabled', () => {
    expect(tsstoreAggToParams({ enabled: true, window: '', func: 'max', fields: '' }))
      .toEqual({ agg_default: 'max' });
  });

  it('trims and omits blank window/fields', () => {
    expect(tsstoreAggToParams({ enabled: true, window: ' 5m ', func: 'avg', fields: '  ' }))
      .toEqual({ agg_default: 'avg', agg_window: '5m' });
  });

  it('round-trips through tsstoreAggFromParams', () => {
    const saved = { agg_window: '1h', agg_default: 'sum', agg_fields: 'temp:avg' };
    expect(tsstoreAggToParams(tsstoreAggFromParams(saved))).toEqual(saved);
  });
});

describe('tsstoreQueryTypeSupportsAgg', () => {
  it('allows windowed/newest reads, not oldest or latest_by', () => {
    expect(['since', 'range', 'newest'].every(tsstoreQueryTypeSupportsAgg)).toBe(true);
    expect(tsstoreQueryTypeSupportsAgg('oldest')).toBe(false);
    expect(tsstoreQueryTypeSupportsAgg('latest')).toBe(false);
  });
});

describe('validateAggWindow', () => {
  it.each(['', '30s', '5m', '1h', '1h30m', '1.5h', '1d', '2w', '500ms'])('accepts %j', (v) => {
    expect(validateAggWindow(v)).toBeNull();
  });
  it.each(['5', 'm', '5 minutes', '1.5d', '-5m', 'banana'])('rejects %j', (v) => {
    expect(validateAggWindow(v)).toMatch(/duration/);
  });
});

describe('validateAggFields', () => {
  it.each(['', 'temp:avg', 'temp:avg, events:sum', 'cpu:stddev,'])('accepts %j', (v) => {
    expect(validateAggFields(v)).toBeNull();
  });
  it('rejects a missing function', () => {
    expect(validateAggFields('temp')).toMatch(/field:function/);
  });
  it('rejects multi-function specs that rename columns', () => {
    expect(validateAggFields('cpu:avg+max')).toMatch(/rename/);
  });
  it('rejects unknown functions', () => {
    expect(validateAggFields('cpu:median')).toMatch(/median/);
  });
});
