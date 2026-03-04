/**
 * Export utilities: CSV, DXF, PDF, ZIP
 */

/**
 * Generate CSV content from computed lots.
 */
export function generateCSV(results) {
  const headers = [
    'lot_number', 'lot_type', 'lot_width_ft', 'lot_depth_ft', 'lot_area_sqft',
    'home_width_ft', 'home_depth_ft', 'home_footprint_sqft', 'levels', 'nrsf_sqft',
    'buildable_area_sqft', 'setback_front_ft', 'setback_side_ft', 'setback_back_ft',
    'sale_price_usd', 'conforming'
  ];
  
  const rows = results.lots.map(lot => [
    lot.id,
    lot.parcelTypeName,
    lot.lotWidthFt.toFixed(1),
    lot.lotDepthFt.toFixed(1),
    lot.areaFt2.toFixed(1),
    lot.homeWidthFt.toFixed(1),
    lot.homeDepthFt.toFixed(1),
    lot.homeFootprintFt2.toFixed(1),
    lot.unitLevels,
    lot.nrsf.toFixed(1),
    lot.buildableArea.toFixed(1),
    lot.setbackFront.toFixed(1),
    lot.setbackSide.toFixed(1),
    lot.setbackBack.toFixed(1),
    lot.pricePerLot.toFixed(2),
    lot.conforming ? 'Yes' : 'No'
  ]);
  
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

/**
 * Generate DXF content using dxf-writer library.
 */
export function generateDXF(results, siteWidthFt, siteDepthFt) {
  // We'll use the dxf-writer library (Drawing class)
  // Imported dynamically to keep this module clean
  let dxfContent = '';
  
  try {
    const Drawing = window.__DxfDrawing;
    if (!Drawing) {
      return generateDXFManual(results, siteWidthFt, siteDepthFt);
    }
    
    const d = new Drawing();
    d.setUnits('Feet');
    
    // Add layers
    d.addLayer('SITE_BOUNDARY', Drawing.ACI.WHITE, 'CONTINUOUS');
    d.addLayer('ROADS', Drawing.ACI.WHITE, 'CONTINUOUS'); // gray not available, use white
    d.addLayer('LOT_LINES', Drawing.ACI.YELLOW, 'CONTINUOUS');
    d.addLayer('HOME_FOOTPRINTS', Drawing.ACI.CYAN, 'CONTINUOUS');
    d.addLayer('LOT_NUMBERS', Drawing.ACI.GREEN, 'CONTINUOUS');
    d.addLayer('SETBACK_LINES', Drawing.ACI.MAGENTA, 'DASHED');
    
    // Site boundary
    d.setActiveLayer('SITE_BOUNDARY');
    d.drawPolyline([
      [0, 0], [siteWidthFt, 0], [siteWidthFt, siteDepthFt], [0, siteDepthFt], [0, 0]
    ]);
    
    // Roads
    d.setActiveLayer('ROADS');
    for (const road of results.roads) {
      d.drawPolyline([
        [road.x, road.y],
        [road.x + road.width, road.y],
        [road.x + road.width, road.y + road.height],
        [road.x, road.y + road.height],
        [road.x, road.y]
      ]);
    }
    
    // Lots
    d.setActiveLayer('LOT_LINES');
    for (const lot of results.lots) {
      const b = lot.lotBoundary;
      d.drawPolyline([...b.map(p => [p[0], p[1]]), [b[0][0], b[0][1]]]);
    }
    
    // Home footprints
    d.setActiveLayer('HOME_FOOTPRINTS');
    for (const lot of results.lots) {
      if (lot.conforming) {
        const b = lot.homeBoundary;
        d.drawPolyline([...b.map(p => [p[0], p[1]]), [b[0][0], b[0][1]]]);
      }
    }
    
    // Lot numbers
    d.setActiveLayer('LOT_NUMBERS');
    for (const lot of results.lots) {
      const cx = (lot.lotBoundary[0][0] + lot.lotBoundary[1][0]) / 2;
      const cy = (lot.lotBoundary[0][1] + lot.lotBoundary[2][1]) / 2;
      d.drawText(cx, cy, 8, 0, String(lot.id));
    }
    
    // Setback lines
    d.setActiveLayer('SETBACK_LINES');
    for (const lot of results.lots) {
      const [x, y] = lot.lotBoundary[0];
      const w = lot.lotWidthFt;
      const h = lot.lotDepthFt;
      const sf = lot.setbackFront;
      const ss = lot.setbackSide;
      const sb = lot.setbackBack;
      
      d.drawPolyline([
        [x + ss, y + sf],
        [x + w - ss, y + sf],
        [x + w - ss, y + h - sb],
        [x + ss, y + h - sb],
        [x + ss, y + sf]
      ]);
    }
    
    return d.toDxfString();
  } catch (e) {
    console.warn('DXF generation with library failed, using manual:', e);
    return generateDXFManual(results, siteWidthFt, siteDepthFt);
  }
}

/**
 * Manual DXF generation fallback (AC1015 format).
 */
function generateDXFManual(results, siteWidthFt, siteDepthFt) {
  let dxf = '';
  dxf += '0\nSECTION\n2\nHEADER\n';
  dxf += '9\n$ACADVER\n1\nAC1015\n';
  dxf += '9\n$INSUNITS\n70\n2\n'; // feet
  dxf += '0\nENDSEC\n';
  
  // Tables section with layers
  dxf += '0\nSECTION\n2\nTABLES\n';
  dxf += '0\nTABLE\n2\nLAYER\n70\n6\n';
  
  const layers = [
    { name: 'SITE_BOUNDARY', color: 7 },
    { name: 'ROADS', color: 8 },
    { name: 'LOT_LINES', color: 2 },
    { name: 'HOME_FOOTPRINTS', color: 4 },
    { name: 'LOT_NUMBERS', color: 3 },
    { name: 'SETBACK_LINES', color: 6 }
  ];
  
  for (const layer of layers) {
    dxf += `0\nLAYER\n2\n${layer.name}\n70\n0\n62\n${layer.color}\n6\nCONTINUOUS\n`;
  }
  dxf += '0\nENDTAB\n';
  dxf += '0\nENDSEC\n';
  
  // Entities
  dxf += '0\nSECTION\n2\nENTITIES\n';
  
  // Helper to draw a closed polyline
  function polyline(layer, points) {
    dxf += `0\nLWPOLYLINE\n8\n${layer}\n90\n${points.length}\n70\n1\n`;
    for (const [x, y] of points) {
      dxf += `10\n${x.toFixed(4)}\n20\n${y.toFixed(4)}\n`;
    }
  }
  
  // Site boundary
  polyline('SITE_BOUNDARY', [[0, 0], [siteWidthFt, 0], [siteWidthFt, siteDepthFt], [0, siteDepthFt]]);
  
  // Roads
  for (const road of results.roads) {
    polyline('ROADS', [
      [road.x, road.y],
      [road.x + road.width, road.y],
      [road.x + road.width, road.y + road.height],
      [road.x, road.y + road.height]
    ]);
  }
  
  // Lot lines
  for (const lot of results.lots) {
    polyline('LOT_LINES', lot.lotBoundary);
  }
  
  // Home footprints
  for (const lot of results.lots) {
    if (lot.conforming) {
      polyline('HOME_FOOTPRINTS', lot.homeBoundary);
    }
  }
  
  // Lot numbers as TEXT
  for (const lot of results.lots) {
    const cx = (lot.lotBoundary[0][0] + lot.lotBoundary[1][0]) / 2;
    const cy = (lot.lotBoundary[0][1] + lot.lotBoundary[2][1]) / 2;
    dxf += `0\nTEXT\n8\nLOT_NUMBERS\n10\n${cx.toFixed(4)}\n20\n${cy.toFixed(4)}\n40\n8\n1\n${lot.id}\n72\n1\n73\n2\n11\n${cx.toFixed(4)}\n21\n${cy.toFixed(4)}\n`;
  }
  
  // Setback lines
  for (const lot of results.lots) {
    const [x, y] = lot.lotBoundary[0];
    const w = lot.lotWidthFt;
    const h = lot.lotDepthFt;
    polyline('SETBACK_LINES', [
      [x + lot.setbackSide, y + lot.setbackFront],
      [x + w - lot.setbackSide, y + lot.setbackFront],
      [x + w - lot.setbackSide, y + h - lot.setbackBack],
      [x + lot.setbackSide, y + h - lot.setbackBack]
    ]);
  }
  
  dxf += '0\nENDSEC\n';
  dxf += '0\nEOF\n';
  
  return dxf;
}

/**
 * Format a number as currency.
 */
export function formatCurrency(n) {
  if (Math.abs(n) >= 1e6) {
    return '$' + (n / 1e6).toFixed(1) + 'M';
  }
  if (Math.abs(n) >= 1e3) {
    return '$' + (n / 1e3).toFixed(0) + 'K';
  }
  return '$' + n.toFixed(0);
}

export function formatNumber(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function formatPercent(n) {
  return n.toFixed(2) + '%';
}

export function formatFullCurrency(n) {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
