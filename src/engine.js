/**
 * Subdivision Engine — Core layout algorithm
 * All calculations in feet, origin at bottom-left of site rectangle.
 */

/**
 * Build a repeating type sequence from weights.
 * E.g. weights [50, 30, 20] → indices [0,0,1,0,1,0,0,1,0,2] repeating pattern
 */
function buildTypeSequence(parcelTypes) {
  if (parcelTypes.length === 0) return [];
  if (parcelTypes.length === 1) return [0];
  
  const totalWeight = parcelTypes.reduce((s, t) => s + t.weight, 0);
  if (totalWeight === 0) return [0];
  
  const sequence = [];
  const counts = parcelTypes.map(t => Math.max(1, Math.round((t.weight / totalWeight) * 10)));
  
  for (let i = 0; i < parcelTypes.length; i++) {
    for (let j = 0; j < counts[i]; j++) {
      sequence.push(i);
    }
  }
  return sequence;
}

/**
 * Pack lots into a single row.
 * @param {number} rowStartX - left edge of row (in feet)
 * @param {number} rowEndX - right edge of row (in feet)
 * @param {number} rowY - bottom edge of row (in feet from site origin)
 * @param {number} rowDepth - available depth for this row (in feet)
 * @param {Array} parcelTypes - array of parcel type configs
 * @param {Array} typeSequence - repeating index sequence
 * @param {number} startingLotNum - lot numbering start
 * @param {number} rowIndex - which row (for metadata)
 * @param {boolean} frontFacesRoad - if true, front setback faces road side
 * @returns {Array} array of ComputedLot objects
 */
function packRow(rowStartX, rowEndX, rowY, rowDepth, parcelTypes, typeSequence, startingLotNum, rowIndex, frontFacesRoad) {
  const lots = [];
  let x = rowStartX;
  let seqIndex = 0;
  let lotNum = startingLotNum;
  const availableWidth = rowEndX - rowStartX;
  
  if (availableWidth <= 0 || rowDepth <= 0 || parcelTypes.length === 0) return lots;
  
  while (x < rowEndX - 1) { // -1 for floating point tolerance
    const typeIdx = typeSequence[seqIndex % typeSequence.length];
    const type = parcelTypes[typeIdx];
    const lotWidth = type.lotWidthFt;
    const lotDepth = Math.min(type.lotDepthFt, rowDepth);
    
    if (x + lotWidth > rowEndX + 0.5) break; // can't fit this lot
    
    // Lot boundary
    const lotBoundary = [
      [x, rowY],
      [x + lotWidth, rowY],
      [x + lotWidth, rowY + lotDepth],
      [x, rowY + lotDepth]
    ];
    
    // Home footprint with setbacks
    const homeX = x + type.setbackSide;
    const homeY = frontFacesRoad ? rowY + type.setbackFront : rowY + type.setbackBack;
    const availableHomeWidth = lotWidth - type.setbackSide * 2;
    const availableHomeDepth = lotDepth - type.setbackFront - type.setbackBack;
    
    const homeWidth = Math.min(type.homeWidthFt, availableHomeWidth);
    const homeDepth = Math.min(type.homeDepthFt, availableHomeDepth);
    
    const conforming = homeWidth >= type.homeWidthFt && homeDepth >= type.homeDepthFt;
    
    const homeBoundary = [
      [homeX, homeY],
      [homeX + homeWidth, homeY],
      [homeX + homeWidth, homeY + homeDepth],
      [homeX, homeY + homeDepth]
    ];
    
    const lotArea = lotWidth * lotDepth;
    const homeFootprint = type.homeWidthFt * type.homeDepthFt;
    const nrsf = conforming ? homeFootprint * type.unitLevels : 0;
    const buildableArea = availableHomeWidth * availableHomeDepth;
    
    lots.push({
      id: lotNum,
      parcelTypeId: type.id,
      parcelTypeName: type.name,
      lotBoundary,
      homeBoundary,
      lotWidthFt: lotWidth,
      lotDepthFt: lotDepth,
      areaFt2: lotArea,
      homeWidthFt: type.homeWidthFt,
      homeDepthFt: type.homeDepthFt,
      homeFootprintFt2: homeFootprint,
      unitLevels: type.unitLevels,
      nrsf,
      buildableArea,
      conforming,
      row: rowIndex,
      position: lots.length,
      color: type.color,
      setbackFront: type.setbackFront,
      setbackSide: type.setbackSide,
      setbackBack: type.setbackBack,
      pricePerLot: type.pricePerLot
    });
    
    x += lotWidth;
    seqIndex++;
    lotNum++;
  }
  
  return lots;
}

/**
 * Main subdivision computation.
 * @param {object} site - { widthFt, depthFt, roadWidthFt, parcelTypes[], financials }
 * @returns {object} ComputedResults
 */
export function computeSubdivision(site) {
  const { widthFt, depthFt, roadWidthFt, parcelTypes, financials } = site;
  
  if (!parcelTypes || parcelTypes.length === 0 || widthFt <= 0 || depthFt <= 0) {
    return emptyResults();
  }
  
  const typeSequence = buildTypeSequence(parcelTypes);
  if (typeSequence.length === 0) return emptyResults();
  
  // Determine the shallowest lot depth to check feasibility
  const minLotDepth = Math.min(...parcelTypes.map(t => t.lotDepthFt));
  const maxLotDepth = Math.max(...parcelTypes.map(t => t.lotDepthFt));
  
  // Smart road count: pick the layout that yields the most conforming lots.
  // Two roads only make sense if the depth is enough for 3 rows of lots + 2 roads.
  // Required for 2 roads: minLotDepth * 3 + roadWidthFt * 2 (absolute minimum)
  // We try both layouts and pick the one with more conforming lots.
  
  function computeLayout(nRoads) {
    let lots = [];
    let lotN = 1;
    const roads = [];
    
    if (nRoads === 1) {
      const roadCenterY = depthFt / 2;
      const roadBottomY = roadCenterY - roadWidthFt / 2;
      const roadTopY = roadCenterY + roadWidthFt / 2;
      roads.push({ x: 0, y: roadBottomY, width: widthFt, height: roadWidthFt });
      
      // Bottom row: lots from y=0 to roadBottomY, front faces road (top)
      const bottomRowDepth = roadBottomY;
      if (bottomRowDepth >= minLotDepth) {
        const bottomLots = packRow(0, widthFt, 0, bottomRowDepth, parcelTypes, typeSequence, lotN, 0, false);
        lots.push(...bottomLots);
        lotN += bottomLots.length;
      }
      
      // Top row: lots from roadTopY to depthFt, front faces road (bottom)
      const topRowDepth = depthFt - roadTopY;
      if (topRowDepth >= minLotDepth) {
        const topLots = packRow(0, widthFt, roadTopY, topRowDepth, parcelTypes, typeSequence, lotN, 1, true);
        lots.push(...topLots);
        lotN += topLots.length;
      }
    } else {
      // Two roads — position them to maximize row depths
      // Optimal: each row gets (depthFt - numRoads * roadWidthFt) / 3
      const totalRoadSpace = nRoads * roadWidthFt;
      const availableForLots = depthFt - totalRoadSpace;
      const rowDepth = availableForLots / 3;
      
      // Road 1 sits after first row, Road 2 sits after second row
      const road1BottomY = rowDepth;
      const road1TopY = road1BottomY + roadWidthFt;
      const road2BottomY = road1TopY + rowDepth;
      const road2TopY = road2BottomY + roadWidthFt;
      
      roads.push({ x: 0, y: road1BottomY, width: widthFt, height: roadWidthFt });
      roads.push({ x: 0, y: road2BottomY, width: widthFt, height: roadWidthFt });
      
      // Row 0: bottom edge to road1 bottom
      if (road1BottomY >= minLotDepth) {
        const rowLots = packRow(0, widthFt, 0, road1BottomY, parcelTypes, typeSequence, lotN, 0, false);
        lots.push(...rowLots);
        lotN += rowLots.length;
      }
      
      // Row 1: road1 top to road2 bottom
      const middleDepth = road2BottomY - road1TopY;
      if (middleDepth >= minLotDepth) {
        const rowLots = packRow(0, widthFt, road1TopY, middleDepth, parcelTypes, typeSequence, lotN, 1, true);
        lots.push(...rowLots);
        lotN += rowLots.length;
      }
      
      // Row 2: road2 top to top edge
      const topDepth = depthFt - road2TopY;
      if (topDepth >= minLotDepth) {
        const rowLots = packRow(0, widthFt, road2TopY, topDepth, parcelTypes, typeSequence, lotN, 2, true);
        lots.push(...rowLots);
        lotN += rowLots.length;
      }
    }
    
    return { lots, roads, numRoads: nRoads };
  }
  
  // Always try single road layout
  const layout1 = computeLayout(1);
  
  // Try two-road layout if there's theoretically enough space
  const minFor2Roads = minLotDepth * 3 + roadWidthFt * 2;
  let bestLayout = layout1;
  
  if (depthFt >= minFor2Roads) {
    const layout2 = computeLayout(2);
    const conforming1 = layout1.lots.filter(l => l.conforming).length;
    const conforming2 = layout2.lots.filter(l => l.conforming).length;
    // Pick layout with more conforming lots; prefer 2 roads if tied (more road = better access)
    if (conforming2 >= conforming1 && conforming2 > 0) {
      bestLayout = layout2;
    }
  }
  
  const allLots = bestLayout.lots;
  const numRoads = bestLayout.numRoads;
  
  // Compute statistics
  const conformingLots = allLots.filter(l => l.conforming);
  const nonConformingCount = allLots.length - conformingLots.length;
  
  const totalLots = allLots.length;
  const conformingCount = conformingLots.length;
  const totalNRSF = conformingLots.reduce((s, l) => s + l.nrsf, 0);
  
  const roadLinearFt = widthFt * numRoads;
  const roadAreaFt2 = roadWidthFt * widthFt * numRoads;
  
  // Financial calculations
  const revenue = conformingLots.reduce((s, l) => s + l.pricePerLot, 0);
  const infraCost = roadLinearFt * (financials?.infraCostPerLF || 0);
  const lotDevCost = conformingCount * (financials?.lotDevCostPerLot || 0);
  const hardCosts = infraCost + lotDevCost;
  const softCosts = hardCosts * ((financials?.softCostPct || 0) / 100);
  const landCosts = financials?.landCost || 0;
  const earthwork = 0; // V1 placeholder
  const totalCosts = landCosts + hardCosts + softCosts + earthwork;
  const expenses = totalCosts;
  const noi = revenue - expenses;
  const yieldOnCost = totalCosts > 0 ? (noi / totalCosts) * 100 : 0;
  const capRate = financials?.capRate || 5;
  const value = capRate > 0 ? noi / (capRate / 100) : 0;
  
  const roads = bestLayout.roads;
  
  return {
    lots: allLots,
    roads,
    numRoads,
    totalLots,
    conformingLots: conformingCount,
    nonConformingCount,
    totalNRSF,
    roadAreaFt2,
    roadLinearFt,
    revenue,
    hardCosts,
    softCosts,
    landCosts,
    earthwork,
    totalCosts,
    expenses,
    noi,
    yieldOnCost,
    capRate,
    value
  };
}

function emptyResults() {
  return {
    lots: [],
    roads: [],
    numRoads: 0,
    totalLots: 0,
    conformingLots: 0,
    nonConformingCount: 0,
    totalNRSF: 0,
    roadAreaFt2: 0,
    roadLinearFt: 0,
    revenue: 0,
    hardCosts: 0,
    softCosts: 0,
    landCosts: 0,
    earthwork: 0,
    totalCosts: 0,
    expenses: 0,
    noi: 0,
    yieldOnCost: 0,
    capRate: 5,
    value: 0
  };
}
