import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import { HeatLayer } from 'leaflet.heat';
import 'leaflet/dist/leaflet.css';
import '../styles/destination.css';
import {
  weatherIcon, weatherLabel, dayLabel, temp, shortDate, localTime, busyText, getJson, destinationUrl,
} from './destinationInfo';

// Destination tab: local time and weather, the trip days at a glance, public
// holidays, and a map of estimated crowds and closed places for a chosen day.

function useTheme() {
  var read = function () { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; };
  var state = useState(read);
  useEffect(function () {
    var obs = new MutationObserver(function () { state[1](read()); });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return function () { obs.disconnect(); };
  }, []);
  return state[0];
}

function useClock(timeZone) {
  var state = useState(function () { return timeZone ? localTime(timeZone) : null; });
  useEffect(function () {
    if (!timeZone) return;
    state[1](localTime(timeZone));
    var t = setInterval(function () { state[1](localTime(timeZone)); }, 20000);
    return function () { clearInterval(t); };
  }, [timeZone]);
  return state[0];
}

function Header({ info, flag }) {
  var loc = info.location;
  var clock = useClock(loc.timezone);
  var cur = info.current;
  // Day or night at the destination (the backup forecast doesn't say).
  var isDay = cur && cur.isDay !== null && cur.isDay !== undefined ? cur.isDay : (function () {
    try { var h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: loc.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date())); return h >= 6 && h < 19; }
    catch (e) { return null; }
  })();
  return (
    <div className="dt-card dt-head">
      <div className="dt-head__place">
        <h2 className="dt-head__title">{flag ? <span className="dt-head__flag">{flag}</span> : null}{loc.city}{loc.country ? ', ' + loc.country : ''}</h2>
        {clock && (
          <p className="dt-head__time">
            <span className="dt-head__clock">{clock.time}</span>
            <span>{clock.day} · {clock.diff}</span>
          </p>
        )}
      </div>
      {cur && (
        <div className="dt-head__now" title={weatherLabel(cur.kind, isDay)}>
          <span className="dt-head__now-icon" aria-hidden="true">{weatherIcon(cur.kind, isDay)}</span>
          <span className="dt-head__now-temp">{temp(cur.temp)}</span>
          <span className="dt-head__now-label">{weatherLabel(cur.kind, isDay)} now</span>
        </div>
      )}
    </div>
  );
}

function DayCard({ day, active, closedCount, onSelect }) {
  var w = day.weather;
  var busy = day.busy && day.busy.level !== 'normal';
  return (
    <button type="button" className={'dt-day' + (active ? ' dt-day--active' : '') + (day.holidays.length ? ' dt-day--holiday' : '')} onClick={onSelect} aria-pressed={active}>
      <span className="dt-day__date">{shortDate(day.date)}</span>
      {w ? (
        <>
          <span className="dt-day__icon" title={dayLabel(w)}>{weatherIcon(w.kind)}</span>
          <span className="dt-day__temps"><b>{temp(w.max)}</b> {temp(w.min)}</span>
          <span className="dt-day__rain">{typeof w.rainChance === 'number' ? '💧 ' + w.rainChance + '%' : ''}</span>
          <span className="dt-day__src">{w.source === 'forecast' ? 'Forecast' : 'Typical · ' + dayLabel(w)}</span>
        </>
      ) : <span className="dt-day__src dt-day__src--none">No weather yet</span>}
      {day.holidays.length > 0 && <span className="dt-chip dt-chip--holiday" title={day.holidays.map(function (h) { return h.name; }).join(', ')}>🎉 Holiday</span>}
      {busy && <span className={'dt-chip dt-chip--busy' + (day.busy.level === 'very busy' ? ' dt-chip--hot' : '')} title={busyText(day.busy)}>{day.busy.level === 'very busy' ? 'Very busy' : 'Busier'}</span>}
      {closedCount > 0 && <span className="dt-chip dt-chip--closed">{closedCount} closed</span>}
    </button>
  );
}

function CrowdMap({ places, day, theme, location }) {
  var el = useRef(null);
  var mapRef = useRef(null);
  var heatRef = useRef(null);
  var closedRef = useRef(null);
  var tilesRef = useRef(null);

  // Create the map once.
  useEffect(function () {
    if (!el.current || mapRef.current) return;
    var touch = window.matchMedia && window.matchMedia('(hover: none)').matches;
    var map = L.map(el.current, {
      // On phones one finger scrolls the page; pinch or the buttons zoom.
      dragging: !touch,
      scrollWheelZoom: false,
      zoomControl: true,
      attributionControl: true,
    });
    map.setView([location.lat, location.lon], 13);
    mapRef.current = map;
    heatRef.current = new HeatLayer([], { radius: 30, blur: 24, max: 1.6, maxZoom: 12, minOpacity: 0.25, gradient: { 0.3: '#3b82f6', 0.55: '#22c55e', 0.75: '#facc15', 1: '#ef4444' } }).addTo(map);
    closedRef.current = L.layerGroup().addTo(map);
    setTimeout(function () { map.invalidateSize(); }, 50);
    return function () { map.remove(); mapRef.current = null; tilesRef.current = null; };
  }, [location.lat, location.lon]);

  // OpenStreetMap tiles; darkened with a filter in the dark theme.
  useEffect(function () {
    var map = mapRef.current;
    if (!map || tilesRef.current) return;
    tilesRef.current = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'dt-tiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
  }, [location.lat, location.lon]);

  // Heat and closed markers for the selected day.
  useEffect(function () {
    var map = mapRef.current;
    if (!map) return;
    var factor = (day && day.busy && day.busy.factor) || 1;
    var date = day && day.date;
    var points = [];
    closedRef.current.clearLayers();
    places.forEach(function (p) {
      var closed = date && p.closedOn.indexOf(date) !== -1;
      if (closed) {
        L.circleMarker([p.lat, p.lon], { radius: 7, color: '#9ca3af', weight: 2, dashArray: '3 3', fillColor: '#4b5563', fillOpacity: 0.85 })
          .bindTooltip(p.name + ' · closed' + (p.seasonal ? ' (seasonal)' : ''), { direction: 'top' })
          .addTo(closedRef.current);
      } else {
        points.push([p.lat, p.lon, p.popularity * factor]);
      }
    });
    heatRef.current.setLatLngs(points);
    if (places.length && !map._dtFitted) {
      // Frame the main cluster; a far-off beach or airport shouldn't zoom the map out.
      var lats = places.map(function (p) { return p.lat; }).sort(), lons = places.map(function (p) { return p.lon; }).sort();
      var mid = [lats[lats.length >> 1], lons[lons.length >> 1]];
      var dist = function (p) { return Math.hypot(p.lat - mid[0], (p.lon - mid[1]) * Math.cos(mid[0] * Math.PI / 180)); };
      var ds = places.map(dist).sort(function (a, b) { return a - b; });
      var limit = Math.max(ds[Math.floor(ds.length * 0.8)] * 1.5, 0.01);
      var core = places.filter(function (p) { return dist(p) <= limit; });
      var bounds = L.latLngBounds((core.length ? core : places).map(function (p) { return [p.lat, p.lon]; }));
      map.fitBounds(bounds.pad(0.1), { maxZoom: 14 });
      map._dtFitted = true;
    }
  }, [places, day]);

  return <div ref={el} className="dt-map" role="img" aria-label="Map of estimated crowds and closed places" />;
}

function Crowds({ placesInfo, day, theme }) {
  var places = placesInfo.places;
  var date = day && day.date;
  var closed = places.filter(function (p) { return date && p.closedOn.indexOf(date) !== -1; });
  var busiest = places
    .filter(function (p) { return !(date && p.closedOn.indexOf(date) !== -1); })
    .slice().sort(function (a, b) { return b.popularity - a.popularity; })
    .slice(0, 5);
  var withHours = places.filter(function (p) { return p.hoursKnown; }).length;
  var reasons = busyText(day && day.busy);

  return (
    <div className="dt-card dt-crowds">
      <div className="dt-section-head">
        <h3 className="dt-h3">Crowds &amp; closures{day ? ' · ' + shortDate(day.date) : ''}</h3>
        <span className="dt-badge">Estimate</span>
      </div>
      <p className="dt-note">
        {reasons ? reasons + ', so expect bigger crowds than usual. ' : 'An ordinary day. '}
        Busier areas are where the best-known sights cluster. This is an estimate from place popularity, weekends, holidays and the season, not live data.
      </p>
      {placesInfo.location && places.length > 0
        ? <div className={'dt-mapwrap dt-mapwrap--' + theme}><CrowdMap key={placesInfo.location.lat + ',' + placesInfo.location.lon} places={places} day={day} theme={theme} location={placesInfo.location} /></div>
        : <p className="dt-empty">We couldn’t load places for this city right now.</p>}
      <div className="dt-legend" aria-hidden="true">
        <span>Quieter</span><span className="dt-legend__bar" /><span>Busier</span>
        <span className="dt-legend__closed" /><span>Closed</span>
      </div>
      <div className="dt-lists">
        <div>
          <h4 className="dt-h4">Busiest spots: go early</h4>
          {busiest.length ? (
            <ul className="dt-list">
              {busiest.map(function (p) { return <li key={p.id}>{p.name}{p.kind ? <span className="dt-muted"> · {p.kind}</span> : null}</li>; })}
            </ul>
          ) : <p className="dt-muted">Nothing to show.</p>}
        </div>
        <div>
          <h4 className="dt-h4">Closed {day ? 'on ' + shortDate(day.date) : 'this day'}</h4>
          {closed.length ? (
            <ul className="dt-list">
              {closed.map(function (p) { return <li key={p.id}>{p.name}{p.seasonal ? <span className="dt-muted"> · closed for the season</span> : null}<span className="dt-hours">{p.hours}</span></li>; })}
            </ul>
          ) : <p className="dt-muted">None of the places we know the hours for are closed.</p>}
          <p className="dt-fine">Opening hours are known for {withHours} of {places.length} places (from OpenStreetMap). Always check before you go.</p>
        </div>
      </div>
    </div>
  );
}

function Holidays({ info }) {
  var list = info.holidays;
  return (
    <div className="dt-card dt-holidays">
      <h3 className="dt-h3">Public holidays{info.trip ? ' during your trip' : ' coming up'}</h3>
      {!info.holidaysCovered ? (
        <p className="dt-muted">We don’t have holiday data for this country.</p>
      ) : list.length === 0 ? (
        <p className="dt-muted">No public holidays during your trip.</p>
      ) : (
        <>
          <ul className="dt-hol-list">
            {list.map(function (h, i) {
              return (
                <li key={h.date + i}>
                  <span className="dt-hol-date">{shortDate(h.date)}</span>
                  <span className="dt-hol-name">{h.name}{h.localName ? <span className="dt-muted"> · {h.localName}</span> : null}</span>
                  {h.regional && <span className="dt-chip">Some regions</span>}
                </li>
              );
            })}
          </ul>
          <p className="dt-fine">On public holidays many shops, banks and some sights close or open shorter hours, and popular places get busier.</p>
        </>
      )}
    </div>
  );
}

export default function DestinationTab(props) {
  var groupId = props.groupId;
  var theme = useTheme();
  var infoState = useState(null);
  var placesState = useState(null);
  var errState = useState('');
  var selState = useState(null);
  var cities = props.cities && props.cities.length ? props.cities : [props.destination].filter(Boolean);
  var cityState = useState(cities[0] || '');
  var city = cities.indexOf(cityState[0]) !== -1 ? cityState[0] : (cities[0] || '');
  var info = infoState[0], placesInfo = placesState[0], error = errState[0];

  useEffect(function () {
    if (!groupId) return;
    var cancelled = false;
    infoState[1](null); placesState[1](null); errState[1]('');
    getJson(destinationUrl(groupId, null, null, city), true).then(function (d) { if (!cancelled) infoState[1](d); })
      .catch(function () { if (!cancelled) errState[1]('We couldn’t load destination info right now. Try again in a minute.'); });
    getJson(destinationUrl(groupId, 'places', null, city), true).then(function (d) { if (!cancelled) placesState[1](d); })
      .catch(function () { if (!cancelled) placesState[1]({ places: [], days: [], dates: [], location: null }); });
    return function () { cancelled = true; };
  }, [groupId, city]);

  var cityChips = cities.length > 1 ? (
    <div className="dt-cities" role="tablist" aria-label="Cities on this trip">
      {cities.map(function (c) {
        return <button key={c} type="button" role="tab" aria-selected={c === city} className={'dt-city' + (c === city ? ' dt-city--active' : '')} onClick={function () { cityState[1](c); }}>📍 {c}</button>;
      })}
    </div>
  ) : null;

  // Day cards come from the trip; without dates, the next 7 days from the places info.
  var days = useMemo(function () {
    if (info && info.days.length) return info.days;
    if (placesInfo && placesInfo.days) return placesInfo.days.map(function (d) { return { date: d.date, weather: null, holidays: [], busy: d.busy }; });
    return [];
  }, [info, placesInfo]);

  var selected = days.find(function (d) { return d.date === selState[0]; }) || days.find(function (d) { return !d.past; }) || days[0] || null;

  var closedCount = useMemo(function () {
    var m = {};
    if (placesInfo) placesInfo.places.forEach(function (p) { p.closedOn.forEach(function (d) { m[d] = (m[d] || 0) + 1; }); });
    return m;
  }, [placesInfo]);

  if (error) return <div className="dt">{cityChips}<div className="dt-card"><p className="dt-empty">{error}</p></div></div>;
  if (!info) return <div className="dt">{cityChips}<div className="dt-card dt-loading">Loading {city || 'destination'} info…</div></div>;
  if (!info.location) return <div className="dt">{cityChips}<div className="dt-card"><p className="dt-empty">We couldn’t find {city || 'this destination'} on the map.</p></div></div>;

  return (
    <div className="dt">
      {cityChips}
      <Header info={info} flag={props.flag} />

      <div className="dt-card">
        <div className="dt-section-head">
          <h3 className="dt-h3">{info.trip ? 'Your trip · ' + shortDate(info.trip.start, false) + ' – ' + shortDate(info.trip.end, false) : 'The next 7 days'}</h3>
          {!info.trip && <button type="button" className="dt-link" onClick={function () { if (window.atlasphereSwitchTab) window.atlasphereSwitchTab('itinerary'); }}>Pick trip dates</button>}
        </div>
        {!info.trip && <p className="dt-note">Pick your dates in the itinerary to see the weather, holidays and closures for each day of the trip.</p>}
        {info.trip && !info.weatherAvailable && <p className="dt-note">Weather isn’t available right now. Try again later.</p>}
        {info.trip && info.days.some(function (d) { return d.weather && d.weather.source === 'typical'; }) && (
          <p className="dt-fine">“Typical” days are more than two weeks away: they show the average for those dates over the last few years.</p>
        )}
        <div className="dt-days">
          {days.map(function (d) {
            return <DayCard key={d.date} day={d} active={selected && selected.date === d.date} closedCount={closedCount[d.date] || 0} onSelect={function () { selState[1](d.date); }} />;
          })}
        </div>
        {selected && selected.holidays && selected.holidays.length > 0 && (
          <p className="dt-alert">🎉 {shortDate(selected.date)} is {selected.holidays.map(function (h) { return h.name; }).join(' and ')}{selected.holidays.every(function (h) { return h.regional; }) ? ' in some regions' : ''}. Expect closures and crowds.</p>
        )}
      </div>

      {placesInfo ? <Crowds placesInfo={placesInfo} day={selected} theme={theme} /> : <div className="dt-card dt-loading">Loading places…</div>}

      <Holidays info={info} />

      <p className="dt-credits">
        Weather: <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> and <a href="https://www.met.no/en" target="_blank" rel="noopener noreferrer">MET Norway</a> · Holidays: <a href="https://date.nager.at/" target="_blank" rel="noopener noreferrer">Nager.Date</a> · Places and hours: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> via Geoapify
      </p>
    </div>
  );
}
