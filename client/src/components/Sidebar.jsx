import React, { useState, useEffect } from 'react';
import '../styles/sidebar.css';

var PREFIX = 'atlas_unread_';

var Sidebar = function(props) {
  var activeGroup = props.activeGroup;
  var onSelect = props.onSelect;
  var searchState = useState('');
  var search = searchState[0];
  var setSearch = searchState[1];
  var groupsState = useState([]);
  var groups = groupsState[0];
  var setGroups = groupsState[1];

  // Track unread counts per group from localStorage
  var unreadState = useState({});
  var unreadCounts = unreadState[0];
  var setUnreadCounts = unreadState[1];

  function readAllUnread() {
    var counts = {};
    try {
      Object.keys(localStorage).forEach(function(k) {
        if (k.startsWith(PREFIX)) {
          var gid = k.substring(PREFIX.length);
          var val = parseInt(localStorage.getItem(k) || '0', 10);
          if (val > 0) counts[gid] = val;
        }
      });
    } catch (e) {}
    return counts;
  }

  useEffect(function() {
    fetch('/groups/api/my-groups')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        console.log("GROUPS FROM API:", data);
        setGroups(data);
        if (data.length > 0 && (!activeGroup || !activeGroup.id)) {
          if (onSelect) onSelect(data[0]);
        }
      })
      .catch(function(err) { console.error('Failed to load groups:', err); });
  }, []);

  // Sync unread from localStorage
  useEffect(function() {
    setUnreadCounts(readAllUnread());

    function onUpdate() { setUnreadCounts(readAllUnread()); }
    window.addEventListener('atlas-unread-update', onUpdate);
    window.addEventListener('storage', onUpdate);
    return function() {
      window.removeEventListener('atlas-unread-update', onUpdate);
      window.removeEventListener('storage', onUpdate);
    };
  }, []);

  var filtered = groups.filter(function(g) {
    return g.name.toLowerCase().indexOf(search.toLowerCase()) !== -1;
  });

  return React.createElement('div', { className: 'sb' + (props.mobileOpen ? ' sb--open' : '') },
    React.createElement('div', { className: 'sb__header' },
      React.createElement('div', { className: 'sb__header-left' },
        React.createElement('span', { className: 'sb__title' }, 'Groups'),
        React.createElement('span', { className: 'sb__count' }, groups.length)
      ),
      React.createElement('a', { href: '/groups/create/country', className: 'sb__add' }, '+'),
      React.createElement('button', {
        type: 'button', className: 'sb__close', 'aria-label': 'Close groups',
        onClick: function() { if (props.onClose) props.onClose(); }
      }, '×')
    ),
    React.createElement('div', { className: 'sb__search-wrap' },
      React.createElement('input', {
        className: 'sb__search',
        type: 'text',
        placeholder: 'search groups',
        value: search,
        onChange: function(e) { setSearch(e.target.value); }
      })
    ),
    React.createElement('div', { className: 'sb__list' },
      filtered.length === 0 && React.createElement('div', {
        style: { textAlign: 'center', padding: '32px 16px', color: 'var(--text-secondary, #888)', fontSize: '14px' }
      },
        React.createElement('p', { style: { marginBottom: '12px' } }, 'No groups yet'),
        React.createElement('a', {
          href: '/groups/create/country',
          style: { color: '#E8933A', fontWeight: 600, textDecoration: 'none' }
        }, 'Create your first trip')
      ),
     filtered.map(function(g) {
  var isActive = activeGroup && activeGroup.id === g.id;
  var unread = unreadCounts[String(g.id)] || 0;
  return React.createElement('div', {
    key: g.id,
    className: 'sb__item' + (isActive ? ' sb__item--active' : ''),
    role: 'button',
    tabIndex: 0,
    style: { cursor: 'pointer', position: 'relative' },
    onClick: function() {
      try { localStorage.removeItem(PREFIX + g.id); } catch(e) {}
      window.dispatchEvent(new CustomEvent('atlas-unread-update'));
      window.dispatchEvent(new CustomEvent('atlas-active-group-changed', { detail: { groupId: String(g.id) } }));
      if (onSelect) onSelect(g);
    },
    onKeyDown: function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        try { localStorage.removeItem(PREFIX + g.id); } catch(ex) {}
        window.dispatchEvent(new CustomEvent('atlas-unread-update'));
        window.dispatchEvent(new CustomEvent('atlas-active-group-changed', { detail: { groupId: String(g.id) } }));
        if (onSelect) onSelect(g);
      }
    }
  },
    React.createElement('div', { className: 'sb__item-icon', style: { backgroundColor: g.color || '#3B5F8A', overflow: 'hidden' } },
      (function() {
        if (g.photo) {
          return React.createElement('img', {
            src: g.photo, alt: '',
            style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '12px' }
          });
        }
        if (g.flag) {
          // Convert flag emoji to ISO country code for flagcdn.com
          var code = Array.from(g.flag).map(function(c) {
            return String.fromCharCode(c.codePointAt(0) - 127397);
          }).join('').toLowerCase();
          return React.createElement('img', {
            src: 'https://flagcdn.com/w80/' + code + '.png',
            alt: g.flag,
            style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '12px' },
            onError: function(e) { e.target.style.display = 'none'; }
          });
        }
        return React.createElement('span', { style: { fontSize: '18px', lineHeight: '44px', fontWeight: '700', color: '#fff' } }, g.name ? g.name[0].toUpperCase() : '?');
      })()
    ),
    React.createElement('div', { className: 'sb__item-info' },
      React.createElement('div', { className: 'sb__item-name' }, g.name)
    ),
    unread > 0 && React.createElement('span', { className: 'sb__item-badge' },
      unread > 99 ? '99+' : unread
    )
  );
})
    )
  );
};

export default Sidebar;