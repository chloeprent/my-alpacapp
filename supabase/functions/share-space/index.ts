// Share Space Edge Function
// Serves HTML with dynamic Open Graph meta tags for social media link previews
// Redirects the user's browser to the actual spaces page

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SITE_URL = "https://YOUR_DOMAIN";
const SITE_NAME = "YOUR_PROPERTY_NAME";
const DEFAULT_IMAGE = "YOUR_SUPABASE_URL/storage/v1/object/public/housephotos/branding/logo-dark.png";
const DEFAULT_DESCRIPTION = "Unique rental and event spaces at Austin's YOUR_PROPERTY_NAME — creative living for adventurous souls.";

serve(async (req: Request) => {
  const url = new URL(req.url);
  const slug = url.searchParams.get("space");

  // No slug — redirect to spaces index
  if (!slug) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${SITE_URL}/spaces/` },
    });
  }

  const canonicalUrl = `${SITE_URL}/spaces/?space=${encodeURIComponent(slug)}`;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch space with first image
    const { data: space, error: dbError } = await supabase
      .from("spaces")
      .select(`
        id, name, slug, description, monthly_rate, weekly_rate, nightly_rate, type,
        media_spaces(display_order, is_primary, media:media_id(url, caption))
      `)
      .eq("slug", slug)
      .eq("is_archived", false)
      .single();

    if (dbError || !space) {
      // Space not found — redirect anyway, let client handle it
      return new Response(null, {
        status: 302,
        headers: { Location: canonicalUrl },
      });
    }

    // Pick best image: primary first, then lowest display_order
    let imageUrl = DEFAULT_IMAGE;
    if (space.media_spaces?.length) {
      const sorted = [...space.media_spaces].sort((a: any, b: any) => {
        if (a.is_primary && !b.is_primary) return -1;
        if (!a.is_primary && b.is_primary) return 1;
        return (a.display_order ?? 999) - (b.display_order ?? 999);
      });
      const bestMedia = sorted[0]?.media;
      if (bestMedia?.url) imageUrl = bestMedia.url;
    }

    // Build title and description
    const title = `${space.name} — ${SITE_NAME}`;
    let description = space.description || DEFAULT_DESCRIPTION;
    // Truncate description to ~200 chars for OG
    if (description.length > 200) {
      description = description.substring(0, 197) + "...";
    }

    // Add rate info to description if available
    const rates: string[] = [];
    if (space.monthly_rate) rates.push(`$${Math.round(space.monthly_rate)}/mo`);
    if (space.weekly_rate) rates.push(`$${Math.round(space.weekly_rate)}/wk`);
    if (space.nightly_rate) rates.push(`$${Math.round(space.nightly_rate)}/night`);
    if (rates.length) {
      const rateStr = rates.join(" · ");
      description = `${rateStr} — ${description}`;
    }

    // Serve HTML with OG tags + instant redirect
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">

  <!-- Redirect browser to real page -->
  <meta http-equiv="refresh" content="0;url=${escapeHtml(canonicalUrl)}">
</head>
<body>
  <p>Redirecting to <a href="${escapeHtml(canonicalUrl)}">${escapeHtml(space.name)}</a>...</p>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
      },
    });
  } catch (err) {
    console.error("share-space error:", err);
    // On error, just redirect
    return new Response(null, {
      status: 302,
      headers: { Location: canonicalUrl },
    });
  }
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
