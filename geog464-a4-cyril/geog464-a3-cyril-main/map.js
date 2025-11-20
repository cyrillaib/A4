// GEOG 464 – Final Project (A3 → A4)
// Abandoned Mines & Tailings in Québec
// Classification by proximity + simple risk buffer on click.

const map = L.map("map").setView([53, -72], 4.3);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

// ===== Reference arrays ===== //
const POP_CENTERS = [
  { name: "Montréal",       lat: 45.5017, lng: -73.5673 },
  { name: "Québec",         lat: 46.8139, lng: -71.2080 },
  { name: "Gatineau",       lat: 45.4765, lng: -75.7013 },
  { name: "Saguenay",       lat: 48.4167, lng: -71.0667 },
  { name: "Sherbrooke",     lat: 45.4042, lng: -71.8929 },
  { name: "Trois-Rivières", lat: 46.3430, lng: -72.5421 },
  { name: "Rouyn-Noranda",  lat: 48.2366, lng: -79.0230 },
  { name: "Val-d'Or",       lat: 48.0975, lng: -77.7974 },
  { name: "Sept-Îles",      lat: 50.2169, lng: -66.3810 }
];

const INDIGENOUS_HUBS = [
  { name: "Mistissini",   lat: 50.43,  lng: -73.87 },
  { name: "Chibougamau",  lat: 49.913, lng: -74.379 },
  { name: "Wendake",      lat: 46.87,  lng: -71.33 },
  { name: "Manawan",      lat: 46.92,  lng: -73.78 },
  { name: "Uashat",       lat: 50.25,  lng: -66.40 },
  { name: "Kahnawake",    lat: 45.40,  lng: -73.69 },
  { name: "Kanesatake",   lat: 45.50,  lng: -74.08 },
  { name: "Waskaganish",  lat: 51.47,  lng: -78.75 }
];

// Haversine distance (km)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ===== Classification (no external hydro dataset) ===== //
function classifyImpact(lat, lng, props) {
  // 1) Indigenous / northern (55 km or far north latitude)
  for (const hub of INDIGENOUS_HUBS) {
    if (haversineKm(lat, lng, hub.lat, hub.lng) <= 55) {
      return "near_indigenous";
    }
  }
  if (lat >= 51.5) return "near_indigenous";

  // 2) Population centres (30 km)
  for (const c of POP_CENTERS) {
    if (haversineKm(lat, lng, c.lat, c.lng) <= 30) {
      return "near_population";
    }
  }

  // 3) Tailings / water-like sites based on attributes only
  const cat = (props.category || "").toLowerCase();
  const nm  = (props.name || "").toLowerCase();
  const desc = (props.description || "").toLowerCase();

  if (
    cat.includes("tailings") || cat.includes("résidu") || cat.includes("residu") ||
    desc.includes("résidu") || desc.includes("residu") ||
    nm.includes("lac") || nm.includes("lake") ||
    nm.includes("river") || nm.includes("rivière") || nm.includes("riviere")
  ) {
    return "water_tailings";
  }

  // 4) Otherwise: remote / other
  return "remote";
}

// ===== Marker style by impact class ===== //
function styleForImpact(impact) {
  const base = { radius: 5, weight: 1, opacity: 1, fillOpacity: 0.65 };
  switch (impact) {
    case "near_indigenous":
      return { ...base, color: "#ff6b6b", fillColor: "#ff6b6b" };
    case "near_population":
      return { ...base, color: "#4dabf7", fillColor: "#4dabf7" };
    case "water_tailings":
      return { ...base, color: "#ffd166", fillColor: "#ffd166" };
    default:
      return { ...base, color: "#ced4da", fillColor: "#ced4da" };
  }
}

// ===== Simple risk buffer radius (meters) ===== //
function bufferRadiusForImpact(impact) {
  switch (impact) {
    case "near_indigenous":
      return 60000; // 60 km
    case "near_population":
      return 30000; // 30 km
    case "water_tailings":
      return 15000; // 15 km
    default:
      return 10000; // 10 km
  }
}

// Layer + state
const markerLayer = L.layerGroup().addTo(map);
const ALL_MARKERS = [];
let activeRiskBuffer = null;

// ===== Load mines data ===== //
fetch("./mines.geojson")
  .then((r) => r.json())
  .then((geo) => {
    L.geoJSON(geo, {
      pointToLayer: (feat, latlng) => {
        const props = feat.properties || {};
        const impactClass = classifyImpact(latlng.lat, latlng.lng, props);

        const marker = L.circleMarker(latlng, styleForImpact(impactClass));

        const popupHtml = `
          <strong>${props.name || "Mine / site"}</strong><br>
          <span><em>Impact class:</em> ${impactClass.replace("_", " ")}</span><br>
          <span>Category: ${props.category || "n/a"}</span><br>
          <span>Status: ${props.status || "n/a"}</span><br>
          <span>Commodity: ${props.commodity || "n/a"}</span><br>
          <span>Last operation: ${props.last_year || "n/a"}</span><br>
          <small>Red circle = simple hypothetical impact radius around this site (not a real model).</small>
        `;

        marker.bindPopup(popupHtml.trim());

        // Store data for filter + info panel
        marker.featureData = {
          name: props.name || "Mine / site",
          impact: impactClass,
          raw: props
        };

        // When user clicks:
        marker.on("click", () => {
          updateInfoPanel(marker.featureData);

          // Remove previous buffer if any
          if (activeRiskBuffer) {
            map.removeLayer(activeRiskBuffer);
            activeRiskBuffer = null;
          }

          // Create new buffer around the clicked site
          const radius = bufferRadiusForImpact(impactClass);
          activeRiskBuffer = L.circle(marker.getLatLng(), {
            radius,
            color: "#ff3333",
            weight: 2,
            fillColor: "#ff6666",
            fillOpacity: 0.18
          }).addTo(map);
        });

        marker.addTo(markerLayer);
        ALL_MARKERS.push(marker);
        return marker;
      }
    });

    updateStatsBox("all");
  })
  .catch((err) => {
    console.error("Could not load ./mines.geojson", err);
    const panel = document.getElementById("infoPanel");
    if (panel) {
      panel.innerHTML =
        '<p style="color:#ff6b6b">Error loading <code>mines.geojson</code>. Make sure it is at the repo root.</p>';
    }
  });

// ===== Filter UI ===== //
const filterEl = document.getElementById("impactFilter");
if (filterEl) {
  filterEl.addEventListener("change", (e) => {
    const want = e.target.value;
    markerLayer.clearLayers();

    ALL_MARKERS.forEach((m) => {
      if (want === "all" || m.featureData.impact === want) {
        m.addTo(markerLayer);
      }
    });

    // If we filter, we also clear any active buffer (to avoid confusion)
    if (activeRiskBuffer) {
      map.removeLayer(activeRiskBuffer);
      activeRiskBuffer = null;
    }

    updateStatsBox(want);
  });
}

// ===== Info panel ===== //
function updateInfoPanel(data) {
  const panel = document.getElementById("infoPanel");
  if (!panel) return;

  const props = data.raw || {};
  const impactLabel = data.impact.replace("_", " ");

  panel.innerHTML = `
    <h3 style="margin-top:0">${data.name}</h3>
    <p><strong>Impact class:</strong> ${impactLabel}</p>
    <p><strong>Category:</strong> ${props.category || "n/a"}</p>
    <p><strong>Status:</strong> ${props.status || "n/a"}</p>
    <p><strong>Commodity:</strong> ${props.commodity || "n/a"}</p>
    <p><strong>Last operation:</strong> ${props.last_year || "n/a"}</p>
    <p style="font-size:0.7rem;color:#a4acc2;">
      Circle around the site is a simple buffer to visualise a possible area of influence.
    </p>
  `;
}

// ===== Stats line under sidebar ===== //
function updateStatsBox(filterValue) {
  const box = document.getElementById("map-stats");
  if (!box) return;

  const visible = ALL_MARKERS.filter((m) => markerLayer.hasLayer(m)).length;
  const label = filterValue === "all" ? "All sites" : filterValue;
  box.textContent = `${visible} site(s) shown for filter: ${label}`;
}

// ===== Sidebar toggle (mobile) ===== //
const sidebar = document.getElementById("sidebar");
const toggleBtn = document.getElementById("toggleSidebar");
if (toggleBtn && sidebar) {
  toggleBtn.addEventListener("click", () => {
    sidebar.classList.toggle("open");
  });
}
