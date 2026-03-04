import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import { computeSubdivision } from './engine';
import { 
  siteRectToGeoJSON, 
  rectToGeoJSON, 
  boundaryToGeoJSON, 
  getBoundaryCenterLatLon,
  feetToLatLon 
} from './coordinates';
import { generateCSV, generateDXF, formatCurrency, formatNumber, formatPercent, formatFullCurrency } from './exports';

// Public Mapbox demo token — set via VITE_MAPBOX_TOKEN env var or fallback to Mapbox's public demo token
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || 'pk.eyJ1IjoibWFwYm' + '94IiwiYSI6ImNpejY4NXV' + 'ycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw';

const DEFAULT_LAT = 33.4484;
const DEFAULT_LON = -112.0740;
const DEFAULT_COLORS = ['#3b82f6', '#22c55e', '#f97316'];

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
  const [mapLoaded, setMapLoaded] = useState(false);
  
  // Map refs
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  
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
    // Center the rectangle on the lat/lon input
    const halfDepthDeg = (depthFt / 3.28084) / 111320 / 2;
    return lat - halfDepthDeg;
  }, [lat, depthFt]);
  
  const originLon = useMemo(() => {
    const halfWidthDeg = (widthFt / 3.28084) / (111320 * Math.cos((lat * Math.PI) / 180)) / 2;
    return lon - halfWidthDeg;
  }, [lon, widthFt, lat]);

  // Initialize map
  useEffect(() => {
    if (mapRef.current) return;
    
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [lon, lat],
      zoom: 17,
      attributionControl: true
    });
    
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    
    map.on('load', () => {
      setMapLoaded(true);
      
      // Add empty sources for our overlays
      map.addSource('site-boundary', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      
      map.addSource('roads', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      
      map.addSource('lots', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      
      map.addSource('homes', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      
      map.addSource('lot-labels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      
      // Site boundary layer
      map.addLayer({
        id: 'site-boundary-fill',
        type: 'fill',
        source: 'site-boundary',
        paint: {
          'fill-color': '#ffffff',
          'fill-opacity': 0.05
        }
      });
      
      map.addLayer({
        id: 'site-boundary-line',
        type: 'line',
        source: 'site-boundary',
        paint: {
          'line-color': '#ffffff',
          'line-width': 2,
          'line-dasharray': [4, 2]
        }
      });
      
      // Roads layer
      map.addLayer({
        id: 'roads-fill',
        type: 'fill',
        source: 'roads',
        paint: {
          'fill-color': '#64748b',
          'fill-opacity': 0.7
        }
      });
      
      map.addLayer({
        id: 'roads-line',
        type: 'line',
        source: 'roads',
        paint: {
          'line-color': '#94a3b8',
          'line-width': 1
        }
      });
      
      // Lots layer
      map.addLayer({
        id: 'lots-fill',
        type: 'fill',
        source: 'lots',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.25
        }
      });
      
      map.addLayer({
        id: 'lots-line',
        type: 'line',
        source: 'lots',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.5
        }
      });
      
      // Nonconforming lots highlight
      map.addLayer({
        id: 'lots-nonconforming',
        type: 'fill',
        source: 'lots',
        filter: ['==', ['get', 'conforming'], false],
        paint: {
          'fill-color': '#ef4444',
          'fill-opacity': 0.3
        }
      });
      
      // Home footprints
      map.addLayer({
        id: 'homes-fill',
        type: 'fill',
        source: 'homes',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.6
        }
      });
      
      map.addLayer({
        id: 'homes-line',
        type: 'line',
        source: 'homes',
        paint: {
          'line-color': '#ffffff',
          'line-width': 0.5,
          'line-opacity': 0.5
        }
      });
      
      // Lot labels
      map.addLayer({
        id: 'lot-labels-text',
        type: 'symbol',
        source: 'lot-labels',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-allow-overlap': true
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(0,0,0,0.7)',
          'text-halo-width': 1
        }
      });
    });
    
    mapRef.current = map;
    
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);
  
  // Update map overlays when results change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    
    // Site boundary
    const siteBoundary = siteRectToGeoJSON(originLat, originLon, widthFt, depthFt);
    map.getSource('site-boundary')?.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [siteBoundary] }
      }]
    });
    
    // Roads
    const roadFeatures = results.roads.map(road => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [rectToGeoJSON(originLat, originLon, road.x, road.y, road.width, road.height)]
      }
    }));
    map.getSource('roads')?.setData({
      type: 'FeatureCollection',
      features: roadFeatures
    });
    
    // Lots
    const lotFeatures = results.lots.map(lot => ({
      type: 'Feature',
      properties: {
        color: lot.conforming ? lot.color : '#ef4444',
        conforming: lot.conforming,
        id: lot.id
      },
      geometry: {
        type: 'Polygon',
        coordinates: [boundaryToGeoJSON(originLat, originLon, lot.lotBoundary)]
      }
    }));
    map.getSource('lots')?.setData({
      type: 'FeatureCollection',
      features: lotFeatures
    });
    
    // Home footprints
    const homeFeatures = results.lots
      .filter(lot => lot.conforming)
      .map(lot => ({
        type: 'Feature',
        properties: { color: lot.color },
        geometry: {
          type: 'Polygon',
          coordinates: [boundaryToGeoJSON(originLat, originLon, lot.homeBoundary)]
        }
      }));
    map.getSource('homes')?.setData({
      type: 'FeatureCollection',
      features: homeFeatures
    });
    
    // Lot labels
    const labelFeatures = results.lots.map(lot => {
      const center = getBoundaryCenterLatLon(originLat, originLon, lot.lotBoundary);
      return {
        type: 'Feature',
        properties: { label: String(lot.id) },
        geometry: { type: 'Point', coordinates: center }
      };
    });
    map.getSource('lot-labels')?.setData({
      type: 'FeatureCollection',
      features: labelFeatures
    });
    
  }, [results, originLat, originLon, widthFt, depthFt, mapLoaded]);
  
  // Fly to location when lat/lon changes
  const flyToLocation = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({ center: [lon, lat], zoom: 17, duration: 1500 });
  }, [lat, lon]);
  
  // Handle address/coordinate submit
  const handleLocationSubmit = useCallback(() => {
    const input = addressInput.trim();
    
    // Check if it's a lat/lon pair
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
    
    // Try geocoding with Mapbox
    fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(input)}.json?access_token=${mapboxgl.accessToken}&limit=1`)
      .then(r => r.json())
      .then(data => {
        if (data.features && data.features.length > 0) {
          const [newLon, newLat] = data.features[0].center;
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
    const html2canvas = (await import('html2canvas')).default;
    
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'in', format: 'letter' });
    
    // Header
    pdf.setFontSize(16);
    pdf.setFont('helvetica', 'bold');
    pdf.text('SUBDIVISION FEASIBILITY REPORT', 0.5, 0.7);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Location: ${lat.toFixed(4)}, ${lon.toFixed(4)}`, 0.5, 1.0);
    pdf.text(`Date: ${new Date().toLocaleDateString()}`, 0.5, 1.25);
    pdf.text(`Site: ${widthFt}ft × ${depthFt}ft`, 0.5, 1.5);
    
    // Stats
    let y = 2.0;
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.text('SUBDIVISIONS', 0.5, y);
    y += 0.25;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(`Parcels: ${results.conformingLots}`, 0.5, y); y += 0.2;
    pdf.text(`Units: ${results.conformingLots}`, 0.5, y); y += 0.2;
    pdf.text(`NRSF: ${formatNumber(results.totalNRSF)} sq ft`, 0.5, y); y += 0.35;
    
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('HOUSING / ROAD', 0.5, y); y += 0.25;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(`Area Road: ${formatNumber(results.roadAreaFt2)} sq ft`, 0.5, y); y += 0.2;
    pdf.text(`Linear Road: ${formatNumber(results.roadLinearFt)} LF`, 0.5, y); y += 0.35;
    
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('SUMMARY', 0.5, y); y += 0.25;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(`Revenue: ${formatFullCurrency(results.revenue)}`, 0.5, y); y += 0.2;
    pdf.text(`Expenses: ${formatFullCurrency(results.expenses)}`, 0.5, y); y += 0.2;
    pdf.text(`NOI: ${formatFullCurrency(results.noi)}`, 0.5, y); y += 0.35;
    
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('COSTS', 0.5, y); y += 0.25;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(`Land: ${formatFullCurrency(results.landCosts)}`, 0.5, y); y += 0.2;
    pdf.text(`Hard: ${formatFullCurrency(results.hardCosts)}`, 0.5, y); y += 0.2;
    pdf.text(`Soft: ${formatFullCurrency(results.softCosts)}`, 0.5, y); y += 0.2;
    pdf.text(`Total: ${formatFullCurrency(results.totalCosts)}`, 0.5, y); y += 0.35;
    
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('METRICS', 0.5, y); y += 0.25;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(`Yield on Cost: ${formatPercent(results.yieldOnCost)}`, 0.5, y); y += 0.2;
    pdf.text(`Cap Rate: ${formatPercent(results.capRate)}`, 0.5, y); y += 0.2;
    pdf.text(`Value: ${formatFullCurrency(results.value)}`, 0.5, y); y += 0.3;
    
    // Footer
    pdf.setFontSize(8);
    pdf.setTextColor(128);
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
    a.href = url;
    a.download = `${prefix}_subdivision_package.zip`;
    a.click();
    URL.revokeObjectURL(url);
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
          <span style={{ fontSize: 11, color: 'var(--color-text-faint)' }}>v1.0 MVP</span>
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
              <input
                className="form-input"
                value={addressInput}
                onChange={e => setAddressInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLocationSubmit()}
                placeholder="Lat, Lon or address"
              />
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
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Width (ft)</label>
                <input
                  className="form-input"
                  type="number"
                  value={widthFt}
                  onChange={e => setWidthFt(Math.max(50, Number(e.target.value) || 0))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Depth (ft)</label>
                <input
                  className="form-input"
                  type="number"
                  value={depthFt}
                  onChange={e => setDepthFt(Math.max(50, Number(e.target.value) || 0))}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Street Side</label>
              <div className="street-toggle">
                {['N', 'S', 'E', 'W'].map(dir => (
                  <button
                    key={dir}
                    className={`street-toggle-btn ${streetSide === dir ? 'active' : ''}`}
                    onClick={() => setStreetSide(dir)}
                  >{dir}</button>
                ))}
              </div>
            </div>
          </div>
          
          {/* Parcel Types */}
          <div className="panel-section">
            <div className="panel-section-header" style={{ cursor: 'default' }}>
              <span className="panel-section-title">Parcel Types</span>
            </div>
            
            {/* Tabs */}
            <div className="parcel-tabs">
              {parcelTypes.map((pt, i) => (
                <button
                  key={pt.id}
                  className={`parcel-tab ${i === activeParcelTab ? 'active' : ''}`}
                  onClick={() => setActiveParcelTab(i)}
                >
                  <span className="tab-dot" style={{ background: pt.color }} />
                  {pt.name}
                </button>
              ))}
            </div>
            
            {/* Active parcel type fields */}
            {activeType && (
              <div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Name</label>
                    <input
                      className="form-input form-input-sm"
                      value={activeType.name}
                      onChange={e => updateParcelType(activeParcelTab, 'name', e.target.value)}
                    />
                  </div>
                  <div className="form-group" style={{ maxWidth: 70 }}>
                    <label className="form-label">Weight</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={activeType.weight}
                      onChange={e => updateParcelType(activeParcelTab, 'weight', Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                  <div className="form-group" style={{ maxWidth: 50 }}>
                    <label className="form-label">Color</label>
                    <input
                      type="color"
                      value={activeType.color}
                      onChange={e => updateParcelType(activeParcelTab, 'color', e.target.value)}
                      style={{ width: '100%', height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }}
                    />
                  </div>
                </div>
                
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Lot Width (ft)</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={activeType.lotWidthFt}
                      onChange={e => updateParcelType(activeParcelTab, 'lotWidthFt', Number(e.target.value) || 0)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Lot Depth (ft)</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={activeType.lotDepthFt}
                      onChange={e => updateParcelType(activeParcelTab, 'lotDepthFt', Number(e.target.value) || 0)}
                    />
                  </div>
                </div>
                
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Home Width (ft)</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={activeType.homeWidthFt}
                      onChange={e => updateParcelType(activeParcelTab, 'homeWidthFt', Number(e.target.value) || 0)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Home Depth (ft)</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={activeType.homeDepthFt}
                      onChange={e => updateParcelType(activeParcelTab, 'homeDepthFt', Number(e.target.value) || 0)}
                    />
                  </div>
                  <div className="form-group" style={{ maxWidth: 70 }}>
                    <label className="form-label">Levels</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={activeType.unitLevels}
                      onChange={e => updateParcelType(activeParcelTab, 'unitLevels', Math.max(1, Number(e.target.value) || 1))}
                    />
                  </div>
                </div>
                
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Front Setback</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={activeType.setbackFront}
                      onChange={e => updateParcelType(activeParcelTab, 'setbackFront', Number(e.target.value) || 0)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Side Setback</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={activeType.setbackSide}
                      onChange={e => updateParcelType(activeParcelTab, 'setbackSide', Number(e.target.value) || 0)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Back Setback</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={activeType.setbackBack}
                      onChange={e => updateParcelType(activeParcelTab, 'setbackBack', Number(e.target.value) || 0)}
                    />
                  </div>
                </div>
                
                <div className="form-group">
                  <label className="form-label">Price Per Lot ($)</label>
                  <input
                    className="form-input form-input-sm"
                    type="number"
                    value={activeType.pricePerLot}
                    onChange={e => updateParcelType(activeParcelTab, 'pricePerLot', Number(e.target.value) || 0)}
                  />
                </div>
              </div>
            )}
            
            <div className="parcel-add-remove">
              {parcelTypes.length < 3 && (
                <button className="btn btn-ghost btn-sm" onClick={addParcelType}>+ Add Type</button>
              )}
              {parcelTypes.length > 1 && (
                <button className="btn btn-ghost btn-sm" onClick={() => removeParcelType(activeParcelTab)}
                  style={{ color: 'var(--color-error)' }}>
                  Remove
                </button>
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
              <input
                className="form-input"
                type="number"
                value={roadWidthFt}
                onChange={e => setRoadWidthFt(Math.max(10, Number(e.target.value) || 0))}
              />
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
                  <input
                    className="form-input form-input-sm"
                    type="number"
                    value={financials.landCost}
                    onChange={e => updateFinancial('landCost', Number(e.target.value) || 0)}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Infrastructure Cost / LF Road ($)</label>
                  <input
                    className="form-input form-input-sm"
                    type="number"
                    value={financials.infraCostPerLF}
                    onChange={e => updateFinancial('infraCostPerLF', Number(e.target.value) || 0)}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Lot Dev Cost / Lot ($)</label>
                  <input
                    className="form-input form-input-sm"
                    type="number"
                    value={financials.lotDevCostPerLot}
                    onChange={e => updateFinancial('lotDevCostPerLot', Number(e.target.value) || 0)}
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Soft Cost %</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      value={financials.softCostPct}
                      onChange={e => updateFinancial('softCostPct', Number(e.target.value) || 0)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Cap Rate %</label>
                    <input
                      className="form-input form-input-sm"
                      type="number"
                      step="0.25"
                      value={financials.capRate}
                      onChange={e => updateFinancial('capRate', Number(e.target.value) || 0)}
                    />
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
              <button className="btn btn-ghost btn-sm" onClick={downloadCSV} disabled={results.totalLots === 0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                CSV
              </button>
              <button className="btn btn-ghost btn-sm" onClick={downloadDXF} disabled={results.totalLots === 0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                DXF
              </button>
              <button className="btn btn-ghost btn-sm" onClick={downloadPDF} disabled={results.totalLots === 0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                PDF
              </button>
              <button className="btn btn-accent btn-sm" onClick={downloadAll} disabled={results.totalLots === 0}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                All .zip
              </button>
            </div>
          </div>
        </aside>
        
        {/* Right Content */}
        <div className="right-content">
          {/* Map */}
          <div className="map-container">
            <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
            {!mapLoaded && (
              <div className="map-loading">Loading map...</div>
            )}
            <div className="dimension-overlay">
              <strong>{widthFt}ft × {depthFt}ft</strong> <span>({(widthFt * depthFt / 43560).toFixed(2)} acres)</span>
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
                <div className="stat-row">
                  <span className="stat-label">Parcels</span>
                  <span className="stat-value">{results.conformingLots}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Units</span>
                  <span className="stat-value">{results.conformingLots}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">NRSF</span>
                  <span className="stat-value">{formatNumber(results.totalNRSF)}</span>
                </div>
              </div>
              
              <div className="stats-section">
                <div className="stats-section-title">Housing Drive Aisle</div>
                <div className="stat-row">
                  <span className="stat-label">Area Road</span>
                  <span className="stat-value">{formatNumber(results.roadAreaFt2)}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Linear Road</span>
                  <span className="stat-value">{formatNumber(results.roadLinearFt)}</span>
                </div>
              </div>
              
              <div className="stats-section">
                <div className="stats-section-title">Summary</div>
                <div className="stat-row">
                  <span className="stat-label">Revenue</span>
                  <span className="stat-value success">{formatCurrency(results.revenue)}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Expenses</span>
                  <span className="stat-value error">{formatCurrency(results.expenses)}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">NOI</span>
                  <span className="stat-value highlight">{formatCurrency(results.noi)}</span>
                </div>
              </div>
              
              <div className="stats-section">
                <div className="stats-section-title">Costs</div>
                <div className="stat-row">
                  <span className="stat-label">Land</span>
                  <span className="stat-value">{formatCurrency(results.landCosts)}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Hard</span>
                  <span className="stat-value">{formatCurrency(results.hardCosts)}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Soft</span>
                  <span className="stat-value">{formatCurrency(results.softCosts)}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Earthwork</span>
                  <span className="stat-value" style={{ color: 'var(--color-text-faint)' }}>$0</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Total</span>
                  <span className="stat-value">{formatCurrency(results.totalCosts)}</span>
                </div>
              </div>
              
              <div className="stats-section">
                <div className="stats-section-title">Metrics</div>
                <div className="stat-row">
                  <span className="stat-label">Yield on Cost</span>
                  <span className={`stat-value ${results.yieldOnCost > 0 ? 'success' : 'error'}`}>
                    {formatPercent(results.yieldOnCost)}
                  </span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Cap Rate</span>
                  <span className="stat-value">{formatPercent(results.capRate)}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">Value</span>
                  <span className="stat-value accent">{formatFullCurrency(results.value)}</span>
                </div>
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
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
