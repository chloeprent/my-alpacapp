/**
 * Receipt processing module - extracts vendor and purchase information from receipts
 * using Gemini Vision API (for images/PDFs) or text extraction.
 */

interface VendorInfo {
  name: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  category?: string;
}

interface PurchaseItem {
  name: string;
  quantity?: number;
  price?: number;
  description?: string;
}

interface ReceiptData {
  vendor: VendorInfo;
  totalAmount: number;
  taxAmount?: number;
  subtotal?: number;
  purchaseDate?: string; // ISO date string
  paymentMethod?: string;
  category?: string;
  items?: PurchaseItem[];
  rawText?: string;
}

/**
 * Extract receipt information from an attachment using Gemini.
 * Handles both images and PDFs.
 */
export async function extractReceiptData(
  fileBuffer: Uint8Array,
  contentType: string,
  filename: string
): Promise<ReceiptData | null> {
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiApiKey) {
    console.warn("GEMINI_API_KEY not set, cannot extract receipt data");
    return null;
  }

  try {
    // Convert buffer to base64 for Gemini API (chunk to avoid stack overflow on large files)
    let binaryStr = "";
    const chunkSize = 8192;
    for (let i = 0; i < fileBuffer.length; i += chunkSize) {
      const chunk = fileBuffer.subarray(i, i + chunkSize);
      binaryStr += String.fromCharCode(...chunk);
    }
    const base64Data = btoa(binaryStr);

    const prompt = `You are a receipt parser. Extract ALL information from this receipt/invoice.

Extract and return a JSON object with this EXACT structure (all fields optional except vendor.name and totalAmount):
{
  "vendor": {
    "name": "Business name",
    "email": "contact@email.com",
    "phone": "+1234567890",
    "website": "https://website.com",
    "address": "Full address if available",
    "category": "One of: grocery, hardware, utilities, services, dining, retail, automotive, healthcare, supplies, other"
  },
  "totalAmount": 123.45,
  "taxAmount": 10.00,
  "subtotal": 113.45,
  "purchaseDate": "2026-02-15",
  "paymentMethod": "credit_card|debit|cash|check|other",
  "category": "Same as vendor.category",
  "items": [
    {"name": "Item 1", "quantity": 2, "price": 50.00, "description": "optional details"},
    {"name": "Item 2", "quantity": 1, "price": 13.45}
  ],
  "rawText": "All extracted text from the receipt for reference"
}

IMPORTANT:
- vendor.name and totalAmount are REQUIRED
- For category, choose the most appropriate from the list above
- Parse dates as YYYY-MM-DD format
- Include as many items as you can identify with prices
- If you can't determine a field, omit it (don't use null)
- Return ONLY valid JSON, no markdown, no explanation`;

    // Use Gemini 2.0 Flash for vision + parsing
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: contentType,
                    data: base64Data,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2000,
          },
        }),
      }
    );

    if (!res.ok) {
      console.error(`Gemini receipt extraction failed: ${res.status}`);
      return null;
    }

    const result = await res.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Log token usage
    const usage = result.usageMetadata;
    if (usage) {
      console.log(
        `Gemini receipt extraction: in=${usage.promptTokenCount}, out=${usage.candidatesTokenCount}, file=${filename}`
      );
    }

    // Parse JSON from response (strip markdown if present)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("No JSON found in Gemini response");
      return null;
    }

    const parsed: ReceiptData = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!parsed.vendor?.name || typeof parsed.totalAmount !== "number") {
      console.error("Missing required fields in receipt data");
      return null;
    }

    return parsed;
  } catch (err) {
    console.error("Receipt extraction error:", err.message);
    return null;
  }
}

/**
 * Check if a filename looks like a receipt based on common patterns.
 */
export function looksLikeReceipt(filename: string, subject?: string): boolean {
  const lowerFilename = filename.toLowerCase();
  const lowerSubject = (subject || "").toLowerCase();

  const receiptPatterns = [
    /receipt/i,
    /invoice/i,
    /bill/i,
    /purchase/i,
    /order.*confirmation/i,
    /payment.*receipt/i,
    /transaction/i,
  ];

  return (
    receiptPatterns.some((p) => p.test(lowerFilename)) ||
    receiptPatterns.some((p) => p.test(lowerSubject))
  );
}

/**
 * Find or create a vendor in the database.
 * Returns the vendor ID.
 */
export async function upsertVendor(
  supabase: any,
  vendorInfo: VendorInfo
): Promise<string | null> {
  try {
    // Try to find existing vendor by name (case-insensitive)
    const { data: existing } = await supabase
      .from("vendors")
      .select("id, name, email, phone, website, address, category, total_spent, purchase_count")
      .ilike("name", vendorInfo.name)
      .limit(1)
      .single();

    if (existing) {
      // Update vendor info if we have new data
      const updates: any = { updated_at: new Date().toISOString() };
      if (vendorInfo.email && !existing.email) updates.email = vendorInfo.email;
      if (vendorInfo.phone && !existing.phone) updates.phone = vendorInfo.phone;
      if (vendorInfo.website && !existing.website) updates.website = vendorInfo.website;
      if (vendorInfo.address && !existing.address) updates.address = vendorInfo.address;
      if (vendorInfo.category && !existing.category) updates.category = vendorInfo.category;

      if (Object.keys(updates).length > 1) {
        await supabase.from("vendors").update(updates).eq("id", existing.id);
      }

      return existing.id;
    }

    // Create new vendor
    const { data: newVendor, error } = await supabase
      .from("vendors")
      .insert({
        name: vendorInfo.name,
        email: vendorInfo.email,
        phone: vendorInfo.phone,
        website: vendorInfo.website,
        address: vendorInfo.address,
        category: vendorInfo.category || "other",
      })
      .select("id")
      .single();

    if (error) {
      console.error("Error creating vendor:", error);
      return null;
    }

    return newVendor.id;
  } catch (err) {
    console.error("Error upserting vendor:", err.message);
    return null;
  }
}

/**
 * Create a purchase record in the database.
 */
export async function createPurchase(
  supabase: any,
  receiptData: ReceiptData,
  vendorId: string | null,
  receiptUrl: string,
  inboundEmailId: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("purchases")
      .insert({
        vendor_id: vendorId,
        vendor_name: receiptData.vendor.name,
        total_amount: receiptData.totalAmount,
        tax_amount: receiptData.taxAmount,
        subtotal: receiptData.subtotal,
        purchase_date: receiptData.purchaseDate,
        payment_method: receiptData.paymentMethod,
        category: receiptData.category || receiptData.vendor.category || "other",
        items: receiptData.items ? JSON.stringify(receiptData.items) : null,
        raw_text: receiptData.rawText,
        receipt_url: receiptUrl,
        inbound_email_id: inboundEmailId,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Error creating purchase:", error);
      return null;
    }

    // Update vendor stats
    if (vendorId) {
      await supabase.rpc("increment_vendor_stats", {
        vendor_uuid: vendorId,
        amount: receiptData.totalAmount,
      });
    }

    return data.id;
  } catch (err) {
    console.error("Error creating purchase:", err.message);
    return null;
  }
}
