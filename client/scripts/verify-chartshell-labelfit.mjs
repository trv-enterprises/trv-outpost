// Verify ChartShell's horizontal-bar label-fit helpers (pure functions).
import { fitLabelFont, horizontalBarCategoryCount, LABEL_FONT_MIN, LABEL_FONT_MAX } from '../src/chart-spec/label-fit.js';

const FAIL = [];
const check = (name, cond) => { if (cond) console.log('✓', name); else { FAIL.push(name); console.log('✗', name); } };

// horizontalBarCategoryCount: only the horizontal-bar shape (category yAxis + bar series).
check('detects horizontal bar', horizontalBarCategoryCount({ yAxis: { type: 'category', data: ['a', 'b', 'c'] }, series: [{ type: 'bar' }] }) === 3);
check('array yAxis[0] read', horizontalBarCategoryCount({ yAxis: [{ type: 'category', data: ['a'] }], series: [{ type: 'bar' }] }) === 1);
check('vertical bar (value yAxis) → 0', horizontalBarCategoryCount({ yAxis: { type: 'value' }, xAxis: { type: 'category', data: ['a'] }, series: [{ type: 'bar' }] }) === 0);
check('line series → 0', horizontalBarCategoryCount({ yAxis: { type: 'category', data: ['a'] }, series: [{ type: 'line' }] }) === 0);
check('null option → 0', horizontalBarCategoryCount(null) === 0);

// fitLabelFont: calibrated against headless ECharts 6 renders.
check('156px/9 → 10px fits', (() => { const f = fitLabelFont(9, 156); return f.fontSize === 10 && f.fits; })());
check('126px/9 → 8px fits', (() => { const f = fitLabelFont(9, 126); return f.fontSize === 8 && f.fits; })());
check('266px/9 → capped at 12px', (() => { const f = fitLabelFont(9, 266); return f.fontSize === LABEL_FONT_MAX && f.fits; })());
check('106px/9 → 8px floor, does NOT fit (thin)', (() => { const f = fitLabelFont(9, 106); return f.fontSize === LABEL_FONT_MIN && !f.fits; })());
check('266px/20 → 8px floor, does NOT fit', (() => { const f = fitLabelFont(20, 266); return f.fontSize === LABEL_FONT_MIN && !f.fits; })());
check('466px/20 → fits', (() => { const f = fitLabelFont(20, 466); return f.fits && f.fontSize >= LABEL_FONT_MIN; })());
check('zero height → null', fitLabelFont(9, 0) === null);
check('zero count → null', fitLabelFont(0, 200) === null);

if (FAIL.length) { process.stderr.write(`\n${FAIL.length} failure(s)\n`); process.exit(1); }
process.stdout.write('\nAll ChartShell label-fit checks passed.\n');
