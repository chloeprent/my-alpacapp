/**
 * Reprocess PAI Email — Admin-only edge function to re-run receipt/document processing
 * on an existing inbound email. Useful when Gemini misclassifies an email.
 *
 * POST /functions/v1/reprocess-pai-email
 * Body: { email_id: uuid, force_type?: "receipt" | "document" }
 *
 * Requires service role key or admin JWT.
 * Deploy with: supabase functions deploy reprocess-pai-email --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { uploadToR2 } from "../_shared/r2-upload.ts";
import {
  extractReceiptData,
  upsertVendor,
  createPurchase,
} from "../_shared/receipt-processor.ts";

const RESEND_API_URL = "https://api.resend.com";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    // Auth: require service role key or admin user
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY")!;

    // Create admin client for DB operations (uses service role key from env)
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Check if token is service_role JWT by decoding the payload
    let isServiceRole = false;
    try {
      const payloadB64 = token.split(".")[1];
      if (payloadB64) {
        const payload = JSON.parse(atob(payloadB64));
        isServiceRole = payload.role === "service_role";
      }
    } catch { /* not a valid JWT, will try user auth */ }

    // If not service role, verify as admin user JWT
    if (!isServiceRole) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);

      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }

      const { data: appUser } = await supabase
        .from("app_users")
        .select("role")
        .eq("supabase_auth_id", user.id)
        .single();

      if (!appUser || !["admin", "oracle"].includes(appUser.role)) {
        return new Response(JSON.stringify({ error: "Admin role required" }), { status: 403 });
      }
    }

    // Parse request body
    const { email_id, force_type } = await req.json();
    if (!email_id) {
      return new Response(JSON.stringify({ error: "email_id is required" }), { status: 400 });
    }

    // Fetch the inbound email record
    const { data: emailRecord, error: emailError } = await supabase
      .from("inbound_emails")
      .select("*")
      .eq("id", email_id)
      .single();

    if (emailError || !emailRecord) {
      return new Response(
        JSON.stringify({ error: `Email not found: ${emailError?.message || "no record"}` }),
        { status: 404 }
      );
    }

    const subject = emailRecord.subject || "";
    const rawPayload = emailRecord.raw_payload || {};
    const attachmentsMetadata = emailRecord.attachments || rawPayload.attachments || [];
    const resendEmailId = emailRecord.resend_email_id || "";
    const processType = force_type || "receipt";

    if (attachmentsMetadata.length === 0) {
      return new Response(
        JSON.stringify({ error: "No attachments found on this email" }),
        { status: 400 }
      );
    }

    console.log(`Reprocessing email ${email_id} as "${processType}": subject="${subject}", attachments=${attachmentsMetadata.length}`);

    const results: Array<{
      filename: string;
      vendor?: string;
      amount?: number;
      purchaseId?: string;
      vendorId?: string;
      receiptUrl?: string;
      error?: string;
    }> = [];

    for (let i = 0; i < attachmentsMetadata.length; i++) {
      const att = attachmentsMetadata[i];
      const filename = att.filename || att.name || `attachment-${i}`;
      const contentType = att.content_type || att.type || "application/octet-stream";
      const attachmentId = att.id;

      // Only process images and PDFs
      if (!contentType.startsWith("image/") && !contentType.includes("pdf")) {
        console.log(`Skipping non-receipt attachment: ${filename} (${contentType})`);
        results.push({ filename, error: `Skipped: unsupported type ${contentType}` });
        continue;
      }

      if (!attachmentId) {
        results.push({ filename, error: "No attachment ID available" });
        continue;
      }

      try {
        // Download attachment from Resend
        console.log(`Downloading attachment: ${filename} (ID: ${attachmentId})`);
        const attRes = await fetch(
          `${RESEND_API_URL}/emails/receiving/${resendEmailId}/attachments/${attachmentId}`,
          { headers: { Authorization: `Bearer ${resendApiKey}` } }
        );

        if (!attRes.ok) {
          const errText = await attRes.text();
          results.push({ filename, error: `Download failed: ${attRes.status} ${errText}` });
          continue;
        }

        const attData = await attRes.json();
        const downloadUrl = attData.download_url;
        if (!downloadUrl) {
          results.push({ filename, error: "No download_url returned" });
          continue;
        }

        const fileRes = await fetch(downloadUrl);
        if (!fileRes.ok) {
          results.push({ filename, error: `File download failed: ${fileRes.status}` });
          continue;
        }

        const fileData = new Uint8Array(await fileRes.arrayBuffer());
        console.log(`Downloaded: ${filename} (${fileData.length} bytes)`);

        // Extract receipt data using Gemini Vision
        console.log(`Extracting receipt data from ${filename}...`);
        const receiptData = await extractReceiptData(
          fileData,
          attData.content_type || contentType,
          filename
        );

        if (!receiptData) {
          results.push({ filename, error: "Could not extract receipt data from file" });
          continue;
        }

        console.log(`Extracted: ${receiptData.vendor.name}, $${receiptData.totalAmount}`);

        // Upload receipt to R2
        const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
        const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const r2Key = `receipts/${datePrefix}/${sanitizedFilename}`;
        const publicUrl = await uploadToR2(r2Key, fileData, attData.content_type || contentType);

        // Upsert vendor
        const vendorId = await upsertVendor(supabase, receiptData.vendor);
        console.log(`Vendor ${receiptData.vendor.name}: ${vendorId || "not created"}`);

        // Create purchase record
        const purchaseId = await createPurchase(
          supabase,
          receiptData,
          vendorId,
          publicUrl,
          emailRecord.id
        );

        // Log API usage
        await supabase.from("api_usage_log").insert({
          vendor: "gemini",
          category: "receipt_extraction",
          endpoint: "generateContent",
          estimated_cost_usd: 0.001,
          metadata: {
            vendor: receiptData.vendor.name,
            amount: receiptData.totalAmount,
            filename,
            source: "reprocess_pai_email",
          },
        });

        await supabase.from("api_usage_log").insert({
          vendor: "cloudflare_r2",
          category: "r2_receipt_upload",
          endpoint: "PutObject",
          units: 1,
          unit_type: "api_calls",
          estimated_cost_usd: 0,
          metadata: { key: r2Key, size_bytes: fileData.length },
        });

        results.push({
          filename,
          vendor: receiptData.vendor.name,
          amount: receiptData.totalAmount,
          purchaseId: purchaseId || undefined,
          vendorId: vendorId || undefined,
          receiptUrl: publicUrl,
        });
      } catch (err) {
        console.error(`Error processing ${filename}:`, err.message);
        results.push({ filename, error: err.message });
      }
    }

    // Update the email record to reflect reprocessing
    const successCount = results.filter((r) => r.purchaseId).length;
    if (successCount > 0) {
      await supabase
        .from("inbound_emails")
        .update({ route_action: "receipt_processed" })
        .eq("id", email_id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        email_id,
        processed: results.length,
        receipts_created: successCount,
        results,
      }),
      {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }
    );
  } catch (err) {
    console.error("Reprocess error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }
});
