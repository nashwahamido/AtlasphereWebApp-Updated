// ── PLACES (Foursquare Places API) ────────────────────────────────────────
// Attraction/points-of-interest recommendations for a city. Sends over HTTPS
// (port 443) so it works on Railway. Configure via env:
//   FOURSQUARE_API_KEY      — Service key from your Foursquare developer account
//   FOURSQUARE_API_VERSION  — optional API version date (default below)
const axios = require("axios");

const FSQ_ENDPOINT = "https://places-api.foursquare.com/places/search";
const DEFAULT_API_VERSION = "2025-06-17";

// Top-level Foursquare categories that make good trip suggestions:
// 10000 Arts & Entertainment, 16000 Landmarks & Outdoors,
// 13000 Dining & Drinking, 17000 Retail, 18000 Sports & Recreation.
const ATTRACTION_CATEGORIES = "10000,16000,13000,17000,18000";

// The app's 11 activity tags (see client/src/components/activities.jsx).
// Foursquare category names are matched to these by keyword so the mapping
// keeps working even when Foursquare tweaks its taxonomy.
const TAG_RULES = [
  { tags: ["Culture", "Sightseeing"], match: ["museum", "gallery", "historic", "monument", "landmark", "memorial", "castle", "palace", "ruin", "heritage", "cultural"] },
  { tags: ["Culture", "Sightseeing"], match: ["church", "cathedral", "basilica", "temple", "mosque", "synagogue", "shrine", "chapel"] },
  { tags: ["Nature", "Relax"], match: ["park", "garden", "beach", "nature", "trail", "mountain", "lake", "river", "waterfall", "forest", "island", "scenic", "lookout", "botanical"] },
  { tags: ["Entertainment", "Culture"], match: ["theater", "theatre", "concert", "opera", "performing", "music venue", "cinema", "movie"] },
  { tags: ["Fun", "Family", "Active"], match: ["amusement", "theme park", "water park", "arcade"] },
  { tags: ["Family", "Nature"], match: ["zoo", "aquarium"] },
  { tags: ["Nightlife", "Food"], match: ["bar", "pub", "nightclub", "night club", "brewery", "cocktail", "wine"] },
  { tags: ["Food"], match: ["restaurant", "café", "cafe", "coffee", "bakery", "food", "diner", "bistro", "eatery"] },
  { tags: ["Shopping"], match: ["shop", "mall", "market", "store", "boutique", "bazaar"] },
  { tags: ["Active"], match: ["gym", "sport", "stadium", "climb", "fitness", "cycling", "surf", "dive"] },
  { tags: ["Relax"], match: ["spa", "hot spring", "sauna", "wellness"] },
  { tags: ["Entertainment", "Fun"], match: ["casino", "entertainment"] },
];

// Map a place's Foursquare categories to the app's activity tags.
function inferTags(categories) {
  var names = (categories || [])
    .map(function (c) { return (c && c.name ? c.name : "").toLowerCase(); })
    .filter(Boolean);

  var tags = [];
  names.forEach(function (name) {
    TAG_RULES.forEach(function (rule) {
      var hit = rule.match.some(function (kw) { return name.indexOf(kw) !== -1; });
      if (hit) {
        rule.tags.forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); });
      }
    });
  });

  if (tags.length === 0) tags.push("Sightseeing");
  return tags;
}

// Build a usable image URL from Foursquare's photo objects (prefix + size + suffix).
function buildPhotoUrl(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return "/images/fallback.jpg";
  var p = photos[0];
  if (p && p.prefix && p.suffix) return p.prefix + "600x400" + p.suffix;
  if (p && p.url) return p.url;
  return "/images/fallback.jpg";
}

async function fetchPlaces(city) {
  var apiKey = process.env.FOURSQUARE_API_KEY;
  if (!apiKey) {
    console.error("Foursquare not configured — set FOURSQUARE_API_KEY.");
    return [];
  }
  var version = process.env.FOURSQUARE_API_VERSION || DEFAULT_API_VERSION;

  var response = await axios.get(FSQ_ENDPOINT, {
    params: {
      near: city,
      categories: ATTRACTION_CATEGORIES,
      sort: "POPULARITY",
      limit: 50,
      fields: "fsq_place_id,name,categories,location,rating,photos,description",
    },
    headers: {
      Authorization: "Bearer " + apiKey,
      "X-Places-Api-Version": version,
      accept: "application/json",
    },
  });

  return (response.data && response.data.results) ? response.data.results : [];
}

// Returns the shape the frontend already expects:
// { id, name, tags, description, image, rating, location }, re-ranked so the
// places matching the user's selected activity tags come first.
async function getRecommendations(city, preferences) {
  var places = await fetchPlaces(city);
  var prefList = preferences || [];

  var normalized = places
    .filter(function (item) { return item && item.name; })
    .map(function (item, index) {
      var tags = inferTags(item.categories);
      var firstCategory = item.categories && item.categories[0] && item.categories[0].name;
      return {
        id: item.fsq_place_id || item.fsq_id || ("fsq-" + index),
        name: item.name,
        tags: tags,
        description: item.description || firstCategory || "A popular spot worth exploring during your trip.",
        image: buildPhotoUrl(item.photos),
        rating: (typeof item.rating === "number") ? item.rating : null,
        location: city,
      };
    });

  return normalized
    .map(function (item) {
      var matched = 0;
      item.tags.forEach(function (t) { if (prefList.indexOf(t) !== -1) matched += 1; });
      return { item: item, score: matched };
    })
    .sort(function (a, b) { return b.score - a.score; })
    .map(function (entry) { return entry.item; });
}

module.exports = { getRecommendations, inferTags };
