import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as d3geo from 'd3-geo';
import * as topojson from 'topojson-client';
import { Satellite, Rocket, Zap, ShieldAlert, Navigation, Activity, Clock, Target } from 'lucide-react';
import classNames from 'classnames';

// ─── Color Palette ───────────────────────────────────────────────────────────
const C = {
  water: '#050a0f',
  land: '#0e1621',
  border: '#1a2535',
  NOMINAL: '#00ff9d',
  LOW_FUEL: '#ffb800',
  EOL_PENDING: '#ff3344',
  DEBRIS: 'rgba(255,255,255,0.18)',
  TERMINATOR: 'rgba(0,0,0,0.45)',
};

// ─── Helper: lat/lon → canvas x/y ────────────────────────────────────────────
function projectPoint(projection, lon, lat) {
  return projection([lon, lat]);
}

// ─── Terminator Line: approximate sun position and day/night boundary ─────────
function getSunLon() {
  const now = Date.now();
  const dayMs = 86400000;
  const dayFraction = (now % dayMs) / dayMs;
  return (dayFraction * 360) - 180;
}

function drawTerminator(ctx, projection, width, height) {
  const sunLon = getSunLon();
  // Paint the night side: iterate columns and shade latitudes in shadow
  const step = 2;
  for (let lon = -180; lon <= 180; lon += step) {
    for (let lat = -90; lat <= 90; lat += step) {
      // Simple terminator: night when angular distance from sub-solar point > 90°
      const dLon = ((lon - sunLon + 540) % 360) - 180;
      const cosSunAngle = Math.cos((dLon * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180);
      if (cosSunAngle < 0) {
        const coords = projectPoint(projection, lon, lat);
        if (coords) {
          ctx.fillStyle = C.TERMINATOR;
          ctx.fillRect(coords[0] - 3, coords[1] - 3, step * 3, step * 3);
        }
      }
    }
  }
}

// ─── Simulate historical trail ────────────────────────────────────────────────
function makeTrail(lat, lon, count = 18) {
  const trail = [];
  for (let i = count; i >= 0; i--) {
    const t = i / count;
    trail.push({ lat: lat - t * 12 + Math.sin(t * 5) * 3, lon: lon - t * 45 });
  }
  return trail;
}

function makePredicted(lat, lon, count = 18) {
  const pred = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    pred.push({ lat: lat + t * 10 - Math.sin(t * 4) * 2, lon: lon + t * 40 });
  }
  return pred;
}

// ─── Gantt helpers ────────────────────────────────────────────────────────────
function genManeuvers(sats) {
  return sats.map((s, idx) => {
    const burnStart = (idx * 90 + 20) % 500;
    const burnDur = 40 + (idx * 17) % 60;
    const cooldown = 600;
    return {
      id: s.id,
      status: s.status,
      burnStart,
      burnEnd: burnStart + burnDur,
      cooldownEnd: burnStart + burnDur + cooldown,
      conflict: burnStart + burnDur > 480 || (idx === 1 && burnStart < 200),
    };
  });
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
  const canvasRef = useRef(null);
  const mapContainerRef = useRef(null);
  const bullseyeRef = useRef(null);
  const efficiencyRef = useRef(null);

  const [worldData, setWorldData] = useState(null);
  const [simData, setSimData] = useState({ satellites: [], debris_cloud: [], timestamp: 0 });
  const [conjunctions, setConjunctions] = useState([]);
  const [efficiencyLog, setEfficiencyLog] = useState([]);
  const [maneuvers, setManeuvers] = useState([]);

  const [isSimulating, setIsSimulating] = useState(false);
  const [hoverTarget, setHoverTarget] = useState(null);
  const [selectedSat, setSelectedSat] = useState(null);
  const [activeTab, setActiveTab] = useState('map'); // map | bullseye | telemetry | gantt
  const [showDebris, setShowDebris] = useState(true);
  const [showSatellites, setShowSatellites] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1); // 1 = normal, 0.5 = zoomed out, 2 = zoomed in

  // Stats
  const totalSats = simData.satellites.length;
  const criticalSats = simData.satellites.filter(s => s.status === 'EOL_PENDING').length;
  const warningSats = simData.satellites.filter(s => s.status === 'LOW_FUEL').length;
  const debrisCount = simData.debris_cloud.length;

  // 1. Load World Map
  useEffect(() => {
    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
      .then(r => r.json())
      .then(data => setWorldData(topojson.feature(data, data.objects.countries)))
      .catch(err => console.error('Map load error:', err));
  }, []);

  // 2. Poll simulation snapshot
  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [snapRes, conjRes, effRes, manRes] = await Promise.all([
          fetch('api/visualization/snapshot'),
          fetch('api/visualization/conjunctions'),
          fetch('api/visualization/efficiency'),
          fetch('api/visualization/maneuvers'),
        ]);
        if (snapRes.ok) setSimData(await snapRes.json());
        if (conjRes.ok) { const d = await conjRes.json(); setConjunctions(d.alerts || []); }
        if (effRes.ok) { const d = await effRes.json(); setEfficiencyLog(d.log || []); }
        if (manRes.ok) { const d = await manRes.json(); setManeuvers(d.maneuvers || []); }
      } catch (err) {
        console.error('API error:', err);
      }
    };
    fetchAll();
    const interval = setInterval(fetchAll, 2000);
    return () => clearInterval(interval);
  }, []);

  // 3. Simulation step loop
  useEffect(() => {
    if (!isSimulating) return;
    const simInterval = setInterval(async () => {
      try {
        await fetch('/api/simulate/step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step_seconds: 60 }),
        });
      } catch (err) { console.error('Simulation error:', err); }
    }, 1000);
    return () => clearInterval(simInterval);
  }, [isSimulating]);

  // 4. Ground Track Canvas Render
  useEffect(() => {
    if (!canvasRef.current || !mapContainerRef.current || !worldData) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    let rafId;

    const render = () => {
      const rect = mapContainerRef.current.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr; canvas.height = h * dpr;
        canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      }
      ctx.save();
      ctx.scale(dpr, dpr);

      const projection = d3geo.geoEquirectangular();
      projection.fitSize([w, h], { type: 'Sphere' });
      const path = d3geo.geoPath().projection(projection).context(ctx);

      // Background
      ctx.fillStyle = C.water;
      ctx.fillRect(0, 0, w, h);

      // Grid lines
      ctx.strokeStyle = 'rgba(0,150,200,0.06)';
      ctx.lineWidth = 0.5;
      for (let lat = -75; lat <= 75; lat += 15) {
        const pts = path({ type: 'Feature', geometry: { type: 'LineString', coordinates: Array.from({ length: 361 }, (_, i) => [i - 180, lat]) } });
        ctx.beginPath(); path({ type: 'Feature', geometry: { type: 'LineString', coordinates: Array.from({ length: 361 }, (_, i) => [i - 180, lat]) } }); ctx.stroke();
      }
      for (let lon = -180; lon <= 180; lon += 30) {
        ctx.beginPath(); path({ type: 'Feature', geometry: { type: 'LineString', coordinates: Array.from({ length: 181 }, (_, i) => [lon, i - 90]) } }); ctx.stroke();
      }

      // Land
      ctx.beginPath(); path(worldData);
      ctx.fillStyle = C.land; ctx.fill();
      ctx.strokeStyle = C.border; ctx.lineWidth = 0.4; ctx.stroke();

      // Terminator overlay
      drawTerminator(ctx, projection, w, h);

      // Debris - with zoom-based filtering
      if (showDebris && simData.debris_cloud.length > 0) {
        ctx.fillStyle = C.DEBRIS;
        const debrisStep = zoomLevel < 1 ? Math.ceil(1 / zoomLevel) : 1; // Show fewer when zoomed out
        simData.debris_cloud.forEach((d, idx) => {
          if (idx % debrisStep !== 0) return; // Skip some debris when zoomed out
          const coords = projection([d[2], d[1]]);
          if (coords) { ctx.beginPath(); ctx.arc(coords[0], coords[1], 1.2, 0, 2 * Math.PI); ctx.fill(); }
        });
      }

      // Satellites with trails + predicted paths
      if (showSatellites) {
      simData.satellites.forEach(sat => {
        const coords = projection([sat.lon, sat.lat]);
        if (!coords) return;
        const color = C[sat.status] || C.NOMINAL;
        const trail = makeTrail(sat.lat, sat.lon);
        const predicted = makePredicted(sat.lat, sat.lon);

        // Historical trail
        ctx.beginPath();
        trail.forEach((p, i) => {
          const c2 = projection([p.lon, p.lat]);
          if (!c2) return;
          if (i === 0) ctx.moveTo(c2[0], c2[1]); else ctx.lineTo(c2[0], c2[1]);
        });
        ctx.strokeStyle = color + '55';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Predicted dashed
        ctx.beginPath();
        ctx.setLineDash([5, 5]);
        let moved = false;
        predicted.forEach(p => {
          const c2 = projection([p.lon, p.lat]);
          if (!c2) return;
          if (!moved) { ctx.moveTo(c2[0], c2[1]); moved = true; } else ctx.lineTo(c2[0], c2[1]);
        });
        ctx.strokeStyle = color + '33';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);

        // Glow for non-nominal (reduced glow)
        if (sat.status !== 'NOMINAL') {
          ctx.beginPath();
          ctx.arc(coords[0], coords[1], 7, 0, 2 * Math.PI);
          ctx.fillStyle = sat.status === 'EOL_PENDING' ? 'rgba(255,51,68,0.15)' : 'rgba(255,184,0,0.1)';
          ctx.fill();
        }

        // Core dot
        ctx.beginPath();
        ctx.arc(coords[0], coords[1], 4, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = C.water;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Selected highlight
        if (selectedSat && selectedSat === sat.id) {
          ctx.beginPath();
          ctx.arc(coords[0], coords[1], 11, 0, 2 * Math.PI);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Hover ring
        if (hoverTarget && hoverTarget.id === sat.id) {
          ctx.beginPath();
          ctx.arc(coords[0], coords[1], 10, 0, 2 * Math.PI);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      });
      }

      ctx.restore();
      rafId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(rafId);
  }, [worldData, simData, hoverTarget, selectedSat, showDebris, showSatellites, zoomLevel]);

  // 5. Bullseye (Polar Chart) Canvas
  useEffect(() => {
    if (!bullseyeRef.current) return;
    const canvas = bullseyeRef.current;
    const parent = canvas.parentElement;
    const w = parent.offsetWidth, h = parent.offsetHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#060b12';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const maxR = Math.min(w, h) * 0.43;

    // Rings
    const ringDefs = [
      { r: maxR * 0.25, label: '< 1km', color: 'rgba(255,51,68,0.5)' },
      { r: maxR * 0.55, label: '< 5km', color: 'rgba(255,184,0,0.4)' },
      { r: maxR * 1.0, label: 'SAFE', color: 'rgba(0,200,255,0.2)' },
    ];
    ringDefs.forEach(({ r, label, color }) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.font = '9px "Space Grotesk", sans-serif';
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(label, cx + r + 4, cy - 2);
    });

    // Spokes
    ctx.strokeStyle = 'rgba(0,150,200,0.1)';
    ctx.lineWidth = 0.5;
    for (let a = 0; a < 360; a += 30) {
      const rad = (a * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(rad) * maxR, cy + Math.sin(rad) * maxR);
      ctx.stroke();
    }

    // TCA labels around edge
    ctx.font = '8px monospace';
    ctx.fillStyle = 'rgba(0,200,255,0.35)';
    ctx.textAlign = 'center';
    ['0s', '30s', '60s', '90s'].forEach((t, i) => {
      ctx.fillText(t, cx + (maxR * (i + 1) * 0.25) + 5, cy - 3);
    });

    // Cross-hair
    [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(cx + dx * 6, cy + dy * 6);
      ctx.lineTo(cx + dx * 12, cy + dy * 12);
      ctx.strokeStyle = '#00c8ff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Debris approach markers from conjunction data
    const riskColor = (miss_km) => miss_km < 1 ? C.EOL_PENDING : miss_km < 5 ? C.LOW_FUEL : C.NOMINAL;

    const mockAlerts = conjunctions.length > 0 ? conjunctions : [
      { tca: 45, angle: 40, miss_km: 3.2 },
      { tca: 15, angle: 120, miss_km: 0.6 },
      { tca: 80, angle: 220, miss_km: 8.1 },
      { tca: 60, angle: 300, miss_km: 4.1 },
    ];

    mockAlerts.slice(0, 8).forEach(alert => {
      const tca = alert.tca_seconds || alert.tca || 60;
      const angle = (alert.angle || alert.approach_angle || 45) * (Math.PI / 180);
      const miss = alert.miss_km || alert.miss_distance_km || 3;
      const r = (tca / 90) * maxR;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      const color = riskColor(miss);

      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.strokeStyle = color + '50';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = '8px monospace';
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(miss.toFixed(1) + 'km', px, py - 12);
    });

    // Center label
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(0,200,255,0.5)';
    ctx.textAlign = 'center';
    ctx.fillText(selectedSat || 'SELECT SAT', cx, h - 14);

  }, [conjunctions, selectedSat, activeTab]);

  // 6. Efficiency Chart Canvas
  useEffect(() => {
    if (!efficiencyRef.current || activeTab !== 'telemetry') return;
    const canvas = efficiencyRef.current;
    const parent = canvas.parentElement;
    const w = parent.offsetWidth - 32, h = 160;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#060b12';
    ctx.fillRect(0, 0, w, h);

    const pts = efficiencyLog.length > 0
      ? efficiencyLog.map((e, i) => ({ x: i / (efficiencyLog.length - 1), y: e.collisions_avoided / (e.fuel_consumed || 1) }))
      : Array.from({ length: 10 }, (_, i) => ({ x: i / 9, y: 0.1 + Math.random() * 0.7 }));

    const pad = 28;
    ctx.strokeStyle = 'rgba(0,200,255,0.08)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad + ((h - 2 * pad) / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - 8, y); ctx.stroke();
    }

    // Area fill
    ctx.beginPath();
    pts.forEach((p, i) => {
      const px = pad + p.x * (w - pad - 8);
      const py = h - pad - p.y * (h - 2 * pad);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.lineTo(pad + pts[pts.length - 1].x * (w - pad - 8), h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,200,255,0.06)';
    ctx.fill();

    // Line
    ctx.beginPath();
    pts.forEach((p, i) => {
      const px = pad + p.x * (w - pad - 8);
      const py = h - pad - p.y * (h - 2 * pad);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = '#00c8ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    pts.forEach(p => {
      const px = pad + p.x * (w - pad - 8);
      const py = h - pad - p.y * (h - 2 * pad);
      ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#00c8ff'; ctx.fill();
    });

    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(0,200,255,0.4)';
    ctx.textAlign = 'center';
    ctx.fillText('Fuel Consumed (kg)', w / 2, h - 4);
    ctx.save();
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Collisions Avoided', -h / 2, 10);
    ctx.restore();

  }, [efficiencyLog, activeTab]);

  // Mouse hover on ground track
  const handleMouseMove = useCallback((e) => {
    if (!canvasRef.current || !mapContainerRef.current || !simData.satellites.length) return;
    const rect = mapContainerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const proj = d3geo.geoEquirectangular().fitSize([rect.width, rect.height], { type: 'Sphere' });
    let found = null;
    for (const sat of simData.satellites) {
      const coords = proj([sat.lon, sat.lat]);
      if (coords) {
        const dx = mx - coords[0], dy = my - coords[1];
        if (Math.sqrt(dx * dx + dy * dy) < 10) { found = { ...sat, x: e.clientX, y: e.clientY }; break; }
      }
    }
    setHoverTarget(found);
  }, [simData.satellites]);

  const handleMapClick = useCallback((e) => {
    if (hoverTarget) {
      setSelectedSat(hoverTarget.id);
      setActiveTab('bullseye');
    }
  }, [hoverTarget]);

  // Derived gantt data
  const ganttData = simData.satellites.length > 0
    ? genManeuvers(simData.satellites.slice(0, 5))
    : maneuvers.slice(0, 5);

  const TOTAL_WINDOW = 700;

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: '#050a0f', color: '#b8d4e8', fontFamily: "'Inter', sans-serif", overflow: 'hidden' }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside style={{
        width: 300, background: '#080e15', borderRight: '1px solid rgba(0,180,255,0.1)',
        display: 'flex', flexDirection: 'column', padding: '18px', gap: '14px', flexShrink: 0, zIndex: 10,
        boxShadow: '4px 0 30px rgba(0,0,0,0.5)'
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Rocket size={26} color="#00c8ff" />
          <div style={{
            fontFamily: "'Space Grotesk', sans-serif", fontSize: 20, fontWeight: 700,
            letterSpacing: 2, background: 'linear-gradient(90deg,#fff,#00c8ff)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
          }}>DEBRIX ORBITAL</div>
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            { label: 'Satellites', value: totalSats, color: '#00c8ff' },
            { label: 'Debris', value: debrisCount, color: '#b8d4e8' },
            { label: 'Low Fuel', value: warningSats, color: '#ffb800' },
            { label: 'EOL Pending', value: criticalSats, color: '#ff3344' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              background: '#0c1520', border: '1px solid rgba(0,180,255,0.1)', borderRadius: 8, padding: '10px 12px'
            }}>
              <div style={{ fontSize: 10, color: '#4a6a7a', letterSpacing: 1, marginBottom: 4 }}>{label.toUpperCase()}</div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 26, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Map Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0', borderTop: '1px solid rgba(0,180,255,0.08)', borderBottom: '1px solid rgba(0,180,255,0.08)' }}>
          <div style={{ fontSize: 9, color: '#4a6a7a', letterSpacing: 1 }}>MAP LAYERS</div>
          <button onClick={() => setShowDebris(!showDebris)} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
            background: showDebris ? 'rgba(255,255,255,0.08)' : 'transparent',
            border: showDebris ? '1px solid rgba(200,200,200,0.2)' : '1px solid transparent',
            borderRadius: 4, color: showDebris ? '#b8d4e8' : '#4a6a7a', cursor: 'pointer',
            fontSize: 10, fontWeight: 600, transition: 'all 0.15s',
          }}>
            {showDebris ? '✓' : '○'} DEBRIS CLOUD
          </button>
          <button onClick={() => setShowSatellites(!showSatellites)} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
            background: showSatellites ? 'rgba(0,200,255,0.08)' : 'transparent',
            border: showSatellites ? '1px solid rgba(0,200,255,0.25)' : '1px solid transparent',
            borderRadius: 4, color: showSatellites ? '#00c8ff' : '#4a6a7a', cursor: 'pointer',
            fontSize: 10, fontWeight: 600, transition: 'all 0.15s',
          }}>
            {showSatellites ? '✓' : '○'} SATELLITES
          </button>
        </div>

        {/* Zoom Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0', borderBottom: '1px solid rgba(0,180,255,0.08)' }}>
          <div style={{ fontSize: 9, color: '#4a6a7a', letterSpacing: 1 }}>ZOOM LEVEL</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => setZoomLevel(0.5)} style={{
              flex: 1, padding: '6px 8px', background: zoomLevel === 0.5 ? 'rgba(255,184,0,0.15)' : 'transparent',
              border: zoomLevel === 0.5 ? '1px solid rgba(255,184,0,0.4)' : '1px solid rgba(0,180,255,0.1)',
              borderRadius: 4, color: zoomLevel === 0.5 ? '#ffb800' : '#4a6a7a', cursor: 'pointer',
              fontSize: 9, fontWeight: 600, transition: 'all 0.15s',
            }}>OUT</button>
            <button onClick={() => setZoomLevel(1)} style={{
              flex: 1, padding: '6px 8px', background: zoomLevel === 1 ? 'rgba(0,200,255,0.15)' : 'transparent',
              border: zoomLevel === 1 ? '1px solid rgba(0,200,255,0.4)' : '1px solid rgba(0,180,255,0.1)',
              borderRadius: 4, color: zoomLevel === 1 ? '#00c8ff' : '#4a6a7a', cursor: 'pointer',
              fontSize: 9, fontWeight: 600, transition: 'all 0.15s',
            }}>NORM</button>
            <button onClick={() => setZoomLevel(2)} style={{
              flex: 1, padding: '6px 8px', background: zoomLevel === 2 ? 'rgba(0,255,157,0.15)' : 'transparent',
              border: zoomLevel === 2 ? '1px solid rgba(0,255,157,0.4)' : '1px solid rgba(0,180,255,0.1)',
              borderRadius: 4, color: zoomLevel === 2 ? '#00ff9d' : '#4a6a7a', cursor: 'pointer',
              fontSize: 9, fontWeight: 600, transition: 'all 0.15s',
            }}>IN</button>
          </div>
        </div>

        {/* Nav Tabs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[
            { id: 'map', icon: <Navigation size={13} />, label: 'GROUND TRACK' },
            { id: 'bullseye', icon: <Target size={13} />, label: 'BULLSEYE PLOT' },
            { id: 'telemetry', icon: <Activity size={13} />, label: 'TELEMETRY' },
            { id: 'gantt', icon: <Clock size={13} />, label: 'GANTT TIMELINE' },
          ].map(({ id, icon, label }) => (
            <button key={id} onClick={() => setActiveTab(id)} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
              background: activeTab === id ? 'rgba(0,200,255,0.1)' : 'transparent',
              border: activeTab === id ? '1px solid rgba(0,200,255,0.25)' : '1px solid transparent',
              borderRadius: 6, color: activeTab === id ? '#00c8ff' : '#4a6a7a', cursor: 'pointer',
              fontSize: 11, fontWeight: 600, letterSpacing: 1, textAlign: 'left',
            }}>
              {icon}{label}
            </button>
          ))}
        </div>

        {/* Satellite List */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: '#4a6a7a', letterSpacing: 1 }}>FLEET STATUS</span>
            <Satellite size={12} color="#4a6a7a" />
          </div>
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            {simData.satellites.map(sat => {
              const color = C[sat.status] || C.NOMINAL;
              const isSelected = selectedSat === sat.id;
              return (
                <div key={sat.id}
                  onClick={() => { setSelectedSat(sat.id); setActiveTab('bullseye'); }}
                  style={{
                    background: isSelected ? 'rgba(0,200,255,0.08)' : '#0c1520',
                    border: `1px solid ${isSelected ? 'rgba(0,200,255,0.3)' : 'rgba(0,180,255,0.08)'}`,
                    borderRadius: 6, padding: '8px 10px', cursor: 'pointer', transition: 'all 0.15s',
                  }}
                  onMouseEnter={() => setHoverTarget(sat)}
                  onMouseLeave={() => setHoverTarget(null)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                    <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 12 }}>{sat.id}</span>
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 10, letterSpacing: 0.5,
                      background: color + '18', color, border: `1px solid ${color}30`
                    }}>{sat.status.replace('_', ' ')}</span>
                  </div>
                  <div style={{ height: 3, background: '#0e1621', borderRadius: 2, overflow: 'hidden', marginBottom: 4 }}>
                    <div style={{ height: '100%', width: `${sat.fuel_percent}%`, background: color, borderRadius: 2, transition: 'width 0.4s' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#4a6a7a' }}>
                    <span>{sat.fuel_kg.toFixed(1)} kg</span>
                    <span>{sat.fuel_percent}%</span>
                  </div>
                </div>
              );
            })}
            {simData.satellites.length === 0 && (
              <div style={{ color: '#4a6a7a', fontSize: 12, textAlign: 'center', marginTop: 16 }}>No tracking data. Start simulation.</div>
            )}
          </div>
        </div>

        {/* Sim Toggle */}
        <button onClick={() => setIsSimulating(v => !v)} style={{
          padding: '10px 14px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12,
          letterSpacing: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          background: isSimulating ? 'rgba(255,51,68,0.12)' : 'rgba(0,200,255,0.08)',
          border: `1px solid ${isSimulating ? 'rgba(255,51,68,0.35)' : 'rgba(0,200,255,0.25)'}`,
          color: isSimulating ? '#ff3344' : '#00c8ff', transition: 'all 0.2s',
        }}>
          {isSimulating ? <><Zap size={15} fill="currentColor" /> STOP SIMULATION</> : <><Rocket size={15} /> START SIMULATION</>}
        </button>
      </aside>

      {/* ── Main Panel ──────────────────────────────────────────────────── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>

        {/* ─── GROUND TRACK TAB ─── */}
        {activeTab === 'map' && (
          <div ref={mapContainerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoverTarget(null)}
            onClick={handleMapClick}
          >
            <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />

            {/* Legend */}
            <div style={{
              position: 'absolute', top: 16, right: 16,
              background: 'rgba(8,14,21,0.85)', backdropFilter: 'blur(12px)',
              border: '1px solid rgba(0,180,255,0.12)', borderRadius: 10, padding: '12px 16px',
              display: 'flex', flexDirection: 'column', gap: 8, zIndex: 20, fontSize: 11
            }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: '#4a6a7a', marginBottom: 2 }}>LEGEND</div>
              {[['NOMINAL', C.NOMINAL], ['LOW FUEL', C.LOW_FUEL], ['EOL PNDG', C.EOL_PENDING], ['DEBRIS', C.DEBRIS]].map(([lbl, clr]) => (
                <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: clr, boxShadow: `0 0 5px ${clr}` }} />
                  <span style={{ color: '#7a9aaf', fontSize: 10 }}>{lbl}</span>
                </div>
              ))}
              <div style={{ marginTop: 4, borderTop: '1px solid rgba(0,180,255,0.1)', paddingTop: 6, fontSize: 9, color: '#3a5a6a' }}>
                <div>— Historical (90 min)</div>
                <div>– – Predicted (90 min)</div>
                <div style={{ color: '#334455', marginTop: 2 }}>▒ Night (Terminator)</div>
              </div>
            </div>

            {/* Click hint */}
            <div style={{
              position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(0,200,255,0.06)', border: '1px solid rgba(0,200,255,0.15)',
              borderRadius: 6, padding: '6px 14px', fontSize: 10, color: '#4a7a8a', zIndex: 20
            }}>Click a satellite to open Bullseye view</div>

            {/* Hover Tooltip */}
            {hoverTarget && (
              <div style={{
                position: 'fixed',
                left: Math.min((hoverTarget.x || 0), window.innerWidth - 180),
                top: (hoverTarget.y || 0),
                transform: 'translate(-50%, calc(-100% - 12px))',
                background: 'rgba(6,11,18,0.97)',
                border: '1px solid rgba(0,200,255,0.2)',
                borderRadius: 8, padding: '10px 14px', zIndex: 200, fontSize: 12,
                pointerEvents: 'none', minWidth: 160, boxShadow: '0 8px 32px rgba(0,0,0,0.6)'
              }}>
                <div style={{ fontWeight: 700, marginBottom: 8, color: '#e0f0ff', fontSize: 13 }}>{hoverTarget.id}</div>
                {[
                  ['Status', hoverTarget.status, C[hoverTarget.status]],
                  ['Lat', `${hoverTarget.lat?.toFixed(2)}°`, null],
                  ['Lon', `${hoverTarget.lon?.toFixed(2)}°`, null],
                  ['Fuel', `${hoverTarget.fuel_percent}% (${hoverTarget.fuel_kg?.toFixed(1)} kg)`, null],
                ].map(([k, v, col]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 3 }}>
                    <span style={{ color: '#4a6a7a' }}>{k}:</span>
                    <span style={{ color: col || '#b8d4e8' }}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── BULLSEYE TAB ─── */}
        {activeTab === 'bullseye' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#060b12', overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(0,180,255,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 10, letterSpacing: 2, color: '#4a6a7a' }}>CONJUNCTION BULLSEYE PLOT</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#b8d4e8', marginTop: 2 }}>
                  {selectedSat ? `Tracking: ${selectedSat}` : 'Select a satellite from fleet list'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 10 }}>
                {[['#00ff9d', 'SAFE (>5km)'], ['#ffb800', 'WARNING (<5km)'], ['#ff3344', 'CRITICAL (<1km)']].map(([c, l]) => (
                  <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
                    <span style={{ color: '#4a7a8a' }}>{l}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <canvas ref={bullseyeRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
            </div>
          </div>
        )}

        {/* ─── TELEMETRY TAB ─── */}
        {activeTab === 'telemetry' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 20, background: '#060b12' }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#4a6a7a', marginBottom: 16 }}>TELEMETRY & RESOURCE HEATMAPS</div>

            {/* Fuel Gauges */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 11, color: '#4a7a8a', marginBottom: 10, letterSpacing: 1 }}>M_FUEL GAUGES — ACTIVE FLEET</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
                {(simData.satellites.length > 0 ? simData.satellites : Array.from({ length: 4 }, (_, i) => ({ id: `SAT-0${i + 1}`, fuel_kg: 50 - i * 12, fuel_percent: 90 - i * 20, status: i < 2 ? 'NOMINAL' : i === 2 ? 'LOW_FUEL' : 'EOL_PENDING' }))).map(sat => {
                  const color = C[sat.status] || C.NOMINAL;
                  const pct = sat.fuel_percent;
                  const r = 36, cx2 = 50, cy2 = 50;
                  const circumference = 2 * Math.PI * r;
                  const dash = (pct / 100) * circumference;
                  return (
                    <div key={sat.id} style={{ background: '#0c1520', border: '1px solid rgba(0,180,255,0.1)', borderRadius: 10, padding: '14px', textAlign: 'center' }}>
                      <svg width="100" height="100" viewBox="0 0 100 100" style={{ display: 'block', margin: '0 auto' }}>
                        <circle cx={cx2} cy={cy2} r={r} fill="none" stroke="#1a2535" strokeWidth="8" />
                        <circle cx={cx2} cy={cy2} r={r} fill="none" stroke={color} strokeWidth="8"
                          strokeDasharray={`${dash} ${circumference - dash}`}
                          strokeLinecap="round"
                          transform={`rotate(-90 ${cx2} ${cy2})`}
                          style={{ filter: `drop-shadow(0 0 4px ${color}60)` }}
                        />
                        <text x="50" y="47" textAnchor="middle" fill={color} fontSize="14" fontWeight="700" fontFamily="monospace">{pct.toFixed(0)}%</text>
                        <text x="50" y="62" textAnchor="middle" fill="#4a6a7a" fontSize="9" fontFamily="monospace">{sat.fuel_kg.toFixed(1)}kg</text>
                      </svg>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#b8d4e8', marginTop: 6 }}>{sat.id}</div>
                      <div style={{ fontSize: 9, color: color, letterSpacing: 1, marginTop: 2 }}>{sat.status}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ΔV Efficiency Plot */}
            <div>
              <div style={{ fontSize: 11, color: '#4a7a8a', marginBottom: 10, letterSpacing: 1 }}>ΔV COST ANALYSIS — FUEL CONSUMED vs COLLISIONS AVOIDED</div>
              <div style={{ background: '#0c1520', border: '1px solid rgba(0,180,255,0.1)', borderRadius: 10, padding: '16px' }}>
                <canvas ref={efficiencyRef} style={{ display: 'block' }} />
              </div>
            </div>
          </div>
        )}

        {/* ─── GANTT TAB ─── */}
        {activeTab === 'gantt' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 20, background: '#060b12' }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#4a6a7a', marginBottom: 16 }}>MANEUVER TIMELINE — GANTT SCHEDULER</div>

            {/* Time axis */}
            <div style={{ display: 'flex', marginLeft: 90, marginBottom: 4, gap: 0 }}>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} style={{ flex: 1, fontSize: 9, color: '#3a5a6a', textAlign: 'right', fontFamily: 'monospace' }}>
                  T+{i * 100}s
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(ganttData.length > 0 ? ganttData : Array.from({ length: 4 }, (_, i) => ({
                id: `SAT-0${i + 1}`, status: 'NOMINAL',
                burnStart: i * 80 + 20, burnEnd: i * 80 + 70, cooldownEnd: i * 80 + 670, conflict: i === 1
              }))).map(row => {
                const color = C[row.status] || C.NOMINAL;
                const burnStartPct = (row.burnStart / TOTAL_WINDOW) * 100;
                const burnWidthPct = ((row.burnEnd - row.burnStart) / TOTAL_WINDOW) * 100;
                const coolStartPct = (row.burnEnd / TOTAL_WINDOW) * 100;
                const coolWidthPct = Math.min(((row.cooldownEnd - row.burnEnd) / TOTAL_WINDOW) * 100, 100 - coolStartPct);
                const hasConflict = row.conflict || row.cooldownEnd > TOTAL_WINDOW;

                return (
                  <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 80, fontSize: 11, fontFamily: 'monospace', color: color, flexShrink: 0, textAlign: 'right' }}>{row.id}</div>
                    <div style={{ flex: 1, height: 24, background: '#0c1520', borderRadius: 4, position: 'relative', overflow: 'hidden', border: '1px solid rgba(0,180,255,0.08)' }}>
                      {/* Burn Start */}
                      <div title="Burn Start" style={{
                        position: 'absolute', left: `${burnStartPct}%`, width: `${burnWidthPct / 2}%`,
                        height: '100%', background: color + '40', borderLeft: `2px solid ${color}`,
                        display: 'flex', alignItems: 'center', paddingLeft: 4,
                        fontSize: 8, color, fontFamily: 'monospace', letterSpacing: 0.5
                      }}>BURN▶</div>
                      {/* Burn End */}
                      <div title="Burn End" style={{
                        position: 'absolute', left: `${burnStartPct + burnWidthPct / 2}%`, width: `${burnWidthPct / 2}%`,
                        height: '100%', background: color + '25', borderRight: `2px solid ${color}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 4,
                        fontSize: 8, color: color + 'aa', fontFamily: 'monospace', letterSpacing: 0.5
                      }}>◀END</div>
                      {/* Cooldown */}
                      <div title="600s Cooldown" style={{
                        position: 'absolute', left: `${coolStartPct}%`, width: `${Math.min(coolWidthPct, 100 - coolStartPct)}%`,
                        height: '100%',
                        background: hasConflict ? 'rgba(255,51,68,0.18)' : 'rgba(40,60,80,0.5)',
                        borderLeft: hasConflict ? '1px solid rgba(255,51,68,0.5)' : '1px solid rgba(0,180,255,0.15)',
                        display: 'flex', alignItems: 'center', paddingLeft: 4,
                        fontSize: 8, color: hasConflict ? '#ff3344' : '#3a5a6a', fontFamily: 'monospace', letterSpacing: 0.5
                      }}>{hasConflict ? '⚠ CONFLICT / COOLDOWN' : '⟳ 600s COOLDOWN'}</div>
                    </div>
                    {hasConflict && (
                      <div style={{ fontSize: 9, color: '#ff3344', fontFamily: 'monospace', width: 60, textAlign: 'right', flexShrink: 0 }}>BLACKOUT!</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div style={{ marginTop: 24, padding: '12px 16px', background: '#0c1520', border: '1px solid rgba(0,180,255,0.08)', borderRadius: 8, fontSize: 10, color: '#4a6a7a' }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 20, height: 8, background: 'rgba(0,255,157,0.35)', borderLeft: '2px solid #00ff9d', borderRadius: 1 }} />
                  <span>Burn Start</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 20, height: 8, background: 'rgba(0,255,157,0.18)', borderRight: '2px solid #00ff9d', borderRadius: 1 }} />
                  <span>Burn End</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 20, height: 8, background: 'rgba(40,60,80,0.5)', borderLeft: '1px solid rgba(0,180,255,0.2)', borderRadius: 1 }} />
                  <span>600s Cooldown</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 20, height: 8, background: 'rgba(255,51,68,0.2)', borderLeft: '1px solid rgba(255,51,68,0.5)', borderRadius: 1 }} />
                  <span>⚠ Conflict / Blackout Zone</span>
                </div>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

export default App;