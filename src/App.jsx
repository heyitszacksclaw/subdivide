import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import { computeSubdivision } from './engine';
import { 
  siteRectToGeoJSON, 
  rectToGeoJSON, 
  boundaryToGeoJSON, 
  getBoundaryCenterLatLon,
  feetToLatLon 
} from './coordinates';
import { generateCSV, generateDXF, formatCurrency, formatNumber, formatPercent, formatFullCurrency } from './exports';

const DEFAULT_LAT = 33.4484;
const DEFAULT_LON = -112.0740;
const DEFAULT_COLORS = ['#3b82f6', '#22c55e', '#f97316'];

// Free map styles — no API key needed
const MAP_STYLES = {
  satellite: {
    version: 8,
    sources: {
      'esri-satellite': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
        ],
        tileSize: 256,
        attribution: '&copy; Esri &mdash; Esri, Maxar, Earthstar Geographics'
      }
    },
    layers: [{
      id: 'esri-satellite',
      type: 'raster',
      source: 'esri-satellite'
    }],
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
  },
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
  dark: {
    version: 8,
    sources: {
      'carto-dark': {
        type: 'raster',
        tiles: [
          'https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/{z}/{x}/{y}@2x.png',
          'https://cartodb-basemaps-b.global.ssl.fastly.net/dark_all/{z}/{x}/{y}@2x.png',
          'https://cartodb-basemaps-c.global.ssl.fastly.net/dark_all/{z}/{x}/{y}@2x.png'
        ],
        tileSize: 256,
        attribution: '&copy; CARTO &copy; OpenStreetMap'
      }
    },
    layers: [{
      id: 'carto-dark',
      type: 'raster',
      source: 'carto-dark'
    }],
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
  },
  bright: 'https://tiles.openfreemap.org/styles/bright',
};

const STYLE_LABELS = {
  satellite: 'Satellite',
  dark: 'Dark',
  liberty: 'Liberty',
  bright: 'Bright',
};

function createDefaultParcelType(index) {
  return {
    id: `type-${index}-${Date.now()}`,
    name: `Parcel ${index + 1}`,
    weight: 100,
    color: DEFAULT_COLORS[index % 3],
    lotWidthFt: 55,
    lotDepthFt: 120,
    homeWidthFt: 40,
    homeDepthFt: 60,
    unitLevels: 2,
    setbackFront: 20,
    setbackSide: 5,
    setbackBack: 20,
    pricePerLot: 180000,
  };
}

const defaultFinancials = {
  landCost: 0,
  infraCostPerLF: 250,
  lotDevCostPerLot: 40000,
  softCostPct: 15,
  capRate: 5,
};

/**
 * Canvas overlay: Renders subdivision geometry directly as HTML Canvas
 * on top of the MapLibre map. This bypasses MapLibre's WebGL layer system
 * which can silently fail with certain style configurations.
 */
function CanvasOverlay({ map, results, originLat, originLon, widthFt, depthFt }) {
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map) return;

    const container = map.getContainer();
    const rect = container.getBoundingClientRect();

    // Match canvas size to map container (with devicePixelRatio for crisp rendering)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Helper: convert [lon, lat] to pixel coordinates
    const toPixel = (lngLat) => {
      const point = map.project(lngLat);
      return [point.x, point.y];
    };

    // Helper: draw a polygon from GeoJSON ring coordinates
    const drawPolygon = (ring, fillColor, strokeColor, lineWidth, lineDash) => {
      if (!ring || ring.length < 3) return;
      ctx.beginPath();
      const [sx, sy] = toPixel(ring[0]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < ring.length; i++) {
        const [px, py] = toPixel(ring[i]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fill();
      }
      if (strokeColor) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth || 1;
        if (lineDash) ctx.setLineDash(lineDash);
        else ctx.setLineDash([]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };

    // 1. Draw site boundary (white dashed outline with subtle fill)
    const siteBoundary = [
      feetToLatLon(originLat, originLon, 0, 0),
      feetToLatLon(originLat, originLon, widthFt, 0),
      feetToLatLon(originLat, originLon, widthFt, depthFt),
      feetToLatLon(originLat, originLon, 0, depthFt),
      feetToLatLon(originLat, originLon, 0, 0),
    ];
    drawPolygon(siteBoundary, 'rgba(255,255,255,0.06)', '#ffffff', 2.5, [8, 4]);

    // 2. Draw roads
    results.roads.forEach(road => {
      const roadRing = rectToGeoJSON(originLat, originLon, road.x, road.y, road.width, road.height);
      drawPolygon(roadRing, 'rgba(71,85,105,0.8)', 'rgba(148,163,184,0.8)', 1.5);
    });

    // 3. Draw lot fills and outlines
    results.lots.forEach(lot => {
      const lotRing = boundaryToGeoJSON(originLat, originLon, lot.lotBoundary);
      const color = lot.conforming ? lot.color : '#ef4444';
      // Parse hex to rgba for fill
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      drawPolygon(lotRing, `rgba(${r},${g},${b},0.35)`, color, 1.5);
    });

    // 4. Draw home footprints (only conforming)
    results.lots.filter(l => l.conforming).forEach(lot => {
      const homeRing = boundaryToGeoJSON(originLat, originLon, lot.homeBoundary);
      const color = lot.color;
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      drawPolygon(homeRing, `rgba(${r},${g},${b},0.75)`, 'rgba(255,255,255,0.4)', 0.5);
    });

    // 5. Draw lot number labels
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    results.lots.forEach(lot => {
      const center = getBoundaryCenterLatLon(originLat, originLon, lot.lotBoundary);
      const [px, py] = toPixel(center);
      // Text halo
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.lineWidth = 3;
      ctx.strokeText(String(lot.id), px, py);
      // Text fill
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(lot.id), px, py);
    });

  }, [map, results, originLat, originLon, widthFt, depthFt]);

  useEffect(() => {
    if (!map) return;

    const onRender = () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = requestAnimationFrame(draw);
    };

    // Redraw on every map render frame (move, zoom, rotate)
    map.on('render', onRender);
    // Also draw immediately
    draw();

    return () => {
      map.off('render', onRender);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [map, draw]);

  // Also redraw when data changes
  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 10,
      }}
    />
  );
}


export default function App() {
  // Site state
  const [lat, setLat] = useState(DEFAULT_LAT);
  const [lon, setLon] = useState(DEFAULT_LON);
  const [addressInput, setAddressInput] = useState('33.4484, -112.0740');
  const [widthFt, setWidthFt] = useState(500);
  const [depthFt, setDepthFt] = useState(300);
  const [streetSide, setStreetSide] = useState('S');
  const [roadWidthFt, setRoadWidthFt] = useState(28);
  
  // Parcel types
  const [parcelTypes, setParcelTypes] = useState([createDefaultParcelType(0)]);
  const [activeParcelTab, setActiveParcelTab] = useState(0);
  
  // Financials
  const [financials, setFinancials] = useState(defaultFinancials);
  
  // UI state
  const [financialsCollapsed, setFinancialsCollapsed] = useState(false);
  const [mapStyle, setMapStyle] = useState('dark');
  const [mapInstance, setMapInstance] = useState(null);
  
  // Map refs
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  
  // Compute subdivision
  const results = useMemo(() => {
    return computeSubdivision({
      widthFt,
      depthFt,
      roadWidthFt,
      parcelTypes,
      financials
    });
  }, [widthFt, depthFt, roadWidthFt, parcelTypes, financials]);
  
  // Origin lat/lon = bottom-left of site rectangle
  const originLat = useMemo(() => {
    const halfDepthDeg = (depthFt / 3.28084) / 111320 / 2;
    return lat - halfDepthDeg;
  }, [lat, depthFt]);
  
  const originLon = useMemo(() => {
    const halfWidthDeg = (widthFt / 3.28084) / (111320 * Math.cos((lat * Math.PI) / 180)) / 2;
    return lon - halfWidthDeg;
  }, [lon, widthFt, lat]);

  // Corner positions for drag handles [SW, SE, NE, NW]
  const corners = useMemo(() => {
    return [
      feetToLatLon(originLat, originLon, 0, 0),           // SW
      feetToLatLon(originLat, originLon, widthFt, 0),      // SE
      feetToLatLon(originLat, originLon, widthFt, depthFt), // NE
      feetToLatLon(originLat, originLon, 0, depthFt),       // NW
    ];
  }, [originLat, originLon, widthFt, depthFt]);

  // Handle drag of corner markers
  const handleCornerDrag = useCallback((cornerIdx, lngLat, isFinal = false) => {
    const FEET_PER_METER = 3.28084;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
    
    // Get current corners in lng/lat
    const sw = feetToLatLon(originLat, originLon, 0, 0);
    const ne = feetToLatLon(originLat, originLon, widthFt, depthFt);
    
    let newSW = [...sw];
    let newNE = [...ne];
    
    // Each corner controls two edges
    switch (cornerIdx) {
      case 0: // SW — controls left and bottom
        newSW = [lngLat.lng, lngLat.lat];
        break;
      case 1: // SE — controls right and bottom
        newNE[0] = lngLat.lng;
        newSW[1] = lngLat.lat;
        break;
      case 2: // NE — controls right and top
        newNE = [lngLat.lng, lngLat.lat];
        break;
      case 3: // NW — controls left and top
        newSW[0] = lngLat.lng;
        newNE[1] = lngLat.lat;
        break;
    }
    
    // Calculate new width and depth in feet
    const dLon = newNE[0] - newSW[0];
    const dLat = newNE[1] - newSW[1];
    const newWidthFt = Math.round(Math.abs(dLon * mPerDegLon * FEET_PER_METER));
    const newDepthFt = Math.round(Math.abs(dLat * mPerDegLat * FEET_PER_METER));
    
    // Calculate new center
    const centerLat = (newSW[1] + newNE[1]) / 2;
    const centerLon = (newSW[0] + newNE[0]) / 2;
    
    if (newWidthFt >= 50 && newDepthFt >= 50 && newWidthFt <= 5000 && newDepthFt <= 5000) {
      setWidthFt(newWidthFt);
      setDepthFt(newDepthFt);
      setLat(centerLat);
      setLon(centerLon);
      if (isFinal) {
        setAddressInput(`${centerLat.toFixed(4)}, ${centerLon.toFixed(4)}`);
      }
    }
  }, [lat, lon, originLat, originLon, widthFt, depthFt]);

  // Initialize map — only when style changes
  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      setMapInstance(null);
      markersRef.current.forEach(m => m.remove());
      markersRef.current = [];
    }
    
    const styleValue = MAP_STYLES[mapStyle] || MAP_STYLES.dark;
    
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: styleValue,
      center: [lon, lat],
      zoom: 17,
      attributionControl: true
    });
    
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    
    map.on('load', () => {
      // Add drag handle markers
      const currentCorners = [
        feetToLatLon(originLat, originLon, 0, 0),
        feetToLatLon(originLat, originLon, widthFt, 0),
        feetToLatLon(originLat, originLon, widthFt, depthFt),
        feetToLatLon(originLat, originLon, 0, depthFt),
      ];
      
      markersRef.current = currentCorners.map((lngLat, idx) => {
        const el = document.createElement('div');
        el.className = 'drag-handle';
        el.style.cssText = `
          width: 16px; height: 16px;
          background: #ffffff;
          border: 2.5px solid #3b82f6;
          border-radius: 50%;
          cursor: ${idx === 0 || idx === 2 ? 'nwse-resize' : 'nesw-resize'};
          box-shadow: 0 0 8px rgba(0,0,0,0.5);
          z-index: 20;
        `;
        
        const marker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat(lngLat)
          .addTo(map);
        
        marker.on('drag', () => handleCornerDrag(idx, marker.getLngLat()));
        marker.on('dragend', () => handleCornerDrag(idx, marker.getLngLat(), true));
        
        return marker;
      });
      
      // Set mapInstance state to trigger CanvasOverlay rendering
      setMapInstance(map);
      
      // Fit map to site
      const center = feetToLatLon(originLat, originLon, widthFt / 2, depthFt / 2);
      map.easeTo({ center, zoom: 17, duration: 300 });
    });
    
    map.on('error', (e) => {
      console.warn('Map error:', e.error?.message || e.message);
    });
    
    mapRef.current = map;
    
    return () => {
      markersRef.current.forEach(m => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      setMapInstance(null);
    };
  }, [mapStyle]); // eslint-disable-line react-hooks/exhaustive-deps
  
  // Update drag handle positions when data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    
    // Update drag handle positions
    if (markersRef.current.length === 4) {
      corners.forEach((lngLat, i) => {
        markersRef.current[i].setLngLat(lngLat);
      });
    }
    
    // Pan to center
    const center = feetToLatLon(originLat, originLon, widthFt / 2, depthFt / 2);
    map.easeTo({ center, duration: 200 });
    
  }, [corners, originLat, originLon, widthFt, depthFt]);
  
  // Handle address/coordinate submit
  const handleLocationSubmit = useCallback(() => {
    const input = addressInput.trim();
    
    const coordMatch = input.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      const newLat = parseFloat(coordMatch[1]);
      const newLon = parseFloat(coordMatch[2]);
      if (newLat >= -90 && newLat <= 90 && newLon >= -180 && newLon <= 180) {
        setLat(newLat);
        setLon(newLon);
        setTimeout(() => {
          mapRef.current?.flyTo({ center: [newLon, newLat], zoom: 17, duration: 1500 });
        }, 100);
      }
      return;
    }
    
    // Nominatim geocoding (free, no API key)
    fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(input)}&limit=1`, {
      headers: { 'User-Agent': 'Subdivide/1.0' }
    })
      .then(r => r.json())
      .then(data => {
        if (data && data.length > 0) {
          const newLat = parseFloat(data[0].lat);
          const newLon = parseFloat(data[0].lon);
          setLat(newLat);
          setLon(newLon);
          setAddressInput(`${newLat.toFixed(4)}, ${newLon.toFixed(4)}`);
          setTimeout(() => {
            mapRef.current?.flyTo({ center: [newLon, newLat], zoom: 17, duration: 1500 });
          }, 100);
        }
      })
      .catch(err => console.error('Geocoding error:', err));
  }, [addressInput]);
  
  // Parcel type handlers
  const updateParcelType = useCallback((index, field, value) => {
    setParcelTypes(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }, []);
  
  const addParcelType = useCallback(() => {
    if (parcelTypes.length >= 3) return;
    setParcelTypes(prev => [...prev, createDefaultParcelType(prev.length)]);
    setActiveParcelTab(parcelTypes.length);
  }, [parcelTypes.length]);
  
  const removeParcelType = useCallback((index) => {
    if (parcelTypes.length <= 1) return;
    setParcelTypes(prev => prev.filter((_, i) => i !== index));
    setActiveParcelTab(Math.max(0, activeParcelTab - 1));
  }, [parcelTypes.length, activeParcelTab]);
  
  // Financial handlers
  const updateFinancial = useCallback((field, value) => {
    setFinancials(prev => ({ ...prev, [field]: value }));
  }, []);
  
  // Export handlers
  const downloadCSV = useCallback(() => {
    const csv = generateCSV(results);
    downloadFile(csv, `${lat.toFixed(4)}_${lon.toFixed(4)}_lots.csv`, 'text/csv');
  }, [results, lat, lon]);
  
  const downloadDXF = useCallback(() => {
    const dxf = generateDXF(results, widthFt, depthFt);
    downloadFile(dxf, `${lat.toFixed(4)}_${lon.toFixed(4)}_subdivision.dxf`, 'application/dxf');
  }, [results, widthFt, depthFt, lat, lon]);
  
  const downloadPDF = useCallback(async () => {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'in', format: 'letter' });
    
    pdf.setFontSize(16);
    pdf.setFont('helvetica', 'bold');
    pdf.text('SUBDIVISION FEASIBILITY REPORT', 0.5, 0.7);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Location: ${lat.toFixed(4)}, ${lon.toFixed(4)}`, 0.5, 1.0);
    pdf.text(`Date: ${new Date().toLocaleDateString()}`, 0.5, 1.25);
    pdf.text(`Site: ${widthFt}ft x ${depthFt}ft (${(widthFt * depthFt / 43560).toFixed(2)} acres)`, 0.5, 1.5);
    
    let y = 2.0;
    const col2 = 5.5;
    
    pdf.setFontSize(11); pdf.setFont('helvetica', 'bold');
    pdf.text('SUBDIVISIONS', 0.5, y); y += 0.25;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    pdf.text(`Parcels: ${results.conformingLots}`, 0.5, y); y += 0.18;
    pdf.text(`Units: ${results.conformingLots}`, 0.5, y); y += 0.18;
    pdf.text(`NRSF: ${formatNumber(results.totalNRSF)} sq ft`, 0.5, y); y += 0.3;
    
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('HOUSING / ROAD', 0.5, y); y += 0.25;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    pdf.text(`Area Road: ${formatNumber(results.roadAreaFt2)} sq ft`, 0.5, y); y += 0.18;
    pdf.text(`Linear Road: ${formatNumber(results.roadLinearFt)} LF`, 0.5, y); y += 0.3;
    
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('SUMMARY', 0.5, y); y += 0.25;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    pdf.text(`Revenue: ${formatFullCurrency(results.revenue)}`, 0.5, y); y += 0.18;
    pdf.text(`Expenses: ${formatFullCurrency(results.expenses)}`, 0.5, y); y += 0.18;
    pdf.text(`NOI: ${formatFullCurrency(results.noi)}`, 0.5, y); y += 0.3;
    
    let y2 = 2.0;
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('COSTS', col2, y2); y2 += 0.25;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    pdf.text(`Land: ${formatFullCurrency(results.landCosts)}`, col2, y2); y2 += 0.18;
    pdf.text(`Hard: ${formatFullCurrency(results.hardCosts)}`, col2, y2); y2 += 0.18;
    pdf.text(`Soft: ${formatFullCurrency(results.softCosts)}`, col2, y2); y2 += 0.18;
    pdf.text(`Earthwork: $0 (V1 placeholder)`, col2, y2); y2 += 0.18;
    pdf.text(`Total: ${formatFullCurrency(results.totalCosts)}`, col2, y2); y2 += 0.3;
    
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('METRICS', col2, y2); y2 += 0.25;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
    pdf.text(`Yield on Cost: ${formatPercent(results.yieldOnCost)}`, col2, y2); y2 += 0.18;
    pdf.text(`Cap Rate: ${formatPercent(results.capRate)}`, col2, y2); y2 += 0.18;
    pdf.text(`Value: ${formatFullCurrency(results.value)}`, col2, y2); y2 += 0.3;
    
    const maxY = Math.max(y, y2) + 0.3;
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('LOT SCHEDULE', 0.5, maxY);
    pdf.setFontSize(8); pdf.setFont('helvetica', 'bold');
    const headers = ['#', 'Type', 'Width', 'Depth', 'Area', 'NRSF', 'Price', 'Conf.'];
    const colWidths = [0.3, 0.8, 0.5, 0.5, 0.7, 0.7, 0.8, 0.4];
    let tx = 0.5;
    const headerY = maxY + 0.25;
    headers.forEach((h, i) => { pdf.text(h, tx, headerY); tx += colWidths[i]; });
    
    pdf.setFont('helvetica', 'normal');
    let ly = headerY + 0.18;
    results.lots.slice(0, 30).forEach(lot => {
      tx = 0.5;
      [String(lot.id), lot.parcelTypeName, lot.lotWidthFt.toFixed(0)+"'", lot.lotDepthFt.toFixed(0)+"'",
       formatNumber(lot.areaFt2)+' sf', formatNumber(lot.nrsf)+' sf',
       '$'+lot.pricePerLot.toLocaleString(), lot.conforming?'Yes':'No'
      ].forEach((v, i) => { pdf.text(v, tx, ly); tx += colWidths[i]; });
      ly += 0.15;
      if (ly > 7.8) return;
    });
    
    pdf.setFontSize(7); pdf.setTextColor(128);
    pdf.text('Generated by Subdivide — Preliminary feasibility only. Not for permitting, engineering, or construction use.', 0.5, 8.0);
    pdf.save(`${lat.toFixed(4)}_${lon.toFixed(4)}_feasibility.pdf`);
  }, [results, lat, lon, widthFt, depthFt]);
  
  const downloadAll = useCallback(async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const prefix = `${lat.toFixed(4)}_${lon.toFixed(4)}`;
    zip.file(`${prefix}_lots.csv`, generateCSV(results));
    zip.file(`${prefix}_subdivision.dxf`, generateDXF(results, widthFt, depthFt));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${prefix}_subdivision_package.zip`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }, [results, lat, lon, widthFt, depthFt]);
  
  const activeType = parcelTypes[activeParcelTab] || parcelTypes[0];
  
  return (
    <div className="app-layout">
      {/* Header */}
      <header className="app-header">
        <div className="logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
          Subdivide
        </div>
        <span className="tagline">Single-Family Subdivision Feasibility</span>
        <div className="header-right">
          <div className="street-toggle" style={{ width: 'auto', minWidth: 200 }}>
            {Object.keys(MAP_STYLES).map(s => (
              <button key={s} className={`street-toggle-btn ${mapStyle === s ? 'active' : ''}`}
                onClick={() => setMapStyle(s)}
                style={{ textTransform: 'capitalize', fontSize: 10 }}
              >{STYLE_LABELS[s]}</button>
            ))}
          </div>
          <span style={{ fontSize: 11, color: 'var(--color-text-faint)' }}>v1.0</span>
        </div>
      </header>
      
      {/* Body */}
      <div className="app-body">
        {/* Left Panel */}
        <aside className="left-panel">
          {/* Location */}
          <div className="panel-section">
            <div className="panel-section-header" style={{ cursor: 'default' }}>
              <span className="panel-section-title">Location</span>
            </div>
            <div className="address-row" style={{ marginBottom: 8 }}>
              <input className="form-input" value={addressInput}
                onChange={e => setAddressInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLocationSubmit()}
                placeholder="Lat, Lon or address" />
              <button className="btn btn-primary" onClick={handleLocationSubmit}>Go</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-faint)' }}>
              {lat.toFixed(6)}, {lon.toFixed(6)}
            </div>
          </div>
          
          {/* Site Dimensions */}
          <div className="panel-section">
            <div className="panel-section-header" style={{ cursor: 'default' }}>
              <span className="panel-section-title">Site Dimensions</span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 8, lineHeight: 1.4 }}>
              Drag the corner handles on the map to resize, or type values below.
            </p>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Width (ft)</label>
                <input className="form-input" type="number" value={widthFt}
                  onChange={e => setWidthFt(Math.max(50, Number(e.target.value) || 0))} />
              </div>
              <div className="form-group">
                <label className="form-label">Depth (ft)</label>
                <input className="form-input" type="number" value={depthFt}
                  onChange={e => setDepthFt(Math.max(50, Number(e.target.value) || 0))} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Street Side</label>
              <div className="street-toggle">
                {['N', 'S', 'E', 'W'].map(dir => (
                  <button key={dir} className={`street-toggle-btn ${streetSide === dir ? 'active' : ''}`}
                    onClick={() => setStreetSide(dir)}>{dir}</button>
                ))}
              </div>
            </div>
          </div>
          
          {/* Parcel Types */}
          <div className="panel-section">
            <div className="panel-section-header" style={{ cursor: 'default' }}>
              <span className="panel-section-title">Parcel Types</span>
            </div>
            <div className="parcel-tabs">
              {parcelTypes.map((pt, i) => (
                <button key={pt.id} className={`parcel-tab ${i === activeParcelTab ? 'active' : ''}`}
                  onClick={() => setActiveParcelTab(i)}>
                  <span className="tab-dot" style={{ background: pt.color }} />{pt.name}
                </button>
              ))}
            </div>
            {activeType && (
              <div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Name</label>
                    <input className="form-input form-input-sm" value={activeType.name}
                      onChange={e => updateParcelType(activeParcelTab, 'name', e.target.value)} />
                  </div>
                  <div className="form-group" style={{ maxWidth: 70 }}>
                    <label className="form-label">Weight</label>
                    <input className="form-input form-input-sm" type="number" value={activeType.weight}
                      onChange={e => updateParcelType(activeParcelTab, 'weight', Math.max(0, Number(e.target.value) || 0))} />
                  </div>
                  <div className="form-group" style={{ maxWidth: 50 }}>
                    <label className="form-label">Color</label>
                    <input type="color" value={activeType.color}
                      onChange={e => updateParcelType(activeParcelTab, 'color', e.target.value)}
                      style={{ width: '100%', height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Lot Width (ft)</label>
                    <input className="form-input form-input-sm" type="number" value={activeType.lotWidthFt}
                      onChange={e => updateParcelType(activeParcelTab, 'lotWidthFt', Number(e.target.value) || 0)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Lot Depth (ft)</label>
                    <input className="form-input form-input-sm" type="number" value={activeType.lotDepthFt}
                      onChange={e => updateParcelType(activeParcelTab, 'lotDepthFt', Number(e.target.value) || 0)} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Home Width (ft)</label>
                    <input className="form-input form-input-sm" type="number" value={activeType.homeWidthFt}
                      onChange={e => updateParcelType(activeParcelTab, 'homeWidthFt', Number(e.target.value) || 0)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Home Depth (ft)</label>
                    <input className="form-input form-input-sm" type="number" value={activeType.homeDepthFt}
                      onChange={e => updateParcelType(activeParcelTab, 'homeDepthFt', Number(e.target.value) || 0)} />
                  </div>
                  <div className="form-group" style={{ maxWidth: 70 }}>
                    <label className="form-label">Levels</label>
                    <input className="form-input form-input-sm" type="number" value={activeType.unitLevels}
                      onChange={e => updateParcelType(activeParcelTab, 'unitLevels', Math.max(1, Number(e.target.value) || 1))} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Front Setback</label>
                    <input className="form-input form-input-sm" type="number" value={activeType.setbackFront}
                      onChange={e => updateParcelType(activeParcelTab, 'setbackFront', Number(e.target.value) || 0)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Side Setback</label>
                    <input className="form-input form-input-sm" type="number" value={activeType.setbackSide}
                      onChange={e => updateParcelType(activeParcelTab, 'setbackSide', Number(e.target.value) || 0)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Back Setback</label>
                    <input className="form-input form-input-sm" type="number" value={activeType.setbackBack}
                      onChange={e => updateParcelType(activeParcelTab, 'setbackBack', Number(e.target.value) || 0)} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Price Per Lot ($)</label>
                  <input className="form-input form-input-sm" type="number" value={activeType.pricePerLot}
                    onChange={e => updateParcelType(activeParcelTab, 'pricePerLot', Number(e.target.value) || 0)} />
                </div>
              </div>
            )}
            <div className="parcel-add-remove">
              {parcelTypes.length < 3 && (
                <button className="btn btn-ghost btn-sm" onClick={addParcelType}>+ Add Type</button>
              )}
              {parcelTypes.length > 1 && (
                <button className="btn btn-ghost btn-sm" onClick={() => removeParcelType(activeParcelTab)}
                  style={{ color: 'var(--color-error)' }}>Remove</button>
              )}
            </div>
          </div>
          
          {/* Road */}
          <div className="panel-section">
            <div className="panel-section-header" style={{ cursor: 'default' }}>
              <span className="panel-section-title">Road</span>
            </div>
            <div className="form-group">
              <label className="form-label">Road Width (ft)</label>
              <input className="form-input" type="number" value={roadWidthFt}
                onChange={e => setRoadWidthFt(Math.max(10, Number(e.target.value) || 0))} />
            </div>
          </div>
          
          {/* Financials */}
          <div className="panel-section">
            <div className="panel-section-header" onClick={() => setFinancialsCollapsed(!financialsCollapsed)}>
              <span className="panel-section-title">Financials</span>
              <span className={`panel-section-toggle ${financialsCollapsed ? 'collapsed' : ''}`}>▼</span>
            </div>
            {!financialsCollapsed && (
              <div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Land Cost ($)</label>
                  <input className="form-input form-input-sm" type="number" value={financials.landCost}
                    onChange={e => updateFinancial('landCost', Number(e.target.value) || 0)} />
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Infrastructure Cost / LF Road ($)</label>
                  <input className="form-input form-input-sm" type="number" value={financials.infraCostPerLF}
                    onChange={e => updateFinancial('infraCostPerLF', Number(e.target.value) || 0)} />
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Lot Dev Cost / Lot ($)</label>
                  <input className="form-input form-input-sm" type="number" value={financials.lotDevCostPerLot}
                    onChange={e => updateFinancial('lotDevCostPerLot', Number(e.target.value) || 0)} />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Soft Cost %</label>
                    <input className="form-input form-input-sm" type="number" value={financials.softCostPct}
                      onChange={e => updateFinancial('softCostPct', Number(e.target.value) || 0)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Cap Rate %</label>
                    <input className="form-input form-input-sm" type="number" step="0.25" value={financials.capRate}
                      onChange={e => updateFinancial('capRate', Number(e.target.value) || 0)} />
                  </div>
                </div>
              </div>
            )}
          </div>
          
          {/* Export */}
          <div className="panel-section">
            <div className="panel-section-header" style={{ cursor: 'default' }}>
              <span className="panel-section-title">Export</span>
            </div>
            <div className="export-section">
              <button className="btn btn-ghost btn-sm" onClick={downloadCSV} disabled={results.totalLots===0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                CSV
              </button>
              <button className="btn btn-ghost btn-sm" onClick={downloadDXF} disabled={results.totalLots===0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                DXF
              </button>
              <button className="btn btn-ghost btn-sm" onClick={downloadPDF} disabled={results.totalLots===0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                PDF
              </button>
              <button className="btn btn-accent btn-sm" onClick={downloadAll} disabled={results.totalLots===0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                All .zip
              </button>
            </div>
          </div>
        </aside>
        
        {/* Right Content */}
        <div className="right-content">
          <div className="map-container" style={{ position: 'relative' }}>
            <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
            {/* Canvas overlay renders all subdivision geometry */}
            <CanvasOverlay
              map={mapInstance}
              results={results}
              originLat={originLat}
              originLon={originLon}
              widthFt={widthFt}
              depthFt={depthFt}
            />
            <div className="dimension-overlay">
              <strong>{widthFt}ft × {depthFt}ft</strong>{' '}
              <span>({(widthFt * depthFt / 43560).toFixed(2)} acres)</span>
            </div>
            <div className="map-info">
              {results.conformingLots} lots · {results.numRoads} road{results.numRoads !== 1 ? 's' : ''} · {(widthFt * depthFt).toLocaleString()} sq ft
            </div>
          </div>
          
          {/* Stats Panel */}
          <div className="stats-panel">
            {results.nonConformingCount > 0 && (
              <div className="warning-banner" style={{ marginBottom: 10 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                {results.nonConformingCount} lot{results.nonConformingCount !== 1 ? 's' : ''} flagged as non-conforming — excluded from totals
              </div>
            )}
            <div className="stats-grid">
              <div className="stats-section">
                <div className="stats-section-title">Subdivisions</div>
                <div className="stat-row"><span className="stat-label">Parcels</span><span className="stat-value">{results.conformingLots}</span></div>
                <div className="stat-row"><span className="stat-label">Units</span><span className="stat-value">{results.conformingLots}</span></div>
                <div className="stat-row"><span className="stat-label">NRSF</span><span className="stat-value">{formatNumber(results.totalNRSF)}</span></div>
              </div>
              <div className="stats-section">
                <div className="stats-section-title">Housing Drive Aisle</div>
                <div className="stat-row"><span className="stat-label">Area Road</span><span className="stat-value">{formatNumber(results.roadAreaFt2)}</span></div>
                <div className="stat-row"><span className="stat-label">Linear Road</span><span className="stat-value">{formatNumber(results.roadLinearFt)}</span></div>
              </div>
              <div className="stats-section">
                <div className="stats-section-title">Summary</div>
                <div className="stat-row"><span className="stat-label">Revenue</span><span className="stat-value success">{formatCurrency(results.revenue)}</span></div>
                <div className="stat-row"><span className="stat-label">Expenses</span><span className="stat-value error">{formatCurrency(results.expenses)}</span></div>
                <div className="stat-row"><span className="stat-label">NOI</span><span className="stat-value highlight">{formatCurrency(results.noi)}</span></div>
              </div>
              <div className="stats-section">
                <div className="stats-section-title">Costs</div>
                <div className="stat-row"><span className="stat-label">Land</span><span className="stat-value">{formatCurrency(results.landCosts)}</span></div>
                <div className="stat-row"><span className="stat-label">Hard</span><span className="stat-value">{formatCurrency(results.hardCosts)}</span></div>
                <div className="stat-row"><span className="stat-label">Soft</span><span className="stat-value">{formatCurrency(results.softCosts)}</span></div>
                <div className="stat-row"><span className="stat-label">Earthwork</span><span className="stat-value" style={{ color: 'var(--color-text-faint)' }}>$0</span></div>
                <div className="stat-row"><span className="stat-label">Total</span><span className="stat-value">{formatCurrency(results.totalCosts)}</span></div>
              </div>
              <div className="stats-section">
                <div className="stats-section-title">Metrics</div>
                <div className="stat-row"><span className="stat-label">Yield on Cost</span>
                  <span className={`stat-value ${results.yieldOnCost > 0 ? 'success' : 'error'}`}>{formatPercent(results.yieldOnCost)}</span></div>
                <div className="stat-row"><span className="stat-label">Cap Rate</span><span className="stat-value">{formatPercent(results.capRate)}</span></div>
                <div className="stat-row"><span className="stat-label">Value</span><span className="stat-value accent">{formatFullCurrency(results.value)}</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {/* Footer */}
      <footer className="app-footer">
        <span>Generated by Subdivide — preliminary feasibility only, not for construction</span>
        <span>·</span>
        <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">
          Created with Perplexity Computer
        </a>
      </footer>
    </div>
  );
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
