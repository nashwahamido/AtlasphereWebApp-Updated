import React, { useEffect, useMemo, useState, useCallback } from "react";
import "../styles/voting-system.css";
import { getJson, destinationUrl, shortDate } from "./destinationInfo";

//max number of cards visible on either side of the main card in the carousel
var MAX_VISIBILITY = 2;

var icons = {
  send: "/icons/Send Icon Bold.svg",
  yes: "/icons/Thumbs Up Icon.svg",
  no: "/icons/Thumbs Down Icon.svg",
  left: "/icons/Left Arrow Icon Bold.svg",
  right: "/icons/Right Arrow Icon Bold.svg",
  maybe: "/icons/maybe-icon.svg",
};

//main activity card will show image, tags, description and vote buttons
function ActivityCard({ activity, vote, onVote, onShare, animation, closure }) {
  return (
    <div className={"vote-card" + (animation ? " " + animation : "")}>
      <img src={activity.image} alt={activity.name} className="vote-card-image" />
      <div className="vote-card-overlay" />

{/*share button to send activity to group chat */}
      <button type="button" className="share-btn" onClick={function() { if (onShare) onShare(activity); }} aria-label={"Share " + activity.name} title="Share to group chat">
        <img src={icons.send} alt="" className="share-icon" />
      </button>

{/*activity tags connected to chosen activities on activity page */}
      <div className="vote-card-content">
        <div className="tag-list">
          {(activity.tags || []).map(function (tag) {
            return (
              <span key={tag} className="activity-tag">
                {tag}
              </span>
            );
          })}
        </div>

        <div className="activity-copy">
          <h2>{activity.name}</h2>
          <p>{activity.description}</p>
          {closure && <span className="vote-closed" title={closure.hours || ""}>{closure.text}</span>}
        </div>

{/* yes/maybe/no vote buttons */}
        <div className="vote-buttons">
          <button
            type="button"
            className={"vote-button" + (vote === "yes" ? " selected" : "")}
            onClick={function () {
              onVote("yes");
            }}
            aria-label={"Vote yes for " + activity.name}
          >
            <img src={icons.yes} alt="" className="vote-icon" />
          </button>

          <button
            type="button"
            className={"vote-button maybe-button" + (vote === "maybe" ? " selected" : "")}
            onClick={function () {
              onVote("maybe");
            }}
            aria-label={"Vote maybe for " + activity.name}
          >
            <img src={icons.maybe} alt="" className="vote-icon maybe-icon" />
          </button>

          <button
            type="button"
            className={"vote-button" + (vote === "no" ? " selected" : "")}
            onClick={function () {
              onVote("no");
            }}
            aria-label={"Vote no for " + activity.name}
          >
            <img src={icons.no} alt="" className="vote-icon" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Carousel({ children, active, setActive }) {
  var count = React.Children.count(children);

  if (count === 0) {
    return null;
  }

  return (
    <div className="carousel-3d">
      <button
        type="button"
        className="nav-btn left"
        onClick={function () {
          setActive(function (i) {
            return (i - 1 + count) % count;
          });
        }}
        aria-label="Previous"
      >
        <img src={icons.left} alt="" className="nav-icon nav-icon-white" />
      </button>

    {React.Children.map(children, function (child, i) {
      var count = React.Children.count(children);
      var rawOffset = active - i;

      //lets carousel loop
      if (rawOffset > count / 2) rawOffset -= count;
      if (rawOffset < -count / 2) rawOffset += count;

      return (
        <div
          className="card-container"
          style={{
            "--active": i === active ? 1 : 0,
            "--offset": rawOffset / 3,
            "--direction": Math.sign(rawOffset),
            "--abs-offset": Math.abs(rawOffset) / 3, 
            //only the active card is interactive, others aren't
            pointerEvents: i === active ? "auto" : "none",
            opacity: Math.abs(rawOffset) > MAX_VISIBILITY ? "0" : "1",
            display: Math.abs(rawOffset) > MAX_VISIBILITY ? "none" : "block",
          }}
          key={i}
        >
            {child}
          </div>
        );
      })}

      <button
        type="button"
        className="nav-btn right"
        onClick={function () {
          setActive(function (i) {
            return (i + 1) % count;
          });
        }}
        aria-label="Next"
      >
        <img src={icons.right} alt="" className="nav-icon nav-icon-white" />
      </button>
    </div>
  );
}


export default function VotingSystem(props) {
  var destination = props.destination || "Rome";
  var groupId = props.groupId || "";
  var userId = props.userId || "";
  var userName = props.userName || "";
  var userAvatar = props.userAvatar || "";

  var activeState = useState(0);
  var active = activeState[0];
  var setActive = activeState[1];
 //list of recommended activities fetched from the API
  var activitiesState = useState([]);
  var activities = activitiesState[0];
  var setActivities = activitiesState[1];

  var votedIdsState = useState({});
  var votedIds = votedIdsState[0];
  var setVotedIds = votedIdsState[1];

  var loadingState = useState(true);
  var loading = loadingState[0];
  var setLoading = loadingState[1];

  var errorState = useState("");
  var error = errorState[0];
  var setError = errorState[1];

  //prevents user frm double submitting a vote while
  var votingState = useState(false);
  var isVoting = votingState[0];
  var setIsVoting = votingState[1];

  //feedback message shown after voting or sharing
  var feedbackState = useState(null);
  var feedback = feedbackState[0];
  var setFeedback = feedbackState[1];

  var animatingState = useState(null);
  var animating = animatingState[0];
  var setAnimating = animatingState[1];

  var preferences = useMemo(function () {
    if (props.savedActivities && props.savedActivities.length > 0) {
      return props.savedActivities.split(",").map(function (s) {
        return s.trim();
      }).filter(Boolean);
    }

    try {
      var gp = localStorage.getItem("activityPreferences-" + groupId);
      if (gp) return JSON.parse(gp);
      return JSON.parse(localStorage.getItem("activityPreferences")) || [];
    } catch (e) {
      return [];
    }
  }, [props.savedActivities, groupId]);

   //fetches recommendations from the API when destination or preferences change
  useEffect(function () {
    setLoading(true);
    fetch(
      "/api/recommendations?city=" +
        encodeURIComponent(destination) +
        "&activities=" +
        encodeURIComponent(preferences.join(","))
    )
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load");
        return res.json();
      })
      .then(function (data) {
        setActivities(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(function (err) {
        console.error(err);
        setError("Could not load recommendations right now.");
        setLoading(false);
      });
  }, [preferences, destination]);

  //loads all the existing votes the user has already made for this group
  useEffect(function () {
    if (!groupId) return;
    fetch("/api/votes?groupId=" + groupId)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var map = {};
        data.forEach(function (v) { map[v.activityId] = v.vote; });
        setVotedIds(map);
      })
      .catch(function () {});
  }, [groupId]);

  // Which places are closed on the trip days (from their opening hours).
  var closuresState = useState({});
  var closures = closuresState[0];
  var setClosures = closuresState[1];
  useEffect(function () {
    if (!groupId) return;
    var cancelled = false;
    getJson(destinationUrl(groupId, "places")).then(function (info) {
      if (cancelled || !info || !info.tripDates) return;
      var map = {};
      var total = info.dates.length;
      info.places.forEach(function (p) {
        if (!p.closedOn.length) return;
        var text = p.closedOn.length === total
          ? (p.seasonal ? "Closed for the season on your dates" : "Closed on your dates")
          : p.closedOn.length === 1
            ? "Closed on " + shortDate(p.closedOn[0])
            : "Closed on " + p.closedOn.length + " of your " + total + " days";
        var entry = { text: text, hours: p.hours };
        map["id:" + p.id] = entry;
        map["name:" + String(p.name).trim().toLowerCase()] = entry;
      });
      setClosures(map);
    }).catch(function () {});
    return function () { cancelled = true; };
  }, [groupId]);

  //filters out any activities the user has already voted on
  var visibleActivities = useMemo(function () {
    return activities.filter(function (a) { return !votedIds[a.id]; });
  }, [activities, votedIds]);

  var safeActive = visibleActivities.length === 0 ? 0 : Math.min(active, visibleActivities.length - 1);

var handleVote = function (activity, choice) {
  if (isVoting || !groupId) return;
  setIsVoting(true);

  var voteType = choice === "yes" ? "upvote" : choice === "maybe" ? "bookmark" : "downvote";
  var label = voteType === "upvote" ? "Upvoted" : voteType === "bookmark" ? "Bookmarked" : "Dismissed";

  var animationType =
    choice === "yes" ? "swipe-right" :
    choice === "no" ? "swipe-left" :
    "swipe-down";

  setAnimating({
    id: activity.id,
    type: animationType
  });

  //waits for the animation to play before sending the request
  setTimeout(function () {
    fetch("/api/votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: groupId,
        activityId: activity.id,
        activityName: activity.name,
        activityImage: activity.image,
        activityDesc: activity.description || "",
        activityTags: activity.tags || [],
        vote: voteType
      })
    })
      .then(function () {
        setVotedIds(function (prev) {
          var next = {};
          for (var k in prev) next[k] = prev[k];
          next[activity.id] = voteType;
          return next;
        });

        setFeedback({ text: label + ": " + activity.name, type: voteType });
        setTimeout(function () { setFeedback(null); }, 1500);

        setAnimating(null);

        // moves to the next card
        setActive(function (prev) {
          var remaining = visibleActivities.length - 1;
          if (remaining <= 0) return 0;
          return Math.min(prev, remaining - 1);
        });

        setIsVoting(false);
      })
      .catch(function () {
        setAnimating(null);
        setIsVoting(false);
      });
  }, 300);
};

  // Share activity to group chat via socket
  var handleShare = function (activity) {
    if (!groupId) return;
    if (!window.io) {
      console.warn('Socket.io not loaded, cannot share');
      return;
    }
    try {

      var socket = window._atlasphereSocket;
      if (!socket || !socket.connected) {
        socket = window.io();
        window._atlasphereSocket = socket;
        socket.emit('join-group', {
          groupId: groupId,
          userId: userId,
          userName: userName || 'Someone',
          userAvatar: userAvatar || ''
        });
      }

      var sendMsg = function () {
        var desc = activity.description ? activity.description.substring(0, 120) : '';
        var payload = '[[SHARE:' + (activity.image || '') + '|' + activity.name + '|' + desc + ']]';
        socket.emit('send-message', {
          groupId: groupId,
          userId: userId,
          userName: userName || 'Someone',
          userAvatar: userAvatar || '',
          text: payload
        });
        setFeedback({ text: 'Shared to chat: ' + activity.name, type: 'upvote' });
        setTimeout(function () { setFeedback(null); }, 2000);
      };

      if (socket.connected) {
        sendMsg();
      } else {
        socket.once('connect', sendMsg);
      }
    } catch (e) {
      console.error('Share error:', e);
    }
  };

  if (loading) {
    return (
      <main className="voting-page">
        <section className="voting-section">
          <header className="voting-header">
            <h1>Recommended</h1>
            <p>Loading things to do in {destination}...</p>
          </header>
        </section>
      </main>
    );
  }

  if (error) {
    return (
      <main className="voting-page">
        <section className="voting-section">
          <header className="voting-header">
            <h1>Recommended</h1>
            <p>{error}</p>
          </header>
        </section>
      </main>
    );
  }

  //for when all activities have been voted on
  if (visibleActivities.length === 0 && activities.length > 0) {
    return (
      <main className="voting-page">
        <section className="voting-section">
          <header className="voting-header">
            <h1>All Done!</h1>
            <p>You've voted on all recommendations. Check the Itinerary tab to see your upvoted and saved activities.</p>
          </header>
        </section>
      </main>
    );
  }

  if (activities.length === 0) {
    return (
      <main className="voting-page">
        <section className="voting-section">
          <header className="voting-header">
            <h1>Recommended</h1>
            <p>No recommendations found for {destination} yet.</p>
          </header>
        </section>
      </main>
    );
  }

  return (
    <main className="voting-page">
      <section className="voting-section">
        <header className="voting-header">
          <h1>Recommended</h1>
          <p>Vote on things to do in {destination}. Upvote, bookmark, or dismiss.</p>
        </header>

        <Carousel active={safeActive} setActive={setActive}>
          {visibleActivities.map(function (activity) {
            return (
              <ActivityCard
                key={activity.id}
                activity={activity}
                vote={null}
                closure={closures["id:" + activity.id] || closures["name:" + String(activity.name).trim().toLowerCase()] || null}
                onVote={function (choice) {
                  handleVote(activity, choice);
                }}
                onShare={function (a) { handleShare(a); }}
                animation={
                  animating && animating.id === activity.id
                    ? animating.type
                    : ""
                }
              />
            );
          })}
        </Carousel>

        {feedback && (
          <div className={"vote-feedback vote-feedback--" + feedback.type}>{feedback.text}</div>
        )}

      </section>
    </main>
  );
}