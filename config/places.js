// ── PLACES (Foursquare Places API) ────────────────────────────────────────
// Attraction/points-of-interest recommendations for a city. Sends over HTTPS
// (port 443) so it works on Railway. Configure via env:
//   FOURSQUARE_API_KEY      — Service key from your Foursquare developer account
//   FOURSQUARE_API_VERSION  — optional API version date (default below)
//
// NOTE: Foursquare's newer API is credit-based. Fields like photos, rating and
// description are *Premium* and return HTTP 429 ("no API credits remaining") on
// the free tier, so we request only free/core fields here and supply each card
// image from the app's bundled per-category images (public/images/<tag>.jpg).
const axios = require("axios");

const FSQ_ENDPOINT = "https://places-api.foursquare.com/places/search";
const DEFAULT_API_VERSION = "2025-06-17";

// Only free/core fields — do NOT add photos/rating/description (Premium).
const FREE_FIELDS = "fsq_place_id,name,categories,location";

// The app's 11 activity tags (see client/src/components/activities.jsx). Each
// has a bundled image at public/images/<lowercase-tag>.jpg.
const KNOWN_TAGS = ["Relax", "Nightlife", "Active", "Culture", "Nature", "Food", "Shopping", "Entertainment", "Family", "Fun", "Sightseeing"];

// Foursquare category names are matched to the app's tags by keyword so the
// mapping keeps working even when Foursquare tweaks its taxonomy.
const TAG_RULES = [
  { tags: ["Culture", "Sightseeing"], match: ["museum", "gallery", "historic", "monument", "landmark", "memorial", "castle", "palace", "ruin", "heritage", "cultural"] },
  { tags: ["Culture", "Sightseeing"], match: ["church", "cathedral", "basilica", "temple", "mosque", "synagogue", "shrine", "chapel"] },
  { tags: ["Nature", "Relax"], match: ["park", "garden", "beach", "nature", "trail", "mountain", "lake", "river", "waterfall", "forest", "island", "scenic", "lookout", "botanical"] },
  { tags: ["Entertainment", "Culture"], match: ["theater", "theatre", "concert", "opera", "performing", "music venue", "cinema", "movie"] },
  { tags: ["Fun", "Family", "Active"], match: ["amusement", "theme park", "water park", "arcade"] },
  { tags: ["Family", "Nature"], match: ["zoo", "aquarium"] },
  { tags: ["Nightlife", "Food"], match: ["bar", "pub", "nightclub", "night club", "brewery", "cocktail", "wine"] },
  { tags: ["Food"], match: ["restaurant", "café", "cafe", "coffee", "bakery", "food", "diner", "bistro", "eatery", "pizzeria", "pizza", "trattoria", "steakhouse", "gelato", "ice cream", "sushi", "dessert", "pastry"] },
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

// Pick a bundled card image based on the place's primary tag (Premium photos
// aren't available on the free tier).
function imageForTags(tags) {
  var primary = (tags && tags[0]) ? tags[0] : "Sightseeing";
  if (KNOWN_TAGS.indexOf(primary) === -1) primary = "Sightseeing";
  return "/images/" + primary.toLowerCase() + ".jpg";
}

async function fetchPlaces(city) {
  var apiKey = (process.env.FOURSQUARE_API_KEY || "").trim();
  if (!apiKey) {
    console.error("Foursquare not configured — set FOURSQUARE_API_KEY.");
    return [];
  }
  var version = (process.env.FOURSQUARE_API_VERSION || "").trim() || DEFAULT_API_VERSION;

  var response = await axios.get(FSQ_ENDPOINT, {
    params: {
      near: city,
      limit: 50,
      fields: FREE_FIELDS,
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
        description: firstCategory || "A popular spot worth exploring during your trip.",
        image: imageForTags(tags),
        rating: null, // Premium field on Foursquare's free tier
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
