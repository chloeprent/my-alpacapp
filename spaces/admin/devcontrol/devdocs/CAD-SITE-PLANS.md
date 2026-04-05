# CAD & Site Plan System — Setup & Usage Guide

> **Goal:** Generate professional, county-permit-ready site plans for outdoor spaces at 160 Still Forest Drive, Cedar Creek TX 78612 (Bastrop County) using 100% free and open-source tools.

## What We're Building

A two-machine CAD pipeline:

- **Alpaca Mac** (Intel, macOS 12.7) — Interactive design workstation for hands-on site plan creation, 3D modeling, and permit sheet composition
- **Hostinger VPS** — Headless automation backend for on-demand rendering, GIS tile serving, and PDF generation callable from AlpacApps

### Deliverables This System Produces

1. **County permit site plans** — Scaled 24×36" or 11×17" sheets with title block, dimensions, setbacks, north arrow, legend (PDF/DXF)
2. **Photorealistic 3D renders** — Bird's-eye and perspective views of proposed outdoor layouts for presentations
3. **Interactive property maps** — Live map tiles on AlpacApps admin showing zones, boundaries, and event areas
4. **Automated permit packets** — Edge function triggers headless render + PDF assembly on Hostinger

---

## Tools & Add-ons (All Free & Open Source)

### Alpaca Mac — Design Workstation

| Tool | Version | Purpose |
|------|---------|---------|
| **Blender** | 4.x | 3D modeling, photorealistic rendering, 2D drafting via Grease Pencil |
| **BlenderBIM** (IfcOpenShell) | latest | Architectural drafting, IFC export, dimensioned drawing sheets, title blocks |
| **BlenderGIS** | latest | Import GIS shapefiles, satellite imagery, terrain elevation data |
| **CAD Sketcher** | latest | Constraint-based 2D sketching (AutoCAD-style parametric constraints) |
| **MeasureIt-ARCH** | bundled | Architectural dimensions, annotations, labels |
| **Archipack** | latest | Parametric walls, fences, floors, roofs, stairs |
| **QGIS Desktop** | 3.x | GIS exploration, parcel data, map composition, print layouts |
| **LibreCAD** | 2.x | Lightweight 2D CAD for quick drafting (DXF native) |

### Hostinger VPS — Automation Backend

| Tool | Deployment | Purpose |
|------|-----------|---------|
| **QGIS Server** | Docker | Serve WMS/WFS map tiles to AlpacApps (parcel boundaries, aerial overlays) |
| **Blender CLI** | Docker | Headless rendering — generate PDFs and 3D renders on demand |
| **GDAL/OGR** | Docker or native | GIS format conversion, shapefile processing, parcel data extraction |
| **LibreOffice headless** | Docker | Convert SVG/DXF exports to PDF for permit packets |

---

## Installation — Alpaca Mac

### Step 1: Install Blender

```bash
brew install --cask blender
```

Or download from https://www.blender.org/download/ (Intel macOS .dmg)

### Step 2: Install Blender Add-ons

Launch Blender, then for each add-on:

**BlenderBIM:**
1. Download from https://blenderbim.org/download.html (macOS build)
2. Blender → Edit → Preferences → Add-ons → Install → select downloaded .zip
3. Enable "Import-Export: BlenderBIM"

**BlenderGIS:**
1. Download from https://github.com/domlysz/BlenderGIS/releases
2. Install via Preferences → Add-ons → Install → select .zip
3. Enable "3D View: BlenderGIS"

**CAD Sketcher:**
1. Download from https://github.com/hlorus/CAD_Sketcher/releases
2. Install via Preferences → Add-ons → Install → select .zip
3. Enable "Mesh: CAD Sketcher"

**MeasureIt-ARCH:**
- Already bundled with Blender
- Enable via Preferences → Add-ons → search "MeasureIt" → enable "3D View: MeasureIt-ARCH"

**Archipack:**
1. Download from https://github.com/s-leger/archipack/releases
2. Install via Preferences → Add-ons → Install → select .zip
3. Enable "Add Mesh: Archipack"

### Step 3: Install QGIS

```bash
brew install --cask qgis
```

### Step 4: Install LibreCAD

```bash
brew install --cask librecad
```

### Step 5: Install GDAL (command-line GIS tools)

```bash
brew install gdal
```

---

## Installation — Hostinger VPS (Docker)

### Step 1: QGIS Server

```bash
docker pull camptocamp/qgis-server:latest
docker run -d --name qgis-server \
  -p 8080:80 \
  -v /opt/qgis-data:/data \
  camptocamp/qgis-server:latest
```

### Step 2: Blender CLI (headless rendering)

```dockerfile
# Dockerfile.blender
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y \
  blender xvfb python3-pip && \
  pip3 install bpy
ENTRYPOINT ["xvfb-run", "blender", "-b"]
```

```bash
docker build -t blender-cli -f Dockerfile.blender .
# Render a .blend file to PDF/PNG:
docker run --rm -v /opt/blend-projects:/projects blender-cli \
  /projects/site-plan.blend -o /projects/output/frame_#### -F PNG -a
```

### Step 3: GDAL

```bash
docker pull ghcr.io/osgeo/gdal:latest
# Convert shapefile to GeoJSON:
docker run --rm -v /opt/gis-data:/data ghcr.io/osgeo/gdal:latest \
  ogr2ogr -f GeoJSON /data/parcels.geojson /data/parcels.shp
```

---

## GIS Data Sources — Bastrop County

### Parcel Boundaries & Property Lines

- **Bastrop County Appraisal District (BCAD):** https://www.bastropcad.org/
  - Download parcel shapefiles or use their GIS viewer
  - Property ID for 160 Still Forest: look up by address
- **Texas Natural Resources Information System (TNRIS):** https://data.tnris.org/
  - Statewide parcel data, elevation (LiDAR DEMs), aerial imagery
  - StratMap parcels dataset covers Bastrop County

### Aerial / Satellite Imagery

- **TNRIS Imagery:** High-resolution orthoimagery (free, Texas-funded)
- **USDA NAIP:** National Agriculture Imagery Program (free, updated ~2 years)
- **OpenStreetMap:** Via BlenderGIS or QGIS (free, community-maintained)
- **Google/Bing tiles:** Available in both BlenderGIS and QGIS (free for viewing)

### Elevation / Terrain

- **USGS 3DEP:** https://apps.nationalmap.gov/downloader/
  - 1-meter LiDAR DEM for Bastrop County
  - Import into BlenderGIS for accurate 3D terrain

### Flood Zones & Environmental

- **FEMA Flood Maps:** https://msc.fema.gov/portal/home
- **TCEQ Environmental Data:** https://www.tceq.texas.gov/gis

### Zoning & Setbacks

- **Bastrop County:** Unincorporated areas have limited zoning — check subdivision deed restrictions
- **Setback requirements:** Vary by lot size and subdivision covenants — verify with Bastrop County Development Services

---

## Workflow: Creating a County Permit Site Plan

### 1. Set Up Base Map (QGIS on Alpaca Mac)

```
1. Open QGIS
2. Add base layer: Google Satellite or TNRIS imagery
3. Import Bastrop County parcel shapefile
4. Locate 160 Still Forest Drive parcel
5. Extract property boundary polygon
6. Export as GeoJSON or Shapefile for Blender
```

### 2. Build 3D Scene (Blender on Alpaca Mac)

```
1. Open Blender with BlenderGIS add-on
2. Import terrain DEM (USGS 3DEP 1m LiDAR)
3. Drape aerial imagery onto terrain mesh
4. Import property boundary from QGIS export
5. Add existing structures (measure from aerial + site visit)
6. Model proposed outdoor elements:
   - Event areas, stages, seating
   - Parking lots, fire lanes, ADA paths
   - Fencing, gates, landscaping
   - Utilities, drainage, lighting
7. Add setback lines, easements, right-of-way
```

### 3. Generate Permit Sheets (BlenderBIM)

```
1. Switch to BlenderBIM drawing mode
2. Create drawing sheets (24×36" at 1"=20' or appropriate scale)
3. Add views: site plan, grading plan, utility plan, landscape plan
4. Add title block with:
   - Property owner: GenAlpaca Residency
   - Address: 160 Still Forest Drive, Cedar Creek TX 78612
   - Preparer name, date, sheet number
5. Add dimensions, setback callouts, north arrow, scale bar, legend
6. Export as PDF and DXF
```

### 4. Create Presentation Renders (Blender)

```
1. Set up camera angles (bird's eye, perspective views)
2. Add lighting (sun position matching Cedar Creek latitude)
3. Apply materials (grass, gravel, wood, concrete)
4. Render at high resolution for presentation
5. Export as PNG/JPEG
```

### 5. Assemble Permit Packet

```
Typical Bastrop County site plan submission includes:
- Cover sheet with project info
- Existing conditions plan
- Proposed site plan (the main drawing)
- Grading/drainage plan
- Utility plan (water, sewer, electric)
- Landscape plan (if applicable)
- Detail sheets (sections, elevations)
- Survey plat (from licensed surveyor — cannot be self-generated)
```

---

## Automation: AlpacApps Integration

### Live Property Map on Admin Dashboard

QGIS Server on Hostinger serves WMS tiles → AlpacApps admin shows interactive map:
- Property boundaries with zone overlays
- Click zones to see capacity, bookings, permit status
- Toggle layers: aerial, parcels, setbacks, flood, event areas

### On-Demand Render Generation

```
AlpacApps edge function → HTTP request to Hostinger
  → Blender CLI renders .blend file with parameters (layout, camera angle)
  → Returns PNG/PDF → stored in Supabase Storage
  → Served to admin or emailed to client
```

### Automated Permit Packet Assembly

```
AlpacApps edge function → triggers on "Generate Permit Packet" button
  → Blender CLI exports drawing sheets as PDF
  → LibreOffice headless assembles cover sheet
  → GDAL extracts GIS data for attachment
  → Combined PDF stored in Supabase Storage
```

---

## Important Notes

- **Licensed survey required:** County permits require a licensed surveyor's plat for property boundaries. These tools help with *site plans* (what you propose to build), not *surveys* (legal boundary determination).
- **Bastrop County requirements:** Check with Development Services (512-581-4200) for specific submittal requirements. Unincorporated areas may have different rules than City of Bastrop.
- **Scale and accuracy:** Always verify on-site measurements. GIS/aerial data is typically accurate to 1-3 feet but is not survey-grade.
- **Professional stamp:** Some submissions require a licensed engineer or architect stamp. These tools produce the drawings, but you may need a professional to review and stamp them.

---

## Costs

| Item | Cost |
|------|------|
| All software and add-ons | **$0** (GPL/LGPL/MIT licensed) |
| GIS data (TNRIS, USGS, FEMA) | **$0** (taxpayer-funded public data) |
| Bastrop County parcel data | **$0** (public records) |
| Hostinger VPS (existing) | Already paying |
| Alpaca Mac (existing) | Already have |
| **Total additional cost** | **$0** |
