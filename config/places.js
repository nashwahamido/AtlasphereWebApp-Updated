// ── PLACES (OpenTripMap API) ──────────────────────────────────────────────
// Attraction/points-of-interest recommendations for a city. Free, no credit
// card (get a key at https://opentripmap.io/product). Sends over HTTPS
// (port 443) so it works on Railway. Configure via env:
//   OPENTRIPMAP_API_KEY — API key from your OpenTripMap account
//
// Two calls: geocode the city (/geoname), then list nearby attractions
// (/radius). Card images come from the app's bundled per-category images
// (public/images/<tag>.jpg), so we don't need any paid photo field.
const axios = require("axios");

const OTM_BASE = "https://api.opentripmap.com/0.1/en/places";
// Broad enough to cover all 11 activity tags: interesting_places already spans
// cultural/historic/natural/architecture/amusements, plus foods and shops.
const KINDS = "interesting_places,foods,shops";
const SEARCH_RADIUS_M = 6000;
const MIN_RATE = 2; // filter out trivial POIs (OpenTripMap importance 1–3)

// The app's 11 activity tags (see client/src/components/activities.jsx). Each
// has a bundled image at public/images/<lowercase-tag>.jpg.
const KNOWN_TAGS = ["Relax", "Nightlife", "Active", "Culture", "Nature", "Food", "Shopping", "Entertainment", "Family", "Fun", "Sightseeing"];

// OpenTripMap "kinds" tokens are matched to the app's tags by keyword.
const TAG_RULES = [
  { tags: ["Culture", "Sightseeing"], match: ["museum", "historic", "monument", "memorial", "castle", "fort", "palace", "archaeolog", "ruins", "tomb", "heritage", "cultural"] },
  { tags: ["Culture", "Sightseeing"], match: ["church", "cathedral", "temple", "mosque", "synagogue", "monaster", "shrine", "religion"] },
  { tags: ["Sightseeing"], match: ["architecture", "view_point", "tower", "bridge", "squares", "fountain", "skyscraper", "lighthouse"] },
  { tags: ["Entertainment", "Culture"], match: ["theatre", "cinema", "concert", "opera", "entertainment"] },
  { tags: ["Fun", "Family", "Active"], match: ["amusement", "theme_park", "water_park", "attraction_park"] },
  { tags: ["Family", "Nature"], match: ["zoo", "aquarium"] },
  { tags: ["Nature", "Relax"], match: ["natural", "nature", "beach", "park", "garden", "water", "lake", "river", "waterfall", "mountain", "forest", "island", "geological", "wood", "spring"] },
  { tags: ["Nightlife", "Fun"], match: ["casino"] },
  { tags: ["Nightlife", "Food"], match: ["bar", "pub", "nightclub", "brewery"] },
  { tags: ["Food"], match: ["foods", "restaurant", "cafe", "bakery", "food"] },
  { tags: ["Shopping"], match: ["shop", "mall", "market", "store", "boutique"] },
  { tags: ["Active"], match: ["sport", "stadium", "climb", "dive", "surf", "golf", "ski"] },
  { tags: ["Relax"], match: ["spa", "resort", "wellness", "hot_spring"] },
];

// Map a place's OpenTripMap "kinds" string to the app's activity tags.
function inferTags(kindsStr) {
  var kinds = (kindsStr || "").toLowerCase();
  var tags = [];
  TAG_RULES.forEach(function (rule) {
    var hit = rule.match.some(function (kw) { return kinds.indexOf(kw) !== -1; });
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

// Turn "historic,architecture,church" into a readable "Historic".
function humanizeKind(kindsStr) {
  var first = (kindsStr || "").split(",")[0].trim();
  if (!first) return "A popular spot worth exploring during your trip.";
  return first.split("_").map(function (w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}

async function fetchPlaces(city) {
  var apiKey = (process.env.OPENTRIPMAP_API_KEY || "").trim();
  if (!apiKey) {
    console.error("OpenTripMap not configured — set OPENTRIPMAP_API_KEY.");
    return [];
  }

  // 1. Geocode the city name to coordinates.
  var geo = await axios.get(OTM_BASE + "/geoname", {
    params: { name: city, apikey: apiKey },
  });
  if (!geo.data || typeof geo.data.lat !== "number" || typeof geo.data.lon !== "number") {
    console.log("OpenTripMap: no location found for:", city);
    return [];
  }

  // 2. List nearby attractions.
  var radiusRes = await axios.get(OTM_BASE + "/radius", {
    params: {
      radius: SEARCH_RADIUS_M,
      lon: geo.data.lon,
      lat: geo.data.lat,
      kinds: KINDS,
      rate: MIN_RATE,
      format: "json",
      limit: 50,
      apikey: apiKey,
    },
  });

  return Array.isArray(radiusRes.data) ? radiusRes.data : [];
}

// Returns the shape the frontend already expects:
// { id, name, tags, description, image, rating, location }, re-ranked so the
// places matching the user's selected activity tags come first.
async function getRecommendations(city, preferences) {
  var places = await fetchPlaces(city);
  var prefList = preferences || [];
  var seenNames = {};

  var normalized = places
    .filter(function (item) { return item && item.name && item.name.trim(); })
    .filter(function (item) {
      var key = item.name.trim().toLowerCase();
      if (seenNames[key]) return false;
      seenNames[key] = true;
      return true;
    })
    .map(function (item, index) {
      var tags = inferTags(item.kinds);
      return {
        id: item.xid || ("otm-" + index),
        name: item.name,
        tags: tags,
        description: humanizeKind(item.kinds),
        image: imageForTags(tags),
        rating: (typeof item.rate === "number") ? item.rate : null,
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
