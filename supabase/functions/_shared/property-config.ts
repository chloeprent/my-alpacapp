/**
 * Property configuration loader for edge functions.
 * Fetches operational identity from `property_config` table.
 * Per-invocation cache (edge functions are short-lived).
 */

const FALLBACK_CONFIG: Record<string, any> = {
  property: {
    name: "YOUR_PROPERTY_NAME",
    short_name: "YOUR_APP_NAME",
    tagline: "We put the AI into Propertys",
    address: "123 Main St, Your City, ST 00000",
    city: "Your City",
    state: "TX",
    zip: "00000",
    country: "US",
    latitude: 30.13,
    longitude: -97.46,
    timezone: "America/Chicago",
  },
  domain: {
    primary: "YOUR_DOMAIN",
    github_pages: "USERNAME.github.io/REPO",
    camera_proxy: "YOUR_CAMERA_PROXY",
  },
  email: {
    team: "team@YOUR_DOMAIN",
    admin_gmail: "admin@YOUR_DOMAIN",
    notifications_from: "notifications@YOUR_DOMAIN",
    noreply_from: "noreply@YOUR_DOMAIN",
    automation: "automation@YOUR_DOMAIN",
  },
  payment: {
    zelle_email: "admin@YOUR_DOMAIN",
    venmo_handle: "@PropertyPlayhouse",
  },
  ai_assistant: {
    name: "PAI",
    full_name: "Prompt Property Intelligence",
    personality: "the AI assistant for the property",
    email_from: "pai@YOUR_DOMAIN",
  },
  wifi: {
    network_name: "Black Rock City",
  },
  mobile_app: {
    name: "YOUR_PROPERTY_NAME",
    id: "com.yourorg.app",
  },
};

let _cached: Record<string, any> | null = null;

export async function getPropertyConfig(
  supabase: any
): Promise<Record<string, any>> {
  if (_cached) return _cached;

  try {
    const { data, error } = await supabase
      .from("property_config")
      .select("config")
      .eq("id", 1)
      .single();

    if (error || !data?.config) {
      _cached = FALLBACK_CONFIG;
    } else {
      _cached = { ...FALLBACK_CONFIG, ...data.config };
    }
  } catch (_e) {
    _cached = FALLBACK_CONFIG;
  }

  return _cached!;
}

export function getFallbackConfig(): Record<string, any> {
  return FALLBACK_CONFIG;
}
