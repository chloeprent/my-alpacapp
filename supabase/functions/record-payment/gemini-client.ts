/**
 * Gemini API Client for Tenant Matching
 * Uses Google's Gemini API to intelligently match payment senders to tenants
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

export interface TenantInfo {
  index: number;
  person_id: string;
  assignment_id: string;
  full_name: string;
  email: string | null;
  monthly_rent: number | null;
  deposit: number | null;
}

export interface GeminiMatchResult {
  matched: boolean;
  person_id?: string;
  person_name?: string;
  assignment_id?: string;
  confidence: number;
  reasoning?: string;
  suggestions?: Array<{
    person_id: string;
    name: string;
    confidence: number;
    reasoning: string;
  }>;
  raw_response?: unknown;
}

/**
 * Match a payment sender to a tenant using Gemini AI
 */
export async function matchWithGemini(
  supabase: ReturnType<typeof createClient>,
  senderName: string,
  paymentAmount: number | null
): Promise<GeminiMatchResult> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    console.error('GEMINI_API_KEY not configured');
    return { matched: false, confidence: 0, reasoning: 'Gemini API key not configured' };
  }

  // Fetch all active tenants with their rent amounts
  const { data: tenants, error } = await supabase
    .from('assignments')
    .select(`
      id,
      rate_amount,
      deposit_amount,
      person:person_id (
        id,
        first_name,
        last_name,
        email
      )
    `)
    .in('status', ['active', 'pending_contract', 'contract_sent']);

  if (error) {
    console.error('Error fetching tenants:', error);
    return { matched: false, confidence: 0, reasoning: 'Database error' };
  }

  if (!tenants || tenants.length === 0) {
    return { matched: false, confidence: 0, reasoning: 'No active tenants found' };
  }

  // Build tenant list for prompt
  const tenantList: TenantInfo[] = tenants.map((t, idx) => {
    const person = t.person as { id: string; first_name: string; last_name: string; email: string | null };
    return {
      index: idx + 1,
      person_id: person.id,
      assignment_id: t.id,
      full_name: `${person.first_name} ${person.last_name}`,
      email: person.email,
      monthly_rent: t.rate_amount,
      deposit: t.deposit_amount
    };
  });

  const prompt = buildMatchingPrompt(senderName, paymentAmount, tenantList);

  try {
    // Call Gemini API
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1, // Low temperature for consistent matching
            topP: 0.8,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', errorText);
      return { matched: false, confidence: 0, reasoning: `Gemini API error: ${response.status}` };
    }

    const geminiResponse = await response.json();
    const content = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
      console.error('Empty Gemini response:', geminiResponse);
      return { matched: false, confidence: 0, raw_response: geminiResponse };
    }

    // Parse Gemini's JSON response
    const parsed = JSON.parse(content);

    if (parsed.best_match && parsed.confidence >= 0.85) {
      const matchedTenant = tenantList.find(t => t.index === parsed.best_match);
      if (matchedTenant) {
        return {
          matched: true,
          person_id: matchedTenant.person_id,
          person_name: matchedTenant.full_name,
          assignment_id: matchedTenant.assignment_id,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          suggestions: buildSuggestions(parsed.other_possibilities, tenantList),
          raw_response: geminiResponse
        };
      }
    }

    // No confident match - return suggestions
    return {
      matched: false,
      confidence: parsed.confidence || 0,
      reasoning: parsed.reasoning,
      suggestions: buildSuggestions(
        parsed.best_match
          ? [{ index: parsed.best_match, confidence: parsed.confidence, reasoning: parsed.reasoning }, ...(parsed.other_possibilities || [])]
          : parsed.other_possibilities,
        tenantList
      ),
      raw_response: geminiResponse
    };
  } catch (err) {
    console.error('Gemini matching error:', err);
    return { matched: false, confidence: 0, reasoning: `Error: ${err.message}` };
  }
}

function buildSuggestions(
  possibilities: Array<{ index: number; confidence: number; reasoning: string }> | undefined,
  tenantList: TenantInfo[]
): Array<{ person_id: string; name: string; confidence: number; reasoning: string }> {
  if (!possibilities) return [];

  return possibilities
    .map(p => {
      const tenant = tenantList.find(t => t.index === p.index);
      return tenant
        ? {
            person_id: tenant.person_id,
            name: tenant.full_name,
            confidence: p.confidence,
            reasoning: p.reasoning
          }
        : null;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
}

function buildMatchingPrompt(
  senderName: string,
  paymentAmount: number | null,
  tenants: TenantInfo[]
): string {
  const tenantListStr = tenants
    .map(
      t =>
        `${t.index}. ${t.full_name}${t.email ? ` (email: ${t.email})` : ''}
   - Monthly Rent: ${t.monthly_rent ? `$${t.monthly_rent.toFixed(2)}` : 'N/A'}
   - Deposit: ${t.deposit ? `$${t.deposit.toFixed(2)}` : 'N/A'}`
    )
    .join('\n');

  return `You are a payment matching assistant for a property management system. Your task is to match a payment sender name to the correct tenant.

PAYMENT INFORMATION:
- Sender Name: "${senderName}"
${paymentAmount ? `- Payment Amount: $${paymentAmount.toFixed(2)}` : '- Payment Amount: Unknown'}

CURRENT TENANTS:
${tenantListStr}

MATCHING RULES:
1. Name matching should be case-insensitive and handle:
   - Different capitalizations (JOHN SMITH = John Smith)
   - Name variations (Mike = Michael, Bob = Robert, Kym = Kymberly, etc.)
   - Partial matches (J. Smith might be John Smith)
   - Common typos (JHON = JOHN)
   - Name order variations (Smith John = John Smith)
   - Missing spaces or extra spaces

2. Payment amount matching (if amount provided):
   - If amount matches monthly rent exactly: increase confidence by 30%
   - If amount matches deposit exactly: increase confidence by 20%
   - If amount is close to rent (within $10): increase confidence by 15%

3. Confidence scoring:
   - 0.95-1.00: Exact or near-exact name match
   - 0.85-0.94: Strong match with minor variations
   - 0.70-0.84: Likely match but some uncertainty
   - Below 0.70: Low confidence, needs manual review

Respond with JSON in this exact format:
{
  "best_match": <tenant index number or null if no reasonable match>,
  "confidence": <0.0 to 1.0>,
  "reasoning": "<brief explanation of why this match was chosen or why no match was found>",
  "other_possibilities": [
    {
      "index": <tenant index>,
      "confidence": <0.0 to 1.0>,
      "reasoning": "<why this could be a match>"
    }
  ]
}

Important: Only include other_possibilities if there are alternative candidates with confidence > 0.5. If best_match is null, still provide reasoning for why no match was found.`;
}
