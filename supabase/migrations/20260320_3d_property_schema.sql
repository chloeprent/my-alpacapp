-- 3D Property Digital Twin Schema
-- Created: 2026-03-20
-- PostGIS 3.3 enabled on Supabase

-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- Enum types
CREATE TYPE structure_type AS ENUM ('house', 'outbuilding', 'container', 'trailer_rv', 'deck', 'sauna', 'shed', 'garage', 'carport', 'fence', 'retaining_wall', 'utility', 'other');
CREATE TYPE structure_use AS ENUM ('primary_residence', 'lodging', 'storage', 'amenity', 'service', 'parking', 'mixed', 'unused');
CREATE TYPE permit_status AS ENUM ('permitted', 'unpermitted', 'exempt', 'violation', 'pending', 'grandfathered');
CREATE TYPE roof_shape AS ENUM ('gable', 'hip', 'flat', 'shed', 'mansard', 'gambrel', 'metal_standing_seam', 'none');

-- 1. PARCELS
CREATE TABLE IF NOT EXISTS parcels (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '160 Still Forest Dr',
  address TEXT,
  city TEXT DEFAULT 'Cedar Creek',
  county TEXT DEFAULT 'Bastrop',
  state TEXT DEFAULT 'TX',
  zip TEXT DEFAULT '78612',
  legal_description TEXT,
  parcel_number TEXT,
  acreage NUMERIC(8,4),
  area_sqft NUMERIC(12,2),
  boundary_geom GEOMETRY(POLYGON, 4326),
  ground_elevation_ft NUMERIC(8,2),
  flood_zone TEXT DEFAULT 'Zone X (unshaded)',
  in_floodplain BOOLEAN DEFAULT FALSE,
  houston_toad_habitat BOOLEAN DEFAULT FALSE,
  esd_district TEXT,
  zoning_district_id INTEGER,
  survey_date DATE,
  survey_by TEXT,
  survey_rpls TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. PARCEL EDGES
CREATE TABLE IF NOT EXISTS parcel_edges (
  id SERIAL PRIMARY KEY,
  parcel_id INTEGER REFERENCES parcels(id),
  edge_side TEXT NOT NULL CHECK (edge_side IN ('N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW')),
  edge_label TEXT,
  bearing TEXT,
  length_ft NUMERIC(10,2),
  edge_geom GEOMETRY(LINESTRING, 4326),
  is_road_frontage BOOLEAN DEFAULT FALSE,
  road_name TEXT,
  road_classification TEXT CHECK (road_classification IN ('local_rural', 'ranch', 'collector', 'arterial')),
  road_row_ft NUMERIC(6,2),
  has_easement BOOLEAN DEFAULT FALSE,
  easement_type TEXT,
  easement_width_ft NUMERIC(6,2),
  setback_required_ft NUMERIC(6,2) NOT NULL DEFAULT 10,
  setback_label TEXT,
  adjoining_owner TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. ZONING RULES
CREATE TABLE IF NOT EXISTS zoning_rules (
  id SERIAL PRIMARY KEY,
  jurisdiction TEXT NOT NULL DEFAULT 'Bastrop County',
  district_code TEXT,
  district_name TEXT,
  rule_source TEXT,
  front_setback_ft NUMERIC(6,2),
  side_setback_ft NUMERIC(6,2),
  rear_setback_ft NUMERIC(6,2),
  road_setback_local_rural_ft NUMERIC(6,2) DEFAULT 20,
  road_setback_ranch_ft NUMERIC(6,2) DEFAULT 15,
  road_setback_collector_ft NUMERIC(6,2) DEFAULT 25,
  road_setback_arterial_ft NUMERIC(6,2) DEFAULT 30,
  lodging_road_row_setback_ft NUMERIC(6,2) DEFAULT 25,
  lodging_property_line_setback_ft NUMERIC(6,2) DEFAULT 15,
  lodging_internal_road_setback_ft NUMERIC(6,2) DEFAULT 10,
  lodging_unit_separation_ft NUMERIC(6,2) DEFAULT 20,
  max_height_ft NUMERIC(6,2),
  max_lot_coverage_pct NUMERIC(5,2),
  max_impervious_pct NUMERIC(5,2),
  min_lot_size_sqft NUMERIC(12,2),
  exempt_structure_sqft NUMERIC(8,2) DEFAULT 25,
  container_behind_primary BOOLEAN DEFAULT TRUE,
  container_screening_required BOOLEAN DEFAULT TRUE,
  container_screening_height_ft NUMERIC(4,1) DEFAULT 6,
  fire_separation_ft NUMERIC(6,2),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. STRUCTURES
CREATE TABLE IF NOT EXISTS structures (
  id SERIAL PRIMARY KEY,
  parcel_id INTEGER REFERENCES parcels(id),
  name TEXT NOT NULL,
  structure_type structure_type NOT NULL,
  use_type structure_use NOT NULL DEFAULT 'storage',
  width_ft NUMERIC(8,2),
  length_ft NUMERIC(8,2),
  height_ft NUMERIC(8,2),
  stories INTEGER DEFAULT 1,
  area_sqft NUMERIC(10,2),
  material TEXT,
  roof_type roof_shape,
  color TEXT,
  year_built INTEGER,
  year_placed INTEGER,
  ground_elevation_ft NUMERIC(8,2),
  footprint_geom GEOMETRY(POLYGON, 4326),
  centroid_geom GEOMETRY(POINT, 4326),
  lod0_footprint GEOMETRY(POLYGONZ, 4326),
  nearest_edge_id INTEGER REFERENCES parcel_edges(id),
  nearest_edge_side TEXT,
  nearest_edge_distance_ft NUMERIC(8,2),
  setback_required_ft NUMERIC(6,2),
  setback_compliant BOOLEAN,
  setback_surplus_ft NUMERIC(8,2),
  permit_status permit_status NOT NULL DEFAULT 'unpermitted',
  is_movable BOOLEAN DEFAULT FALSE,
  is_permanent_structure BOOLEAN DEFAULT TRUE,
  guest_capacity INTEGER DEFAULT 0,
  bedrooms INTEGER DEFAULT 0,
  bathrooms NUMERIC(3,1) DEFAULT 0,
  has_plumbing BOOLEAN DEFAULT FALSE,
  has_electric BOOLEAN DEFAULT FALSE,
  has_hvac BOOLEAN DEFAULT FALSE,
  condition TEXT,
  space_id INTEGER,
  photo_urls TEXT[],
  notes TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. STRUCTURE SETBACKS (computed compliance columns)
CREATE TABLE IF NOT EXISTS structure_setbacks (
  id SERIAL PRIMARY KEY,
  structure_id INTEGER REFERENCES structures(id) ON DELETE CASCADE,
  edge_id INTEGER REFERENCES parcel_edges(id) ON DELETE CASCADE,
  measured_distance_ft NUMERIC(8,2) NOT NULL,
  required_distance_ft NUMERIC(6,2) NOT NULL,
  is_compliant BOOLEAN GENERATED ALWAYS AS (measured_distance_ft >= required_distance_ft) STORED,
  surplus_ft NUMERIC(8,2) GENERATED ALWAYS AS (measured_distance_ft - required_distance_ft) STORED,
  measured_at DATE,
  measured_by TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(structure_id, edge_id)
);

-- 6. PROPERTY UTILITIES
CREATE TABLE IF NOT EXISTS property_utilities (
  id SERIAL PRIMARY KEY,
  parcel_id INTEGER REFERENCES parcels(id),
  utility_type TEXT NOT NULL CHECK (utility_type IN ('water', 'wastewater', 'electric', 'gas', 'internet', 'fire_protection')),
  provider TEXT,
  account_number TEXT,
  status TEXT DEFAULT 'active',
  system_type TEXT,
  capacity TEXT,
  location_geom GEOMETRY(POINT, 4326),
  location_description TEXT,
  availability_letter_status TEXT DEFAULT 'pending',
  notes TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. IMPERVIOUS COVER
CREATE TABLE IF NOT EXISTS impervious_cover (
  id SERIAL PRIMARY KEY,
  parcel_id INTEGER REFERENCES parcels(id),
  structure_id INTEGER REFERENCES structures(id),
  surface_type TEXT CHECK (surface_type IN ('structure', 'driveway', 'patio', 'sidewalk', 'parking', 'other')),
  area_sqft NUMERIC(10,2) NOT NULL,
  material TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. PERMIT APPLICATIONS
CREATE TABLE IF NOT EXISTS permit_applications (
  id SERIAL PRIMARY KEY,
  parcel_id INTEGER REFERENCES parcels(id),
  structure_id INTEGER REFERENCES structures(id),
  permit_type TEXT NOT NULL CHECK (permit_type IN ('development', 'building', 'septic', 'electrical', 'plumbing', 'demolition', 'grading', 'lodging', 'rv_park')),
  permit_number TEXT,
  application_date DATE,
  approval_date DATE,
  issue_date DATE,
  expiration_date DATE,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'denied', 'expired', 'closed')),
  estimated_cost NUMERIC(12,2),
  actual_cost NUMERIC(12,2),
  scope_of_work TEXT,
  applicant_name TEXT,
  contractor_name TEXT,
  contractor_license TEXT,
  jurisdiction TEXT DEFAULT 'Bastrop County',
  document_urls TEXT[],
  notes TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. INSPECTIONS
CREATE TABLE IF NOT EXISTS inspections (
  id SERIAL PRIMARY KEY,
  permit_id INTEGER REFERENCES permit_applications(id) ON DELETE CASCADE,
  inspection_type TEXT NOT NULL,
  scheduled_date DATE,
  completed_date DATE,
  inspector_name TEXT,
  result TEXT CHECK (result IN ('pass', 'fail', 'partial', 'cancelled')),
  notes TEXT,
  next_inspection_required TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. PERMIT DOCUMENTS
CREATE TABLE IF NOT EXISTS permit_documents (
  id SERIAL PRIMARY KEY,
  permit_id INTEGER REFERENCES permit_applications(id) ON DELETE CASCADE,
  document_type TEXT CHECK (document_type IN ('site_plan', 'floor_plan', 'structural', 'survey', 'engineering', 'septic_design', 'drainage', 'esd_letter', 'availability_letter', 'application_form', 'other')),
  file_url TEXT NOT NULL,
  file_name TEXT,
  file_size_bytes INTEGER,
  version INTEGER DEFAULT 1,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_structures_parcel ON structures(parcel_id);
CREATE INDEX IF NOT EXISTS idx_structures_footprint ON structures USING GIST(footprint_geom);
CREATE INDEX IF NOT EXISTS idx_parcels_boundary ON parcels USING GIST(boundary_geom);
CREATE INDEX IF NOT EXISTS idx_parcel_edges_geom ON parcel_edges USING GIST(edge_geom);
CREATE INDEX IF NOT EXISTS idx_structure_setbacks_struct ON structure_setbacks(structure_id);
CREATE INDEX IF NOT EXISTS idx_structure_setbacks_edge ON structure_setbacks(edge_id);
CREATE INDEX IF NOT EXISTS idx_permit_apps_parcel ON permit_applications(parcel_id);
CREATE INDEX IF NOT EXISTS idx_permit_apps_structure ON permit_applications(structure_id);

-- RLS
ALTER TABLE parcels ENABLE ROW LEVEL SECURITY;
ALTER TABLE parcel_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoning_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE structures ENABLE ROW LEVEL SECURITY;
ALTER TABLE structure_setbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_utilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE impervious_cover ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_documents ENABLE ROW LEVEL SECURITY;
