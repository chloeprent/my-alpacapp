/**
 * Tenant Matcher
 * Orchestrates the matching process: cache → exact → Gemini
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { normalizeName } from './payment-parser.ts';
import { matchWithGemini } from './gemini-client.ts';

export interface MatchResult {
  matched: boolean;
  person_id?: string;
  person_name?: string;
  assignment_id?: string;
  confidence: number;
  method: 'cached' | 'gemini' | 'exact' | 'failed';
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
 * Match a payment sender to a tenant
 * Process: 1. Check cache → 2. Try exact match → 3. Use Gemini AI
 */
export async function matchTenant(
  supabase: ReturnType<typeof createClient>,
  senderName: string,
  paymentAmount: number | null,
  forceGemini: boolean = false
): Promise<MatchResult> {
  const normalizedName = normalizeName(senderName);
  console.log(`Matching sender: "${senderName}" (normalized: "${normalizedName}")`);

  // Step 1: Check cached mappings (unless force_gemini)
  if (!forceGemini) {
    const cachedResult = await checkCachedMapping(supabase, normalizedName);
    if (cachedResult) {
      console.log(`Found cached mapping for "${senderName}" → ${cachedResult.person_name}`);
      return cachedResult;
    }
  }

  // Step 2: Try exact name match in people table
  const exactResult = await tryExactMatch(supabase, normalizedName, senderName);
  if (exactResult) {
    console.log(`Found exact match for "${senderName}" → ${exactResult.person_name}`);
    return exactResult;
  }

  // Step 3: Use Gemini for fuzzy matching
  console.log(`No exact match found, using Gemini AI for "${senderName}"`);
  const geminiResult = await matchWithGemini(supabase, senderName, paymentAmount);

  if (geminiResult.matched && geminiResult.confidence >= 0.85) {
    // High confidence match - save mapping and return
    await saveSenderMapping(
      supabase,
      senderName,
      geminiResult.person_id!,
      geminiResult.confidence,
      'gemini'
    );
    console.log(`Gemini matched "${senderName}" → ${geminiResult.person_name} (${geminiResult.confidence})`);

    return {
      matched: true,
      person_id: geminiResult.person_id,
      person_name: geminiResult.person_name,
      assignment_id: geminiResult.assignment_id,
      confidence: geminiResult.confidence,
      method: 'gemini',
      reasoning: geminiResult.reasoning,
      suggestions: geminiResult.suggestions,
      raw_response: geminiResult.raw_response
    };
  }

  // Return as failed with suggestions for manual review
  console.log(`No confident match for "${senderName}", sending to manual review`);
  return {
    matched: false,
    confidence: geminiResult.confidence,
    method: 'failed',
    reasoning: geminiResult.reasoning,
    suggestions: geminiResult.suggestions,
    raw_response: geminiResult.raw_response
  };
}

/**
 * Check if we have a cached mapping for this sender name
 */
async function checkCachedMapping(
  supabase: ReturnType<typeof createClient>,
  normalizedName: string
): Promise<MatchResult | null> {
  const { data: cachedMapping, error } = await supabase
    .from('payment_sender_mappings')
    .select('person_id, confidence_score')
    .eq('sender_name_normalized', normalizedName)
    .single();

  if (error || !cachedMapping) {
    return null;
  }

  // Get person details
  const { data: person } = await supabase
    .from('people')
    .select('id, first_name, last_name')
    .eq('id', cachedMapping.person_id)
    .single();

  if (!person) {
    // Cached mapping points to deleted person, remove it
    await supabase
      .from('payment_sender_mappings')
      .delete()
      .eq('sender_name_normalized', normalizedName);
    return null;
  }

  // Get active assignment
  const { data: assignment } = await supabase
    .from('assignments')
    .select('id')
    .eq('person_id', cachedMapping.person_id)
    .in('status', ['active', 'pending_contract', 'contract_sent'])
    .order('start_date', { ascending: false })
    .limit(1)
    .single();

  return {
    matched: true,
    person_id: person.id,
    person_name: `${person.first_name} ${person.last_name}`,
    assignment_id: assignment?.id,
    confidence: cachedMapping.confidence_score || 1.0,
    method: 'cached'
  };
}

/**
 * Try to find an exact name match in the people table
 */
async function tryExactMatch(
  supabase: ReturnType<typeof createClient>,
  normalizedName: string,
  originalName: string
): Promise<MatchResult | null> {
  // Fetch all tenants
  const { data: people, error } = await supabase
    .from('people')
    .select('id, first_name, last_name')
    .eq('type', 'tenant');

  if (error || !people) {
    return null;
  }

  // Check for exact normalized name match
  for (const person of people) {
    const fullName = `${person.first_name} ${person.last_name}`;
    if (normalizeName(fullName) === normalizedName) {
      // Found exact match - save mapping for future
      await saveSenderMapping(supabase, originalName, person.id, 1.0, 'exact');

      // Get active assignment
      const { data: assignment } = await supabase
        .from('assignments')
        .select('id')
        .eq('person_id', person.id)
        .in('status', ['active', 'pending_contract', 'contract_sent'])
        .order('start_date', { ascending: false })
        .limit(1)
        .single();

      return {
        matched: true,
        person_id: person.id,
        person_name: fullName,
        assignment_id: assignment?.id,
        confidence: 1.0,
        method: 'exact'
      };
    }
  }

  return null;
}

/**
 * Save a sender name → person mapping for future lookups
 */
async function saveSenderMapping(
  supabase: ReturnType<typeof createClient>,
  senderName: string,
  personId: string,
  confidence: number,
  source: string
): Promise<void> {
  const { error } = await supabase.from('payment_sender_mappings').upsert(
    {
      sender_name: senderName,
      sender_name_normalized: normalizeName(senderName),
      person_id: personId,
      confidence_score: confidence,
      match_source: source,
      updated_at: new Date().toISOString()
    },
    {
      onConflict: 'sender_name_normalized'
    }
  );

  if (error) {
    console.error('Error saving sender mapping:', error);
  }
}
