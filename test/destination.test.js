const test = require("node:test");
const assert = require("node:assert/strict");
const createDestination = require("../services/destination");
const { tripFromItinerary, countryCodeFromFlag, busyLevel, hoursStatus, kindFromWmo } = createDestination.helpers;

const ROME = { lat: 41.89, lon: 12.48, countryCode: "IT" };

test("trip dates come from the itinerary range, including into the next month", () => {
  assert.deepEqual(tripFromItinerary({ rangeStart: 29, rangeEnd: 33, calYear: 2026, calMonth: 11 }), { start: "2026-12-29", end: "2027-01-02" });
  assert.equal(tripFromItinerary({ rangeStart: null, rangeEnd: null, calYear: 2026, calMonth: 0 }), null);
  assert.equal(tripFromItinerary(undefined), null);
});

test("country code from a flag emoji", () => {
  assert.equal(countryCodeFromFlag("🇮🇹"), "IT");
  assert.equal(countryCodeFromFlag("🇯🇵"), "JP");
  assert.equal(countryCodeFromFlag(""), null);
  assert.equal(countryCodeFromFlag("IT"), null);
});

test("busy days: weekends, holidays and peak season", () => {
  assert.equal(busyLevel("2026-11-10", [], 41).level, "normal"); // a November Tuesday
  assert.deepEqual(busyLevel("2026-11-14", [], 41).reasons, ["weekend"]);
  const ferragosto = busyLevel("2026-08-15", [{ name: "Assumption Day", regional: false }], 41);
  assert.equal(ferragosto.level, "very busy");
  assert.deepEqual(ferragosto.reasons, ["public holiday", "weekend", "peak season"]);
  assert.deepEqual(busyLevel("2027-01-12", [], -33).reasons, ["peak season"]); // southern summer
});

test("closures: weekly rest days, seasonal closures and unknown hours", () => {
  const days = ["2026-12-07", "2026-12-08", "2026-12-09"]; // Mon, Tue, Wed
  assert.deepEqual(hoursStatus("Tu-Su 09:00-19:00", days, ROME, ROME).closedOn, ["2026-12-07"]);
  const seasonal = hoursStatus("Apr-Oct: 09:00-18:00; Nov-Mar off", days, ROME, ROME);
  assert.deepEqual(seasonal.closedOn, days);
  assert.equal(seasonal.seasonal, true);
  assert.deepEqual(hoursStatus("24/7", days, ROME, ROME).closedOn, []);
  assert.deepEqual(hoursStatus(null, days, ROME, ROME), { known: false, closedOn: [], seasonal: false });
  assert.equal(hoursStatus("this is not a rule", days, ROME, ROME).known, false);
});

test("weather codes map to a small vocabulary", () => {
  assert.equal(kindFromWmo(0), "clear");
  assert.equal(kindFromWmo(63), "rain");
  assert.equal(kindFromWmo(75), "snow");
  assert.equal(kindFromWmo(96), "storm");
});

// A fake HTTP client answering like the real providers.
function fakeHttp(overrides) {
  const calls = [];
  const handlers = Object.assign({
    "geocoding-api.open-meteo.com": () => ({ results: [
      { name: "Rome", country: "United States", country_code: "US", latitude: 34.2, longitude: -85.1, timezone: "America/New_York" },
      { name: "Rome", country: "Italy", country_code: "IT", latitude: 41.89, longitude: 12.48, timezone: "Europe/Rome" },
    ] }),
    "api.open-meteo.com": () => {
      const time = [], code = [], max = [], min = [], prob = [], sum = [];
      for (let i = 0; i < 16; i++) {
        time.push(new Date(Date.UTC(2026, 10, 6 + i)).toISOString().slice(0, 10));
        code.push(i % 2 ? 63 : 0); max.push(18 + i); min.push(9); prob.push(i % 2 ? 80 : 5); sum.push(i % 2 ? 6 : 0);
      }
      return { current: { temperature_2m: 17.3, weather_code: 2, is_day: 1 }, daily: { time, weather_code: code, temperature_2m_max: max, temperature_2m_min: min, precipitation_probability_max: prob, precipitation_sum: sum } };
    },
    "archive-api.open-meteo.com": (params) => {
      const time = [], max = [], min = [], rain = [];
      for (let d = params.start_date; d <= params.end_date; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) {
        time.push(d); max.push(12); min.push(4); rain.push(2);
      }
      return { daily: { time, temperature_2m_max: max, temperature_2m_min: min, precipitation_sum: rain } };
    },
    "date.nager.at": (params, url) => (url.endsWith("/2026/IT") ? [
      { date: "2026-12-08", localName: "Immacolata Concezione", name: "Immaculate Conception", global: true, counties: null },
      { date: "2026-12-25", localName: "Natale", name: "Christmas Day", global: true, counties: null },
    ] : []),
  }, overrides || {});
  return {
    calls,
    get: async (url, cfg) => {
      calls.push(url);
      const host = new URL(url).host;
      const h = handlers[host];
      if (!h) throw new Error("unexpected " + url);
      const data = await h((cfg && cfg.params) || {}, url);
      return { data };
    },
  };
}

const GROUP = { id: 1, name: "Italy", destination: "Rome", flag: "🇮🇹" };
const now = () => new Date("2026-11-06T10:00:00Z");

test("overview: forecast for near days, typical weather for later ones, holidays per day", async () => {
  const http = fakeHttp();
  const dest = createDestination({ http, now, places: { fetchPlaces: async () => [] } });
  const info = await dest.overview(GROUP, { start: "2026-11-20", end: "2026-12-09" });

  assert.equal(info.location.city, "Rome");
  assert.equal(info.location.countryCode, "IT"); // picked Rome, Italy, not Rome, Georgia
  assert.equal(info.location.timezone, "Europe/Rome");
  assert.equal(info.current.kind, "partly");
  assert.equal(info.days.length, 20);

  const first = info.days[0]; // 2026-11-20 is forecast day 15
  assert.equal(first.weather.source, "forecast");
  assert.equal(first.weather.max, 32);
  const later = info.days.find((d) => d.date === "2026-12-01");
  assert.equal(later.weather.source, "typical");
  assert.equal(later.weather.max, 12);
  assert.equal(later.weather.kind, "rain");

  const dec8 = info.days.find((d) => d.date === "2026-12-08");
  assert.equal(dec8.holidays[0].name, "Immaculate Conception");
  assert.equal(dec8.busy.level, "busier");
  assert.deepEqual(info.holidays.map((h) => h.date), ["2026-12-08"]);
});

test("overview without trip dates: the coming week and upcoming holidays", async () => {
  const dest = createDestination({ http: fakeHttp(), now, places: { fetchPlaces: async () => [] } });
  const info = await dest.overview(GROUP, null);
  assert.equal(info.trip, null);
  // Without dates: the coming week, with the forecast.
  assert.deepEqual(info.days.map((d) => d.date), ["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]);
  assert.equal(info.days[0].weather.source, "forecast");
  assert.deepEqual(info.holidays.map((h) => h.name), ["Immaculate Conception", "Christmas Day"]);
});

test("falls back to MET Norway when Open-Meteo is rate limited", async () => {
  const limited = async () => { const e = new Error("429"); e.response = { status: 429 }; throw e; };
  const http = fakeHttp({
    "api.open-meteo.com": limited,
    "archive-api.open-meteo.com": limited,
    "api.met.no": () => ({ properties: { timeseries: [
      { time: "2026-11-07T11:00:00Z", data: { instant: { details: { air_temperature: 15 } }, next_1_hours: { summary: { symbol_code: "rain" }, details: { precipitation_amount: 1.2 } }, next_6_hours: { summary: { symbol_code: "rain" }, details: {} } } },
      { time: "2026-11-07T15:00:00Z", data: { instant: { details: { air_temperature: 19 } }, next_1_hours: { summary: { symbol_code: "cloudy" }, details: { precipitation_amount: 0 } } } },
    ] } }),
  });
  const dest = createDestination({ http, now, places: { fetchPlaces: async () => [] } });
  const info = await dest.overview(GROUP, { start: "2026-11-07", end: "2026-11-08" });
  assert.equal(info.days[0].weather.max, 19);
  assert.equal(info.days[0].weather.min, 15);
  assert.equal(info.days[0].weather.kind, "rain");
  assert.equal(info.days[1].weather, null); // no data at all: shown as unavailable
  assert.equal(info.weatherAvailable, true);
});

test("places: closures on the trip days and a popularity score", async () => {
  const features = [
    { properties: { place_id: "a", name: "Colosseum", lat: 41.89, lon: 12.49, categories: ["tourism.sights"], datasource: { raw: { wikidata: "Q10285", opening_hours: "Tu-Su 09:00-19:00" } } } },
    { properties: { place_id: "b", name: "Summer Lido", lat: 41.7, lon: 12.3, categories: ["leisure.park"], opening_hours: "May-Sep 08:00-20:00; Oct-Apr off" } },
    { properties: { place_id: "c", name: "Caffè", lat: 41.9, lon: 12.5, categories: ["catering.cafe"] } },
    { properties: { place_id: "d", name: "PA_1200", lat: 41.9, lon: 12.5, categories: [] } },
  ];
  const places = require("../config/places");
  const dest = createDestination({ http: fakeHttp(), now, places: Object.assign({}, places, { fetchPlaces: async () => features }) });
  const info = await dest.placesInfo(GROUP, { start: "2026-12-07", end: "2026-12-08" });

  assert.equal(info.places.length, 3);
  const [colosseum, lido, cafe] = info.places;
  assert.deepEqual(colosseum.closedOn, ["2026-12-07"]);
  assert.ok(colosseum.popularity > lido.popularity);
  assert.deepEqual(lido.closedOn, ["2026-12-07", "2026-12-08"]);
  assert.equal(lido.seasonal, true);
  assert.equal(cafe.hoursKnown, false);
  assert.equal(info.days[1].busy.reasons[0], "public holiday");
});
