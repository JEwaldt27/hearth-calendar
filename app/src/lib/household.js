import { one, query } from '../db.js';
import { httpError } from './security.js';

/** Household-wide settings managed by admins: location (for weather) and temperature units. */
export async function householdSettings() {
  const row = await one("SELECT value FROM app_settings WHERE key = 'household'");
  return { placeName: '', latitude: null, longitude: null, units: 'fahrenheit', ...(row?.value || {}) };
}

export async function saveHouseholdSettings(input) {
  const current = await householdSettings();
  const next = { ...current };
  if (input.units !== undefined) next.units = input.units === 'celsius' ? 'celsius' : 'fahrenheit';
  if (input.clearLocation) Object.assign(next, { placeName: '', latitude: null, longitude: null });
  if (input.latitude !== undefined && input.longitude !== undefined) {
    const lat = Number(input.latitude);
    const lon = Number(input.longitude);
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw httpError(400, 'Invalid location.');
    next.latitude = lat;
    next.longitude = lon;
    next.placeName = String(input.placeName || '').slice(0, 120);
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('household', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [next],
  );
  weatherCache = null;
  return next;
}

/** City search via Open-Meteo's free geocoding service (no API key). */
export async function geocode(q) {
  const name = String(q || '').trim();
  if (name.length < 2) return [];
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=${encodeURIComponent(name)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw httpError(502, 'Location search is unavailable right now.');
  const json = await res.json();
  return (json.results || []).map((r) => ({
    name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
  }));
}

// WMO weather codes → emoji + short label.
function describe(code, isDay = true) {
  if (code === 0) return { icon: isDay ? '☀️' : '🌙', label: 'Clear' };
  if (code === 1 || code === 2) return { icon: isDay ? '⛅' : '☁️', label: code === 1 ? 'Mostly clear' : 'Partly cloudy' };
  if (code === 3) return { icon: '☁️', label: 'Cloudy' };
  if (code === 45 || code === 48) return { icon: '🌫️', label: 'Fog' };
  if (code >= 51 && code <= 57) return { icon: '🌦️', label: 'Drizzle' };
  if (code >= 61 && code <= 67) return { icon: '🌧️', label: 'Rain' };
  if (code >= 71 && code <= 77) return { icon: '❄️', label: 'Snow' };
  if (code >= 80 && code <= 82) return { icon: '🌦️', label: 'Showers' };
  if (code === 85 || code === 86) return { icon: '🌨️', label: 'Snow showers' };
  if (code >= 95) return { icon: '⛈️', label: 'Thunderstorms' };
  return { icon: '🌡️', label: '' };
}

let weatherCache = null;

/** Current conditions + 3-day forecast, cached for 15 minutes. */
export async function weather() {
  const h = await householdSettings();
  if (h.latitude === null || h.longitude === null) return { configured: false };
  if (weatherCache && weatherCache.expires > Date.now()) return weatherCache.data;
  const params = new URLSearchParams({
    latitude: h.latitude,
    longitude: h.longitude,
    current: 'temperature_2m,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: h.units,
    timezone: 'auto',
    forecast_days: '3',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw httpError(502, 'Weather is unavailable right now.');
  const j = await res.json();
  const data = {
    configured: true,
    place: h.placeName,
    units: h.units === 'celsius' ? '°C' : '°F',
    current: { temp: Math.round(j.current.temperature_2m), ...describe(j.current.weather_code, j.current.is_day === 1) },
    days: j.daily.time.map((date, i) => ({
      date,
      high: Math.round(j.daily.temperature_2m_max[i]),
      low: Math.round(j.daily.temperature_2m_min[i]),
      rain: j.daily.precipitation_probability_max?.[i] ?? null,
      ...describe(j.daily.weather_code[i]),
    })),
  };
  weatherCache = { data, expires: Date.now() + 15 * 60 * 1000 };
  return data;
}
