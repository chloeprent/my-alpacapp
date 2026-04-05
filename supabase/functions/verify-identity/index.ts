/**
 * Identity Verification Edge Function
 * Receives DL photo uploads, calls Gemini Vision to extract data,
 * compares to rental applicant or associate, auto-approves or flags for review.
 *
 * Supports two contexts:
 * - Rental applicant: token has rental_application_id + person_id
 * - Associate: token has app_user_id (no rental_application_id)
 *
 * Deploy with: supabase functions deploy verify-identity --no-verify-jwt
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    // Parse multipart form data
    const formData = await req.formData();
    const token = formData.get('token') as string;
    const file = formData.get('file') as File;

    if (!token || !file) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: token, file' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate file type
    if (!file.type.startsWith('image/')) {
      return new Response(
        JSON.stringify({ error: 'File must be an image' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate token — fetch with both person and app_user joins
    const { data: tokenRecord, error: tokenError } = await supabase
      .from('upload_tokens')
      .select('*, person:person_id(id, first_name, last_name, email), app_user:app_user_id(id, first_name, last_name, email)')
      .eq('token', token)
      .eq('is_used', false)
      .single();

    if (tokenError || !tokenRecord) {
      return new Response(
        JSON.stringify({ error: 'Invalid or already-used upload token' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'This upload link has expired. Please request a new one.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Determine context: rental applicant (person_id) vs associate (app_user_id)
    const isAssociateContext = !tokenRecord.person_id && !!tokenRecord.app_user_id;
    const person = isAssociateContext
      ? tokenRecord.app_user as { id: string; first_name: string; last_name: string; email: string }
      : tokenRecord.person as { id: string; first_name: string; last_name: string; email: string };

    // Upload image to storage
    const fileBuffer = await file.arrayBuffer();
    const ext = file.name?.split('.').pop() || 'jpg';
    const storagePath = isAssociateContext
      ? `associate-${tokenRecord.app_user_id}/${Date.now()}.${ext}`
      : `${tokenRecord.rental_application_id}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('identity-documents')
      .upload(storagePath, fileBuffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      throw new Error('Failed to store document');
    }

    // Generate signed URL (private bucket)
    const { data: signedUrlData } = await supabase.storage
      .from('identity-documents')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 365); // 1 year

    const documentUrl = signedUrlData?.signedUrl || '';

    // Call Gemini Vision API with retry
    const uint8Array = new Uint8Array(fileBuffer);
    let binaryString = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binaryString += String.fromCharCode(uint8Array[i]);
    }
    const base64Image = btoa(binaryString);

    // Two prompt variants — the second is rephrased to avoid content filter triggers
    const prompts = [
      `Extract the following information from this driver's license or state ID image.
Return ONLY valid JSON with no additional text or markdown formatting:
{
  "full_name": "Full name exactly as shown",
  "first_name": "First name",
  "last_name": "Last name",
  "date_of_birth": "YYYY-MM-DD or null if unreadable",
  "address": "Full address as shown or null",
  "dl_number": "License number or null",
  "expiration_date": "YYYY-MM-DD or null if unreadable",
  "state": "Issuing state abbreviation or null",
  "confidence": "high or medium or low"
}
If the image is not a valid ID document, return: {"error": "not_a_valid_id"}`,
      `You are a document data extraction assistant for an authorized identity verification system. The user has consented to this verification.
Please read the government-issued identification card in this image and return the data fields below as JSON. This is for a legitimate property management identity check.
Return ONLY valid JSON:
{
  "full_name": "Name on the document",
  "first_name": "Given name",
  "last_name": "Family name",
  "date_of_birth": "YYYY-MM-DD or null",
  "address": "Address on document or null",
  "dl_number": "Document number or null",
  "expiration_date": "YYYY-MM-DD or null",
  "state": "Issuing state code or null",
  "confidence": "high or medium or low"
}
If this is not an ID document, return: {"error": "not_a_valid_id"}`,
    ];

    let extracted: Record<string, any> | null = null;
    let lastError = '';
    let inputTokens = 0;
    let outputTokens = 0;

    // Map common image MIME types to Gemini-supported types
    const mimeType = file.type === 'image/jpg' ? 'image/jpeg' : file.type;

    for (let attempt = 0; attempt < prompts.length; attempt++) {
      const promptText = prompts[attempt];

      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
        const geminiResponse = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64Image,
                  },
                },
                { text: promptText },
              ],
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 1024,
              responseMimeType: 'application/json',
            },
          }),
        });

        if (!geminiResponse.ok) {
          const errBody = await geminiResponse.text();
          console.error(`Gemini API error (attempt ${attempt + 1}):`, errBody);

          // Check for safety/content filter block — retry with alternate prompt
          if (errBody.includes('SAFETY') || errBody.includes('blocked') || errBody.includes('HARM')) {
            lastError = 'Content filter triggered';
            console.log(`Content filter block on attempt ${attempt + 1}, ${attempt + 1 < prompts.length ? 'retrying with alternate prompt...' : 'no more retries'}`);
            continue;
          }

          throw new Error('Failed to analyze document');
        }

        const geminiResult = await geminiResponse.json();

        // Check for safety blocks in candidates
        const candidate = geminiResult.candidates?.[0];
        if (candidate?.finishReason === 'SAFETY' || !candidate?.content) {
          console.log(`Safety block in response (attempt ${attempt + 1}), ${attempt + 1 < prompts.length ? 'retrying...' : 'no more retries'}`);
          lastError = 'Content filter triggered on response';
          continue;
        }

        const extractedText = candidate.content?.parts?.[0]?.text || '';

        // Track token usage
        const usage = geminiResult.usageMetadata || {};
        inputTokens = usage.promptTokenCount || 0;
        outputTokens = usage.candidatesTokenCount || 0;

        if (!extractedText) {
          console.log(`Empty response (attempt ${attempt + 1}), ${attempt + 1 < prompts.length ? 'retrying...' : 'no more retries'}`);
          lastError = 'Empty AI response';
          continue;
        }

        // Parse JSON from Gemini response (handle markdown code blocks)
        let cleanJson = extractedText.trim();
        if (cleanJson.startsWith('```')) {
          cleanJson = cleanJson.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }

        try {
          extracted = JSON.parse(cleanJson);
          console.log(`Successfully extracted ID data on attempt ${attempt + 1}`);
          break; // Success — exit retry loop
        } catch {
          console.error(`Failed to parse Gemini response (attempt ${attempt + 1}):`, extractedText);
          lastError = 'Failed to parse document data';
          continue;
        }
      } catch (fetchErr) {
        console.error(`Fetch error (attempt ${attempt + 1}):`, fetchErr);
        lastError = fetchErr instanceof Error ? fetchErr.message : 'Unknown error';
        if (attempt + 1 >= prompts.length) throw fetchErr;
      }
    }

    // Log API usage regardless of success/failure
    await supabase.from('api_usage_log').insert({
      vendor: 'gemini',
      category: 'identity_verification',
      endpoint: 'generateContent',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: (inputTokens * 0.15 / 1_000_000) + (outputTokens * 3.50 / 1_000_000), // Gemini 2.5 Flash pricing
      metadata: { model: 'gemini-2.5-flash', success: !!extracted },
    });

    if (!extracted) {
      // All attempts failed — return a user-friendly error instead of crashing
      return new Response(
        JSON.stringify({
          success: false,
          error: 'We were unable to analyze your ID photo. This can happen with certain image types or lighting conditions. Please try again with a clearer, well-lit photo of your ID. If this persists, contact team@YOUR_DOMAIN.',
          technical_detail: lastError,
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build verification insert record (shared fields)
    const verificationBase: Record<string, any> = {
      upload_token_id: tokenRecord.id,
      document_url: documentUrl,
    };
    if (isAssociateContext) {
      verificationBase.app_user_id = tokenRecord.app_user_id;
    } else {
      verificationBase.rental_application_id = tokenRecord.rental_application_id;
      verificationBase.person_id = tokenRecord.person_id;
    }

    if (extracted.error === 'not_a_valid_id') {
      // Still store the attempt but mark as failed
      const { data: verification } = await supabase
        .from('identity_verifications')
        .insert({
          ...verificationBase,
          extraction_raw_json: extracted,
          verification_status: 'flagged',
          name_match_score: 0,
          name_match_details: 'Uploaded image is not a valid ID document',
        })
        .select()
        .single();

      // Mark token as used
      await supabase
        .from('upload_tokens')
        .update({ is_used: true, used_at: new Date().toISOString() })
        .eq('id', tokenRecord.id);

      // Update the appropriate record
      if (isAssociateContext) {
        await updateAssociateVerification(supabase, tokenRecord.app_user_id, 'flagged', verification?.id);
      } else {
        await supabase
          .from('rental_applications')
          .update({
            identity_verification_status: 'flagged',
            identity_verification_id: verification?.id,
            updated_at: new Date().toISOString(),
          })
          .eq('id', tokenRecord.rental_application_id);
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: 'The uploaded image does not appear to be a valid ID document. Please try again with a clear photo of your driver\'s license.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Name comparison
    const appFirst = (person?.first_name || '').trim().toLowerCase();
    const appLast = (person?.last_name || '').trim().toLowerCase();
    const dlFirst = (extracted.first_name || '').trim().toLowerCase();
    const dlLast = (extracted.last_name || '').trim().toLowerCase();
    const applicationName = `${person?.first_name || ''} ${person?.last_name || ''}`.trim();
    const extractedName = extracted.full_name || '';
    const { score, details } = compareNameParts(appFirst, appLast, dlFirst, dlLast);

    // Check DL expiration
    const isExpired = extracted.expiration_date
      ? new Date(extracted.expiration_date) < new Date()
      : false;

    // Determine verification status
    const AUTO_APPROVE_THRESHOLD = 80;
    const verificationStatus = score >= AUTO_APPROVE_THRESHOLD && !isExpired
      ? 'auto_approved'
      : 'flagged';

    // Store verification record
    const { data: verification, error: verError } = await supabase
      .from('identity_verifications')
      .insert({
        ...verificationBase,
        document_type: 'drivers_license',
        extracted_full_name: extracted.full_name,
        extracted_first_name: extracted.first_name,
        extracted_last_name: extracted.last_name,
        extracted_dob: extracted.date_of_birth,
        extracted_address: extracted.address,
        extracted_dl_number: extracted.dl_number,
        extracted_expiration_date: extracted.expiration_date,
        extracted_state: extracted.state,
        extraction_raw_json: extracted,
        verification_status: verificationStatus,
        name_match_score: score,
        name_match_details: details,
        is_expired_dl: isExpired,
      })
      .select()
      .single();

    if (verError) {
      console.error('Error storing verification:', verError);
      throw new Error('Failed to store verification');
    }

    // Mark token as used
    await supabase
      .from('upload_tokens')
      .update({ is_used: true, used_at: new Date().toISOString() })
      .eq('id', tokenRecord.id);

    // Update the appropriate record
    const appStatus = verificationStatus === 'auto_approved' ? 'verified' : 'flagged';
    if (isAssociateContext) {
      await updateAssociateVerification(supabase, tokenRecord.app_user_id, appStatus, verification.id);
    } else {
      await supabase
        .from('rental_applications')
        .update({
          identity_verification_status: appStatus,
          identity_verification_id: verification.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', tokenRecord.rental_application_id);
    }

    // Send emails
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

    if (RESEND_API_KEY && person?.email) {
      try {
        if (verificationStatus === 'auto_approved') {
          await fetch(`${supabaseUrl}/functions/v1/send-email`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              type: 'dl_verified',
              to: person.email,
              data: { first_name: person.first_name },
            }),
          });
        } else {
          const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL') || 'automation@YOUR_DOMAIN';
          const adminUrl = isAssociateContext
            ? `https://USERNAME.github.io/REPO/spaces/admin/worktracking.html`
            : `https://USERNAME.github.io/REPO/spaces/admin/rentals.html`;
          await fetch(`${supabaseUrl}/functions/v1/send-email`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              type: 'dl_mismatch',
              to: ADMIN_EMAIL,
              data: {
                applicant_name: applicationName,
                extracted_name: extractedName,
                match_score: score,
                admin_url: adminUrl,
                is_expired: isExpired,
              },
            }),
          });
        }
      } catch (emailErr) {
        console.error('Error sending verification email:', emailErr);
      }
    }

    const contextLabel = isAssociateContext
      ? `associate ${tokenRecord.app_user_id}`
      : `application ${tokenRecord.rental_application_id}`;
    console.log(`Identity verification completed: ${verificationStatus}, score: ${score}, for ${contextLabel}`);

    return new Response(
      JSON.stringify({
        success: true,
        verification_status: verificationStatus,
        name_match_score: score,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Verification error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

/**
 * Update associate_profiles with verification result
 */
async function updateAssociateVerification(
  supabase: any,
  appUserId: string,
  status: string,
  verificationId: string | undefined
) {
  await supabase
    .from('associate_profiles')
    .update({
      identity_verification_status: status,
      identity_verification_id: verificationId || null,
      updated_at: new Date().toISOString(),
    })
    .eq('app_user_id', appUserId);
}

// Name comparison using extracted first/last name fields directly
function compareNameParts(appFirst: string, appLast: string, dlFirst: string, dlLast: string): { score: number; details: string } {
  const clean = (s: string) => s.toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '').trim();

  const af = clean(appFirst);
  const al = clean(appLast);
  const df = clean(dlFirst);
  const dl = clean(dlLast);

  if (!af || !al || !df || !dl) {
    return { score: 0, details: 'One or more name fields are empty' };
  }

  if (af === df && al === dl) {
    return { score: 100, details: 'Exact match' };
  }

  if (af === dl && al === df) {
    return { score: 95, details: 'Names match (first/last swapped on ID)' };
  }

  const firstDist = levenshteinDistance(af, df);
  const lastDist = levenshteinDistance(al, dl);
  const firstScore = 1 - firstDist / Math.max(af.length, df.length, 1);
  const lastScore = 1 - lastDist / Math.max(al.length, dl.length, 1);
  let combinedScore = Math.round(firstScore * 40 + lastScore * 60);

  const firstDistSwap = levenshteinDistance(af, dl);
  const lastDistSwap = levenshteinDistance(al, df);
  const firstScoreSwap = 1 - firstDistSwap / Math.max(af.length, dl.length, 1);
  const lastScoreSwap = 1 - lastDistSwap / Math.max(al.length, df.length, 1);
  const swappedScore = Math.round(firstScoreSwap * 40 + lastScoreSwap * 60);

  if (swappedScore > combinedScore) {
    combinedScore = swappedScore;
    return {
      score: combinedScore,
      details: `Names match when swapped. First: ${Math.round(firstScoreSwap * 100)}%, Last: ${Math.round(lastScoreSwap * 100)}%`,
    };
  }

  return {
    score: combinedScore,
    details: `First name: ${Math.round(firstScore * 100)}% match, Last name: ${Math.round(lastScore * 100)}% match`,
  };
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}
