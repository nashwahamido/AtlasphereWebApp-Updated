// ── PLACES (Geoapify Places API + Pexels photos) ─────────────────────────
// Attraction/points-of-interest recommendations for a city. Two providers,
// both free, over HTTPS (Railway-friendly). Configure via env:
//   GEOAPIFY_API_KEY — place data      (https://myprojects.geoapify.com)
//   PEXELS_API_KEY   — card photos     (https://www.pexels.com/api/)
//
// Geoapify gives the places; Pexels gives an attractive, on-city photo for
// each ("{name} {city}"), falling back to a pool of destination-city photos so
// a card is never the wrong city. If Pexels is unset, bundled category images
// (public/images/<tag>.jpg) are used.
const axios = require("axios");

const GEOCODE_URL = "https://api.geoapify.com/v1/geocode/search";
const PLACES_URL = "https://api.geoapify.com/v2/places";
const PEXELS_URL = "https://api.pexels.com/v1/search";

// Geoapify category codes broad enough to cover the 11 activity tags.
const CATEGORIES = [
  "tourism.sights",
  "tourism.attraction",
  "entertainment",
  "leisure.park",
  "natural",
  "catering",
  "commercial.shopping_mall",
  "commercial.marketplace",
  "sport",
].join(",");

const SEARCH_RADIUS_M = 6000;
const LIMIT = 50;
// How many places get their own per-place Pexels lookup (keeps us well under
// Pexels' free rate limit); the rest use the varied city-photo pool.
const PHOTO_LOOKUP_CAP = 20;

// The app's 11 activity tags (see client/src/components/activities.jsx). Each
// has a bundled image at public/images/<lowercase-tag>.jpg (last-resort image).
const KNOWN_TAGS = ["Relax", "Nightlife", "Active", "Culture", "Nature", "Food", "Shopping", "Entertainment", "Family", "Fun", "Sightseeing"];

// Geoapify category strings are matched to the app's tags by keyword.
const TAG_RULES = [
  { tags: ["Culture", "Sightseeing"], match: ["museum", "monument", "memorial", "castle", "ruines", "archaeological", "heritage", "fort", "city_gate", "battlefield", "tower"] },
  { tags: ["Culture", "Sightseeing"], match: ["place_of_worship", "religion", "church", "cathedral", "mosque", "temple", "synagogue"] },
  { tags: ["Culture"], match: ["gallery", "arts_centre", "culture"] },
  { tags: ["Sightseeing"], match: ["tourism.sights", "attraction", "viewpoint", "artwork", "fountain"] },
  { tags: ["Entertainment", "Culture"], match: ["theatre", "cinema", "concert"] },
  { tags: ["Fun", "Family", "Active"], match: ["theme_park", "amusement", "water_park"] },
  { tags: ["Family", "Nature"], match: ["zoo", "aquarium"] },
  { tags: ["Nature", "Relax"], match: ["park", "garden", "natural", "beach", "forest", "water", "nature_reserve", "national_park"] },
  { tags: ["Nightlife", "Fun"], match: ["casino"] },
  { tags: ["Nightlife", "Food"], match: ["nightclub", "bar", "pub", "biergarten"] },
  { tags: ["Food"], match: ["restaurant", "cafe", "fast_food", "food_court", "catering"] },
  { tags: ["Shopping"], match: ["shopping", "mall", "marketplace", "supermarket", "department_store", "commercial"] },
  { tags: ["Active"], match: ["stadium", "sport", "fitness", "pitch"] },
  { tags: ["Relax"], match: ["spa", "sauna", "wellness"] },
];

// Map a place's Geoapify categories to the app's activity tags.
function inferTags(categories) {
  var joined = (Array.isArray(categories) ? categories.join(",") : "").toLowerCase();
  var tags = [];
  TAG_RULES.forEach(function (rule) {
    var hit = rule.match.some(function (kw) { return joined.indexOf(kw) !== -1; });
    if (hit) {
      rule.tags.forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); });
    }
  });
  if (tags.length === 0) tags.push("Sightseeing");
  return tags;
}

// Last-resort bundled image based on the place's primary tag (used only when
// Pexels is unconfigured or returns nothing at all).
function imageForTags(tags) {
  var primary = (tags && tags[0]) ? tags[0] : "Sightseeing";
  if (KNOWN_TAGS.indexOf(primary) === -1) primary = "Sightseeing";
  return "/images/" + primary.toLowerCase() + ".jpg";
}

// Turn the most specific category (e.g. "tourism.sights.memorial") into a
// readable label ("Memorial").
function describe(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return "A popular spot worth exploring during your trip.";
  }
  var mostSpecific = categories.slice().sort(function (a, b) {
    return b.split(".").length - a.split(".").length;
  })[0];
  var leaf = mostSpecific.split(".").pop() || "";
  if (!leaf) return "A popular spot worth exploring during your trip.";
  return leaf.split("_").map(function (w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}

// Skip raw OSM catalog codes that aren't real names, e.g. "PA_1200", "N45".
function looksLikeCode(name) {
  var n = String(name).trim();
  if (/^[A-Za-z]{1,4}[ _\-]?\d+[A-Za-z]?$/.test(n)) return true; // PA_1200, N45, A1
  if (n.replace(/[^A-Za-z]/g, "").length < 2) return true;       // mostly non-letters
  return false;
}

// ── Pexels photos ──────────────────────────────────────────────────────
function pickSrc(photo) {
  if (!photo || !photo.src) return null;
  return photo.src.large || photo.src.landscape || photo.src.medium || photo.src.original || null;
}

async function pexelsSearch(query, perPage) {
  var apiKey = (process.env.PEXELS_API_KEY || "").trim();
  try {
    var res = await axios.get(PEXELS_URL, {
      params: { query: query, per_page: perPage || 1, orientation: "landscape" },
      headers: { Authorization: apiKey },
      timeout: 6000,
    });
    return (res.data && Array.isArray(res.data.photos)) ? res.data.photos : [];
  } catch (e) {
    console.error("Pexels search failed for '" + query + "':", e.message);
    return [];
  }
}

// Small deterministic hash so the same place always gets the same city-pool
// photo (stable across reloads) while different places get different ones.
function hashString(s) {
  var h = 0;
  s = String(s);
  for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

// Give every card an attractive, on-city photo. Matched places get their own
// photo; the rest get a varied photo of the destination city itself.
async function attachPexelsImages(items, city) {
  var apiKey = (process.env.PEXELS_API_KEY || "").trim();
  if (!apiKey) {
    console.error("Pexels not configured — set PEXELS_API_KEY (using category images).");
    return items;
  }

  // Pool of destination-city photos for fallback variety.
  var cityPhotos = (await pexelsSearch(city, 15)).map(pickSrc).filter(Boolean);
  function cityFallback(seed) {
    if (cityPhotos.length === 0) return null;
    return cityPhotos[hashString(seed) % cityPhotos.length];
  }

  // Per-place lookups for the first N places (parallel, capped).
  var head = items.slice(0, PHOTO_LOOKUP_CAP);
  await Promise.all(head.map(async function (item) {
    var photos = await pexelsSearch(item.name + " " + city, 1);
    var src = photos.length ? pickSrc(photos[0]) : null;
    item.image = src || cityFallback(item.id) || item.image;
  }));

  // Everything else: a varied city photo (keep category image if no pool).
  items.slice(PHOTO_LOOKUP_CAP).forEach(function (item) {
    var src = cityFallback(item.id);
    if (src) item.image = src;
  });

  return items;
}

async function fetchPlaces(city) {
  var apiKey = (process.env.GEOAPIFY_API_KEY || "").trim();
  if (!apiKey) {
    console.error("Geoapify not configured — set GEOAPIFY_API_KEY.");
    return [];
  }

  // 1. Geocode the city name to coordinates.
  var geo = await axios.get(GEOCODE_URL, {
    params: { text: city, format: "json", limit: 1, apiKey: apiKey },
  });
  var place = geo.data && Array.isArray(geo.data.results) ? geo.data.results[0] : null;
  if (!place || typeof place.lat !== "number" || typeof place.lon !== "number") {
    console.log("Geoapify: no location found for:", city);
    return [];
  }

  // 2. List nearby places by category (lon,lat order for Geoapify).
  var places = await axios.get(PLACES_URL, {
    params: {
      categories: CATEGORIES,
      filter: "circle:" + place.lon + "," + place.lat + "," + SEARCH_RADIUS_M,
      bias: "proximity:" + place.lon + "," + place.lat,
      limit: LIMIT,
      apiKey: apiKey,
    },
  });

  return (places.data && Array.isArray(places.data.features)) ? places.data.features : [];
}

// Returns the shape the frontend already expects:
// { id, name, tags, description, image, rating, location }, re-ranked so the
// places matching the user's selected activity tags come first.
async function getRecommendations(city, preferences) {
  var features = await fetchPlaces(city);
  var prefList = preferences || [];
  var seenNames = {};

  var normalized = features
    .map(function (f) { return f && f.properties ? f.properties : null; })
    .filter(function (p) { return p && p.name && String(p.name).trim() && !looksLikeCode(p.name); })
    .filter(function (p) {
      var key = String(p.name).trim().toLowerCase();
      if (seenNames[key]) return false;
      seenNames[key] = true;
      return true;
    })
    .map(function (p, index) {
      var tags = inferTags(p.categories);
      return {
        id: p.place_id || ("geoapify-" + index),
        name: p.name,
        tags: tags,
        description: describe(p.categories),
        image: imageForTags(tags),
        rating: null, // Geoapify does not provide user ratings
        location: city,
      };
    });

  var ranked = normalized
    .map(function (item) {
      var matched = 0;
      item.tags.forEach(function (t) { if (prefList.indexOf(t) !== -1) matched += 1; });
      return { item: item, score: matched };
    })
    .sort(function (a, b) { return b.score - a.score; })
    .map(function (entry) { return entry.item; });

  return attachPexelsImages(ranked, city);
}

module.exports = { getRecommendations, inferTags };
