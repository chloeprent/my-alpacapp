# 3D Property Render Pipeline — 160 Still Forest Dr

> **Status:** Pipeline designed, awaiting on-site data collection
> **Property:** 160 Still Forest Drive, Cedar Creek TX 78612 (Bastrop County)
> **Tools:** Blender 4.5 + add-ons, QGIS 4.0, GDAL — all on Alpuca (192.168.1.200)

---

## Part 1: Audit — Why the Procedural Pipeline Failed

### What Was Attempted

A Python script (`blender/render_property.py`) that:
1. Reads PostGIS geometry from `property_data.json` (parcel boundary, structure footprints)
2. Converts GPS coordinates to local feet
3. Extrudes 2D footprint polygons into 3D boxes
4. Adds primitive trees (cylinder trunk + icosphere crown)
5. Adds flat-color Principled BSDF materials
6. Renders with Cycles at 2560×1440

### What It Produced

Flat colored rectangles on a green plane — a site plan diagram, not a render. The output looks like a color-coded zoning map viewed from above, not a realistic property visualization.

### Root Causes (5 Fundamental Flaws)

#### Flaw 1: No Terrain — Flat Plane Instead of Real Ground

The script creates a flat polygon at Z=0 from the parcel boundary. Reality: the property has gentle rolling terrain typical of Bastrop County post-oak savanna. Without elevation data, everything floats on a billiard table.

**What's needed:** USGS 3DEP LiDAR DEM (1-meter resolution, free) imported via BlenderGIS, creating a real terrain mesh with proper elevation contours.

#### Flaw 2: No Textures — Solid Colors Instead of Real Materials

Every surface uses a single-color Principled BSDF node. The grass is RGB (0.18, 0.40, 0.10). The stone house is RGB (0.65, 0.60, 0.52). These are paint swatches, not materials.

**What's needed:** PBR texture maps (albedo, normal, roughness, displacement) from free libraries like ambientCG, Poly Haven, or cgbookcase. Ground needs grass + dirt + gravel textures with proper UV mapping. Structures need material-specific textures (stone, corrugated metal, wood siding).

#### Flaw 3: No Real Geometry — Extruded Polygons Instead of Buildings

The script takes a 2D footprint polygon and extrudes it upward. A house becomes a box with a triangulated gable on top. A shipping container becomes a colored rectangle. There are no windows, doors, porches, overhangs, rooflines, mechanical equipment, or any architectural detail.

**What's needed:** Reference photos of each structure, then manual or semi-procedural modeling in Blender. For the main structures (Main House, Back House), this means walls with window cutouts, proper roof geometry, porch overhangs, and material zones. For containers, this means corrugated walls, double doors, and proper corner castings.

#### Flaw 4: No Environment — Cartoon Trees on a Void

30 randomly placed lollipop trees (cylinder + icosphere) with no ground vegetation, no underbrush, no grass variation, no fallen leaves, no stumps, no fence posts, no utility poles, no mailbox. The sky is a flat blue color node. There's no atmospheric perspective, no distant tree line, no sense of place.

**What's needed:** HDRI environment map for realistic sky/lighting (free from Poly Haven). Real tree models (free from SpeedTree community, Botaniq lite, or manually modeled from photos). Particle systems for grass/groundcover. Reference photos to place vegetation accurately.

#### Flaw 5: No Ground Truth — Pure Database Dimensions

The script has never "seen" the property. All it knows is GPS coordinates and numbers (width: 10, height: 8.5, material: steel_container). It cannot infer that the Main House has a wraparound porch, that the driveway curves around a live oak, that Container #3 sits on concrete blocks 2 feet off the ground, or that there's a woodpile between the sauna and the back house.

**What's needed:** On-site reference photography (every structure from 4+ angles), drone aerial photos for overhead reference, and manual measurements of features not in the database.

### The Core Problem

**Procedural generation from a database cannot produce realistic renders.** Database dimensions tell you WHERE things are and HOW BIG they are, but not WHAT THEY LOOK LIKE. The database is excellent for site plan diagrams, setback compliance checks, and permit applications — it was never designed for photorealistic visualization.

The new pipeline uses the database for positioning and dimensions (what it's good at) and adds real-world input sources for appearance (what was missing).

---

## Part 2: New Pipeline Design

### Pipeline Overview

```
Phase 1: Data Collection (On-Site)
  ├── Structure reference photos (4+ angles per building)
  ├── Drone aerial photos (overhead + 45° oblique)
  ├── Ground texture photos (grass, gravel, dirt, paths)
  └── Detail photos (porches, doors, fencing, utilities)

Phase 2: GIS Base Layer (Desktop)
  ├── Download USGS 3DEP LiDAR DEM → terrain mesh
  ├── Download TNRIS/NAIP aerial imagery → ground texture
  ├── Import parcel boundary from PostGIS
  └── Assemble in QGIS → export GeoTIFF + GeoJSON

Phase 3: Blender Scene Assembly
  ├── Import terrain mesh via BlenderGIS
  ├── Drape aerial imagery onto terrain
  ├── Import structure footprints from PostGIS (positioning only)
  ├── Model each structure using reference photos
  ├── Apply PBR materials from texture libraries
  ├── Place trees/vegetation from reference photos
  └── Set up HDRI lighting + camera

Phase 4: Render & Publish
  ├── Render multiple views (bird's-eye, approach, detail)
  ├── Post-process in Blender compositor
  ├── Upload to PhyProp Renderings tab
  └── Push to GitHub Pages
```

### Phase 1: On-Site Data Collection

**Who:** Associates via task system (projects page)
**Duration:** 2-3 hours on-site
**Equipment:** Smartphone camera, tape measure, drone (if available)

#### Task 1A: Structure Reference Photography

For each of the 14 structures, photograph:
- **Front face** (the "main" side facing the driveway or road)
- **Back face**
- **Left side**
- **Right side**
- **Close-up of material/texture** (stone detail, container corrugation, wood siding)
- **Any unique features** (windows, doors, porches, stairs, AC units, awnings)

**Naming convention:** `{structure_name}_{angle}.jpg`
- Example: `main_house_front.jpg`, `main_house_back.jpg`, `red_container_1_left.jpg`

**Total photos needed:** ~70-90 (14 structures × 5-6 photos each)

#### Task 1B: Drone Aerial Photography

- **Overhead shot** at ~100ft altitude centered on property (matches satellite view)
- **4 oblique shots** at ~60ft altitude from N/S/E/W at ~45° angle
- **Approach shot** from Still Forest Dr looking north into the property
- **Detail pass** low over the main cluster of structures

If no drone available, the satellite imagery from Google/TNRIS will suffice for overhead. The oblique views are the biggest gap.

#### Task 1C: Ground & Context Photography

- **Driveway** from road entrance looking north
- **Gravel parking area** texture close-up
- **Grass areas** in open sun and under tree canopy
- **Dirt/bare areas** where foot traffic has worn paths
- **Tree line** on west boundary (standing at east side, looking west)
- **Road frontage** — Still Forest Dr looking both directions
- **Fence lines** — any existing fencing, gates
- **Utility fixtures** — well head, septic access, electrical panel, propane tank

#### Task 1D: Supplemental Measurements

Things NOT in the database that affect the 3D model:
- **Porch depth** on Main House and Back House (overhang from wall to edge)
- **Deck railing height** (the existing deck)
- **Container elevation** — are they on ground or on blocks/piers? How high?
- **Roof pitch** — photograph roof from side to estimate angle (the database has roof_type but not pitch angle)
- **Window/door positions** — rough sketch showing window placement on Main House front face
- **Heights of things on blocks** — some structures may be elevated on concrete blocks
- **Tree trunk diameters** of the 3-4 largest trees (for accurate modeling)

### Phase 2: GIS Base Layer

**Where:** Desktop work on Almaca
**Tool:** QGIS 4.0 + GDAL

#### Step 2A: Download USGS 3DEP LiDAR DEM

1. Go to https://apps.nationalmap.gov/downloader/
2. Search: 30.145°N, -97.358°W (property coords)
3. Select: Elevation Products (3DEP) → 1 Meter DEM
4. Download the tile covering the property (GeoTIFF format)
5. Save to `~/gis-data/dem/` on Almaca

```bash
# Clip DEM to property area with buffer (GDAL on Almaca)
/Applications/QGIS-final-4_0_0.app/Contents/MacOS/gdalwarp \
  -te -97.362 30.142 -97.354 30.150 \
  -t_srs EPSG:4326 \
  input_dem.tif property_dem.tif
```

#### Step 2B: Download Aerial Imagery

**Option A — TNRIS (best quality, free):**
1. Go to https://data.tnris.org/
2. Search Bastrop County → Orthoimagery
3. Download latest NAIP or StratMap tile
4. Save to `~/gis-data/imagery/`

**Option B — BlenderGIS (quickest):**
- BlenderGIS can pull Google/Bing/OSM tiles directly in Blender
- Less control over resolution but much faster workflow

#### Step 2C: Export PostGIS Data

```bash
# Export parcel boundary as GeoJSON
curl -s -X POST \
  -H "Authorization: Bearer $MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT id, name, ST_AsGeoJSON(boundary_geom) as geojson FROM parcels WHERE id = 1"}' \
  "https://api.supabase.com/v1/projects/aphrrfprbixmhissnjfn/database/query" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(json.loads(d[0]['geojson'])))" \
  > ~/gis-data/parcel_boundary.geojson

# Export structure footprints
curl -s -X POST \
  -H "Authorization: Bearer $MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT id, name, structure_type, width_ft, length_ft, height_ft, material, roof_type, ST_AsGeoJSON(footprint_geom) as geojson FROM structures WHERE parcel_id = 1"}' \
  "https://api.supabase.com/v1/projects/aphrrfprbixmhissnjfn/database/query" \
  > ~/gis-data/structure_footprints.json
```

#### Step 2D: QGIS Assembly (Verification)

1. Open QGIS → New project
2. Add DEM raster layer
3. Add aerial imagery raster layer
4. Add parcel_boundary.geojson as vector layer
5. Verify alignment — parcel boundary should sit correctly on aerial imagery
6. Export combined basemap as GeoTIFF for Blender import

### Phase 3: Blender Scene Assembly

**Where:** Almaca, Blender with GUI (not headless)
**Required add-ons:** BlenderGIS (terrain import), MeasureIt-ARCH (dimensions)

#### Step 3A: Terrain Import

1. Open Blender → Enable BlenderGIS add-on
2. BlenderGIS → Web Geodata → set property GPS coordinates as reference
3. Import DEM as mesh: BlenderGIS → Import → GeoTIFF DEM
4. Import aerial imagery: BlenderGIS → Import → Georeferenced Raster → drape on mesh
5. Scale terrain to match real-world units (1 Blender unit = 1 foot)

**Alternative (if BlenderGIS struggles with DEM):**
- Use QGIS to generate a mesh from the DEM (Mesh → Create Mesh from Raster)
- Export as .OBJ → Import to Blender
- UV-map the aerial imagery onto the mesh

#### Step 3B: Structure Placement Guide

Import the PostGIS footprints as flat reference planes:
- These show EXACTLY where each structure goes on the terrain
- Model the actual buildings on top of these reference planes
- Delete the reference planes when modeling is complete

```python
# Simplified placement script — just creates flat reference planes
# at the correct GPS positions, no extrusion
import bpy, json
with open('structure_footprints.json') as f:
    structures = json.load(f)
for s in structures:
    # create flat polygon at correct position (reference only)
    ...
```

#### Step 3C: Structure Modeling

This is the core creative work. For each structure, using reference photos:

**Main House (stone/frame, gable roof):**
- Start with footprint dimensions from DB (width/length)
- Model walls with window and door cutouts from reference photos
- Build proper gable roof with correct pitch (from side photo)
- Add porch overhang, railing, steps
- Apply stone texture to lower walls, siding texture to upper

**Back House (wood, gable roof):**
- Same process — model from reference photos
- Wood siding texture

**Shipping Containers (4 total):**
- Use parametric approach — corrugated box with doors on one end
- Apply red/beige/blue steel material per container
- Add container corner castings, locking bars
- If elevated on blocks, model the support blocks

**Trailers (2 total):**
- Model from reference photos — tongue, wheels, siding
- RV-style white/beige exterior

**Deck, Sauna, Bathroom Building, Pool:**
- Model each from reference photos
- Deck: wood planks with railing
- Sauna: small wood structure
- Pool: concrete/vinyl with water shader

**Modeling time estimate:** 4-8 hours total for all 14 structures (experienced Blender user), or 2-3 sessions spread across days.

#### Step 3D: Materials & Textures

Download PBR texture sets from free libraries:

| Surface | Source | Texture Set |
|---------|--------|-------------|
| Grass/lawn | [Poly Haven](https://polyhaven.com/textures) | Grass + dirt blend |
| Gravel driveway | [ambientCG](https://ambientcg.com/) | Gravel/crushed stone |
| Stone wall | ambientCG | Natural stone wall |
| Wood siding | Poly Haven | Painted wood planks |
| Corrugated metal | ambientCG | Corrugated steel (color-tint per container) |
| Roof shingles | ambientCG | Asphalt shingle or metal standing seam |
| Concrete | ambientCG | Poured concrete |
| Water | Built-in | Glass BSDF + volume absorption |

Apply using UV mapping — use "box project" for simple structures, manual unwrap for the main house.

#### Step 3E: Vegetation

**Trees (critical — west side is heavily wooded):**
- Use Sapling Tree Gen (bundled with Blender) for realistic tree geometry
- Or download free tree models from Poly Haven / BlenderKit
- Place trees matching the aerial imagery — dense on west, scattered elsewhere
- 3-5 tree species (post oak, cedar elm, eastern red cedar are common in Bastrop County)

**Ground cover:**
- Particle system on terrain mesh for grass
- Weight paint to control density (less under tree canopy, more in open areas)
- Bare dirt patches near structures and pathways

#### Step 3F: Lighting & Environment

1. Download HDRI sky from [Poly Haven](https://polyhaven.com/hdris) — use "Outdoor" category
   - Recommended: a clear Texas sky HDRI or similar sunny rural scene
2. Set as World environment texture
3. Optionally add a Sun light matching the HDRI direction for sharper shadows
4. Set sun position for Cedar Creek, TX latitude (~30.1°N)

#### Step 3G: Camera Setup

Create multiple cameras matching the views you want to display:

| View Name | Camera Position | Purpose |
|-----------|----------------|---------|
| Bird's Eye | 300ft above, slight ESE tilt | Overall property layout |
| Approach | At road level, looking north from Still Forest Dr | First impression view |
| Main Cluster | 100ft above main house area, 45° angle | Detail of primary structures |
| West Tree Line | Eye level from driveway, looking west | Show the wooded buffer |
| Pool Area | 50ft above, looking down at pool & deck | Amenity showcase |

### Phase 4: Render & Publish

#### Step 4A: Render Settings

```
Engine: Cycles
Samples: 256 (final) / 64 (preview)
Denoising: OpenImageDenoise (OptiX if GPU available)
Resolution: 3840×2160 (4K) for hero shots, 1920×1080 for secondary
Color Management: Filmic (medium-high contrast)
```

Note: Almaca is Intel (no GPU Cycles acceleration). Expect 5-15 minutes per frame at 4K with Cycles CPU rendering. Consider EEVEE for faster preview renders.

#### Step 4B: Post-Processing

In Blender Compositor:
- Slight color grading (warm Texas sunlight feel)
- Vignette
- Glare on bright surfaces (optional)
- Export as PNG (lossless) and JPEG (web display)

#### Step 4C: Upload to PhyProp

1. Upload rendered images to Supabase Storage (`housephotos` bucket)
2. Add entries to the `RENDERINGS` array in `spaces/admin/phyprop.js`
3. Push to main → deploys to GitHub Pages

```javascript
// In phyprop.js — add to RENDERINGS array
{
  url: 'https://aphrrfprbixmhissnjfn.supabase.co/storage/v1/object/public/housephotos/renders/birds_eye_v1.jpg',
  label: 'Bird\'s Eye View',
  date: '2026-03-21'
}
```

---

## Part 3: Software Assessment

### Current Toolchain — What's Sufficient

| Tool | Status | Role in Pipeline |
|------|--------|-----------------|
| Blender 4.5 | Installed | 3D modeling, rendering, compositing |
| BlenderGIS | Downloaded, not activated | Terrain/imagery import |
| Bonsai (BlenderBIM) | Downloaded, not activated | Drawing sheets (permit use, not renders) |
| MeasureIt-ARCH | Bundled, not activated | Dimension verification |
| QGIS 4.0 | Installed | GIS data prep, DEM processing |
| GDAL 3.12 | Bundled with QGIS | Format conversion |

### Add-ons to Activate (Required)

These are already downloaded to `~/Downloads/blender-addons/` — just need GUI activation:

1. **BlenderGIS** — Critical for terrain + imagery import
2. **MeasureIt-ARCH** — Verify dimensions match database

### Add-ons to Activate (Recommended)

3. **Archipack** — Speeds up wall/window/door creation for Main House and Back House
4. **CAD Sketcher** — Useful for precise footprint tracing

### Free Resources to Download

| Resource | URL | Purpose |
|----------|-----|---------|
| PBR Textures | https://polyhaven.com/textures | Grass, stone, wood, metal |
| HDRI Skies | https://polyhaven.com/hdris | Environment lighting |
| Tree Models | Sapling Tree Gen (bundled) | Vegetation |
| LiDAR DEM | https://apps.nationalmap.gov/downloader/ | Terrain elevation |
| Aerial Imagery | https://data.tnris.org/ | Ground texture |

### What's NOT Needed

- **No paid software required** — Blender + free textures can produce professional renders
- **No photogrammetry software** — Reference photos are for manual modeling, not photogrammetry reconstruction (which would require many more photos and processing power)
- **No GPU upgrade** — CPU Cycles rendering is slow but adequate. EEVEE is fast enough for iterations

### Optional Future Enhancement

If you want to go further in the future:
- **Meshroom** (free, open-source) — Photogrammetry to create 3D scans of structures from many photos (requires 30+ photos per structure from all angles). This would automate Step 3C but requires a much more extensive photo collection effort.

---

## Part 4: Associate Tasks (Data Collection)

The following tasks should be created in the `tasks` table for on-site data collection. See "Phase 1" above for detailed instructions for each task.

### Task List

| # | Title | Priority | Notes | Location |
|---|-------|----------|-------|----------|
| 1 | Photograph all 14 structures (4+ angles each) | P2 (High) | Front/back/left/right + material close-up for each. Name files: {structure}_{angle}.jpg. See CAD-RENDER-PIPELINE.md Phase 1A for full list. | 160 Still Forest Dr |
| 2 | Drone aerial photos of property | P3 (Medium) | Overhead at 100ft + 4 oblique shots at 60ft from N/S/E/W. If no drone, skip — satellite imagery will be used. | 160 Still Forest Dr |
| 3 | Photograph ground textures & context | P3 (Medium) | Driveway entrance, gravel areas, grass in sun/shade, dirt paths, tree line from east side, road both directions, fencing, utility fixtures. | 160 Still Forest Dr |
| 4 | Measure structure details not in database | P2 (High) | Porch depths, deck railing height, container elevation (on ground or blocks?), roof pitch (photo from side), window/door positions on Main House, trunk diameters of 3-4 largest trees. | 160 Still Forest Dr |

### SQL to Create Tasks

```sql
INSERT INTO tasks (title, notes, description, priority, location_label, status) VALUES
(
  'Photograph all 14 structures (4+ angles each)',
  'Front/back/left/right + material close-up for each structure',
  'For 3D property render pipeline. Name files: {structure_name}_{angle}.jpg (e.g., main_house_front.jpg). Structures to photograph: Main House, Back House, Big Trailer, Small Trailer, Red Container #1, Red Container #2, Container #3, Beige Container, Deck, Sauna, Bathroom Building, Pool, Driveway/Gravel areas. See docs/CAD-RENDER-PIPELINE.md Phase 1A for full requirements.',
  2,
  '160 Still Forest Dr',
  'open'
),
(
  'Drone aerial photos of property',
  'Overhead at 100ft + 4 oblique shots from N/S/E/W at 60ft',
  'For 3D property render pipeline. Fly overhead centered on property at ~100ft altitude. Then 4 oblique passes at ~60ft from each cardinal direction at 45° angle. Also capture approach view from Still Forest Dr looking north. If no drone available, skip this task — satellite imagery will be used instead. See docs/CAD-RENDER-PIPELINE.md Phase 1B.',
  3,
  '160 Still Forest Dr',
  'open'
),
(
  'Photograph ground textures and context',
  'Driveway, gravel, grass, dirt, tree line, road, fencing, utilities',
  'For 3D property render pipeline. Capture: (1) Driveway from road entrance looking north, (2) Gravel parking texture close-up, (3) Grass in open sun and under tree canopy, (4) Worn dirt paths, (5) West tree line from east side, (6) Still Forest Dr both directions, (7) Any fencing/gates, (8) Well head, septic access, electrical panel, propane tank. See docs/CAD-RENDER-PIPELINE.md Phase 1C.',
  3,
  '160 Still Forest Dr',
  'open'
),
(
  'Measure structure details not in database',
  'Porches, railings, elevations, roof pitch, windows, tree trunks',
  'For 3D property render pipeline. Measure: (1) Porch depth on Main House and Back House, (2) Deck railing height, (3) Are containers on ground or elevated on blocks? How high?, (4) Photograph roofs from side to estimate pitch angle, (5) Sketch window/door positions on Main House front face, (6) Trunk diameters of 3-4 largest trees. See docs/CAD-RENDER-PIPELINE.md Phase 1D.',
  2,
  '160 Still Forest Dr',
  'open'
);
```

---

## Part 5: Execution Checklist

A future session can follow this checklist to produce the render:

### Pre-requisites
- [ ] Associate tasks 1-4 completed (photos + measurements uploaded)
- [ ] BlenderGIS add-on activated in Blender on Almaca
- [ ] MeasureIt-ARCH add-on activated in Blender
- [ ] USGS 3DEP LiDAR DEM downloaded for property area
- [ ] TNRIS aerial imagery downloaded (or use BlenderGIS live tiles)
- [ ] PBR textures downloaded from Poly Haven / ambientCG
- [ ] HDRI sky downloaded from Poly Haven

### Build Steps
- [ ] **QGIS:** Verify DEM + aerial + parcel boundary alignment
- [ ] **Blender:** Import terrain mesh via BlenderGIS
- [ ] **Blender:** Drape aerial imagery on terrain
- [ ] **Blender:** Import structure footprints as reference planes
- [ ] **Blender:** Model Main House from reference photos
- [ ] **Blender:** Model Back House from reference photos
- [ ] **Blender:** Model 4 shipping containers (parametric)
- [ ] **Blender:** Model 2 trailers from reference photos
- [ ] **Blender:** Model deck, sauna, bathroom building, pool
- [ ] **Blender:** Apply PBR materials to all structures
- [ ] **Blender:** Place trees matching aerial imagery
- [ ] **Blender:** Add grass particle system
- [ ] **Blender:** Set up HDRI environment lighting
- [ ] **Blender:** Create camera views (bird's eye, approach, cluster, tree line, pool)
- [ ] **Blender:** Test render at low samples (64) to verify
- [ ] **Blender:** Final render at 256 samples, 4K resolution
- [ ] **Blender:** Post-process in compositor
- [ ] **Upload:** Push renders to Supabase Storage
- [ ] **Code:** Add to RENDERINGS array in phyprop.js
- [ ] **Deploy:** Push to main

### Time Estimates

| Phase | Duration | Who |
|-------|----------|-----|
| On-site data collection | 2-3 hours | Associate |
| GIS data download + prep | 1-2 hours | Desktop |
| Terrain + imagery import | 1 hour | Blender |
| Structure modeling (all 14) | 6-10 hours | Blender (can be spread across sessions) |
| Materials + textures | 1-2 hours | Blender |
| Vegetation + environment | 1-2 hours | Blender |
| Render + post-process | 1-2 hours | Blender |
| Upload + deploy | 30 min | Code |
| **Total** | **~15-22 hours** | Spread across multiple sessions |

---

## Appendix: Database → Blender Field Mapping

For reference when modeling, these database fields inform the 3D model:

| DB Field | Blender Use |
|----------|-------------|
| `footprint_geom` | XY position and footprint shape (reference plane) |
| `width_ft`, `length_ft` | Model dimensions |
| `height_ft` | Wall height (extrusion) |
| `stories` | Interior floor count (window rows) |
| `material` | Texture selection (stone, wood, steel, etc.) |
| `roof_type` | Roof geometry (gable, hip, flat, shed, metal_standing_seam) |
| `structure_type` | Modeling approach (house=detailed, container=parametric) |
| `color` (metadata) | Material tint (red/beige/blue containers) |
| `boundary_geom` | Parcel boundary position |
| `edge_geom` + `setback_required_ft` | Setback line positions |
| `ground_elevation_ft` | Base elevation for 3D placement |
