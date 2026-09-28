import { describe, it, expect } from 'vitest';
import {
  EMPTY_TSSTORE_NATIVE,
  tsstoreNativeFromParams,
  tsstoreNativeToParams,
  tsstoreNativeApplies,
  tsstoreNativeHasValues,
  validateTsstoreDuration,
  validateAggFields,
  validateScanLimit,
} from './tsstoreNativeParams';

const full = { aggWindow: '5m', aggDefault: 'max', aggFields: 'events:sum', window: '6h', scanLimit: '20000' };

describe('tsstoreNativeFromParams', () => {
  it('is empty when nothing is saved', () => {
    expect(tsstoreNativeFromParams({ limit: 10 })).toEqual(EMPTY_TSSTORE_NATIVE);
    expect(tsstoreNativeFromParams(undefined)).toEqual(EMPTY_TSSTORE_NATIVE);
  });

  it('restores every key, scan_limit from a number', () => {
    expect(tsstoreNativeFromParams({
      agg_window: '5m', agg_default: 'max', agg_fields: 'events:sum', window: '6h', scan_limit: 20000,
    })).toEqual(full);
  });

  it('keeps scan_limit 0 (unbounded)', () => {
    expect(tsstoreNativeFromParams({ scan_limit: 0 }).scanLimit).toBe('0');
  });
});

describe('tsstoreNativeToParams', () => {
  it('sends aggregation + window on newest, not scan_limit', () => {
    expect(tsstoreNativeToParams(full, 'newest'))
      .toEqual({ agg_window: '5m', agg_default: 'max', agg_fields: 'events:sum', window: '6h' });
  });

  it('sends only aggregation on since and range', () => {
    const want = { agg_window: '5m', agg_default: 'max', agg_fields: 'events:sum' };
    expect(tsstoreNativeToParams(full, 'since')).toEqual(want);
    expect(tsstoreNativeToParams(full, 'range')).toEqual(want);
  });

  it('sends window + scan_limit on latest, never aggregation', () => {
    expect(tsstoreNativeToParams(full, 'latest')).toEqual({ window: '6h', scan_limit: 20000 });
  });

  it('sends only scan_limit on oldest', () => {
    expect(tsstoreNativeToParams(full, 'oldest')).toEqual({ scan_limit: 20000 });
  });

  it('omits blanks and keeps a 0 scan_limit', () => {
    expect(tsstoreNativeToParams({ ...EMPTY_TSSTORE_NATIVE, scanLimit: '0' }, 'latest')).toEqual({ scan_limit: 0 });
    expect(tsstoreNativeToParams(EMPTY_TSSTORE_NATIVE, 'newest')).toEqual({});
  });

  it('round-trips', () => {
    const saved = { agg_window: '1h', agg_default: 'avg,max', window: '0' };
    expect(tsstoreNativeToParams(tsstoreNativeFromParams(saved), 'newest')).toEqual(saved);
  });
});

describe('tsstoreNativeApplies / HasValues', () => {
  it('maps groups to query types', () => {
    expect(tsstoreNativeApplies('agg', 'oldest')).toBe(false);
    expect(tsstoreNativeApplies('agg', 'latest')).toBe(false);
    expect(tsstoreNativeApplies('window', 'since')).toBe(false);
    expect(tsstoreNativeApplies('scanLimit', 'newest')).toBe(false);
  });

  it('detects any value', () => {
    expect(tsstoreNativeHasValues(EMPTY_TSSTORE_NATIVE)).toBe(false);
    expect(tsstoreNativeHasValues({ ...EMPTY_TSSTORE_NATIVE, scanLimit: '0' })).toBe(true);
  });
});

describe('validators', () => {
  it.each(['', '30s', '5m', '1h30m', '1.5h', '1d', '2w', '1mo', '1y', '500ms'])('duration accepts %j', (v) => {
    expect(validateTsstoreDuration(v)).toBeNull();
  });
  it.each(['5', 'm', '5 minutes', '-5m', 'banana', '0'])('duration rejects %j', (v) => {
    expect(validateTsstoreDuration(v)).toMatch(/duration/);
  });
  it('window allows 0', () => {
    expect(validateTsstoreDuration('0', { allowZero: true })).toBeNull();
  });

  it.each(['', 'temp:avg', 'temp:avg, events:sum', 'cpu:avg+max', 'cpu:stddev,'])('agg_fields accepts %j', (v) => {
    expect(validateAggFields(v)).toBeNull();
  });
  it('agg_fields rejects a missing function and unknown functions', () => {
    expect(validateAggFields('temp')).toMatch(/field:function/);
    expect(validateAggFields('cpu:avg+median')).toMatch(/median/);
  });

  it('scan_limit takes whole non-negative numbers', () => {
    expect(validateScanLimit('0')).toBeNull();
    expect(validateScanLimit('20000')).toBeNull();
    expect(validateScanLimit('-1')).toMatch(/whole number/);
    expect(validateScanLimit('1.5')).toMatch(/whole number/);
  });
});
