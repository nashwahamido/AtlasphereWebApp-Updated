// ── PLACES (Geoapify Places API) ──────────────────────────────────────────
// Attraction/points-of-interest recommendations for a city. Free (3,000
// req/day), no credit card — get a key at https://myprojects.geoapify.com.
// Sends over HTTPS (port 443) so it works on Railway. Configure via env:
//   GEOAPIFY_API_KEY — API key from your Geoapify project
//
// Two calls: geocode the city, then list nearby places by category. Card
// images come from Wikipedia when a place matches an article, otherwise the
// app's bundled per-category images (public/images/<tag>.jpg).
const axios = require("axios");

const GEOCODE_URL = "https://api.geoapify.com/v1/geocode/search";
const PLACES_URL = "https://api.geoapify.com/v2/places";
// Wikipedia gives us free real photos for well-known places (batched, no key).
const WIKI_URL = "https://en.wikipedia.org/w/api.php";

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

// The app's 11 activity tags (see client/src/components/activities.jsx). Each
// has a bundled image at public/images/<lowercase-tag>.jpg.
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

// Pick a bundled card image based on the place's primary tag.
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

// Best-effort: replace each item's image with a real Wikipedia thumbnail when
// the place name matches an article. One batched request (up to 50 titles);
// anything without a match keeps its bundled category image. Never throws —
// on any failure the category images stand.
async function attachWikipediaImages(items) {
  var named = items.filter(function (i) { return i.name; }).slice(0, 50);
  if (named.length === 0) return items;

  try {
    var res = await axios.get(WIKI_URL, {
      params: {
        action: "query",
        format: "json",
        prop: "pageimages",
        piprop: "thumbnail",
        pithumbsize: 600,
        titles: named.map(function (i) { return i.name; }).join("|"),
        redirects: 1,
      },
      // Wikimedia rejects requests without a descriptive User-Agent (HTTP 403).
      headers: {
        "User-Agent": "AtlasphereTravelApp/1.0 (https://github.com/nashwahamido/AtlasphereWebApp-Updated; atlasphere.app@gmail.com)",
        "Accept": "application/json",
      },
      timeout: 6000,
    });

    var q = (res.data && res.data.query) ? res.data.query : {};
    var pages = q.pages || {};

    // normalized title -> thumbnail URL
    var thumbByTitle = {};
    Object.keys(pages).forEach(function (k) {
      var p = pages[k];
      if (p && p.title && p.thumbnail && p.thumbnail.source) {
        thumbByTitle[p.title.toLowerCase()] = p.thumbnail.source;
      }
    });

    // Wikipedia rewrites some titles (case) or redirects them; follow those maps.
    var alias = {};
    (q.normalized || []).forEach(function (n) { alias[n.from.toLowerCase()] = n.to.toLowerCase(); });
    (q.redirects || []).forEach(function (r) { alias[r.from.toLowerCase()] = r.to.toLowerCase(); });

    items.forEach(function (item) {
      var key = String(item.name).toLowerCase();
      var resolved = alias[key] || key;
      resolved = alias[resolved] || resolved; // resolve normalized -> redirect chain
      var thumb = thumbByTitle[resolved];
      if (thumb) item.image = thumb;
    });
  } catch (e) {
    console.error("Wikipedia image lookup failed (using category images):", e.message);
  }

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

  return attachWikipediaImages(ranked);
}

module.exports = { getRecommendations, inferTags };
