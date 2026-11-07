// Planning info for a trip's destination: where it is and its local time,
// the weather for the trip days, public holidays, and which popular places
// are closed or likely to be crowded on each day.
//
// Every source is free and needs no key:
//   Open-Meteo   geocoding, forecast (16 days) and past-years weather
//   MET Norway   backup forecast if Open-Meteo is rate limited
//   Nager.Date   public holidays
// Places come from Geoapify through config/places.js (already configured for
// recommendations). Results are cached in memory so a busy group doesn't
// hammer the providers.
const axios = require("axios");
const OpeningHours = require("opening_hours");
const places = require("../config/places");

const UA = "Atlasphere/1.0 (+https://atlasphere.up.railway.app)";
const DAY_MS = 24 * 60 * 60 * 1000;
const FORECAST_DAYS = 16;
const MAX_TRIP_DAYS = 60;

// ── tiny TTL cache ────────────────────────────────────────────────────────
function createCache() {
  const store = new Map();
  return async function cached(key, ttlMs, fn) {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await fn();
    if (value !== undefined && value !== null) {
      store.set(key, { at: Date.now(), value });
      if (store.size > 2000) store.delete(store.keys().next().value);
    }
    return value;
  };
}

// ── dates (all trip dates are plain "YYYY-MM-DD" strings) ──────────────────
function isoDate(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function parseIso(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
  const d = new Date(s + "T00:00:00Z");
  return isNaN(d) || isoDate(d) !== s ? null : d;
}
function addDays(iso, n) { return isoDate(new Date(parseIso(iso).getTime() + n * DAY_MS)); }
function dateRange(start, end) {
  const out = [];
  for (let d = start; d <= end && out.length < MAX_TRIP_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}
function weekday(iso) { return parseIso(iso).getUTCDay(); } // 0 = Sunday
function shiftYears(iso, years) {
  const [y, m, d] = iso.split("-").map(Number);
  const day = (m === 2 && d === 29) ? 28 : d;
  return (y + years) + "-" + String(m).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}
// Today's date in a time zone.
function todayIn(timeZone, now) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    if (/^\d{4}-\d{2}-\d{2}$/.test(parts)) return parts;
  } catch (e) { /* unknown zone */ }
  return isoDate(now);
}

// The itinerary stores its range as day-of-month numbers in one month
// (calMonth is 0-based; the range may run into the next month).
function tripFromItinerary(row) {
  if (!row || row.rangeStart === null || row.rangeStart === undefined || row.calYear === null || row.calMonth === null) return null;
  const startNum = Number(row.rangeStart);
  const endNum = row.rangeEnd === null || row.rangeEnd === undefined ? startNum : Number(row.rangeEnd);
  if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) return null;
  const start = new Date(Date.UTC(Number(row.calYear), Number(row.calMonth), startNum));
  const end = new Date(Date.UTC(Number(row.calYear), Number(row.calMonth), Math.max(startNum, endNum)));
  if (isNaN(start) || isNaN(end)) return null;
  return { start: isoDate(start), end: isoDate(end) };
}

// 🇮🇹 → "IT"
function countryCodeFromFlag(flag) {
  const cps = Array.from(String(flag || "")).map((c) => c.codePointAt(0));
  if (cps.length < 2) return null;
  const letters = cps.slice(0, 2).map((cp) => cp - 0x1f1e6);
  if (letters.some((n) => n < 0 || n > 25)) return null;
  return letters.map((n) => String.fromCharCode(65 + n)).join("");
}

// ── weather ───────────────────────────────────────────────────────────────
// One small vocabulary for both providers: clear, partly, cloudy, fog,
// drizzle, rain, snow, storm.
function kindFromWmo(code) {
  const c = Number(code);
  if (c === 0 || c === 1) return "clear";
  if (c === 2) return "partly";
  if (c === 3) return "cloudy";
  if (c === 45 || c === 48) return "fog";
  if (c >= 51 && c <= 57) return "drizzle";
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return "rain";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  if (c >= 95) return "storm";
  return "cloudy";
}
function kindFromMetSymbol(sym) {
  const s = String(sym || "");
  if (s.includes("thunder")) return "storm";
  if (s.includes("snow") || s.includes("sleet")) return "snow";
  if (s.includes("drizzle") || s.includes("lightrain")) return "drizzle";
  if (s.includes("rain")) return "rain";
  if (s.includes("fog")) return "fog";
  if (s.includes("partlycloudy") || s.includes("fair")) return "partly";
  if (s.includes("clearsky")) return "clear";
  return "cloudy";
}
const round1 = (n) => (typeof n === "number" && isFinite(n) ? Math.round(n * 10) / 10 : null);

module.exports = function createDestination(opts) {
  const options = opts || {};
  const http = options.http || axios;
  const now = options.now || (() => new Date());
  const placesApi = options.places || places;
  const cached = createCache();

  async function getJson(url, params, headers) {
    const res = await http.get(url, { params, headers: Object.assign({ "User-Agent": UA }, headers || {}), timeout: 6000 });
    return res.data;
  }

  // City → coordinates and time zone. Open-Meteo first (gives the zone),
  // Geoapify as a backup when it's configured.
  async function locate(city, countryCode) {
    const key = "geo:" + String(city).toLowerCase() + ":" + (countryCode || "");
    return cached(key, 30 * DAY_MS, async () => {
      try {
        const data = await getJson("https://geocoding-api.open-meteo.com/v1/search", { name: city, count: 10, language: "en", format: "json" });
        const results = (data && data.results) || [];
        const best = results.find((r) => countryCode && r.country_code === countryCode) || (countryCode ? null : results[0]);
        if (best) {
          return { name: best.name, country: best.country || null, countryCode: best.country_code || countryCode || null, lat: best.latitude, lon: best.longitude, timezone: best.timezone || "UTC" };
        }
      } catch (e) {
        console.error("Geocoding (Open-Meteo) failed for " + city + ":", e.message);
      }
      const apiKey = (process.env.GEOAPIFY_API_KEY || "").trim();
      if (!apiKey) return null;
      try {
        const data = await getJson("https://api.geoapify.com/v1/geocode/search", { text: city, filter: countryCode ? "countrycode:" + countryCode.toLowerCase() : undefined, format: "json", limit: 1, apiKey });
        const r = data && data.results && data.results[0];
        if (!r) return null;
        return { name: r.city || r.name || city, country: r.country || null, countryCode: (r.country_code || countryCode || "").toUpperCase() || null, lat: r.lat, lon: r.lon, timezone: (r.timezone && r.timezone.name) || "UTC" };
      } catch (e) {
        console.error("Geocoding (Geoapify) failed for " + city + ":", e.message);
        return null;
      }
    });
  }

  // Current conditions plus a daily forecast for the next 16 days.
  async function forecast(loc) {
    const key = "fc:" + loc.lat.toFixed(2) + "," + loc.lon.toFixed(2);
    return cached(key, 2 * 60 * 60 * 1000, async () => {
      try {
        const d = await getJson("https://api.open-meteo.com/v1/forecast", {
          latitude: loc.lat, longitude: loc.lon, timezone: loc.timezone || "auto", forecast_days: FORECAST_DAYS,
          current: "temperature_2m,weather_code,is_day",
          daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
        });
        const days = {};
        (d.daily && d.daily.time || []).forEach((date, i) => {
          days[date] = {
            kind: kindFromWmo(d.daily.weather_code[i]),
            max: round1(d.daily.temperature_2m_max[i]),
            min: round1(d.daily.temperature_2m_min[i]),
            rainChance: d.daily.precipitation_probability_max ? d.daily.precipitation_probability_max[i] : null,
            rainMm: round1(d.daily.precipitation_sum ? d.daily.precipitation_sum[i] : null),
            source: "forecast",
          };
        });
        const current = d.current ? { temp: round1(d.current.temperature_2m), kind: kindFromWmo(d.current.weather_code), isDay: d.current.is_day === 1 } : null;
        return { current, days };
      } catch (e) {
        console.error("Forecast (Open-Meteo) failed:", e.message);
        return metNorwayForecast(loc);
      }
    });
  }

  // Backup forecast (about 9 days). Hourly data is folded into local days.
  async function metNorwayForecast(loc) {
    try {
      const d = await getJson("https://api.met.no/weatherapi/locationforecast/2.0/compact", { lat: loc.lat.toFixed(3), lon: loc.lon.toFixed(3) });
      const series = (d && d.properties && d.properties.timeseries) || [];
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: loc.timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
      const days = {};
      series.forEach((t) => {
        const parts = Object.fromEntries(fmt.formatToParts(new Date(t.time)).map((p) => [p.type, p.value]));
        const date = parts.year + "-" + parts.month + "-" + parts.day;
        const hour = Number(parts.hour);
        const temp = t.data && t.data.instant && t.data.instant.details && t.data.instant.details.air_temperature;
        const day = days[date] || (days[date] = { max: -Infinity, min: Infinity, rainMm: 0, kind: null, source: "forecast", rainChance: null });
        if (typeof temp === "number") { day.max = Math.max(day.max, temp); day.min = Math.min(day.min, temp); }
        // Hourly steps for the first days, then 6-hourly: count each once.
        const step = t.data.next_1_hours || t.data.next_6_hours;
        if (step && step.details && typeof step.details.precipitation_amount === "number") day.rainMm += step.details.precipitation_amount;
        const sym = (t.data.next_6_hours || t.data.next_1_hours || {}).summary;
        if (sym && (day.kind === null || (hour >= 11 && hour <= 14))) day.kind = kindFromMetSymbol(sym.symbol_code);
      });
      Object.values(days).forEach((day) => {
        day.max = isFinite(day.max) ? round1(day.max) : null;
        day.min = isFinite(day.min) ? round1(day.min) : null;
        day.rainMm = round1(day.rainMm);
        day.kind = day.kind || "cloudy";
        // A dry midday symbol on a wet day would mislead.
        const dry = ["clear", "partly", "cloudy", "fog"].includes(day.kind);
        if (dry && day.rainMm >= 3) day.kind = "rain";
        else if (dry && day.rainMm >= 0.5) day.kind = "drizzle";
      });
      const first = series[0];
      const current = first ? { temp: round1(first.data.instant.details.air_temperature), kind: kindFromMetSymbol(((first.data.next_1_hours || {}).summary || {}).symbol_code), isDay: null } : null;
      return { current, days };
    } catch (e) {
      console.error("Forecast (MET Norway) failed:", e.message);
      return null;
    }
  }

  // What the weather is usually like on these dates: the same dates in the
  // last three years, averaged.
  async function typical(loc, dates) {
    if (!dates.length) return {};
    const key = "typ:" + loc.lat.toFixed(2) + "," + loc.lon.toFixed(2) + ":" + dates[0] + ":" + dates[dates.length - 1];
    return cached(key, 7 * DAY_MS, async () => {
      const today = isoDate(now());
      const latestUsable = addDays(today, -7); // the archive lags a few days
      const offsets = [];
      for (let k = 1; offsets.length < 3 && k < 8; k++) {
        if (shiftYears(dates[dates.length - 1], -k) <= latestUsable) offsets.push(k);
      }
      const years = await Promise.all(offsets.map(async (k) => {
        try {
          const d = await getJson("https://archive-api.open-meteo.com/v1/archive", {
            latitude: loc.lat, longitude: loc.lon, timezone: loc.timezone || "auto",
            start_date: shiftYears(dates[0], -k), end_date: shiftYears(dates[dates.length - 1], -k),
            daily: "temperature_2m_max,temperature_2m_min,precipitation_sum",
          });
          const byDate = {};
          (d.daily && d.daily.time || []).forEach((t, i) => {
            byDate[t] = { max: d.daily.temperature_2m_max[i], min: d.daily.temperature_2m_min[i], rain: d.daily.precipitation_sum[i] };
          });
          return { k, byDate };
        } catch (e) {
          console.error("Past weather (Open-Meteo) failed:", e.message);
          return null;
        }
      }));
      const ok = years.filter(Boolean);
      if (!ok.length) return null;
      const out = {};
      dates.forEach((date) => {
        const samples = ok.map((y) => y.byDate[shiftYears(date, -y.k)]).filter((s) => s && typeof s.max === "number");
        if (!samples.length) return;
        const avg = (f) => samples.reduce((a, s) => a + (typeof s[f] === "number" ? s[f] : 0), 0) / samples.length;
        const wetShare = samples.filter((s) => (s.rain || 0) >= 1).length / samples.length;
        const max = avg("max");
        const kind = wetShare >= 0.5 ? (max <= 2 ? "snow" : "rain") : wetShare > 0 ? "partly" : "clear";
        out[date] = { kind, max: round1(max), min: round1(avg("min")), rainMm: round1(avg("rain")), rainChance: samples.length >= 2 ? Math.round(wetShare * 100) : null, source: "typical", years: samples.length };
      });
      return out;
    });
  }

  // Public holidays for a country and year, as { date, name, localName, regional }.
  async function holidaysFor(countryCode, year) {
    if (!countryCode) return [];
    const key = "hol:" + countryCode + ":" + year;
    const list = await cached(key, 7 * DAY_MS, async () => {
      try {
        const d = await getJson("https://date.nager.at/api/v3/PublicHolidays/" + year + "/" + encodeURIComponent(countryCode));
        if (!Array.isArray(d)) return [];
        return d.map((h) => ({
          date: h.date,
          name: h.name,
          localName: h.localName && h.localName !== h.name ? h.localName : null,
          regional: h.global === false,
          regions: Array.isArray(h.counties) ? h.counties.length : 0,
        }));
      } catch (e) {
        // 404 = a country Nager.Date doesn't cover; 204 = no data
        if (!(e.response && (e.response.status === 404 || e.response.status === 204))) console.error("Holidays failed for " + countryCode + ":", e.message);
        return null;
      }
    });
    return list || [];
  }

  // ── public: overview ────────────────────────────────────────────────────
  // trip = { start, end } (ISO dates) or null when no dates are picked yet.
  async function overview(group, trip) {
    const countryCode = group.countryCode || countryCodeFromFlag(group.flag);
    const city = group.destination || group.name;
    const loc = await locate(city, countryCode);
    if (!loc) return { location: null, trip: trip || null, days: [], holidays: [], current: null };

    const nowDate = now();
    const today = todayIn(loc.timezone, nowDate);
    // Without trip dates, show the coming week so there's still a forecast.
    const dates = trip ? dateRange(trip.start, trip.end) : dateRange(today, addDays(today, 6));

    // Holidays: the trip's years, or the coming 12 months when there's no trip.
    const years = new Set(trip ? dates.map((d) => d.slice(0, 4)) : [today.slice(0, 4), String(Number(today.slice(0, 4)) + 1)]);
    const allHolidays = (await Promise.all([...years].map((y) => holidaysFor(loc.countryCode, y)))).flat();
    const holidayByDate = {};
    allHolidays.forEach((h) => { (holidayByDate[h.date] = holidayByDate[h.date] || []).push(h); });

    // Forecast and past-years weather load side by side. Past years cover
    // every day past the backup forecast's ~9-day reach, in case the main
    // forecast is unavailable.
    const needTypical = dates.filter((d) => d > addDays(today, 8));
    const [fc, typ] = await Promise.all([
      forecast(loc),
      needTypical.length ? typical(loc, needTypical) : Promise.resolve({}),
    ]);

    const days = dates.map((date) => {
      const weather = (fc && fc.days[date] && date >= today) ? fc.days[date] : (typ && typ[date]) || null;
      const holidays = holidayByDate[date] || [];
      const wd = weekday(date);
      return {
        date,
        weekday: wd,
        weekend: wd === 0 || wd === 6,
        past: date < today,
        weather,
        holidays,
        busy: busyLevel(date, holidays, loc.lat),
      };
    });

    const upcoming = trip
      ? allHolidays.filter((h) => h.date >= trip.start && h.date <= trip.end)
      : allHolidays.filter((h) => h.date >= today && h.date <= addDays(today, 365)).slice(0, 12);

    return {
      location: { city: loc.name || city, country: loc.country || group.name || null, countryCode: loc.countryCode, lat: loc.lat, lon: loc.lon, timezone: loc.timezone },
      today,
      trip: trip || null,
      current: fc ? fc.current : null,
      weatherAvailable: !!(fc || (typ && Object.keys(typ).length)),
      days,
      holidays: upcoming,
      holidaysCovered: allHolidays.length > 0,
    };
  }

  // ── public: places, closures and estimated crowds ───────────────────────
  async function placesInfo(group, trip) {
    const countryCode = group.countryCode || countryCodeFromFlag(group.flag);
    const city = group.destination || group.name;
    const loc = await locate(city, countryCode);
    let features = [];
    try { features = await placesApi.fetchPlaces(city); } catch (e) { console.error("Places failed for " + city + ":", e.message); }

    const today = loc ? todayIn(loc.timezone, now()) : isoDate(now());
    const dates = trip ? dateRange(trip.start, trip.end) : dateRange(today, addDays(today, 6));
    const years = new Set(dates.map((d) => d.slice(0, 4)));
    const holidays = loc ? (await Promise.all([...years].map((y) => holidaysFor(loc.countryCode, y)))).flat() : [];
    const holidayByDate = {};
    holidays.forEach((h) => { (holidayByDate[h.date] = holidayByDate[h.date] || []).push(h); });

    const seen = {};
    const list = [];
    features.forEach((f, index) => {
      const p = f && f.properties;
      if (!p || !p.name || typeof p.lat !== "number" || typeof p.lon !== "number") return;
      if (placesApi.looksLikeCode && placesApi.looksLikeCode(p.name)) return;
      const nameKey = String(p.name).trim().toLowerCase();
      if (seen[nameKey]) return;
      seen[nameKey] = true;
      const hours = placesApi.openingHoursOf ? placesApi.openingHoursOf(p) : null;
      const status = hoursStatus(hours, dates, p, loc);
      list.push({
        id: p.place_id || ("geoapify-" + index),
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        kind: placesApi.describe ? placesApi.describe(p.categories) : null,
        popularity: popularity(p),
        hours,
        hoursKnown: status.known,
        closedOn: status.closedOn,
        seasonal: status.seasonal,
      });
    });

    return {
      location: loc ? { city: loc.name || city, lat: loc.lat, lon: loc.lon, timezone: loc.timezone } : null,
      dates,
      tripDates: !!trip,
      days: dates.map((date) => ({ date, busy: busyLevel(date, holidayByDate[date] || [], loc ? loc.lat : 0) })),
      places: list,
    };
  }

  return { overview, placesInfo, locate };
};

// How busy a day tends to be, from things that are known for sure: weekends,
// public holidays and peak travel months. 1 = an ordinary weekday.
function busyLevel(date, holidays, lat) {
  const wd = weekday(date);
  const month = Number(date.slice(5, 7));
  const reasons = [];
  let factor = 1;
  const national = holidays.filter((h) => !h.regional);
  if (national.length) { factor *= 1.5; reasons.push("public holiday"); }
  else if (holidays.length) { factor *= 1.2; reasons.push("regional holiday"); }
  if (wd === 0 || wd === 6) { factor *= 1.3; reasons.push("weekend"); }
  const northPeak = [6, 7, 8].includes(month) || (month === 12 && Number(date.slice(8, 10)) >= 20);
  const southPeak = [12, 1, 2].includes(month);
  if ((lat >= 0 && northPeak) || (lat < 0 && southPeak)) { factor *= 1.2; reasons.push("peak season"); }
  return { factor: Math.round(factor * 100) / 100, level: factor >= 1.7 ? "very busy" : factor >= 1.25 ? "busier" : "normal", reasons };
}

// A rough "how many visitors does this draw" score from the place's type and
// whether it's notable enough to have a Wikipedia/Wikidata entry.
function popularity(p) {
  const cats = (p.categories || []).join(",");
  const raw = (p.datasource && p.datasource.raw) || {};
  let score = 0.35;
  if (/tourism\.(sights|attraction)/.test(cats)) score = 0.8;
  if (/entertainment\.(theme_park|zoo|aquarium|museum)|tourism\.sights\.(castle|cathedral|monument)/.test(cats)) score = 0.95;
  if (/commercial\.(shopping_mall|marketplace)/.test(cats)) score = Math.max(score, 0.7);
  if (/leisure\.park/.test(cats)) score = Math.max(score, 0.5);
  if (/catering/.test(cats)) score = Math.min(score, 0.3);
  if (raw.wikidata || raw.wikipedia || (p.wiki_and_media && (p.wiki_and_media.wikidata || p.wiki_and_media.wikipedia))) score += 0.4;
  return Math.round(Math.min(score, 1.4) * 100) / 100;
}

// Uses the OpenStreetMap opening hours to find the trip days a place is
// closed all day (including seasonal closures like "Nov-Mar off").
function hoursStatus(hours, dates, p, loc) {
  if (!hours) return { known: false, closedOn: [], seasonal: false };
  let oh;
  try {
    oh = new OpeningHours(hours, {
      lat: p.lat, lon: p.lon,
      address: { country_code: String((loc && loc.countryCode) || p.country_code || "").toLowerCase(), state: p.state || "" },
    }, { mode: 0, warnings_severity: 0 });
  } catch (e) {
    return { known: false, closedOn: [], seasonal: false };
  }
  const closedOn = [];
  dates.forEach((date) => {
    // The library works in the server's local time; build that local day.
    const [y, m, d] = date.split("-").map(Number);
    const from = new Date(y, m - 1, d, 0, 0, 0);
    const to = new Date(y, m - 1, d + 1, 0, 0, 0);
    try {
      const open = oh.getState(from) || oh.getOpenDuration(from, to)[0] > 0;
      const unknown = oh.getUnknown(from) && !open;
      if (!open && !unknown) closedOn.push(date);
    } catch (e) { /* ignore odd rules */ }
  });
  return { known: true, closedOn, seasonal: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(hours) };
}

module.exports.helpers = { tripFromItinerary, countryCodeFromFlag, busyLevel, popularity, hoursStatus, kindFromWmo, kindFromMetSymbol, dateRange, parseIso };
