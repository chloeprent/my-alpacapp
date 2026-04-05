/**
 * Shared helper for logging external API usage to api_usage_log table.
 * All edge functions that call external APIs MUST log usage per CLAUDE.md standards.
 */

interface ApiUsageData {
  vendor: string;
  category: string;
  endpoint?: string;
  input_tokens?: number;
  output_tokens?: number;
  units?: number;
  unit_type?: string;
  estimated_cost_usd?: number;
  metadata?: Record<string, any>;
  app_user_id?: string | null;
}

export async function logApiUsage(
  supabase: any,
  data: ApiUsageData
): Promise<void> {
  try {
    await supabase.from("api_usage_log").insert({
      vendor: data.vendor,
      category: data.category,
      endpoint: data.endpoint ?? null,
      input_tokens: data.input_tokens ?? null,
      output_tokens: data.output_tokens ?? null,
      units: data.units ?? null,
      unit_type: data.unit_type ?? null,
      estimated_cost_usd: data.estimated_cost_usd ?? 0,
      metadata: data.metadata ?? null,
      app_user_id: data.app_user_id ?? null,
    });
  } catch (err) {
    console.error("Failed to log API usage:", err);
  }
}
