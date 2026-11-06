// Shared helpers for the Destination tab and the planning hints shown on the
// itinerary and recommendations.

var WEATHER = {
  clear: { icon: '☀️', label: 'Sunny' },
  partly: { icon: '⛅', label: 'Partly cloudy' },
  cloudy: { icon: '☁️', label: 'Cloudy' },
  fog: { icon: '🌫️', label: 'Fog' },
  drizzle: { icon: '🌦️', label: 'Drizzle' },
  rain: { icon: '🌧️', label: 'Rain' },
  snow: { icon: '❄️', label: 'Snow' },
  storm: { icon: '⛈️', label: 'Thunderstorms' },
};

export function weatherIcon(kind, isDay) {
  if (kind === 'clear' && isDay === false) return '🌙';
  return (WEATHER[kind] || WEATHER.cloudy).icon;
}
export function weatherLabel(kind) { return (WEATHER[kind] || WEATHER.cloudy).label; }

// A typical (past years) day only says how often it rained, not if it's sunny.
export function dayLabel(w) {
  if (!w) return '';
  if (w.source !== 'typical') return weatherLabel(w.kind);
  if (w.kind === 'snow') return 'Often snowy';
  if (w.kind === 'rain') return 'Often rainy';
  if (w.kind === 'partly') return 'Some rain';
  return 'Usually dry';
}

export function temp(n) { return typeof n === 'number' ? Math.round(n) + '°' : '–'; }

var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-12-08" → "Tue 8 Dec"
export function shortDate(iso, withDay) {
  var d = new Date(iso + 'T12:00:00Z');
  var s = d.getUTCDate() + ' ' + MONTH_SHORT[d.getUTCMonth()];
  return withDay === false ? s : DAY_SHORT[d.getUTCDay()] + ' ' + s;
}

export function isoFromParts(year, month, day) {
  var d = new Date(Date.UTC(year, month, day));
  return d.toISOString().slice(0, 10);
}

// Minutes the zone is ahead of UTC right now.
function zoneOffset(timeZone, date) {
  try {
    var parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
    var asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
  } catch (e) {
    return 0;
  }
}

// { time: "14:32", day: "Fri", diff: "1 h ahead of you" }
export function localTime(timeZone, date) {
  var now = date || new Date();
  var time, day;
  try {
    time = new Intl.DateTimeFormat(undefined, { timeZone: timeZone, hour: '2-digit', minute: '2-digit' }).format(now);
    day = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone, weekday: 'long' }).format(now);
  } catch (e) {
    return null;
  }
  var mine = -now.getTimezoneOffset();
  var minutes = zoneOffset(timeZone, now) - mine;
  var diff;
  if (minutes === 0) diff = 'Same time as you';
  else {
    var abs = Math.abs(minutes);
    var h = Math.floor(abs / 60), m = abs % 60;
    diff = (h ? h + ' h' : '') + (m ? (h ? ' ' : '') + m + ' min' : '') + (minutes > 0 ? ' ahead of you' : ' behind you');
  }
  return { time: time, day: day, diff: diff };
}

// Short "why" for a busy day: "Weekend · public holiday".
export function busyText(busy) {
  if (!busy || !busy.reasons || !busy.reasons.length) return '';
  var s = busy.reasons.join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Fetch helper with a tiny in-page cache so the tabs share one request.
var memo = {};
export function getJson(url, fresh) {
  var hit = memo[url];
  if (!fresh && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.promise;
  var promise = fetch(url, { credentials: 'same-origin' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
  memo[url] = { at: Date.now(), promise: promise };
  promise.catch(function () { delete memo[url]; });
  return promise;
}

export function destinationUrl(groupId, kind, range) {
  var url = '/api/destination/' + encodeURIComponent(groupId) + (kind === 'places' ? '/places' : '');
  if (range && range.start && range.end) url += '?start=' + range.start + '&end=' + range.end;
  return url;
}

// Places by lower-cased name → place (to match itinerary blocks and cards).
export function placesByName(places) {
  var map = {};
  (places || []).forEach(function (p) { map[String(p.name).trim().toLowerCase()] = p; });
  return map;
}
