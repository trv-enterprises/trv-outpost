// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import PropTypes from 'prop-types';
import StreamConnectionManager from '../../utils/streamConnectionManager';
import './WeatherDisplay.scss';

// Map Visual Crossing icon names to Bas Milius weather-icons
const ICON_MAP = {
  'clear-day': 'clear-day',
  'clear-night': 'clear-night',
  'partly-cloudy-day': 'partly-cloudy-day',
  'partly-cloudy-night': 'partly-cloudy-night',
  'cloudy': 'cloudy',
  'rain': 'rain',
  'showers-day': 'partly-cloudy-day-rain',
  'showers-night': 'partly-cloudy-night-rain',
  'snow': 'snow',
  'snow-showers-day': 'partly-cloudy-day-snow',
  'snow-showers-night': 'partly-cloudy-night-snow',
  'thunder-rain': 'thunderstorms-rain',
  'thunder-showers-day': 'thunderstorms-day',
  'thunder-showers-night': 'thunderstorms-night',
  'fog': 'fog',
  'wind': 'wind',
  'hail': 'hail',
  'sleet': 'sleet',
};

// Weather icons are bundled locally in client/public/weather-icons/ so the
// app doesn't depend on an external CDN (the upstream repo was renamed from
// `weather-icons` to `meteocons` once already) and works offline on kiosk
// displays. Source: https://github.com/basmilius/meteocons (MIT licensed).
// To refresh: re-download the 19 mapped names via curl from
// https://basmilius.github.io/meteocons/production/fill/svg/<name>.svg
const ICON_BASE = '/weather-icons';

function weatherIcon(icon, size = 64) {
  const mapped = ICON_MAP[icon] || 'not-available';
  return (
    <img
      src={`${ICON_BASE}/${mapped}.svg`}
      alt={icon || 'weather'}
      width={size}
      height={size}
      className="weather-icon"
    />
  );
}

function formatHour(datetime) {
  // Extract hour from "HH:MM:SS", "YYYY-MM-DDThh:mm:ss", or "YYYY-MM-DD hh:mm:ss"
  const timePart = datetime.includes('T') ? datetime.split('T')[1]
    : datetime.includes(' ') ? datetime.split(' ')[1]
    : datetime;
  const hour = parseInt(timePart.split(':')[0], 10);
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
}

function formatDay(datetime) {
  const date = new Date(datetime + 'T12:00:00');
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return days[date.getDay()];
}

function windDirection(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function CurrentConditions({ data }) {
  if (!data) return null;
  return (
    <div className="weather-current">
      <div className="weather-current__icon">
        {weatherIcon(data.icon, 100)}
      </div>
      <div className="weather-current__temp">
        <span className="temp-value">{Math.round(data.temp)}°</span>
        <span className="temp-feels">Feels {Math.round(data.feelslike)}°</span>
        <span className="temp-conditions">{data.conditions}</span>
      </div>
      <div className="weather-current__details">
        <DetailItem label="Humidity" value={`${Math.round(data.humidity)}%`} />
        <DetailItem label="Wind" value={`${Math.round(data.windspeed)} mph ${windDirection(data.winddir)}`} />
        <DetailItem label="UV Index" value={data.uvindex} />
        <DetailItem label="Pressure" value={`${data.pressure} mb`} />
        <DetailItem label="Visibility" value={`${data.visibility} mi`} />
        <DetailItem label="Dew Point" value={`${Math.round(data.dew)}°`} />
      </div>
    </div>
  );
}

// Small variant: one row — icon, temperature, then conditions and location
// on a single subtitle line. Sized to fit a short, wide tile.
function CurrentCompact({ data, location }) {
  if (!data) return null;
  const subtitle = [data.conditions, location].filter(Boolean).join(' · ');
  return (
    <div className="weather-compact">
      <div className="weather-compact__icon">
        {weatherIcon(data.icon, 72)}
      </div>
      <div className="weather-compact__text">
        <span className="compact-temp">{Math.round(data.temp)}°F</span>
        {subtitle && <span className="compact-subtitle">{subtitle}</span>}
      </div>
    </div>
  );
}

function DetailItem({ label, value }) {
  return (
    <div className="detail-item">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  );
}

function SunBar({ data }) {
  if (!data?.sunrise) return null;
  return (
    <div className="weather-sun">
      <span>&#9728; Sunrise {data.sunrise.slice(0, 5)}</span>
      <span>&#9789; Sunset {data.sunset.slice(0, 5)}</span>
    </div>
  );
}

function HourlyForecast({ data }) {
  if (!data || data.length === 0) return null;
  // Data is pre-filtered by the poller to next 24 hours; show first 8 in this compact view
  const hours = data.slice(0, 8);

  return (
    <div className="weather-hourly">
      <div className="forecast-label">Hourly</div>
      <div className="hourly-list">
        {hours.map((h, i) => (
          <div key={i} className="hourly-row">
            <span className="hourly-time">{formatHour(h.datetime)}</span>
            {weatherIcon(h.icon, 24)}
            <span className="hourly-temp">{Math.round(h.temp)}°</span>
            {h.precipprob > 20 && (
              <span className="hourly-precip">{Math.round(h.precipprob)}%</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DailyForecast({ data }) {
  if (!data || data.length === 0) return null;
  const days = data.slice(1, 6);

  return (
    <div className="weather-daily">
      <div className="forecast-label">5-Day Forecast</div>
      <div className="daily-cards">
        {days.map((d, i) => (
          <div key={i} className="daily-card">
            <span className="daily-day">{formatDay(d.datetime)}</span>
            <div className="daily-icon">{weatherIcon(d.icon, 40)}</div>
            <span className="daily-high">{Math.round(d.tempmax)}°</span>
            <span className="daily-low">{Math.round(d.tempmin)}°</span>
            <span className="daily-precip">
              {d.precipprob > 20 ? `${Math.round(d.precipprob)}%` : '\u00A0'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AlertBanner({ alerts }) {
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (!alerts || alerts.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentIndex(i => (i + 1) % alerts.length);
    }, 8000);
    return () => clearInterval(interval);
  }, [alerts]);

  if (!alerts || alerts.length === 0) return null;
  const alert = alerts[currentIndex];

  return (
    <div className="weather-alert">
      <span className="alert-icon">&#9888;</span>
      <div className="alert-text">
        <span className="alert-event">{alert.event}</span>
        {alert.headline && <span className="alert-headline"> — {alert.headline}</span>}
      </div>
      {alerts.length > 1 && (
        <span className="alert-counter">{currentIndex + 1}/{alerts.length}</span>
      )}
    </div>
  );
}

function WeatherDisplay({ config }) {
  const [current, setCurrent] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [hourly, setHourly] = useState([]);
  const [daily, setDaily] = useState([]);
  const [connected, setConnected] = useState(false);

  const connectionId = config?.mqtt_connection_id;
  const topicPrefix = config?.weather_topic_prefix || 'weather';
  const location = config?.weather_location || '';
  const size = config?.weather_size || 'large';

  const handleRecord = useCallback((record) => {
    const topic = record.topic;
    if (!topic) return;

    try {
      // Parse the payload — may come as string or already parsed
      let payload = record.payload || record.data || record;
      if (typeof payload === 'string') {
        payload = JSON.parse(payload);
      }

      if (topic === `${topicPrefix}/current`) {
        setCurrent(payload);
      } else if (topic === `${topicPrefix}/alerts`) {
        setAlerts(Array.isArray(payload) ? payload : []);
      } else if (topic === `${topicPrefix}/forecast/hourly`) {
        setHourly(Array.isArray(payload) ? payload : []);
      } else if (topic === `${topicPrefix}/forecast/daily`) {
        setDaily(Array.isArray(payload) ? payload : []);
      }
    } catch (err) {
      console.error('Weather: failed to parse MQTT message:', err);
    }
  }, [topicPrefix]);

  useEffect(() => {
    if (!connectionId) return;

    const manager = StreamConnectionManager.getInstance();
    const unsubscribe = manager.subscribe(connectionId, handleRecord, {
      topics: `${topicPrefix}/#`,
      onConnect: () => setConnected(true),
      onDisconnect: () => setConnected(false)
    });

    return () => unsubscribe();
  }, [connectionId, topicPrefix, handleRecord]);

  if (!connectionId) {
    return (
      <div className="weather-display weather-display--empty">
        No MQTT connection configured
      </div>
    );
  }

  if (!current) {
    return (
      <div className="weather-display weather-display--empty">
        {connected ? 'Waiting for weather data...' : 'Connecting to weather service...'}
      </div>
    );
  }

  // Small folds the location into the subtitle line and drops the alert
  // banner — there's no room for it, and the banner would dominate the tile.
  if (size === 'small') {
    return (
      <div className="weather-display weather-display--small">
        <CurrentCompact data={current} location={location} />
      </div>
    );
  }

  return (
    <div className={`weather-display weather-display--${size}`}>
      <AlertBanner alerts={alerts} />
      {location && <div className="weather-location">{location}</div>}
      <CurrentConditions data={current} />
      <SunBar data={current} />
      {size === 'large' && (
        <>
          <div className="weather-divider" />
          <div className="weather-forecasts">
            <HourlyForecast data={hourly} />
            <div className="weather-divider--vertical" />
            <DailyForecast data={daily} />
          </div>
        </>
      )}
    </div>
  );
}

WeatherDisplay.propTypes = {
  config: PropTypes.shape({
    mqtt_connection_id: PropTypes.string,
    weather_topic_prefix: PropTypes.string,
    weather_location: PropTypes.string,
    weather_size: PropTypes.oneOf(['small', 'medium', 'large'])
  })
};

export default WeatherDisplay;
