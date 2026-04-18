// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useContext, createContext } from 'react';
import * as React from 'react';
import * as echarts from 'echarts';
import 'echarts-gl'; // Required for 3D charts (scatter3D, bar3D, surface, etc.)
import ReactECharts from 'echarts-for-react';
import { carbonLightTheme, carbonDarkTheme } from '../theme/carbonEchartsTheme';
import { useData as useDataOriginal } from '../hooks/useData';
import { transformData, toObjects, getValue, formatTimestamp, formatCellValue, buildTransformsFromMapping } from '../utils/dataTransforms';
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

// Context to provide transforms to child components
const TransformsContext = createContext(null);

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
    rawData: result.data
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
 * - Carbon DataTable components: DataTable, Table, TableHead, TableRow, TableHeader,
 *   TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch
 *
 * 3D Chart Support (via echarts-gl):
 * - scatter3D, bar3D, line3D, surface, map3D, globe
 * - grid3D, xAxis3D, yAxis3D, zAxis3D
 */
export default function DynamicComponentLoader({ code, props = {}, dataMapping = null, datasourceId = null, queryConfig = null, dataRefreshInterval = null, children = null }) {
  const [error, setError] = useState(null);
  const [Component, setComponent] = useState(null);

  // Get datasource ID from prop or dataMapping
  const effectiveDatasourceId = datasourceId || dataMapping?.datasource_id;

  // Build transforms from dataMapping (memoized)
  const transforms = useMemo(() => buildTransformsFromMapping(dataMapping), [dataMapping]);

  // Determine if we need to fetch data ourselves
  // Fetch data when: datasourceId is available AND no data prop was provided
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

  const {
    data: fetchedData,
    loading: dataLoading,
    error: dataError,
    isStreaming,
    isAggregated,
    reconnecting,
    disconnectedSince
  } = useDataOriginal({
    datasourceId: shouldFetchData ? effectiveDatasourceId : null,
    query: queryConfig || dataMapping?.query_config || { raw: '', type: 'sql' },
    refreshInterval: dataRefreshInterval,
    useCache: true,
    timeBucket: timeBucketConfig,
    parser: dataMapping?.parser || null
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
        AgGridReact
      );

      setComponent(() => LoadedComponent);
      setError(null);
    } catch (err) {
      console.error('Error loading component:', err);
      setError(err.message);
      setComponent(null);
    }
  }, [code]);

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

  // Determine final props - if we fetched data, add it; otherwise use provided props
  const finalProps = shouldFetchData
    ? { ...props, data: transformedFetchedData }
    : props;

  // Show overlay error when reconnecting but we have existing data
  const showReconnectOverlay = shouldFetchData && dataError && transformedFetchedData && reconnecting;

  return (
    <TransformsContext.Provider value={transforms}>
      <DataContext.Provider value={{
        data: transformedFetchedData,
        loading: dataLoading,
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
    </TransformsContext.Provider>
  );
}
