/**
 * Guestbook Upload Edge Function
 *
 * Accepts multipart form data with a media file (video/audio),
 * uploads to Cloudflare R2, and creates a guestbook_entries record.
 *
 * Deploy: supabase functions deploy guestbook-upload --no-verify-jwt
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { uploadToR2 } from '../_shared/r2-upload.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const key = formData.get('key') as string;
    const guestName = formData.get('guest_name') as string || null;
    const mediaType = formData.get('media_type') as string || 'video';
    const contentType = formData.get('content_type') as string || 'video/webm';

    if (!file || !key) {
      return new Response(
        JSON.stringify({ error: 'Missing file or key' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Read file bytes
    const bytes = new Uint8Array(await file.arrayBuffer());

    // Enforce 50MB limit
    if (bytes.length > 50 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: 'File too large (max 50MB)' }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Upload to R2
    const publicUrl = await uploadToR2(key, bytes, contentType);

    // Create guestbook entry in DB
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const entry: Record<string, unknown> = {
      guest_name: guestName,
      entry_type: mediaType,
      media_type: mediaType,
      source: 'kiosk',
    };

    if (mediaType === 'video') {
      entry.video_url = publicUrl;
    } else {
      entry.audio_url = publicUrl;
    }

    const { data, error } = await supabase
      .from('guestbook_entries')
      .insert(entry)
      .select('id')
      .single();

    if (error) {
      console.error('DB insert failed:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to save entry', detail: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, id: data.id, url: publicUrl }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('guestbook-upload error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
