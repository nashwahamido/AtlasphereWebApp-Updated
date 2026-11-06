import React from 'react';
import { createRoot } from 'react-dom/client';

import TabSwitcher from './components/TabSwitcher';
import Sidebar from './components/Sidebar';
import ChatBox from './components/ChatBox';
import ChatOverlay from './components/ChatOverlay';
import ItineraryBuilder from './components/ItineraryBuilder';
import VotingSystem from './components/VotingSystem';

// The Destination tab brings in the map library, so it loads only when opened.
var DestinationTab = React.lazy(function() { return import('./components/DestinationTab'); });

import './styles/tab-switcher.css';
import './styles/sidebar.css';
import './styles/chatbox.css';
import './styles/chat-overlay.css';
import './styles/itinerary-builder.css';
import './styles/voting-system.css';
import './styles/group-mobile.css';
import './styles/destination.css';

var mount = document.getElementById('group-tabs-root');

if (mount) {
  var groupId = mount.dataset.groupId;
  var userId = mount.dataset.userId;
  var userName = mount.dataset.userName || 'You';
  var userAvatar = mount.dataset.userAvatar || '';
  var groupName = mount.dataset.groupName;
  var groupDestination = mount.dataset.groupDestination;
  var groupPhoto = mount.dataset.groupPhoto || '';
  var tripDays = parseInt(mount.dataset.tripDays) || 7;
  var groupActivities = mount.dataset.groupActivities || "";

  var App = function() {
    var initialTab = (new URLSearchParams(window.location.search)).get('tab') || 'chat';
    var tabState = React.useState(initialTab);
    var activeTab = tabState[0];
    var setActiveTab = tabState[1];

    // Expose tab switcher so share cards in chat can navigate to discover
    React.useEffect(function() {
      window.atlasphereSwitchTab = setActiveTab;
      return function() { delete window.atlasphereSwitchTab; };
    }, []);

    var groupFlag = mount.dataset.groupFlag || '';

    var groupState = React.useState({
      id: groupId,
      name: groupName || 'Rome',
      color: '#3B5F8A',
      destination: groupDestination || '',
      photo: groupPhoto || '',
      flag: groupFlag || ''
    });
    var activeGroup = groupState[0];
    var setActiveGroup = groupState[1];

    // Mobile-only: the groups sidebar collapses into a drawer to give the chat room.
    var sbState = React.useState(false);
    var mobileSidebarOpen = sbState[0];
    var setMobileSidebarOpen = sbState[1];

    var chatProps = {
      groupId: activeGroup.id || groupId,
      userId: userId,
      userName: userName,
      userAvatar: userAvatar,
      groupName: activeGroup.name || groupName || 'Rome',
      groupColor: activeGroup.color || '#3B5F8A',
      groupPhoto: activeGroup.photo !== undefined ? activeGroup.photo : groupPhoto,
      groupFlag: activeGroup.flag || groupFlag || ''
    };

    console.log("ACTIVE GROUP:", activeGroup);

    return React.createElement('div', { className: 'gp-app' },
      React.createElement(TabSwitcher, { active: activeTab, onChange: setActiveTab }),
      React.createElement('div', { className: 'gp-content' },

        // Chat tab — always mounted, hidden when not active
        activeTab === 'chat' && React.createElement(React.Fragment, null,
          React.createElement(Sidebar, {
            activeGroup: activeGroup,
            onSelect: function(g) { setActiveGroup(g); setMobileSidebarOpen(false); },
            mobileOpen: mobileSidebarOpen,
            onClose: function() { setMobileSidebarOpen(false); }
          }),
          mobileSidebarOpen && React.createElement('div', { className: 'sb-backdrop', onClick: function() { setMobileSidebarOpen(false); } }),
          React.createElement(ChatBox, Object.assign({ key: 'chat-' + (activeGroup.id || groupId), onOpenSidebar: function() { setMobileSidebarOpen(true); } }, chatProps))
        ),

        // Discover tab — always mounted, hidden when not active
        activeTab === 'discover' && React.createElement('div', { className: 'gp-tab-with-overlay' },
          React.createElement(VotingSystem, {
            key: 'vote-' + (activeGroup.id || groupId),
            destination: activeGroup.destination || groupDestination,
            groupId: activeGroup.id || groupId,
            savedActivities: groupActivities,
            userId: userId,
            userName: userName,
            userAvatar: userAvatar
          }),
          React.createElement(ChatOverlay, Object.assign({
            key: 'overlay-discover-' + (activeGroup.id || groupId),
            notificationsMuted: false
          }, chatProps))
        ),

        // Itinerary tab — always mounted, hidden when not active
        activeTab === 'itinerary' && React.createElement('div', { className: 'gp-tab-with-overlay' },
          React.createElement(ItineraryBuilder, {
            tripId: activeGroup.id || groupId,
            groupId: activeGroup.id || groupId,
            tripDays: tripDays,
            isActive: true
          }),
          React.createElement(ChatOverlay, Object.assign({
            key: 'overlay-itinerary-' + (activeGroup.id || groupId),
            notificationsMuted: false
          }, chatProps))
        ),

        // Destination tab — weather, local time, holidays, crowds and closures
        activeTab === 'destination' && React.createElement('div', { className: 'gp-tab-with-overlay' },
          React.createElement(React.Suspense, { fallback: React.createElement('div', { className: 'dt' }, React.createElement('div', { className: 'dt-card dt-loading' }, 'Loading…')) },
            React.createElement(DestinationTab, {
              key: 'dest-' + (activeGroup.id || groupId),
              groupId: activeGroup.id || groupId,
              destination: activeGroup.destination || groupDestination,
              flag: activeGroup.flag || groupFlag
            })
          ),
          React.createElement(ChatOverlay, Object.assign({
            key: 'overlay-destination-' + (activeGroup.id || groupId),
            notificationsMuted: false
          }, chatProps))
        )

      )
    );
  };

  createRoot(mount).render(React.createElement(App));
}