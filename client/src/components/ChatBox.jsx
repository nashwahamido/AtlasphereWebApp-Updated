import React, { useState, useRef, useEffect } from 'react';
import '../styles/chatbox.css';

var ChatBox = function(props) {
  var groupId = props.groupId || '1';
  var userId = props.userId || '1';
  var userName = props.userName || 'You';
  var userAvatar = props.userAvatar || '';
  var groupName = props.groupName || 'Rome';
  var groupColor = props.groupColor || '#3B5F8A';
  var groupPhoto = props.groupPhoto || '';
  var groupFlag = props.groupFlag || '';
  var compact = props.compact || false;

  var msgState = useState([]);
  var messages = msgState[0];
  var setMessages = msgState[1];
  var inputState = useState('');
  var input = inputState[0];
  var setInput = inputState[1];
  var lastActiveState = useState(null);
  var lastActive = lastActiveState[0];
  var setLastActive = lastActiveState[1];
  var socketRef = useRef(null);
  var bottomRef = useRef(null);
  var connectedRef = useRef(false);

  useEffect(function() {
    if (connectedRef.current) return;

    // Fetch last active time
    if (!compact) {
      fetch('/api/groups/last-active?groupId=' + groupId)
        .then(function(r) { return r.json(); })
        .then(function(data) { if (data.lastActive) setLastActive(data.lastActive); })
        .catch(function() {});
    }

    function initSocket() {
      if (!window.io) return;
      connectedRef.current = true;
      var socket = window.io();
      socketRef.current = socket;

      socket.emit('join-group', { groupId: groupId, userId: userId, userName: userName, userAvatar: userAvatar });

      socket.on('chat-history', function(history) {
        setMessages(history);
      });

      socket.on('new-message', function(msg) {
        setMessages(function(prev) { return prev.concat([msg]); });
        setLastActive(new Date().toISOString());
        // Let the overlay know a message arrived (overlay listens to this instead of its own socket)
        if (String(msg.userId) !== String(userId)) {
          window.dispatchEvent(new CustomEvent('atlas-overlay-message', { detail: { groupId: msg.groupId } }));
        }
      });

      socket.on('user-joined', function(data) {
        setMessages(function(prev) {
          return prev.concat([{ id: 'sys-' + Date.now(), system: true, text: data.userName + ' joined the chat' }]);
        });
      });
    }

    if (window.io) {
      initSocket();
    } else {
      var existing = document.querySelector('script[src="/socket.io/socket.io.js"]');
      if (!existing) {
        var script = document.createElement('script');
        script.src = '/socket.io/socket.io.js';
        script.onload = initSocket;
        document.head.appendChild(script);
      } else {
        var check = setInterval(function() {
          if (window.io) { clearInterval(check); initSocket(); }
        }, 100);
      }
    }

 return function() {
  // Don't disconnect on unmount since we keep component mounted
};

  }, [groupId]);

  useEffect(function() {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  var sendMessage = function() {
    if (!input.trim() || !socketRef.current) return;
    socketRef.current.emit('send-message', {
      groupId: groupId,
      userId: userId,
      userName: userName,
      userAvatar: userAvatar,
      text: input.trim()
    });
    setInput('');
  };

  var handleKey = function(e) {
    if (e.key === 'Enter') sendMessage();
  };

  function renderAvatar(avatarUrl, fallbackColor, extraClass) {
    var cls = 'cb__avatar' + (extraClass ? ' ' + extraClass : '');
    if (avatarUrl) {
      return React.createElement('div', { className: cls },
        React.createElement('img', { src: avatarUrl, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' } })
      );
    }
    return React.createElement('div', { className: cls, style: { backgroundColor: fallbackColor } });
  }

  function formatMsgTime(t) {
    if (!t) return '';
    // If it's already short (like "09:45"), return as-is
    if (t.length <= 5) return t;
    // If ISO string, convert to local time
    try {
      var d = new Date(t);
      if (!isNaN(d.getTime())) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    } catch(e) {}
    return t;
  }

  function chatTimeAgo(isoStr) {
    if (!isoStr) return 'Online';
    var diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
    if (diff < 60) return 'Active just now';
    if (diff < 3600) return 'Active ' + Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return 'Active ' + Math.floor(diff / 3600) + 'h ago';
    return 'Active ' + Math.floor(diff / 86400) + 'd ago';
  }

  var photoInputRef = useRef(null);
  var iconInner;
  if (groupPhoto) {
    iconInner = React.createElement('div', { className: 'cb__header-icon', style: { overflow: 'hidden' } },
      React.createElement('img', { src: groupPhoto, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '10px' } })
    );
  } else if (groupFlag) {
    var flagCode = Array.from(groupFlag).map(function(c) {
      return String.fromCharCode(c.codePointAt(0) - 127397);
    }).join('').toLowerCase();
    iconInner = React.createElement('div', { className: 'cb__header-icon', style: { overflow: 'hidden' } },
      React.createElement('img', {
        src: 'https://flagcdn.com/w80/' + flagCode + '.png',
        alt: groupFlag,
        style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '10px' },
        onError: function(e) { e.target.style.display = 'none'; }
      })
    );
  } else {
    iconInner = React.createElement('div', { className: 'cb__header-icon', style: { backgroundColor: groupColor } });
  }

  // Let members change the group photo at any time: a small pencil button over
  // the icon opens a file picker and posts to /groups/upload-photo, which saves
  // the resized image and redirects back to this group page.
  var headerIcon = React.createElement('div', { style: { position: 'relative', display: 'inline-block', lineHeight: 0 } },
    iconInner,
    React.createElement('form', { action: '/groups/upload-photo', method: 'post', encType: 'multipart/form-data', style: { margin: 0 } },
      React.createElement('input', { type: 'hidden', name: 'groupId', value: groupId }),
      React.createElement('input', { type: 'hidden', name: 'redirectTo', value: '/groups/' + groupId }),
      React.createElement('input', {
        type: 'file', name: 'groupPhoto', accept: 'image/*', ref: photoInputRef,
        style: { display: 'none' },
        onChange: function(e) { if (e.target.files && e.target.files.length) e.target.form.submit(); }
      }),
      React.createElement('button', {
        type: 'button',
        title: 'Change group photo',
        'aria-label': 'Change group photo',
        onClick: function() { if (photoInputRef.current) photoInputRef.current.click(); },
        style: {
          position: 'absolute', right: -4, bottom: -4, width: 22, height: 22,
          borderRadius: '50%', border: '2px solid #fff', background: '#0B3856',
          color: '#fff', cursor: 'pointer', fontSize: 11, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }
      }, '✎')
    )
  );

  var statusText = messages.length > 0 ? 'Online' : (lastActive ? chatTimeAgo(lastActive) : 'Online');

  // ── Invite popup state ──────────────────────────────────────────────────
  var inviteState = useState(false);
  var showInvite = inviteState[0];
  var setShowInvite = inviteState[1];
  var inviteQueryState = useState('');
  var inviteQuery = inviteQueryState[0];
  var setInviteQuery = inviteQueryState[1];
  var inviteMsgState = useState(null);
  var inviteMsg = inviteMsgState[0];
  var setInviteMsg = inviteMsgState[1];
  var inviteLoadingState = useState(false);
  var inviteLoading = inviteLoadingState[0];
  var setInviteLoading = inviteLoadingState[1];
  var inviteLinkState = useState('');
  var inviteLinkVal = inviteLinkState[0];
  var setInviteLinkVal = inviteLinkState[1];
  var inviteCopiedState = useState(false);
  var inviteCopied = inviteCopiedState[0];
  var setInviteCopied = inviteCopiedState[1];
  var inviteRef = useRef(null);

  // Close popup when clicking outside
  useEffect(function() {
    if (!showInvite) return;
    function handleClickOutside(e) {
      if (inviteRef.current && !inviteRef.current.contains(e.target)) setShowInvite(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return function() { document.removeEventListener('mousedown', handleClickOutside); };
  }, [showInvite]);

  function handleInviteSubmit() {
    if (!inviteQuery.trim() || inviteLoading) return;
    setInviteLoading(true);
    setInviteMsg(null);
    fetch('/api/groups/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: groupId, query: inviteQuery.trim() })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      setInviteLoading(false);
      if (data.success) {
        setInviteMsg({ type: 'success', text: data.message });
        setInviteQuery('');
      } else {
        setInviteMsg({ type: 'error', text: data.error || 'Something went wrong' });
      }
    })
    .catch(function() {
      setInviteLoading(false);
      setInviteMsg({ type: 'error', text: 'Network error' });
    });
  }

  function handleCopyLink() {
    if (inviteLinkVal) {
      navigator.clipboard.writeText(inviteLinkVal).then(function() {
        setInviteCopied(true);
        setTimeout(function() { setInviteCopied(false); }, 2000);
      });
      return;
    }
    fetch('/api/groups/invite-link?groupId=' + groupId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.inviteLink) {
          setInviteLinkVal(data.inviteLink);
          navigator.clipboard.writeText(data.inviteLink).then(function() {
            setInviteCopied(true);
            setTimeout(function() { setInviteCopied(false); }, 2000);
          });
        }
      })
      .catch(function() {});
  }

  return React.createElement('div', { className: compact ? 'cb cb--compact' : 'cb' },
    !compact && React.createElement('div', { className: 'cb__header' },
      headerIcon,
      React.createElement('div', { className: 'cb__header-info' },
        React.createElement('div', { className: 'cb__header-name' }, groupName),
        React.createElement('div', { className: 'cb__header-status' },
          React.createElement('span', { className: 'cb__status-dot' }),
          statusText
        )
      ),
      React.createElement('div', { className: 'cb__header-actions', style: { marginLeft: 'auto', position: 'relative' } },
        React.createElement('button', {
          type: 'button',
          className: 'cb__invite-btn' + (showInvite ? ' cb__invite-btn--active' : ''),
          onClick: function() { setShowInvite(!showInvite); setInviteMsg(null); },
          title: 'Invite a friend'
        },
          React.createElement('svg', { width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round' },
            React.createElement('path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }),
            React.createElement('circle', { cx: '9', cy: '7', r: '4' }),
            React.createElement('line', { x1: '19', y1: '8', x2: '19', y2: '14' }),
            React.createElement('line', { x1: '22', y1: '11', x2: '16', y2: '11' })
          )
        ),
        showInvite && React.createElement('div', {
          className: 'cb__invite-popup',
          ref: inviteRef,
          id: 'inviteContent'
        },
          React.createElement('p', { className: 'gc-invite-label' }, 'Search for a friend'),
          React.createElement('div', { className: 'gc-search' },
            React.createElement('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round', style: { flexShrink: 0, opacity: 0.6 } },
              React.createElement('circle', { cx: '11', cy: '11', r: '8' }),
              React.createElement('line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' })
            ),
            React.createElement('input', {
              type: 'text',
              name: 'friendEmail',
              placeholder: 'Username or email...',
              value: inviteQuery,
              onChange: function(e) { setInviteQuery(e.target.value); },
              onKeyDown: function(e) { if (e.key === 'Enter') { e.preventDefault(); handleInviteSubmit(); } }
            }),
            React.createElement('button', {
              type: 'button',
              className: 'cb__invite-send',
              onClick: handleInviteSubmit,
              disabled: inviteLoading || !inviteQuery.trim(),
              title: 'Send invite'
            }, inviteLoading
              ? React.createElement('span', { style: { fontSize: '11px' } }, '...')
              : React.createElement('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round' },
                  React.createElement('line', { x1: '22', y1: '2', x2: '11', y2: '13' }),
                  React.createElement('polygon', { points: '22 2 15 22 11 13 2 9 22 2' })
                )
            )
          ),
          inviteMsg && React.createElement('div', {
            className: 'cb__invite-msg cb__invite-msg--' + inviteMsg.type
          }, inviteMsg.text),
          React.createElement('p', { className: 'gc-or' }, 'or'),
          React.createElement('button', {
            type: 'button',
            className: 'gc-share-btn',
            onClick: handleCopyLink
          }, inviteCopied ? 'Copied!' : 'Share Link')
        )
      )
    ),
    React.createElement('div', { className: 'cb__messages' },
      messages.map(function(m) {
        if (m.system) {
          return React.createElement('div', { key: m.id, className: 'cb__system' }, m.text);
        }
        var isSelf = String(m.userId) === String(userId);
        var avatarUrl = isSelf ? userAvatar : (m.userAvatar || '');

        // Detect shared activity format: [[SHARE:imageUrl|name|description]]
        var shareMatch = m.text && m.text.match(/^\[\[SHARE:([^|]*)\|([^|]+)\|([\s\S]*)\]\]$/);
        var bubbleContent;
        if (shareMatch) {
          var shareImg = shareMatch[1];
          var shareName = shareMatch[2];
          var shareDesc = shareMatch[3];
          bubbleContent = React.createElement('div', {
            className: 'cb__share-card',
            onClick: function() {
              // Switch to discover tab if callable handler exists
              if (typeof window.atlasphereSwitchTab === 'function') {
                window.atlasphereSwitchTab('discover');
              }
            },
            title: 'Click to view in recommendations'
          },
            shareImg ? React.createElement('img', { src: shareImg, alt: shareName, className: 'cb__share-card-img' }) : null,
            React.createElement('div', { className: 'cb__share-card-body' },
              React.createElement('div', { className: 'cb__share-card-label' }, '📍 Shared a place'),
              React.createElement('div', { className: 'cb__share-card-title' }, shareName),
              shareDesc ? React.createElement('div', { className: 'cb__share-card-desc' }, shareDesc) : null
            )
          );
        } else {
          bubbleContent = m.text;
        }

        return React.createElement('div', { key: m.id, className: 'cb__row' + (isSelf ? ' cb__row--self' : '') },
          !isSelf && renderAvatar(avatarUrl, '#E8933A', ''),
          React.createElement('div', { className: 'cb__bubble-group' + (isSelf ? ' cb__bubble-group--self' : '') },
            React.createElement('span', { className: 'cb__sender' + (isSelf ? ' cb__sender--self' : '') }, isSelf ? userName : (m.userName || m.user)),
            React.createElement('div', {
              className: 'cb__bubble' + (isSelf ? ' cb__bubble--self' : '') + (shareMatch ? ' cb__bubble--share' : '')
            }, bubbleContent),
            m.time ? React.createElement('span', { className: 'cb__time' + (isSelf ? ' cb__time--self' : '') }, formatMsgTime(m.time)) : null
          ),
          isSelf && renderAvatar(userAvatar, '#3B5F8A', 'cb__avatar--self')
        );
      }),
      messages.length === 0 && React.createElement('div', { className: 'cb__empty' }, 'No messages yet. Say hello!'),
      React.createElement('div', { ref: bottomRef })
    ),
    React.createElement('div', { className: 'cb__input-area' },
      React.createElement('div', { className: 'cb__input-wrap' },
        React.createElement('input', {
          className: 'cb__input',
          type: 'text',
          value: input,
          onChange: function(e) { setInput(e.target.value); },
          onKeyDown: handleKey,
          placeholder: 'Type a message'
        }),
        React.createElement('button', { className: 'cb__send-btn', onClick: sendMessage },
          React.createElement('img', { src: '/icons/Send Icon Bold.svg', alt: 'Send', style: { width: 20, height: 20 } })
        )
      )
    )
  );
};

export default ChatBox;