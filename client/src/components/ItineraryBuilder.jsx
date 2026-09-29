import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import '../styles/itinerary-builder.css';

const HOURS = ['08.00','09.00','10.00','11.00','12.00','13.00','14.00','15.00','16.00','17.00','18.00','19.00','20.00','21.00','22.00','23.00','00.00','01.00','02.00'];
const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const DURATION_STEP = 1;
const MIN_DURATION = 1;
const MAX_DURATION = 6;
var ROW_HEIGHT = 48;

function slotsForDuration(dur) { return Math.ceil(dur); }

function formatDuration(dur) {
  var h = Math.floor(dur);
  var m = Math.round((dur - h) * 60);
  if (h === 0) return m + 'min';
  if (m === 0) return h + 'h';
  return h + 'h' + m;
}

const ItineraryBuilder = ({ tripId = null, groupId = null, onSave = null, tripDays = 7, isActive = false }) => {
  const today = new Date();
  const storageKey = 'itinerary-' + (tripId || 'default');
  const gid = groupId || tripId;

  // ── Socket ref for real-time sync ─────────────────────────────────────────
  const socketRef = useRef(null);
  const isRemoteUpdate = useRef(false);

  useEffect(() => {
    if (!gid || !isActive) return;
    // Reuse existing socket if possible
    if (window.io) {
      var socket = window.io();
      socketRef.current = socket;

      socket.on('itinerary-update', function(data) {
        if (String(data.groupId) !== String(gid)) return;
        isRemoteUpdate.current = true;
        if (data.action === 'set') {
          setAllBlocks(prev => {
            var dayData = { ...(prev[data.dayIndex] || {}) };
            dayData[data.timeSlot] = data.block;
            return { ...prev, [data.dayIndex]: dayData };
          });
        } else if (data.action === 'delete') {
          setAllBlocks(prev => {
            var dayData = { ...(prev[data.dayIndex] || {}) };
            delete dayData[data.timeSlot];
            return { ...prev, [data.dayIndex]: dayData };
          });
        } else if (data.action === 'dates') {
          setRangeStart(data.rangeStart);
          setRangeEnd(data.rangeEnd);
          setCalYear(data.calYear);
          setCalMonth(data.calMonth);
          setRangeYear(data.calYear);
          setRangeMonth(data.calMonth);
        }
        setTimeout(() => { isRemoteUpdate.current = false; }, 0);
      });

      return () => {
        socket.off('itinerary-update');
      };
    }
  }, [gid, isActive]);

  const emitUpdate = useCallback((data) => {
    if (isRemoteUpdate.current) return;
    if (socketRef.current && gid) {
      socketRef.current.emit('itinerary-update', { ...data, groupId: gid });
    }
  }, [gid]);

  const [upvotedActivities, setUpvotedActivities] = useState([]);
  const [savedActivities, setSavedActivities] = useState([]);

  // ── Itinerary comments (notes per scheduled block) ────────────────────────
  const [commentCounts, setCommentCounts] = useState({}); // "day|slot" -> count
  const [commentModal, setCommentModal] = useState(null); // { dayIndex, timeSlot, title }
  const [commentList, setCommentList] = useState([]);
  const [commentInput, setCommentInput] = useState('');
  const [commentLoading, setCommentLoading] = useState(false);

  function fmtCommentTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  const loadCommentCounts = useCallback(() => {
    if (!gid) return;
    fetch('/api/itinerary/comments/counts?groupId=' + gid)
      .then(r => r.json())
      .then(rows => {
        var m = {};
        (rows || []).forEach(function (r) { m[r.dayIndex + '|' + r.timeSlot] = r.count; });
        setCommentCounts(m);
      })
      .catch(() => {});
  }, [gid]);

  const openComments = useCallback((dayIndex, timeSlot, title) => {
    setCommentModal({ dayIndex: dayIndex, timeSlot: timeSlot, title: title });
    setCommentList([]);
    setCommentInput('');
    setCommentLoading(true);
    fetch('/api/itinerary/comments?groupId=' + gid + '&dayIndex=' + dayIndex + '&timeSlot=' + encodeURIComponent(timeSlot))
      .then(r => r.json())
      .then(rows => { setCommentList(rows || []); setCommentLoading(false); })
      .catch(() => setCommentLoading(false));
  }, [gid]);

  const submitComment = useCallback(() => {
    var text = commentInput.trim();
    if (!text || !commentModal) return;
    fetch('/api/itinerary/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid, dayIndex: commentModal.dayIndex, timeSlot: commentModal.timeSlot, comment: text })
    })
      .then(r => r.json())
      .then(data => {
        if (data && data.comment) {
          setCommentList(prev => prev.concat([data.comment]));
          setCommentInput('');
          setCommentCounts(prev => {
            var m = Object.assign({}, prev);
            var k = commentModal.dayIndex + '|' + commentModal.timeSlot;
            m[k] = (m[k] || 0) + 1;
            return m;
          });
        }
      })
      .catch(() => {});
  }, [commentInput, commentModal, gid]);

  useEffect(() => { if (isActive) loadCommentCounts(); }, [isActive, loadCommentCounts]);

  useEffect(() => {
    if (!gid || !isActive) return;
    fetch('/api/votes/saved?groupId=' + gid + '&type=upvote')
      .then(r => r.json())
      .then(data => {
        setUpvotedActivities((data || []).map((v, i) => ({
          id: v.activityId || ('up-' + i),
          name: v.activityName,
          desc: (v.activityTags || '').split(',').filter(Boolean).join(', '),
          color: '#3B5F8A',
          image: v.activityImage
        })));
      })
      .catch(() => {});
    fetch('/api/votes/saved?groupId=' + gid + '&type=bookmark')
      .then(r => r.json())
      .then(data => {
        setSavedActivities((data || []).map((v, i) => ({
          id: v.activityId || ('bk-' + i),
          name: v.activityName,
          desc: (v.activityTags || '').split(',').filter(Boolean).join(', '),
          color: '#E8933A',
          image: v.activityImage
        })));
      })
      .catch(() => {});
  }, [gid, isActive]);

  const [calYear, setCalYear] = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());
  const [rangeStart, setRangeStart] = useState(null);
  const [rangeEnd, setRangeEnd] = useState(null);
  const [rangeYear, setRangeYear] = useState(null);
  const [rangeMonth, setRangeMonth] = useState(null);
  const [pickingEnd, setPickingEnd] = useState(false);
  const [activeDay, setActiveDay] = useState(0);

  useEffect(() => {
    if (!gid || !isActive) return;
    fetch('/api/itinerary/dates?groupId=' + gid)
      .then(r => r.json())
      .then(data => {
        if (data && data.rangeStart !== null) {
          setRangeStart(data.rangeStart);
          setRangeEnd(data.rangeEnd);
          setCalYear(data.calYear);
          setCalMonth(data.calMonth);
          setRangeYear(data.calYear);
          setRangeMonth(data.calMonth);
        }
      })
      .catch(() => {});
  }, [gid, isActive]);

  const actualDays = (rangeStart !== null && rangeEnd !== null) ? rangeEnd - rangeStart + 1 : tripDays;

  const weekDays = useMemo(() => {
    if (rangeStart === null || rangeYear === null) return [];
    return Array.from({ length: actualDays }, (_, i) => {
      const date = new Date(rangeYear, rangeMonth, rangeStart + i);
      return { index: i, num: date.getDate(), month: date.getMonth(), year: date.getFullYear(), label: DAY_NAMES[date.getDay()] };
    });
  }, [rangeStart, rangeEnd, actualDays, rangeYear, rangeMonth]);

  const [allBlocks, setAllBlocks] = useState({});
  const dayBlocks = allBlocks[activeDay] || {};

  const [search, setSearch] = useState('');
  const [panelMode, setPanelMode] = useState('recommend');
  const [dragInfo, setDragInfo] = useState(null);
  const [overSlot, setOverSlot] = useState(null);
  const [hasLoadedBlocks, setHasLoadedBlocks] = useState(false);

  useEffect(() => {
    if (!gid || !isActive) return;
    fetch('/api/itinerary/blocks?groupId=' + gid)
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data)) { setHasLoadedBlocks(true); return; }
        var loaded = {};
        data.forEach(function(b) {
          if (!loaded[b.dayIndex]) loaded[b.dayIndex] = {};
          loaded[b.dayIndex][b.timeSlot] = { name: b.activityName, color: b.activityColor || '#E8933A', duration: b.duration || 1 };
        });
        setAllBlocks(loaded);
        setHasLoadedBlocks(true);
      })
      .catch(() => { setHasLoadedBlocks(true); });
  }, [gid, isActive]);

  useEffect(() => {
    if (!hasLoadedBlocks) return;
    localStorage.setItem(storageKey + '-blocks', JSON.stringify(allBlocks));
  }, [allBlocks, hasLoadedBlocks, storageKey]);

  useEffect(() => {
    if (!gid || rangeStart === null || isRemoteUpdate.current) return;
    fetch('/api/itinerary/dates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid, rangeStart, rangeEnd, calYear: rangeYear, calMonth: rangeMonth })
    }).catch(() => {});
    emitUpdate({ action: 'dates', rangeStart, rangeEnd, calYear: rangeYear, calMonth: rangeMonth });
  }, [rangeStart, rangeEnd, rangeYear, rangeMonth, gid]);

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = (() => { const d = new Date(calYear, calMonth, 1).getDay(); return d === 0 ? 6 : d - 1; })();
  const prevDays = new Date(calYear, calMonth, 0).getDate();
  const cells = firstDay + daysInMonth;
  const overflow = cells % 7 === 0 ? 0 : 7 - (cells % 7);

  const goPrev = () => { if (calMonth === 0) { setCalMonth(11); setCalYear(calYear - 1); } else setCalMonth(calMonth - 1); };
  const goNext = () => { if (calMonth === 11) { setCalMonth(0); setCalYear(calYear + 1); } else setCalMonth(calMonth + 1); };

  const clickDay = (d) => {
    if (pickingEnd && rangeStart !== null) {
      if (d <= rangeStart && calYear === rangeYear && calMonth === rangeMonth) {
        setPickingEnd(false);
        setRangeStart(d); setRangeEnd(Math.min(d + tripDays - 1, daysInMonth));
        setRangeYear(calYear); setRangeMonth(calMonth); setActiveDay(0);
        return;
      }
      const newLength = d - rangeStart + 1;
      setAllBlocks(prev => {
        var trimmed = {};
        Object.keys(prev).forEach(idx => { if (parseInt(idx) < newLength) trimmed[idx] = prev[idx]; });
        return trimmed;
      });
      setRangeEnd(d); setPickingEnd(false);
      return;
    }
    setRangeStart(d); setRangeEnd(Math.min(d + tripDays - 1, daysInMonth));
    setRangeYear(calYear); setRangeMonth(calMonth); setActiveDay(0);
  };

  const daysWithBlocks = useMemo(() => {
    var result = {};
    for (var dayIdx in allBlocks) { if (Object.keys(allBlocks[dayIdx]).length > 0) result[dayIdx] = true; }
    return result;
  }, [allBlocks]);

  const dateToDayIndex = (d) => {
    if (rangeStart === null || rangeYear === null) return -1;
    if (calYear !== rangeYear || calMonth !== rangeMonth) return -1;
    if (d < rangeStart || d > rangeEnd) return -1;
    return d - rangeStart;
  };

  const dayClass = (d) => {
    if (rangeStart === null || rangeYear === null) return 'ib-cal__day';
    if (calYear !== rangeYear || calMonth !== rangeMonth) return 'ib-cal__day';
    var cls = 'ib-cal__day';
    if (d === rangeStart) cls += ' ib-cal__day--start';
    else if (d === rangeEnd) cls += ' ib-cal__day--end';
    else if (d > rangeStart && d < rangeEnd) cls += ' ib-cal__day--range';
    if (pickingEnd && d > rangeStart) cls += ' ib-cal__day--pickable';
    var idx = dateToDayIndex(d);
    if (idx >= 0 && daysWithBlocks[idx]) cls += ' ib-cal__day--has-plans';
    return cls;
  };

  const activeDayInfo = weekDays[activeDay];
  const scheduleTitle = activeDayInfo
    ? `${MONTHS[activeDayInfo.month]} ${activeDayInfo.num} (Day ${activeDay + 1})`
    : 'Schedule';

  // ── API helpers ─────────────────────────────────────────────────────────────
  const persistBlock = useCallback((dayIdx, timeSlot, block) => {
    if (!gid) return;
    fetch('/api/itinerary/block', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid, dayIndex: dayIdx, timeSlot, activityName: block.name, activityColor: block.color || '#E8933A', duration: block.duration || 1 })
    }).catch(() => {});
    emitUpdate({ action: 'set', dayIndex: dayIdx, timeSlot, block });
  }, [gid, emitUpdate]);

  const deleteBlockAPI = useCallback((dayIdx, timeSlot) => {
    if (!gid) return;
    fetch('/api/itinerary/block', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid, dayIndex: dayIdx, timeSlot })
    }).catch(() => {});
    emitUpdate({ action: 'delete', dayIndex: dayIdx, timeSlot });
  }, [gid, emitUpdate]);

  // ── Drag & drop ─────────────────────────────────────────────────────────────
  const panelDragStart = (e, act) => {
    setDragInfo({ type: 'panel', name: act.name, id: act.id, color: act.color || '#E8933A' });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', act.id);
  };

  const blockDragStart = (e, timeKey, block) => {
    setDragInfo({ type: 'block', id: block.id, name: block.name || block.text, from: timeKey, duration: block.duration || 1, color: block.color || '#E8933A' });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', block.id || '');
  };

  const slotDrop = useCallback((e, timeKey) => {
    e.preventDefault();
    setOverSlot(null);
    if (!dragInfo) return;

    var slotIndex = HOURS.indexOf(timeKey);
    var newName = dragInfo.name;
    var newColor = dragInfo.color || '#E8933A';
    var dur = dragInfo.type === 'block' ? (dragInfo.duration || 1) : 1;
    var fromSlot = dragInfo.type === 'block' ? dragInfo.from : null;

    setAllBlocks(prev => {
      const dayData = { ...(prev[activeDay] || {}) };
      if (fromSlot) delete dayData[fromSlot];

      var finalDur = dur;
      for (var i = slotIndex + 1; i < HOURS.length && (i - slotIndex) < slotsForDuration(dur); i++) {
        if (dayData[HOURS[i]]) { finalDur = i - slotIndex; break; }
      }
      finalDur = Math.min(finalDur, HOURS.length - slotIndex);
      if (finalDur < MIN_DURATION) finalDur = MIN_DURATION;

      var newBlock = { id: dragInfo.id || ('sb-' + Date.now()), name: newName, color: newColor, duration: finalDur };
      dayData[timeKey] = newBlock;

      if (fromSlot) deleteBlockAPI(activeDay, fromSlot);
      persistBlock(activeDay, timeKey, newBlock);
      return { ...prev, [activeDay]: dayData };
    });
    setDragInfo(null);
  }, [dragInfo, activeDay, persistBlock, deleteBlockAPI]);

  const removeBlock = (k) => {
    setAllBlocks(prev => { const d = { ...(prev[activeDay] || {}) }; delete d[k]; return { ...prev, [activeDay]: d }; });
    deleteBlockAPI(activeDay, k);
  };

  // ── Resize via +/- buttons ──────────────────────────────────────────────────
  const resizeBlock = useCallback((timeKey, delta) => {
    setAllBlocks(prev => {
      const dayData = { ...(prev[activeDay] || {}) };
      const block = dayData[timeKey];
      if (!block) return prev;

      var oldDur = block.duration || 1;
      var newDur = Math.max(MIN_DURATION, Math.min(MAX_DURATION, oldDur + delta));
      var startIdx = HOURS.indexOf(timeKey);

      if (startIdx + slotsForDuration(newDur) > HOURS.length) {
        newDur = HOURS.length - startIdx;
      }

      if (newDur > oldDur) {
        var expandStart = startIdx + slotsForDuration(oldDur);
        var expandEnd = startIdx + slotsForDuration(newDur) - 1;
        var toPush = [];
        for (var i = expandStart; i <= expandEnd && i < HOURS.length; i++) {
          if (dayData[HOURS[i]]) toPush.push({ slot: HOURS[i], idx: i });
        }
        toPush.sort(function(a, b) { return b.idx - a.idx; });
        for (var p = 0; p < toPush.length; p++) {
          var conflictSlot = toPush[p].slot;
          var conflictIdx = toPush[p].idx;
          var conflictBlock = dayData[conflictSlot];
          var conflictDur = conflictBlock.duration || 1;
          var conflictSpan = slotsForDuration(conflictDur);
          var targetIdx = expandEnd + 1;
          while (targetIdx < HOURS.length) {
            var fits = true;
            for (var c = 0; c < conflictSpan && (targetIdx + c) < HOURS.length; c++) {
              if (dayData[HOURS[targetIdx + c]] && HOURS[targetIdx + c] !== conflictSlot) { fits = false; break; }
            }
            if (fits && targetIdx + conflictSpan <= HOURS.length) break;
            targetIdx++;
          }
          if (targetIdx + conflictSpan > HOURS.length) {
            newDur = conflictIdx - startIdx;
            if (newDur < MIN_DURATION) newDur = MIN_DURATION;
            break;
          }
          delete dayData[conflictSlot];
          dayData[HOURS[targetIdx]] = conflictBlock;
          deleteBlockAPI(activeDay, conflictSlot);
          persistBlock(activeDay, HOURS[targetIdx], conflictBlock);
        }
      }

      if (newDur === oldDur) return prev;
      var updated = { ...block, duration: newDur };
      dayData[timeKey] = updated;
      persistBlock(activeDay, timeKey, updated);
      return { ...prev, [activeDay]: dayData };
    });
  }, [activeDay, persistBlock, deleteBlockAPI]);

  // ── Covered slots ────────────────────────────────────────────────────────────
  const coveredSlots = useMemo(() => {
    var covered = {};
    Object.keys(dayBlocks).forEach(key => {
      var idx = HOURS.indexOf(key);
      if (idx === -1) return;
      var dur = dayBlocks[key].duration || 1;
      var span = slotsForDuration(dur);
      for (var s = 1; s < span && (idx + s) < HOURS.length; s++) {
        covered[HOURS[idx + s]] = key;
      }
    });
    return covered;
  }, [dayBlocks]);

  // ── Drag-resize handle ──────────────────────────────────────────────────────
  const onResizePointerDown = useCallback((e, timeKey) => {
    e.preventDefault();
    e.stopPropagation();
    var startY = e.clientY;
    var block = dayBlocks[timeKey];
    var startDur = block ? (block.duration || 1) : 1;
    var lastApplied = startDur;

    var onMove = function(ev) {
      var dy = ev.clientY - startY;
      var slotDelta = Math.round(dy / ROW_HEIGHT);
      var desired = Math.max(MIN_DURATION, Math.min(MAX_DURATION, startDur + slotDelta));
      if (desired !== lastApplied) {
        lastApplied = desired;
        resizeBlock(timeKey, desired - startDur);
      }
    };

    var onUp = function() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [dayBlocks, resizeBlock]);

  // ── Week strip scroll ───────────────────────────────────────────────────────
  const weekStripRef = useRef(null);
  const activeDayRef = useRef(null);

  useEffect(() => {
    const strip = weekStripRef.current;
    const pill = activeDayRef.current;
    if (!strip || !pill) return;
    strip.scrollLeft = pill.offsetLeft - strip.offsetWidth / 2 + pill.offsetWidth / 2;
  }, [activeDay, weekDays.length]);

  const currentActivities = panelMode === 'recommend' ? upvotedActivities : savedActivities;
  const filtered = currentActivities.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    (a.desc || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="ib-layout">

      {/* ═══ LEFT: Calendar ═══ */}
      <div className="ib-calendar">
        <div className="ib-cal__header">
          <h3 className="ib-cal__title">{MONTHS[calMonth]} {calYear}</h3>
          <div className="ib-cal__arrows">
            <button className="ib-cal__arrow" onClick={goPrev}>&lsaquo;</button>
            <button className="ib-cal__arrow" onClick={goNext}>&rsaquo;</button>
          </div>
        </div>

        {rangeStart ? (
          <div>
            <p className="ib-cal__hint">
              Trip: {MONTHS[rangeMonth]} {rangeStart} – {rangeEnd} ({rangeEnd - rangeStart + 1} days)
            </p>
            {pickingEnd ? (
              <p className="ib-cal__hint" style={{ color: 'var(--ib-accent)', marginTop: 4 }}>
                Click a new end date ↓
                <button onClick={() => setPickingEnd(false)}
                  style={{ marginLeft: 8, fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ib-text-muted)' }}>
                  Cancel
                </button>
              </p>
            ) : (
              <button className="ib-cal__hint-btn" onClick={() => setPickingEnd(true)}>
                Adjust end date
              </button>
            )}
          </div>
        ) : (
          <p className="ib-cal__hint">Click a start date to highlight your {tripDays}-day trip</p>
        )}

        <div className="ib-cal__grid">
          {DAY_LABELS.map(d => <div key={d} className="ib-cal__head">{d}</div>)}
          {Array.from({ length: firstDay }, (_, i) => (
            <div key={'p' + i} className="ib-cal__day ib-cal__day--other">{prevDays - firstDay + 1 + i}</div>
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => (
            <div key={i + 1} className={dayClass(i + 1)} onClick={() => clickDay(i + 1)}>{i + 1}</div>
          ))}
          {Array.from({ length: overflow }, (_, i) => (
            <div key={'n' + i} className="ib-cal__day ib-cal__day--other">{i + 1}</div>
          ))}
        </div>
      </div>

      {/* ═══ CENTER: Schedule ═══ */}
      <div className="ib-schedule">
        {weekDays.length > 0 ? (
          <div className="ib-week" ref={weekStripRef}>
            {weekDays.map((d, i) => (
              <div key={i}
                ref={activeDay === i ? activeDayRef : null}
                className={`ib-week__day${activeDay === i ? ' ib-week__day--active' : ''}${daysWithBlocks[i] ? ' ib-week__day--has-plans' : ''}`}
                onClick={() => setActiveDay(i)}>
                <span className="ib-week__num">{d.num}</span>
                <span className="ib-week__label">{d.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="ib-week" style={{ justifyContent: 'center', opacity: 0.5, fontSize: 13, padding: '12px 0' }}>
            Select a start date on the calendar
          </div>
        )}
        <h4 className="ib-schedule__title">{scheduleTitle}</h4>
        <div className="ib-timeslots">
          {HOURS.map((h, hIdx) => {
            var isCovered = coveredSlots[h] !== undefined;
            var block = dayBlocks[h];
            var dur = block ? (block.duration || 1) : 1;
            var spanSlots = block ? slotsForDuration(dur) : 1;
            var canGrow = block && dur < MAX_DURATION && (hIdx + slotsForDuration(dur + DURATION_STEP)) <= HOURS.length;
            var canShrink = block && dur > MIN_DURATION;

            if (isCovered) {
              return (
                <div key={h} className="ib-timerow ib-timerow--covered">
                  <span className="ib-timerow__label">{h}</span>
                  <div className="ib-timerow__slot" />
                </div>
              );
            }

            return (
              <div key={h} className="ib-timerow">
                <span className="ib-timerow__label">{h}</span>
                <div className={`ib-timerow__slot${overSlot === h ? ' ib-timerow__slot--over' : ''}`}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                  onDragEnter={e => { e.preventDefault(); setOverSlot(h); }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOverSlot(null); }}
                  onDrop={e => slotDrop(e, h)}>
                  {block && (
                    <div
                      className="ib-block"
                      draggable
                      onDragStart={e => blockDragStart(e, h, block)}
                      style={{
                        minHeight: (spanSlots * ROW_HEIGHT - 6) + 'px',
                        position: 'relative',
                      }}
                    >
                      <div className="ib-block__row">
                        <span className="ib-block__text">{block.name || block.text}</span>
                        <div className="ib-block__controls">
                          <button className="ib-block__cmt-btn" title="Comments"
                            onClick={e => { e.stopPropagation(); openComments(activeDay, h, block.name || block.text); }}>
                            <span aria-hidden="true">💬</span>
                            {commentCounts[activeDay + '|' + h] ? <span className="ib-block__cmt-count">{commentCounts[activeDay + '|' + h]}</span> : null}
                          </button>
                          <span className="ib-block__dur">{formatDuration(dur)}</span>
                          <button className="ib-block__resize-btn" disabled={!canShrink}
                            onClick={e => { e.stopPropagation(); resizeBlock(h, -DURATION_STEP); }}
                            title="Shrink by 1h">−</button>
                          <button className="ib-block__resize-btn" disabled={!canGrow}
                            onClick={e => { e.stopPropagation(); resizeBlock(h, DURATION_STEP); }}
                            title="Extend by 1h">+</button>
                          <button className="ib-block__x" onClick={() => removeBlock(h)}>&times;</button>
                        </div>
                      </div>
                      <div className="ib-block__drag-handle"
                        onPointerDown={e => onResizePointerDown(e, h)}
                        title="Drag to resize" />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══ RIGHT: Activities ═══ */}
      <div className="ib-panel">
        <div className="ib-panel__toggles">
          <button className={`ib-panel__tog${panelMode === 'recommend' ? ' ib-panel__tog--on' : ''}`}
            onClick={() => setPanelMode('recommend')}>Upvoted</button>
          <button className={`ib-panel__tog${panelMode === 'recent' ? ' ib-panel__tog--on' : ''}`}
            onClick={() => setPanelMode('recent')}>Saved</button>
        </div>
        <input className="ib-panel__search" type="text" placeholder="search activities"
          value={search} onChange={e => setSearch(e.target.value)} />
        <div className="ib-panel__list">
          {filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--ib-text-muted, #888)', fontSize: '13px' }}>
              <p style={{ marginBottom: '8px' }}>No activities yet</p>
              <p style={{ fontSize: '12px', opacity: 0.7 }}>Upvoted and saved activities from recommendations will appear here</p>
            </div>
          )}
          {filtered.map(a => (
            <div key={a.id} className="ib-act" draggable onDragStart={e => panelDragStart(e, a)}>
              <div className="ib-act__icon" style={{ backgroundColor: a.color, overflow: 'hidden' }}>
                {a.image && <img src={a.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '10px' }} />}
              </div>
              <div className="ib-act__info">
                <div className="ib-act__name">{a.name}</div>
                <div className="ib-act__desc">{a.desc || ''}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {commentModal && (
        <div className="ib-cmt-overlay" onClick={() => setCommentModal(null)}>
          <div className="ib-cmt-modal" onClick={e => e.stopPropagation()}>
            <div className="ib-cmt-modal__head">
              <h4>
                {commentModal.title || 'Notes'}
                <span className="ib-cmt-modal__slot">Day {commentModal.dayIndex + 1} · {commentModal.timeSlot}</span>
              </h4>
              <button className="ib-cmt-modal__close" onClick={() => setCommentModal(null)}>&times;</button>
            </div>
            <div className="ib-cmt-modal__list">
              {commentLoading
                ? <p className="ib-cmt-empty">Loading…</p>
                : (commentList.length === 0
                    ? <p className="ib-cmt-empty">No comments yet. Add the first note.</p>
                    : commentList.map(c => (
                        <div key={c.id} className="ib-cmt">
                          <div className="ib-cmt__meta"><strong>{c.userName}</strong><span>{fmtCommentTime(c.createdAt)}</span></div>
                          <div className="ib-cmt__text">{c.comment}</div>
                        </div>
                      ))
                  )}
            </div>
            <div className="ib-cmt-modal__add">
              <input type="text" value={commentInput} placeholder="Add a comment…"
                onChange={e => setCommentInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitComment(); }} />
              <button onClick={submitComment} disabled={!commentInput.trim()}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ItineraryBuilder;