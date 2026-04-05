-- Brand configuration table
-- Stores all brand assets, colors, fonts, and usage guidelines in a single JSONB document
-- This is the single source of truth for all branding across emails, web, and collateral

CREATE TABLE IF NOT EXISTS brand_config (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  config      jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES app_users(id)
);

-- RLS
ALTER TABLE brand_config ENABLE ROW LEVEL SECURITY;

-- Anyone can read brand config (needed by edge functions, client pages)
CREATE POLICY "brand_config_select" ON brand_config
  FOR SELECT USING (true);

-- Only admin can update
CREATE POLICY "brand_config_update" ON brand_config
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE auth_user_id = auth.uid()
        AND role IN ('admin')
    )
  );

-- Seed the brand config with current values extracted from the codebase
INSERT INTO brand_config (id, config) VALUES (1, '{
  "brand": {
    "primary_name": "Alpaca Playhouse",
    "full_name": "Alpaca Playhouse Austin",
    "platform_name": "AlpacApps",
    "legal_name": "AlpacApps Residency",
    "tagline": "Where the herd gathers",
    "address": "160 Still Forest Dr, Cedar Creek, TX 78612",
    "website": "https://alpacaplayhouse.com"
  },
  "colors": {
    "primary": {
      "background": "#faf9f6",
      "background_muted": "#f2f0e8",
      "background_dark": "#1c1618",
      "text": "#2a1f23",
      "text_light": "#faf9f6",
      "text_muted": "#7d6f74",
      "accent": "#d4883a",
      "accent_hover": "#be7830",
      "accent_light": "rgba(212, 136, 58, 0.1)",
      "border": "#e6e2d9"
    },
    "status": {
      "success": "#54a326",
      "success_light": "#e8f5e0",
      "error": "#8f3d4b",
      "error_light": "#f5e6e9",
      "warning": "#d4883a",
      "warning_light": "#fdf1e0",
      "info": "#3b82f6",
      "info_light": "#eff6ff"
    },
    "semantic": {
      "occupied": "#8f3d4b",
      "occupied_light": "#f5e6e9",
      "available": "#54a326",
      "available_light": "#e8f5e0",
      "secret": "#7c6a9a",
      "secret_light": "#f3effc"
    }
  },
  "typography": {
    "font_family": "DM Sans",
    "font_import": "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap",
    "font_stack": "''DM Sans'', -apple-system, BlinkMacSystemFont, ''Segoe UI'', sans-serif",
    "font_stack_mono": "''SF Mono'', ''Menlo'', monospace",
    "scale": {
      "h1": "2.75rem",
      "h2": "2.25rem",
      "h3": "1.75rem",
      "h4": "1.35rem",
      "body": "1rem",
      "small": "0.875rem",
      "tiny": "0.75rem"
    },
    "weights": {
      "light": 300,
      "regular": 400,
      "medium": 500,
      "semibold": 600,
      "bold": 700
    }
  },
  "logos": {
    "base_url": "https://aphrrfprbixmhissnjfn.supabase.co/storage/v1/object/public/housephotos/logos",
    "icon_dark": "alpaca-head-black-transparent.png",
    "icon_light": "alpaca-head-white-transparent.png",
    "wordmark_dark": "wordmark-black-transparent.png",
    "wordmark_light": "wordmark-white-transparent.png",
    "sizes": {
      "header_icon": "30px",
      "header_wordmark": "22px",
      "footer_icon": "52px",
      "footer_wordmark": "24px",
      "email_icon": "40px",
      "email_wordmark": "28px"
    }
  },
  "visual": {
    "border_radius": {
      "small": "6px",
      "standard": "8px",
      "large": "16px",
      "pill": "100px"
    },
    "shadows": {
      "small": "0 1px 2px rgba(42, 31, 35, 0.04)",
      "standard": "0 2px 8px rgba(42, 31, 35, 0.06), 0 1px 2px rgba(42, 31, 35, 0.04)",
      "large": "0 8px 24px rgba(42, 31, 35, 0.08), 0 2px 6px rgba(42, 31, 35, 0.04)",
      "accent_glow": "0 2px 8px rgba(212, 136, 58, 0.30)"
    },
    "transitions": {
      "standard": "0.2s ease",
      "slow": "0.4s cubic-bezier(0.16, 1, 0.3, 1)"
    }
  },
  "email": {
    "max_width": "600px",
    "header": {
      "background": "#1c1618",
      "text_color": "#faf9f6",
      "padding": "32px",
      "logo_height": "40px",
      "wordmark_height": "20px"
    },
    "body": {
      "background": "#faf9f6",
      "text_color": "#2a1f23",
      "text_muted": "#7d6f74",
      "padding": "32px",
      "line_height": "1.6"
    },
    "callout": {
      "background": "#f2f0e8",
      "border_color": "#e6e2d9",
      "border_radius": "8px",
      "padding": "20px 24px"
    },
    "button": {
      "background": "#d4883a",
      "text_color": "#ffffff",
      "border_radius": "8px",
      "padding": "14px 36px",
      "font_weight": "600",
      "shadow": "0 2px 8px rgba(212, 136, 58, 0.30)"
    },
    "footer": {
      "background": "#f2f0e8",
      "text_color": "#7d6f74",
      "border_top": "1px solid #e6e2d9",
      "padding": "20px 32px"
    }
  }
}'::jsonb)
ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now();
