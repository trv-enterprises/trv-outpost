// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * gauge_v1 — the gauge ECharts template. Receives the preamble values
 * assembled by getDataDrivenChartCode (so they stay in lockstep with
 * legacy codegen) plus the spec's `template_bindings` block, and
 * returns the same code string the legacy gauge branch emits.
 *
 * IMPORTANT: this template must emit byte-identical output to the
 * legacy gauge branch of getDataDrivenChartCode for representative
 * inputs. Any divergence is a bug to fix before PR 2.
 *
 * @param {object} ctx
 * @param {string} ctx.connectionId
 * @param {string} ctx.queryRaw
 * @param {string} ctx.queryType
 * @param {object} ctx.queryParams
 * @param {string} ctx.extraOptionsLine    — preamble (backfill, parser)
 * @param {string} ctx.useDataFields       — destructuring shape
 * @param {string} ctx.noDataLine          — "no data" branch
 * @param {string} ctx.transformsConfig    — client-side transforms config string
 * @param {boolean} ctx.hasTransforms      — selects rows source (transformed vs data)
 * @param {string} ctx.yAxisStr            — "'colA', 'colB'" — quoted CSV
 * @param {string} ctx.chartName           — chart title (may be empty)
 * @param {object} ctx.chartOptions        — full chartOptions map
 * @param {object} ctx.bindings            — spec.codegen.template_bindings (unused
 *                                           in v1 — chartOptions is authoritative;
 *                                           bindings are kept on the spec for the
 *                                           future declarative-codegen path)
 * @returns {string} the component_code string
 */
export function renderGaugeV1(ctx) {
  const {
    connectionId,
    queryRaw,
    queryType,
    queryParams,
    extraOptionsLine,
    useDataFields,
    noDataLine,
    transformsConfig,
    hasTransforms,
    yAxisStr,
    chartName,
    chartOptions,
  } = ctx;

  const gaugeMin = chartOptions?.gaugeMin ?? 0;
  const gaugeMax = chartOptions?.gaugeMax ?? 100;
  const warningThreshold = (chartOptions?.gaugeWarningThreshold ?? 70) / 100;
  const dangerThreshold = (chartOptions?.gaugeDangerThreshold ?? 90) / 100;
  const unit = chartOptions?.gaugeUnit || '';
  const lineThickness = (chartOptions?.gaugeLineThickness ?? 8) / 100;
  const detailFormatter = unit ? `'{value}${unit}'` : "'{value}'";

  return `const Component = () => {
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 200, height: 200 });

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      // Only update if size changed by more than 1px to prevent resize loops
      setContainerSize(prev => {
        if (Math.abs(prev.width - width) > 1 || Math.abs(prev.height - height) > 1) {
          return { width, height };
        }
        return prev;
      });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const ${useDataFields} = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }${extraOptionsLine}
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>Loading...</div>;
  if (error) return <div style={{ color: '#da1e28', padding: '1rem' }}>Error: {error.message}</div>;
  ${noDataLine}
${transformsConfig}

  const yCol = ${yAxisStr.split(',')[0]};
  const yIdx = ${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(yCol);
  const value = rows.length > 0 ? Number(rows[0][yIdx]) : 0;

  // Calculate responsive sizes based on container - all proportional, no minimums
  const minDim = Math.min(containerSize.width, containerSize.height);
  const baseFontSize = Math.floor(minDim * 0.12);
  const titleFontSize = Math.floor(minDim * 0.08);
  const labelFontSize = Math.floor(minDim * 0.06);
  const axisLineWidth = Math.floor(minDim * ${lineThickness});
  const splitLineLength = Math.floor(minDim * 0.05);
  const anchorSize = Math.floor(minDim * 0.08);

  // Calculate all spacing as percentage of minDim for consistent scaling
  const topMarginPercent = 0; // Top margin as percentage
  const titleHeightPercent = ${chartName ? 'Math.max(8, (titleFontSize / containerSize.height) * 100)' : '0'};
  const gapPercent = 1; // Gap between title and gauge
  const totalTitleSpace = ${chartName ? 'topMarginPercent + titleHeightPercent + gapPercent' : '0'};
  const gaugeCenter = ['50%', String(55 + totalTitleSpace / 2) + '%'];
  const gaugeRadius = String(95 - totalTitleSpace) + '%';
  const titleTop = String(topMarginPercent) + '%';

  const option = {
    backgroundColor: 'transparent',
    ${chartName ? `title: { text: '${chartName.replace(/'/g, "\\'")}', left: 'center', top: titleTop, textStyle: { color: '#f4f4f4', fontSize: titleFontSize } },` : ''}
    series: [{
      type: 'gauge',
      min: ${gaugeMin},
      max: ${gaugeMax},
      center: gaugeCenter,
      radius: gaugeRadius,
      progress: { show: false },
      axisLine: {
        lineStyle: {
          width: axisLineWidth,
          color: [
            [${warningThreshold}, '#24a148'],
            [${dangerThreshold}, '#f1c21b'],
            [1, '#da1e28']
          ]
        }
      },
      axisTick: { show: false },
      splitLine: { length: splitLineLength, lineStyle: { width: 2, color: '#999' } },
      axisLabel: { distance: Math.floor(minDim * 0.08), color: '#999', fontSize: labelFontSize },
      anchor: { show: true, showAbove: true, size: anchorSize, itemStyle: { borderWidth: Math.floor(anchorSize * 0.4) } },
      title: { show: false },
      detail: { valueAnimation: true, fontSize: baseFontSize, offsetCenter: [0, '75%'], formatter: ${detailFormatter} },
      data: [{ value: value, name: yCol }]
    }]
  };

  return (
    <div ref={containerRef} style={{ height: '100%', width: '100%' }}>
      <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />
    </div>
  );
};`;
}
