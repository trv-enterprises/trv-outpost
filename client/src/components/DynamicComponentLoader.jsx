// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useContext, createContext } from 'react';
import * as React from 'react';
import * as echarts from 'echarts';
import 'echarts-gl'; // Required for 3D charts (scatter3D, bar3D, surface, etc.)
import ReactECharts from 'echarts-for-react';

// NOTE: We previously wrapped ReactECharts to inject tooltip.appendToBody so
// tooltips overflow the panel's overflow:hidden. Removed because the wrapper
// rebuilt `option` on every render, which combined with React Strict Mode's
// double-invoke triggered a teardown bug in echarts-for-react
// (sensor.disconnect on undefined). The theme-level appendToBody in
// carbonEchartsTheme.js still applies to charts using theme="carbon-dark";
// AI-generated charts that skip the theme prop need to set appendToBody
// in their option block directly (system prompt instructs this).
import { carbonLightTheme, carbonDarkTheme } from '../theme/carbonEchartsTheme';
import { useData as useDataOriginal } from '../hooks/useData';
import { transformData, toObjects, getValue, formatTimestamp, formatCellValue, buildTransformsFromMapping, DASHBOARD_VARIABLE_TOKEN } from '../utils/dataTransforms';
import * as Babel from '@babel/standalone';
import {
  DataTable,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableContainer,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  Loading,
  InlineNotification
} from '@carbon/react';
// AG Grid Community — used by the dataview chart type. Virtualized, handles
// unbounded streaming journal/log data that broke IBM Products Datagrid
// (200+ useContext per row → OOM). Exposed in the dynamic-eval scope so
// generated dataview code can render <AgGridReact>. Module registration
// happens once at app startup in main.jsx.
import { AgGridReact } from 'ag-grid-react';
import { useDataviewLayout } from '../hooks/useDataviewLayout';
import SpecDrivenChart from '../chart-codegen/SpecDrivenChart';
import { CARBON_COLORS } from '../chart-spec/option-helpers';

// Context to provide transforms to child components
const TransformsContext = createContext(null);

// Context that exposes the saved component's config ({title, name, description})
// to anything inside the dynamically-eval'd component. AI-generated code often
// destructures `config` from useData()'s return rather than from props — so
// we mirror it onto the useData return value as a convenience to avoid
// chart-by-chart fixes.
// Exported so spec-driven shells (SpecDrivenChart) can read the chart's
// full config (data_mapping, options, chart_type, etc.) without having
// to thread props through. Internal eval'd components don't need this —
// they already destructure `config` from useData()'s return shape.
export const ComponentConfigContext = createContext(null);

// Context that exposes the live data (columns + rows) and stream state
// for the chart in this subtree. Populated by DynamicComponentLoader so
// any child UI — notably the "show me the underlying data" modal — can
// display the exact same data the chart is rendering without opening a
// second stream or duplicating a fetch.
export const DataContext = createContext(null);

/**
 * Custom hook that wraps useData and auto-applies transforms from context
 * When dataMapping is provided to DynamicComponentLoader, the chart's filters
 * are automatically applied to the data without requiring any code changes.
 * Also supports timeBucket parameter for server-side aggregation of socket streams.
 */
function useDataWithTransforms(params) {
  const transforms = useContext(TransformsContext);
  const componentConfig = useContext(ComponentConfigContext);
  // Pass through all params including timeBucket for aggregated streaming
  const result = useDataOriginal(params);

  // Apply transforms if we have them and data is ready
  const transformedData = useMemo(() => {
    if (!transforms || !result.data) {
      return result.data;
    }
    return transformData(result.data, transforms);
  }, [result.data, transforms]);

  return {
    ...result,
    data: transformedData,
    // Keep original data available if needed
    rawData: result.data,
    // Mirror the component's config onto the useData return so AI-generated
    // code that destructures `config` from useData() keeps working. Reading
    // from the prop (`const Component = ({ config }) => ...`) is still the
    // canonical pattern; this is just a fallback for existing charts.
    config: componentConfig,
  };
}

/**
 * Dynamic Component Loader
 * Loads and renders React components from string code at runtime
 *
 * Available libraries in component scope:
 * - React hooks: useState, useEffect, useMemo, useCallback, useRef, useContext
 * - useData: Custom hook for fetching data from datasources with caching
 *   (auto-applies transforms from dataMapping prop if provided)
 * - transformData: Utility to apply filters and aggregations to data
 * - toObjects: Convert columnar data to array of objects
 * - getValue: Get a single value from first row of data
 * - formatTimestamp: Format timestamp values for display (supports Unix seconds, ms, ISO)
 * - formatCellValue: Auto-format cell values based on column name and value type
 * - echarts: ECharts core library (includes echarts-gl for 3D charts)
 * - ReactECharts: ECharts React wrapper component
 * - carbonTheme: Carbon Design System ECharts theme (light mode)
 * - carbonDarkTheme: Carbon Design System ECharts theme (dark mode)
 * - CARBON_COLORS: Carbon palette object ({primary, secondary, ok, warn, danger,
 *   text, textSecondary}). Use these instead of hardcoded hex so custom charts
 *   match spec-driven charts and follow theme changes.
 * - Carbon DataTable components: DataTable, Table, TableHead, TableRow, TableHeader,
 *   TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch
 *
 * 3D Chart Support (via echarts-gl):
 * - scatter3D, bar3D, line3D, surface, map3D, globe
 * - grid3D, xAxis3D, yAxis3D, zAxis3D
 */
export default function DynamicComponentLoader({ code, props = {}, componentMeta = null, dataMapping = null, connectionId = null, queryConfig = null, dataRefreshInterval = null, refreshTick = 0, dashboardVariableValue = null, rangeValue = null, children = null }) {
  const [error, setError] = useState(null);
  const [Component, setComponent] = useState(null);

  // Get datasource ID from prop or dataMapping
  const effectiveDatasourceId = connectionId || dataMapping?.connection_id;

  // Build transforms from dataMapping (memoized). The active dashboard-variable
  // value is threaded in so a {{dashboard-variable}} filter value resolves and
  // recomputes when the value changes (live re-filter for streaming panels).
  const transforms = useMemo(
    () => buildTransformsFromMapping(dataMapping, dashboardVariableValue),
    [dataMapping, dashboardVariableValue]
  );

  // Pass the active dashboard-variable value to the server in
  // query.params.dashboard_variable whenever the query's raw text contains the
  // {{dashboard-variable}} token. The TOKEN's presence — not the component's
  // uses_dashboard_variable flag — is the runtime signal: the flag is an
  // authoring hint that drives editor affordances, while the actual binding is
  // wherever the author wrote the token. Substitution happens server-side,
  // per-adapter (SQL → bound param, EdgeLake → escaped literal); leaving the
  // token in raw with no value set lets the server return a structured "not
  // set" state. The query identity changes only when the value changes, so
  // useData's effect re-runs on selection.
  //
  // The range variable rides the SAME mechanism: when a range is active we add
  // the structured range INTENT (params.range = {type:'relative',token} |
  // {type:'absolute',from,to}). SQL/EdgeLake authors opt in via a
  // `<col> {{range-variable}}` WHERE condition (the server expands it to a
  // bounded predicate); ts-store/Prometheus auto-apply the window. The extra
  // param is harmless for components that ignore it.
  const effectiveQuery = useMemo(() => {
    const base = queryConfig || dataMapping?.query_config || { raw: '', type: 'sql' };
    const hasVarToken = typeof base.raw === 'string' && base.raw.includes(DASHBOARD_VARIABLE_TOKEN);
    const hasRange = !!(rangeValue && rangeValue.type);
    if (!hasVarToken && !hasRange) return base;

    const params = { ...(base.params || {}) };
    if (hasVarToken) params.dashboard_variable = dashboardVariableValue ?? '';
    if (hasRange) params.range = rangeValue;
    return { ...base, params };
  }, [queryConfig, dataMapping?.query_config, dashboardVariableValue, rangeValue]);

  // Determine if we need to fetch data ourselves
  // Fetch data when: connectionId is available AND no data prop was provided
  const shouldFetchData = effectiveDatasourceId && !props.data;

  // Use data hook when we need to fetch (always called but disabled when not needed)
  // dataRefreshInterval is in milliseconds, passed from dashboard settings
  // timeBucket enables server-side aggregation for socket datasources
  // Include series_col from dataMapping.series for time bucket partitioning
  const timeBucketConfig = useMemo(() => {
    if (!dataMapping?.time_bucket) return null;
    return {
      ...dataMapping.time_bucket,
      series_col: dataMapping.series || '' // Include series for bucket partitioning
    };
  }, [dataMapping?.time_bucket, dataMapping?.series]);

  // Parser config on data_mapping uses snake_case (data_path,
  // timestamp_field, timestamp_scale) because that's the wire format
  // from MongoDB. useData expects camelCase. Translate once here so
  // every data-context consumer (including the data-grid modal) gets
  // parser-flattened records — matches what chart component_code
  // sees when it calls useData itself.
  const parserConfig = useMemo(() => {
    const p = dataMapping?.parser;
    if (!p) return null;
    return {
      dataPath: p.data_path || p.dataPath || '',
      timestampField: p.timestamp_field || p.timestampField || '',
      timestampScale: p.timestamp_scale || p.timestampScale || '',
    };
  }, [dataMapping?.parser]);

  const {
    data: fetchedData,
    loading: dataLoading,
    error: dataError,
    isStreaming,
    isAggregated,
    reconnecting,
    disconnectedSince
  } = useDataOriginal({
    connectionId: shouldFetchData ? effectiveDatasourceId : null,
    query: effectiveQuery,
    refreshInterval: dataRefreshInterval,
    useCache: true,
    timeBucket: timeBucketConfig,
    parser: parserConfig,
    refreshTick,
  });

  // Apply transforms to fetched data
  const transformedFetchedData = useMemo(() => {
    if (!shouldFetchData || !fetchedData) return null;
    if (!transforms) return fetchedData;
    return transformData(fetchedData, transforms);
  }, [fetchedData, transforms, shouldFetchData]);

  useEffect(() => {
    if (!code) {
      setComponent(null);
      setError(null);
      return;
    }

    try {
      // Register Carbon themes with ECharts
      echarts.registerTheme('carbon-light', carbonLightTheme);
      echarts.registerTheme('carbon-dark', carbonDarkTheme);

      // Transform JSX to JavaScript using Babel
      const transformedCode = Babel.transform(code, {
        presets: ['react'],
      }).code;

      // Create a function that will evaluate the component code
      // We provide React hooks, data fetching, transforms, and visualization libraries in the scope
      const componentFunction = new Function(
        'React',
        'useState',
        'useEffect',
        'useMemo',
        'useCallback',
        'useRef',
        'useContext',
        'useData',
        'transformData',
        'toObjects',
        'getValue',
        'formatTimestamp',
        'formatCellValue',
        'echarts',
        'ReactECharts',
        'carbonTheme',
        'carbonDarkTheme',
        'DataTable',
        'Table',
        'TableHead',
        'TableRow',
        'TableHeader',
        'TableBody',
        'TableCell',
        'TableContainer',
        'TableToolbar',
        'TableToolbarContent',
        'TableToolbarSearch',
        'AgGridReact',
        'useDataviewLayout',
        'SpecDrivenChart',
        'CARBON_COLORS',
        `
        ${transformedCode}
        return typeof Component !== 'undefined' ? Component :
               typeof Widget !== 'undefined' ? Widget :
               (function() { throw new Error('Component or Widget not found in code') })();
        `
      );

      // Execute the function with React dependencies, data hooks, transforms, and visualization libraries
      const LoadedComponent = componentFunction(
        React,
        React.useState,
        React.useEffect,
        React.useMemo,
        React.useCallback,
        React.useRef,
        React.useContext,
        useDataWithTransforms, // Use our wrapped version that auto-applies transforms from context
        transformData,
        toObjects,
        getValue,
        formatTimestamp,
        formatCellValue,
        echarts,
        ReactECharts,
        carbonLightTheme,
        carbonDarkTheme,
        DataTable,
        Table,
        TableHead,
        TableRow,
        TableHeader,
        TableBody,
        TableCell,
        TableContainer,
        TableToolbar,
        TableToolbarContent,
        TableToolbarSearch,
        AgGridReact,
        useDataviewLayout,
        SpecDrivenChart,
        CARBON_COLORS
      );

      setComponent(() => LoadedComponent);
      setError(null);
    } catch (err) {
      console.error('Error loading component:', err);
      setError(err.message);
      setComponent(null);
    }
  }, [code]);

  // Build the `config` prop the component receives. Must be declared before
  // any conditional early-return so hook order stays stable across renders.
  // componentMeta is optional — undefined when the loader is invoked outside
  // a saved-component context (AI preview, ad-hoc usage); fields fall back
  // to empty strings so the component can `config?.title || 'fallback'`.
  //
  // Legacy eval'd code (AI-generated, custom code) only reads
  // `{ title, name, description }` — the system prompt documents that
  // contract. Spec-driven shells (SpecDrivenChart) need the full chart
  // record so they can read `config.data_mapping`, `config.options`,
  // `config.chart_type`, and `config.transforms?.x_axis_format`. We
  // expose those additional fields here; legacy code ignores them.
  const config = useMemo(() => ({
    // id is needed by spec-driven views that key per-user state on the
    // component id (dataview's column layout via useDataviewLayout).
    id: componentMeta?.id || '',
    title: componentMeta?.title || '',
    name: componentMeta?.name || '',
    description: componentMeta?.description || '',
    // Spec-driven fields. Undefined when componentMeta doesn't carry
    // them (legacy charts, ad-hoc usage). SpecDrivenChart reads with
    // optional chaining and falls back to empty defaults.
    chart_type: componentMeta?.chart_type,
    data_mapping: componentMeta?.data_mapping,
    options: componentMeta?.options,
    transforms: componentMeta?.transforms,
  }), [
    componentMeta?.id,
    componentMeta?.title,
    componentMeta?.name,
    componentMeta?.description,
    componentMeta?.chart_type,
    componentMeta?.data_mapping,
    componentMeta?.options,
    componentMeta?.transforms,
  ]);

  if (error) {
    return (
      <div style={{
        padding: '20px',
        border: '2px solid #da1e28',
        borderRadius: '4px',
        backgroundColor: '#fff1f1',
        color: '#750e13'
      }}>
        <h3 style={{ margin: '0 0 10px 0', fontWeight: 600 }}>Component Error</h3>
        <pre style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordWrap: 'break-word',
          fontSize: '14px',
          fontFamily: "'IBM Plex Mono', 'Menlo', 'Courier New', monospace"
        }}>
          {error}
        </pre>
      </div>
    );
  }

  if (!Component) {
    return null;
  }

  // If we're fetching data ourselves and it's loading (and no data yet)
  if (shouldFetchData && dataLoading && !transformedFetchedData) {
    const loadingMessage = isAggregated
      ? 'Connecting to aggregated stream...'
      : isStreaming
        ? 'Connecting to stream...'
        : 'Loading data...';
    return (
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#c6c6c6'
      }}>
        <Loading description={loadingMessage} withOverlay={false} small />
      </div>
    );
  }

  // If we're fetching data ourselves and there's an error (and no data to show)
  if (shouldFetchData && dataError && !transformedFetchedData) {
    return (
      <div style={{ padding: '8px', height: '100%', display: 'flex', alignItems: 'center' }}>
        <InlineNotification
          kind="error"
          title="Data Error"
          subtitle={dataError.message || 'Failed to fetch data'}
          lowContrast
          hideCloseButton
          style={{ maxWidth: '100%', minWidth: 'auto' }}
        />
      </div>
    );
  }

  // Determine final props. Inject `config` AFTER caller props so we always
  // win — AI-generated component code reads `config.title` without optional
  // chaining, so config must always be a real object even if the caller
  // accidentally passed `props={ config: undefined }` or left it off.
  const baseProps = shouldFetchData
    ? { ...props, data: transformedFetchedData }
    : props;
  const finalProps = { ...baseProps, config };

  // Show overlay error when reconnecting but we have existing data
  const showReconnectOverlay = shouldFetchData && dataError && transformedFetchedData && reconnecting;

  // Data the context exposes to spec-driven children (SpecDrivenChart
  // reads DataContext, not props). When the loader fetches its own data
  // (shouldFetchData), that's transformedFetchedData. When the caller
  // supplies data as a prop instead — the AI Builder preview path, which
  // runs its own query and passes props.data — fall back to that, else a
  // spec chart sees null and hangs on "loading". With prop-supplied data
  // there's no fetch in flight, so loading is false.
  const contextData = shouldFetchData ? transformedFetchedData : (props.data ?? null);
  const contextLoading = shouldFetchData ? dataLoading : false;

  return (
    <TransformsContext.Provider value={transforms}>
      <ComponentConfigContext.Provider value={config}>
      <DataContext.Provider value={{
        data: contextData,
        loading: contextLoading,
        error: dataError,
        isStreaming,
        reconnecting,
        disconnectedSince,
      }}>
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        <Component {...finalProps} />
        {children}
        {/* Overlay for connection errors when we still have data to display */}
        {showReconnectOverlay && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(22, 22, 22, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10
          }}>
            <div style={{
              padding: '16px 24px',
              borderRadius: '4px',
              backgroundColor: 'rgba(218, 30, 40, 0.15)',
              border: '1px solid rgba(218, 30, 40, 0.5)',
              textAlign: 'center',
              maxWidth: '90%'
            }}>
              <p style={{
                margin: 0,
                fontSize: '14px',
                color: '#fa4d56',
                fontWeight: 500
              }}>
                {dataError.message || 'Connection lost, retrying...'}
              </p>
              {disconnectedSince && (
                <p style={{
                  margin: '8px 0 0 0',
                  fontSize: '12px',
                  color: '#c6c6c6'
                }}>
                  Disconnected since {new Date(disconnectedSince).toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      </DataContext.Provider>
      </ComponentConfigContext.Provider>
    </TransformsContext.Provider>
  );
}
