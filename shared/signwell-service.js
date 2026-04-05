/**
 * SignWell Service
 * Integrates with SignWell API for electronic signature collection
 * API Documentation: https://developers.signwell.com/
 */

import { supabase } from './supabase.js';

const SIGNWELL_API_BASE = 'https://www.signwell.com/api/v1';

/**
 * Get SignWell configuration from database
 */
async function getConfig() {
  const { data, error } = await supabase
    .from('signwell_config')
    .select('*')
    .single();

  if (error) {
    console.error('Error fetching SignWell config:', error);
    throw new Error('SignWell not configured. Please add your API key in Settings.');
  }

  if (!data.api_key) {
    throw new Error('SignWell API key not configured. Please add your API key in Settings.');
  }

  return data;
}

/**
 * Make authenticated request to SignWell API
 */
async function signwellRequest(endpoint, options = {}) {
  const config = await getConfig();

  const response = await fetch(`${SIGNWELL_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'X-Api-Key': config.api_key,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const err = new Error(errorData.message || `SignWell API error: ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

/**
 * Create a document for signing
 * @param {string} pdfUrl - URL of the PDF to sign (must be publicly accessible)
 * @param {string} recipientEmail - Email address of the signer (tenant)
 * @param {string} recipientName - Name of the signer (tenant)
 * @param {Object} options - Additional options
 * @param {number} options.pageCount - Total pages in the PDF
 * @param {string} options.documentName - Custom document name
 * @param {number} options.leaseSignaturePage - Page for lease signatures (defaults to last page)
 * @param {number|null} options.waiverSignaturePage - Page for waiver signature (null = no waiver)
 * @param {Object} options.signaturePositions - Dynamic Y positions from PDF generation (72-DPI pixels)
 */
async function createDocument(pdfUrl, recipientEmail, recipientName, options = {}) {
  const config = await getConfig();

  // A4 page at 72 DPI is approximately 595 x 842 pixels.
  // Lease signature fields go on the lease's signature page (detected during PDF generation).
  // If a waiver is appended, waiver signature fields go on the waiver's signature page.
  const leaseSignaturePage = options.leaseSignaturePage || options.pageCount || 1;
  const waiverSignaturePage = options.waiverSignaturePage || null;

  // Use dynamic positions from PDF generation if available, otherwise fall back to defaults.
  // Default positions assume signatures section starts at top of a fresh page.
  const sp = options.signaturePositions || {};
  const landlordSigY = sp.landlordSignatureY || 115;
  const landlordDateY = sp.landlordDateY || 175;
  const tenantSigY = sp.tenantSignatureY || 200;
  const tenantDateY = sp.tenantDateY || 255;

  // Build signature fields array
  const fields = [
    // === LEASE AGREEMENT SIGNATURES (on lease section's signature page) ===
    // Landlord signature + date
    {
      type: 'signature',
      required: true,
      recipient_id: '1',
      page: leaseSignaturePage,
      x: 50,
      y: landlordSigY,
      width: 200,
      height: 35,
    },
    {
      type: 'date',
      required: true,
      recipient_id: '1',
      page: leaseSignaturePage,
      x: 100,
      y: landlordDateY,
      width: 150,
      height: 20,
    },
    // Tenant signature + date (lease)
    {
      type: 'signature',
      required: true,
      recipient_id: '2',
      page: leaseSignaturePage,
      x: 50,
      y: tenantSigY,
      width: 200,
      height: 35,
    },
    {
      type: 'date',
      required: true,
      recipient_id: '2',
      page: leaseSignaturePage,
      x: 100,
      y: tenantDateY,
      width: 150,
      height: 20,
    },
  ];

  // === WAIVER SIGNATURE (on waiver section's signature page, tenant only) ===
  // The waiver is a separate acknowledgment — only the tenant/participant signs it.
  // This ensures conspicuous, separate waiver acceptance for stronger legal enforceability.
  if (waiverSignaturePage) {
    const waiverSigY = sp.waiverSignatureY || 200;
    const waiverDateY = sp.waiverDateY || 255;
    fields.push(
      {
        type: 'signature',
        required: true,
        recipient_id: '2',
        page: waiverSignaturePage,
        x: 50,
        y: waiverSigY,
        width: 200,
        height: 35,
      },
      {
        type: 'date',
        required: true,
        recipient_id: '2',
        page: waiverSignaturePage,
        x: 100,
        y: waiverDateY,
        width: 150,
        height: 20,
      }
    );
  }

  const documentData = {
    test_mode: config.test_mode,
    files: [
      {
        name: `${options.documentName || 'Lease Agreement'}.pdf`,
        file_url: pdfUrl,
      },
    ],
    name: options.documentName || 'Lease Agreement',
    recipients: [
      {
        id: '1',
        name: 'Rahul Sonnad',
        email: 'admin@YOUR_DOMAIN',
        role: 'Landlord',
      },
      {
        id: '2',
        name: recipientName,
        email: recipientEmail,
        role: 'Tenant',
      },
    ],
    // fields is a 2D array — one array of fields per file
    fields: [fields],
    // Send email automatically
    delivery: 'email',
  };

  const result = await signwellRequest('/documents', {
    method: 'POST',
    body: JSON.stringify(documentData),
  });

  return result;
}

/**
 * Get document status
 * @param {string} documentId - SignWell document ID
 */
async function getDocumentStatus(documentId) {
  const result = await signwellRequest(`/documents/${documentId}`);
  return result;
}

/**
 * Download completed/signed PDF
 * @param {string} documentId - SignWell document ID
 */
async function downloadSignedPdf(documentId) {
  const config = await getConfig();

  const response = await fetch(`${SIGNWELL_API_BASE}/documents/${documentId}/completed_pdf`, {
    headers: {
      'X-Api-Key': config.api_key,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download signed PDF: ${response.status}`);
  }

  return response.blob();
}

/**
 * Send a reminder to signer
 * @param {string} documentId - SignWell document ID
 */
async function sendReminder(documentId) {
  const result = await signwellRequest(`/documents/${documentId}/send_reminder`, {
    method: 'POST',
  });
  return result;
}

/**
 * Delete/cancel a document
 * @param {string} documentId - SignWell document ID
 */
async function deleteDocument(documentId) {
  const result = await signwellRequest(`/documents/${documentId}`, {
    method: 'DELETE',
  });
  return result;
}

/**
 * Update rental application with SignWell document info
 */
async function linkDocumentToApplication(applicationId, signwellDocumentId) {
  const { error } = await supabase
    .from('rental_applications')
    .update({
      signwell_document_id: signwellDocumentId,
      agreement_status: 'sent',
      agreement_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', applicationId);

  if (error) throw error;
}

/**
 * Full workflow: Send document for signature
 * 1. Creates document in SignWell
 * 2. Links to rental application
 * 3. Returns document info
 * @param {number} pageCount - Total pages in the PDF
 * @param {Object} pageOptions - Page-specific signature placement
 * @param {number} pageOptions.leaseSignaturePage - Page for lease signatures
 * @param {number|null} pageOptions.waiverSignaturePage - Page for waiver signature (null = no waiver)
 */
async function sendForSignature(applicationId, pdfUrl, recipientEmail, recipientName, pageCount, pageOptions = {}) {
  // Create document in SignWell
  const document = await createDocument(pdfUrl, recipientEmail, recipientName, {
    documentName: `Lease Agreement - ${recipientName}`,
    pageCount,
    leaseSignaturePage: pageOptions.leaseSignaturePage || pageCount,
    waiverSignaturePage: pageOptions.waiverSignaturePage || null,
    signaturePositions: pageOptions.signaturePositions || null,
  });

  // Link to application
  await linkDocumentToApplication(applicationId, document.id);

  return document;
}

export const signwellService = {
  getConfig,
  createDocument,
  getDocumentStatus,
  downloadSignedPdf,
  sendReminder,
  deleteDocument,
  linkDocumentToApplication,
  sendForSignature,
};
