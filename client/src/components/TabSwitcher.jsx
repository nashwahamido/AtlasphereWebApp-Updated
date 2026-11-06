import React from 'react';
import { MessageIcon, DiscoverIcon, CalendarIcon, MapIcon } from './Icons';
import '../styles/tab-switcher.css';

var TabSwitcher = function(props) {
  var active = props.active || 'chat';
  var onChange = props.onChange;

  var tabs = [
    { id: 'chat', Icon: MessageIcon, label: 'Chat' },
    { id: 'discover', Icon: DiscoverIcon, label: 'Recommendations' },
    { id: 'itinerary', Icon: CalendarIcon, label: 'Itinerary' },
    { id: 'destination', Icon: MapIcon, label: 'Destination: weather, holidays and crowds' },
  ];

  return React.createElement('div', { className: 'ts' },
    React.createElement('div', { className: 'ts__pill' },
      tabs.map(function(t) {
        var isActive = active === t.id;
        return React.createElement('button', {
          key: t.id,
          className: 'ts__btn' + (isActive ? ' ts__btn--active' : ''),
          'aria-label': t.label,
          title: t.label,
          'aria-pressed': isActive,
          onClick: function() { if (onChange) onChange(t.id); }
        },
          React.createElement(t.Icon, { bold: isActive, color: isActive ? '#3B5F8A' : 'var(--ib-text-muted, #999)' })
        );
      })
    )
  );
};

export default TabSwitcher;

