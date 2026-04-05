// Identity verification service for DL upload and verification
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

const VERIFY_IDENTITY_URL = `${SUPABASE_URL}/functions/v1/verify-identity`;

export const identityService = {
  /**
   * Generate an upload token and return the upload URL
   * @param {string} applicationId - Rental application ID
   * @param {string} personId - Person ID
   * @param {string} createdBy - Admin who triggered it
   * @returns {Promise<{token: string, uploadUrl: string}>}
   */
  async requestVerification(applicationId, personId, createdBy = null) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const { data: token, error } = await supabase
      .from('upload_tokens')
      .insert({
        rental_application_id: applicationId,
        person_id: personId,
        token_type: 'identity_verification',
        expires_at: expiresAt.toISOString(),
        created_by: createdBy,
      })
      .select()
      .single();

    if (error) throw error;

    const uploadUrl = `https://USERNAME.github.io/REPO/spaces/verify.html?token=${token.token}`;

    // Update application status
    await supabase
      .from('rental_applications')
      .update({
        identity_verification_status: 'link_sent',
        updated_at: new Date().toISOString(),
      })
      .eq('id', applicationId);

    return { token: token.token, uploadUrl };
  },

  /**
   * Get the latest verification for an application
   * @param {string} applicationId
   * @returns {Promise<object|null>}
   */
  async getVerification(applicationId) {
    const { data, error } = await supabase
      .from('identity_verifications')
      .select('*')
      .eq('rental_application_id', applicationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  },

  /**
   * Get the upload token for an application
   * @param {string} applicationId
   * @returns {Promise<object|null>}
   */
  async getUploadToken(applicationId) {
    const { data, error } = await supabase
      .from('upload_tokens')
      .select('*')
      .eq('rental_application_id', applicationId)
      .eq('token_type', 'identity_verification')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  },

  /**
   * Manually approve a flagged verification
   * @param {string} verificationId
   * @param {string} reviewedBy
   * @param {string} notes
   */
  async approveVerification(verificationId, reviewedBy, notes = null) {
    const { data, error } = await supabase
      .from('identity_verifications')
      .update({
        verification_status: 'manually_approved',
        reviewed_by: reviewedBy,
        reviewed_at: new Date().toISOString(),
        review_notes: notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', verificationId)
      .select()
      .single();

    if (error) throw error;

    // Update rental application
    await supabase
      .from('rental_applications')
      .update({
        identity_verification_status: 'verified',
        updated_at: new Date().toISOString(),
      })
      .eq('identity_verification_id', verificationId);

    return data;
  },

  /**
   * Manually reject a flagged verification
   * @param {string} verificationId
   * @param {string} reviewedBy
   * @param {string} notes
   */
  async rejectVerification(verificationId, reviewedBy, notes = null) {
    const { data, error } = await supabase
      .from('identity_verifications')
      .update({
        verification_status: 'manually_rejected',
        reviewed_by: reviewedBy,
        reviewed_at: new Date().toISOString(),
        review_notes: notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', verificationId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // =============================================
  // ASSOCIATE VERIFICATION
  // =============================================

  /**
   * Generate an upload token for an associate and return the upload URL
   * @param {string} appUserId - app_users.id
   * @param {string} createdBy - Admin who triggered it (or 'self')
   * @returns {Promise<{token: string, uploadUrl: string}>}
   */
  async requestAssociateVerification(appUserId, createdBy = null, personId = null) {
    // Resolve person_id: prefer passed value, then look up from app_users
    let resolvedPersonId = personId;
    if (!resolvedPersonId) {
      const { data: appUser } = await supabase
        .from('app_users')
        .select('person_id')
        .eq('id', appUserId)
        .single();
      resolvedPersonId = appUser?.person_id;
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const insertData = {
      app_user_id: appUserId,
      token_type: 'identity_verification',
      expires_at: expiresAt.toISOString(),
      created_by: createdBy,
    };
    if (resolvedPersonId) insertData.person_id = resolvedPersonId;

    const { data: token, error } = await supabase
      .from('upload_tokens')
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    const uploadUrl = `https://YOUR_DOMAIN/spaces/verify.html?token=${token.token}`;

    // Update associate profile status
    await supabase
      .from('associate_profiles')
      .update({
        identity_verification_status: 'link_sent',
        updated_at: new Date().toISOString(),
      })
      .eq('app_user_id', appUserId);

    return { token: token.token, uploadUrl };
  },

  /**
   * Get the latest verification for an associate
   * @param {string} appUserId - app_users.id
   * @returns {Promise<object|null>}
   */
  async getAssociateVerification(appUserId) {
    const { data, error } = await supabase
      .from('identity_verifications')
      .select('*')
      .eq('app_user_id', appUserId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  },

  /**
   * Get the upload token for an associate
   * @param {string} appUserId - app_users.id
   * @returns {Promise<object|null>}
   */
  async getAssociateUploadToken(appUserId) {
    const { data, error } = await supabase
      .from('upload_tokens')
      .select('*')
      .eq('app_user_id', appUserId)
      .eq('token_type', 'identity_verification')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  },

  /**
   * Manually approve a flagged associate verification
   */
  async approveAssociateVerification(verificationId, appUserId, reviewedBy, notes = null) {
    const { data, error } = await supabase
      .from('identity_verifications')
      .update({
        verification_status: 'manually_approved',
        reviewed_by: reviewedBy,
        reviewed_at: new Date().toISOString(),
        review_notes: notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', verificationId)
      .select()
      .single();

    if (error) throw error;

    await supabase
      .from('associate_profiles')
      .update({
        identity_verification_status: 'verified',
        identity_verification_id: verificationId,
        updated_at: new Date().toISOString(),
      })
      .eq('app_user_id', appUserId);

    return data;
  },

  /**
   * Manually reject a flagged associate verification
   */
  async rejectAssociateVerification(verificationId, appUserId, reviewedBy, notes = null) {
    const { data, error } = await supabase
      .from('identity_verifications')
      .update({
        verification_status: 'manually_rejected',
        reviewed_by: reviewedBy,
        reviewed_at: new Date().toISOString(),
        review_notes: notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', verificationId)
      .select()
      .single();

    if (error) throw error;

    await supabase
      .from('associate_profiles')
      .update({
        identity_verification_status: 'rejected',
        updated_at: new Date().toISOString(),
      })
      .eq('app_user_id', appUserId);

    return data;
  },
};

export default identityService;
