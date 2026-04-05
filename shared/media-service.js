/**
 * Media Service - Abstraction layer for media storage
 *
 * Handles:
 * - Image uploads to Supabase
 * - Video routing to external storage (GCS - future)
 * - Storage usage tracking
 * - Tagging and categorization
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';
import { errorLogger } from './error-logger.js';

// =============================================
// CONFIGURATION
// =============================================

// Extract project ID from URL for direct storage hostname
const PROJECT_ID = SUPABASE_URL.match(/https:\/\/([^.]+)\./)?.[1] || '';
const STORAGE_URL = PROJECT_ID
  ? `https://${PROJECT_ID}.supabase.co`  // Direct storage hostname for better performance
  : SUPABASE_URL;

const CONFIG = {
  // Storage limits
  supabaseMaxBytes: 1 * 1024 * 1024 * 1024, // 1GB
  warningThreshold: 0.8, // Warn at 80% usage

  // Bucket names
  buckets: {
    images: 'housephotos',
    // videos: 'videos', // Future: GCS bucket
  },

  // Categories
  validCategories: ['space', 'mktg', 'projects', 'archive', 'qr_code'],

  // File type detection
  imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  videoTypes: ['video/mp4', 'video/webm', 'video/quicktime', 'video/avi'],

  // Upload settings
  upload: {
    maxRetries: 3,
    baseRetryDelayMs: 2000,
    timeoutMs: 120000,        // 2 minutes per attempt
    stallTimeoutMs: 30000,    // 30 seconds without progress = stalled
    stallCheckIntervalMs: 5000, // Check for stalls every 5 seconds
  },

  // Error codes that should NOT be retried
  nonRetriableStatusCodes: [400, 401, 403, 413, 422],
  // Error codes that need token refresh before retry
  tokenRefreshStatusCodes: [401],
};

// =============================================
// ERROR CLASSIFICATION
// =============================================

/**
 * Structured error type for upload failures
 */
class UploadError extends Error {
  constructor(message, code, statusCode = null, retriable = true, details = null) {
    super(message);
    this.name = 'UploadError';
    this.code = code;           // e.g., 'NETWORK_ERROR', 'TIMEOUT', 'AUTH_FAILED'
    this.statusCode = statusCode; // HTTP status if applicable
    this.retriable = retriable;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      retriable: this.retriable,
      details: this.details,
      timestamp: this.timestamp,
    };
  }
}

/**
 * Classify HTTP status code into error type
 */
function classifyHttpError(status, responseText = '') {
  let parsed = {};
  try {
    parsed = JSON.parse(responseText);
  } catch (e) { /* ignore */ }

  const serverMessage = parsed.message || parsed.error || '';

  switch (status) {
    case 400:
      if (serverMessage.includes('already exists') || parsed.error === 'Duplicate') {
        return new UploadError(
          'File already exists at this path',
          'DUPLICATE_FILE',
          400,
          false,
          { serverMessage }
        );
      }
      return new UploadError(
        serverMessage || 'Invalid request',
        'INVALID_REQUEST',
        400,
        false,
        { serverMessage }
      );

    case 401:
      return new UploadError(
        'Authentication expired - please refresh and try again',
        'AUTH_EXPIRED',
        401,
        true, // Retriable after token refresh
        { serverMessage, needsTokenRefresh: true }
      );

    case 403:
      return new UploadError(
        'Permission denied - check storage bucket policies',
        'PERMISSION_DENIED',
        403,
        false,
        { serverMessage }
      );

    case 409:
      return new UploadError(
        'Conflict - file is being uploaded by another process',
        'CONFLICT',
        409,
        true, // Can retry after delay
        { serverMessage }
      );

    case 413:
      return new UploadError(
        'File is too large for upload',
        'FILE_TOO_LARGE',
        413,
        false,
        { serverMessage }
      );

    case 429:
      return new UploadError(
        'Too many requests - please wait and try again',
        'RATE_LIMITED',
        429,
        true,
        { serverMessage, retryAfter: 5000 }
      );

    case 500:
    case 502:
    case 503:
    case 504:
      return new UploadError(
        'Server error - please try again',
        'SERVER_ERROR',
        status,
        true,
        { serverMessage }
      );

    default:
      return new UploadError(
        serverMessage || `Upload failed with status ${status}`,
        'UNKNOWN_ERROR',
        status,
        status >= 500, // Server errors are retriable
        { serverMessage }
      );
  }
}

// =============================================
// STORAGE ROUTING
// =============================================

/**
 * Determine which storage provider to use for a file
 */
function getStorageProvider(file) {
  const isVideo = CONFIG.videoTypes.includes(file.type);

  if (isVideo) {
    // Videos always go to external storage (GCS)
    // For now, return 'pending' until GCS is set up
    return 'pending';
  }

  return 'supabase';
}

/**
 * Check if file type is supported
 */
function isSupported(file) {
  return CONFIG.imageTypes.includes(file.type) || CONFIG.videoTypes.includes(file.type);
}

/**
 * Check if file is a video
 */
function isVideo(file) {
  return CONFIG.videoTypes.includes(file.type);
}

// =============================================
// AUTHENTICATION HELPERS
// =============================================

/**
 * Get the current auth token, refreshing if needed
 * Falls back to anon key if no session
 */
async function getAuthToken() {
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) {
      console.warn('[auth] Error getting session, using anon key:', error.message);
      return SUPABASE_ANON_KEY;
    }
    if (session?.access_token) {
      // Check if token is about to expire (within 60 seconds)
      const expiresAt = session.expires_at * 1000; // Convert to ms
      if (expiresAt - Date.now() < 60000) {
        console.log('[auth] Token expiring soon, refreshing...');
        const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError || !refreshed.session) {
          console.warn('[auth] Token refresh failed, using anon key');
          return SUPABASE_ANON_KEY;
        }
        return refreshed.session.access_token;
      }
      return session.access_token;
    }
    return SUPABASE_ANON_KEY;
  } catch (e) {
    console.warn('[auth] Exception getting token, using anon key:', e.message);
    return SUPABASE_ANON_KEY;
  }
}

/**
 * Force refresh the auth token
 */
async function refreshAuthToken() {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session) {
      console.warn('[auth] Force refresh failed:', error?.message);
      return null;
    }
    console.log('[auth] Token refreshed successfully');
    return data.session.access_token;
  } catch (e) {
    console.warn('[auth] Exception during force refresh:', e.message);
    return null;
  }
}

// =============================================
// XHR UPLOAD WITH PROGRESS AND STALL DETECTION
// =============================================

/**
 * Upload file to Supabase storage with progress tracking and stall detection
 * Uses XMLHttpRequest instead of fetch to get upload progress events
 *
 * @param {string} bucket - Storage bucket name
 * @param {string} storagePath - Path within bucket
 * @param {Blob|File} file - File to upload
 * @param {string} contentType - MIME type
 * @param {Function} onProgress - Progress callback (loaded, total) => void
 * @param {Function} onStall - Stall callback () => void (called when upload stalls)
 * @param {string} authToken - Auth token to use
 * @param {Object} options - Additional options
 * @returns {Promise<{data: object|null, error: UploadError|null}>}
 */
function uploadWithProgress(bucket, storagePath, file, contentType, onProgress, onStall, authToken, options = {}) {
  const {
    timeout = CONFIG.upload.timeoutMs,
    stallTimeout = CONFIG.upload.stallTimeoutMs,
    stallCheckInterval = CONFIG.upload.stallCheckIntervalMs,
    allowUpsert = false,
  } = options;

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const url = `${STORAGE_URL}/storage/v1/object/${bucket}/${storagePath}`;

    let lastProgressTime = Date.now();
    let lastLoadedBytes = 0;
    let stallCheckerId = null;
    let isStalled = false;

    // Cleanup function
    const cleanup = () => {
      if (stallCheckerId) {
        clearInterval(stallCheckerId);
        stallCheckerId = null;
      }
    };

    // Stall detection - check periodically if progress has been made
    stallCheckerId = setInterval(() => {
      const timeSinceProgress = Date.now() - lastProgressTime;
      if (timeSinceProgress > stallTimeout && !isStalled) {
        isStalled = true;
        console.warn(`[upload] Upload stalled - no progress for ${timeSinceProgress}ms`);
        if (onStall) {
          onStall();
        }
      }
    }, stallCheckInterval);

    // Track progress and reset stall timer
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        // Only update if we actually made progress
        if (e.loaded > lastLoadedBytes) {
          lastProgressTime = Date.now();
          lastLoadedBytes = e.loaded;
          isStalled = false;
        }
        if (onProgress) {
          onProgress(e.loaded, e.total);
        }
      }
    });

    // Handle completion
    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ data: { path: storagePath }, error: null });
      } else {
        const error = classifyHttpError(xhr.status, xhr.responseText);
        console.warn(`[upload] HTTP ${xhr.status}:`, error.toJSON());
        resolve({ data: null, error });
      }
    });

    xhr.addEventListener('error', () => {
      cleanup();
      const error = new UploadError(
        'Network error during upload - check your connection',
        'NETWORK_ERROR',
        null,
        true,
        { hint: 'This may be due to unstable WiFi, VPN issues, or firewall blocking' }
      );
      console.warn('[upload] Network error:', error.toJSON());
      resolve({ data: null, error });
    });

    xhr.addEventListener('timeout', () => {
      cleanup();
      const error = new UploadError(
        `Upload timed out after ${timeout / 1000} seconds`,
        'TIMEOUT',
        null,
        true,
        { timeoutMs: timeout, wasStalled: isStalled }
      );
      console.warn('[upload] Timeout:', error.toJSON());
      resolve({ data: null, error });
    });

    xhr.addEventListener('abort', () => {
      cleanup();
      const error = new UploadError(
        'Upload was cancelled',
        'ABORTED',
        null,
        false
      );
      resolve({ data: null, error });
    });

    xhr.timeout = timeout;
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    xhr.setRequestHeader('x-upsert', allowUpsert ? 'true' : 'false');
    xhr.send(file);
  });
}

// =============================================
// TUS RESUMABLE UPLOAD (for files > 6MB)
// =============================================

/**
 * Check if TUS client is available
 */
function isTusAvailable() {
  return typeof window !== 'undefined' && window.tus && window.tus.Upload;
}

/**
 * Upload file using TUS resumable protocol
 * Recommended for files > 6MB for better reliability
 *
 * @param {string} bucket - Storage bucket name
 * @param {string} storagePath - Path within bucket (e.g., "mktg/image.jpg")
 * @param {Blob|File} file - File to upload
 * @param {string} contentType - MIME type
 * @param {Function} onProgress - Progress callback (loaded, total) => void
 * @param {string} authToken - Auth token
 * @param {Object} options - Additional options
 * @returns {Promise<{data: object|null, error: UploadError|null}>}
 */
function uploadWithTus(bucket, storagePath, file, contentType, onProgress, authToken, options = {}) {
  const {
    allowUpsert = false,
    cacheControl = '3600',
  } = options;

  return new Promise((resolve) => {
    if (!isTusAvailable()) {
      console.warn('[tus] TUS client not available, falling back to standard upload');
      resolve({
        data: null,
        error: new UploadError(
          'TUS client not loaded - using fallback',
          'TUS_UNAVAILABLE',
          null,
          true,
          { fallbackAvailable: true }
        ),
      });
      return;
    }

    const tusEndpoint = `${STORAGE_URL}/storage/v1/upload/resumable`;

    console.log(`[tus] Starting resumable upload to ${tusEndpoint}`);
    console.log(`[tus] File: ${storagePath} (${formatBytes(file.size)})`);

    const upload = new window.tus.Upload(file, {
      endpoint: tusEndpoint,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000], // Retry with backoff
      chunkSize: 6 * 1024 * 1024, // 6MB chunks (Supabase requirement)
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-upsert': allowUpsert ? 'true' : 'false',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true, // Allow re-upload of same file
      metadata: {
        bucketName: bucket,
        objectName: storagePath,
        contentType: contentType,
        cacheControl: cacheControl,
      },

      onError: (error) => {
        console.error('[tus] Upload error:', error);

        // Parse TUS error
        let uploadError;
        const errorMessage = error.message || error.toString();

        if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
          uploadError = new UploadError(
            'Permission denied - check storage policies',
            'PERMISSION_DENIED',
            403,
            false,
            { tusError: errorMessage }
          );
        } else if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
          uploadError = new UploadError(
            'Authentication expired',
            'AUTH_EXPIRED',
            401,
            true,
            { tusError: errorMessage, needsTokenRefresh: true }
          );
        } else if (errorMessage.includes('409') || errorMessage.includes('Conflict')) {
          uploadError = new UploadError(
            'File conflict - another upload in progress',
            'CONFLICT',
            409,
            true,
            { tusError: errorMessage }
          );
        } else if (errorMessage.includes('413') || errorMessage.includes('too large')) {
          uploadError = new UploadError(
            'File too large',
            'FILE_TOO_LARGE',
            413,
            false,
            { tusError: errorMessage }
          );
        } else if (errorMessage.includes('network') || errorMessage.includes('Network')) {
          uploadError = new UploadError(
            'Network error during upload',
            'NETWORK_ERROR',
            null,
            true,
            { tusError: errorMessage }
          );
        } else {
          uploadError = new UploadError(
            errorMessage || 'TUS upload failed',
            'TUS_ERROR',
            null,
            true,
            { tusError: errorMessage }
          );
        }

        resolve({ data: null, error: uploadError });
      },

      onProgress: (bytesUploaded, bytesTotal) => {
        const percent = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
        console.log(`[tus] Progress: ${formatBytes(bytesUploaded)} / ${formatBytes(bytesTotal)} (${percent}%)`);
        if (onProgress) {
          onProgress(bytesUploaded, bytesTotal);
        }
      },

      onSuccess: () => {
        console.log('[tus] Upload completed successfully');
        resolve({ data: { path: storagePath }, error: null });
      },
    });

    // Check for previous incomplete uploads and resume
    upload.findPreviousUploads().then((previousUploads) => {
      if (previousUploads.length > 0) {
        console.log('[tus] Found previous upload, resuming...');
        upload.resumeFromPreviousUpload(previousUploads[0]);
      }
      upload.start();
    }).catch((err) => {
      console.warn('[tus] Could not check for previous uploads:', err);
      upload.start();
    });
  });
}

/**
 * Threshold for using TUS vs standard upload (6MB)
 */
const TUS_THRESHOLD_BYTES = 6 * 1024 * 1024;

// =============================================
// STORAGE USAGE
// =============================================

/**
 * Get current Supabase storage usage
 */
async function getStorageUsage() {
  // Use direct query instead of RPC to avoid cold-start delays
  try {
    const query = supabase
      .from('media')
      .select('file_size_bytes')
      .eq('storage_provider', 'supabase')
      .eq('is_archived', false);

    const { data, error } = await withTimeout(query, 5000, 'Storage usage check timed out');

    if (error) {
      console.error('Error checking storage:', error);
      return null;
    }

    const totalBytes = data?.reduce((sum, m) => sum + (m.file_size_bytes || 0), 0) || 0;
    return {
      current_bytes: totalBytes,
      limit_bytes: CONFIG.supabaseMaxBytes,
      percent_used: (totalBytes / CONFIG.supabaseMaxBytes) * 100,
      bytes_remaining: CONFIG.supabaseMaxBytes - totalBytes,
    };
  } catch (err) {
    console.warn('[getStorageUsage] Failed:', err.message);
    return null;
  }
}

/**
 * Get storage breakdown by category
 */
async function getStorageBreakdown() {
  const { data, error } = await supabase
    .from('storage_usage')
    .select('*');

  if (error) {
    console.error('Error getting breakdown:', error);
    return [];
  }

  return data || [];
}

/**
 * Check if we should warn about storage usage
 */
async function shouldWarnStorage() {
  const usage = await getStorageUsage();
  if (!usage) return false;
  return usage.percent_used >= CONFIG.warningThreshold * 100;
}

// =============================================
// UPLOAD FUNCTIONS
// =============================================

/**
 * Upload media file
 *
 * @param {File} file - The file to upload
 * @param {Object} options - Upload options
 * @param {string} options.category - 'mktg', 'projects', or 'archive'
 * @param {string} options.caption - Optional caption
 * @param {string} options.title - Optional title
 * @param {string[]} options.tags - Array of tag names to assign
 * @param {string} options.spaceId - Optional space to link to
 * @param {number} options.displayOrder - Display order if linking to space
 * @param {Function} options.onProgress - Progress callback: (loaded, total) => void
 * @returns {Object} - { success, media, error }
 */
async function upload(file, options = {}) {
  // Wrap entire upload in a global timeout to prevent infinite hangs
  const GLOBAL_TIMEOUT_MS = 180000; // 3 minutes max for entire upload

  try {
    return await withTimeout(
      uploadInternal(file, options),
      GLOBAL_TIMEOUT_MS,
      'Upload timed out - please check your connection and try again'
    );
  } catch (err) {
    console.error('[upload] Global timeout or error:', err.message);
    return {
      success: false,
      error: err.message || 'Upload failed',
      errorDetails: { code: 'GLOBAL_TIMEOUT', message: err.message },
    };
  }
}

/**
 * Internal upload implementation (wrapped by upload() with global timeout)
 */
async function uploadInternal(file, options = {}) {
  const {
    category = 'mktg',
    caption = '',
    title = '',
    tags = [],
    spaceId = null,
    displayOrder = 0,
    onProgress = null, // Progress callback: (loaded, total) => void
  } = options;

  // Validate file type
  if (!isSupported(file)) {
    return {
      success: false,
      error: `Unsupported file type: ${file.type}. Supported: images (JPEG, PNG, WebP, GIF) and videos (MP4, WebM, MOV, AVI)`,
    };
  }

  // Check if video (not supported yet)
  if (isVideo(file)) {
    return {
      success: false,
      error: 'Video upload requires external storage (coming soon). For now, please use an external video host like YouTube or Vimeo and paste the URL.',
      isVideo: true,
    };
  }

  // Validate category
  if (!CONFIG.validCategories.includes(category)) {
    return {
      success: false,
      error: `Invalid category: ${category}. Valid: ${CONFIG.validCategories.join(', ')}`,
    };
  }

  // Check for duplicate content by hash
  console.log('[upload] Computing content hash for duplicate check...');
  let contentHash = null;
  try {
    contentHash = await withTimeout(computeFileHash(file), 10000, 'Hash computation timed out');
    console.log('[upload] Content hash:', contentHash.substring(0, 12) + '...');

    const { exists, media: existingMedia } = await checkDuplicateByHash(contentHash);
    if (exists) {
      console.log('[upload] Duplicate detected, existing media:', existingMedia.id);
      return {
        success: false,
        error: 'This image already exists in your library',
        isDuplicate: true,
        existingMedia,
      };
    }
  } catch (hashError) {
    console.warn('[upload] Hash check failed, continuing without duplicate detection:', hashError.message);
    // Continue without duplicate detection if hash fails
  }

  // Check storage usage (with timeout to prevent hangs)
  // Use a fast direct query instead of RPC to avoid cold-start delays
  console.log('[upload] Checking storage usage...');
  let usage = null;
  try {
    const storageCheck = async () => {
      const { data, error } = await supabase
        .from('media')
        .select('file_size_bytes')
        .eq('storage_provider', 'supabase')
        .eq('is_archived', false);

      if (error) throw error;

      const totalBytes = data?.reduce((sum, m) => sum + (m.file_size_bytes || 0), 0) || 0;
      return {
        current_bytes: totalBytes,
        limit_bytes: CONFIG.supabaseMaxBytes,
        percent_used: (totalBytes / CONFIG.supabaseMaxBytes) * 100,
        bytes_remaining: CONFIG.supabaseMaxBytes - totalBytes,
      };
    };
    usage = await withTimeout(storageCheck(), 5000, 'Storage check timed out');
  } catch (storageCheckError) {
    console.warn('[upload] Storage check failed, continuing anyway:', storageCheckError.message);
    // Continue without storage check - don't block upload
  }

  if (usage && (usage.bytes_remaining < file.size)) {
    return {
      success: false,
      error: `Not enough storage space. Need ${formatBytes(file.size)}, only ${formatBytes(usage.bytes_remaining)} available.`,
    };
  }

  try {
    // Compress image before upload
    let fileToUpload = file;
    let finalMimeType = file.type;

    // Only compress if it's a compressible image type and larger than 500KB
    const compressibleTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (compressibleTypes.includes(file.type) && file.size > 500 * 1024) {
      try {
        console.log(`[upload] Compressing image: ${file.name} (${formatBytes(file.size)})`);
        const compressedBlob = await compressImage(file, {
          maxWidth: 1920,
          maxHeight: 1920,
          quality: 0.85,
          timeout: 30000,
        });

        // Validate compression output
        if (!compressedBlob || compressedBlob.size === 0) {
          console.warn('[upload] Compression produced empty output, using original');
        } else if (compressedBlob.size >= file.size) {
          console.log('[upload] Compression did not reduce size, using original');
        } else {
          fileToUpload = compressedBlob;
          finalMimeType = 'image/jpeg';
          console.log(`[upload] Compressed to: ${formatBytes(compressedBlob.size)} (${((1 - compressedBlob.size / file.size) * 100).toFixed(0)}% reduction)`);
        }
      } catch (compressError) {
        console.warn('[upload] Image compression failed, uploading original:', compressError.message);
        // Continue with original file if compression fails
      }
    }

    // Generate unique filename with content hash to avoid collisions
    const ext = finalMimeType === 'image/jpeg' ? 'jpg' : (file.name.split('.').pop()?.toLowerCase() || 'jpg');
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);
    // Include file size in path to reduce collision probability
    const sizeHash = (fileToUpload.size % 10000).toString(36);
    const storagePath = `${category}/${timestamp}-${randomId}-${sizeHash}.${ext}`;

    // Get auth token (with refresh if needed)
    let authToken = await getAuthToken();

    // Determine upload method based on file size
    const useTus = fileToUpload.size > TUS_THRESHOLD_BYTES && isTusAvailable();
    console.log(`[upload] Uploading to Supabase: ${storagePath} (${formatBytes(fileToUpload.size)}) via ${useTus ? 'TUS resumable' : 'standard XHR'}`);

    // Retry with smart error classification
    let uploadData = null;
    let uploadError = null;
    let lastError = null;
    const maxRetries = CONFIG.upload.maxRetries;
    let isStalled = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[upload] Attempt ${attempt}/${maxRetries} via ${useTus ? 'TUS' : 'XHR'}...`);

        // Reset progress at start of each attempt
        if (onProgress) {
          onProgress(0, fileToUpload.size || file.size);
        }
        isStalled = false;

        let result;

        if (useTus) {
          // Use TUS resumable upload for large files
          result = await uploadWithTus(
            CONFIG.buckets.images,
            storagePath,
            fileToUpload,
            finalMimeType,
            onProgress,
            authToken,
            { allowUpsert: attempt > 1 }
          );

          // If TUS is unavailable, fall back to standard upload
          if (result.error?.code === 'TUS_UNAVAILABLE') {
            console.log('[upload] Falling back to standard XHR upload');
            result = await uploadWithProgress(
              CONFIG.buckets.images,
              storagePath,
              fileToUpload,
              finalMimeType,
              onProgress,
              () => { isStalled = true; },
              authToken,
              { allowUpsert: attempt > 1 }
            );
          }
        } else {
          // Use standard XHR upload for smaller files
          result = await uploadWithProgress(
            CONFIG.buckets.images,
            storagePath,
            fileToUpload,
            finalMimeType,
            onProgress,
            () => { isStalled = true; }, // onStall callback
            authToken,
            { allowUpsert: attempt > 1 } // Allow upsert on retries to handle partial uploads
          );
        }

        uploadData = result.data;
        uploadError = result.error;

        if (!uploadError) {
          console.log(`[upload] Success on attempt ${attempt}`);
          break;
        }

        lastError = uploadError;

        // Check if error is retriable
        if (!uploadError.retriable) {
          console.error(`[upload] Non-retriable error on attempt ${attempt}:`, uploadError.toJSON());
          break;
        }

        // Check if we need to refresh token before retrying
        if (uploadError.details?.needsTokenRefresh) {
          console.log('[upload] Refreshing auth token before retry...');
          const newToken = await refreshAuthToken();
          if (newToken) {
            authToken = newToken;
          } else {
            console.warn('[upload] Token refresh failed, continuing with current token');
          }
        }

        console.warn(`[upload] Attempt ${attempt} failed (retriable):`, uploadError.message);

        if (attempt < maxRetries) {
          // Exponential backoff with jitter
          const baseDelay = CONFIG.upload.baseRetryDelayMs * Math.pow(2, attempt - 1);
          const jitter = Math.random() * 1000;
          const backoffMs = Math.min(baseDelay + jitter, 30000); // Cap at 30s

          // Longer delay for rate limiting
          const finalDelay = uploadError.code === 'RATE_LIMITED'
            ? Math.max(backoffMs, uploadError.details?.retryAfter || 5000)
            : backoffMs;

          console.log(`[upload] Retrying in ${(finalDelay / 1000).toFixed(1)} seconds...`);
          await new Promise(r => setTimeout(r, finalDelay));
        }
      } catch (err) {
        console.warn(`[upload] Attempt ${attempt} exception:`, err.message);
        lastError = new UploadError(err.message, 'EXCEPTION', null, true, { originalError: err.name });

        if (attempt < maxRetries) {
          const backoffMs = CONFIG.upload.baseRetryDelayMs * attempt;
          console.log(`[upload] Retrying in ${backoffMs / 1000} seconds...`);
          await new Promise(r => setTimeout(r, backoffMs));
        }
      }
    }

    if (uploadError || !uploadData) {
      const finalError = uploadError || lastError;
      console.error('[upload] Upload failed after all attempts:', finalError?.toJSON?.() || finalError);

      // Log to error reporting service
      errorLogger.error('upload', finalError?.code || 'UPLOAD_FAILED', finalError?.message || 'Upload failed', {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        category,
        storagePath,
        attempts: maxRetries,
        errorDetails: finalError?.toJSON?.() || {},
      });

      return {
        success: false,
        error: finalError?.message || 'Upload failed',
        errorDetails: finalError?.toJSON?.() || { code: 'UNKNOWN', message: finalError?.message },
      };
    }
    console.log('[upload] Upload successful');

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(CONFIG.buckets.images)
      .getPublicUrl(storagePath);

    const publicUrl = urlData?.publicUrl;

    if (!publicUrl) {
      return { success: false, error: 'Failed to get public URL' };
    }

    // Get image dimensions (if browser supports it) - with timeout
    let width = null;
    let height = null;
    try {
      const dimensions = await getImageDimensions(file, 10000);
      width = dimensions.width;
      height = dimensions.height;
    } catch (e) {
      console.warn('[upload] Could not get image dimensions:', e.message);
    }

    // Insert media record with retry logic for DB timeouts
    console.log('[upload] Creating media record...');

    let mediaRecord = null;
    let mediaError = null;
    const dbMaxRetries = 3;
    const dbTimeoutMs = 22500; // 22.5 seconds per attempt (increased 50% for high-latency connections)

    for (let dbAttempt = 1; dbAttempt <= dbMaxRetries; dbAttempt++) {
      try {
        console.log(`[upload] DB insert attempt ${dbAttempt}/${dbMaxRetries}...`);

        // First check if record already exists (from a previous timed-out but successful insert)
        if (dbAttempt > 1) {
          const { data: existing } = await withTimeout(
            supabase.from('media').select('*').eq('storage_path', storagePath).single(),
            10000,
            'Check for existing record timed out'
          ).catch(() => ({ data: null }));

          if (existing) {
            console.log('[upload] Found existing record from previous attempt');
            mediaRecord = existing;
            mediaError = null;
            break;
          }
        }

        const insertPromise = supabase
          .from('media')
          .insert({
            url: publicUrl,
            storage_provider: 'supabase',
            storage_path: storagePath,
            media_type: 'image',
            mime_type: finalMimeType,
            file_size_bytes: fileToUpload.size,
            width,
            height,
            title: title || null,
            caption: caption || null,
            category,
            content_hash: contentHash,
          })
          .select()
          .single();

        const result = await withTimeout(
          insertPromise,
          dbTimeoutMs,
          'Database insert timed out'
        );

        mediaRecord = result.data;
        mediaError = result.error;

        if (!mediaError && mediaRecord) {
          console.log(`[upload] DB insert succeeded on attempt ${dbAttempt}`);
          break;
        }

        // Check for duplicate key error (record was actually created)
        if (mediaError?.code === '23505' || mediaError?.message?.includes('duplicate')) {
          console.log('[upload] Duplicate key - record exists, fetching...');
          const { data: existing } = await supabase
            .from('media')
            .select('*')
            .eq('storage_path', storagePath)
            .single();
          if (existing) {
            mediaRecord = existing;
            mediaError = null;
            break;
          }
        }

        console.warn(`[upload] DB insert attempt ${dbAttempt} failed:`, mediaError?.message);

      } catch (dbErr) {
        console.warn(`[upload] DB insert attempt ${dbAttempt} exception:`, dbErr.message);
        mediaError = { message: dbErr.message };
      }

      if (dbAttempt < dbMaxRetries) {
        const dbBackoff = dbAttempt * 2000;
        console.log(`[upload] Retrying DB insert in ${dbBackoff / 1000}s...`);
        await new Promise(r => setTimeout(r, dbBackoff));
      }
    }

    if (mediaError || !mediaRecord) {
      console.error('[upload] Media record creation failed after all attempts:', mediaError);

      // IMPORTANT: Don't delete the file on timeout - it may have succeeded server-side
      // The file can be cleaned up later via orphan detection
      const isTimeout = mediaError?.message?.includes('timed out');
      if (!isTimeout) {
        // Only clean up if it's a definite failure (not timeout)
        console.log('[upload] Cleaning up orphaned file...');
        await supabase.storage.from(CONFIG.buckets.images).remove([storagePath]).catch(() => {});
      } else {
        console.warn('[upload] Skipping file cleanup due to timeout - may need manual cleanup');
        console.warn('[upload] Orphaned file path:', storagePath);
      }

      // Log to error reporting service
      const errorCode = isTimeout ? 'DB_TIMEOUT' : 'DB_ERROR';
      errorLogger.error('upload', errorCode, mediaError?.message || 'Failed to create media record', {
        fileName: file.name,
        fileSize: file.size,
        category,
        storagePath,
        publicUrl,
        dbAttempts: dbMaxRetries,
        isTimeout,
      });

      return {
        success: false,
        error: mediaError?.message || 'Failed to create media record',
        errorDetails: {
          code: errorCode,
          message: mediaError?.message,
          storagePath, // Include path for manual recovery
          publicUrl,   // Include URL for manual recovery
          hint: isTimeout
            ? 'The file was uploaded but database record creation timed out. The file may exist without a database record.'
            : 'Database error during record creation',
        },
      };
    }
    console.log('[upload] Media record created:', mediaRecord.id);

    // Assign tags
    if (tags.length > 0) {
      await assignTags(mediaRecord.id, tags);
    }

    // Link to space if provided
    if (spaceId) {
      await linkToSpace(mediaRecord.id, spaceId, displayOrder);
    }

    // Warn if storage is getting full
    if (usage && usage.percent_used >= CONFIG.warningThreshold * 100) {
      console.warn(`Storage usage warning: ${usage.percent_used.toFixed(1)}% used`);
    }

    return {
      success: true,
      media: mediaRecord,
      storageWarning: usage?.percent_used >= CONFIG.warningThreshold * 100,
    };

  } catch (error) {
    console.error('Upload failed:', error);

    // Log to error reporting service
    errorLogger.error('upload', 'UNEXPECTED_ERROR', error.message, {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      category,
      stack: error.stack,
    });

    return { success: false, error: error.message };
  }
}

/**
 * Add external media (video URL, etc.)
 */
async function addExternal(url, options = {}) {
  const {
    category = 'mktg',
    mediaType = 'video',
    caption = '',
    title = '',
    tags = [],
    spaceId = null,
    displayOrder = 0,
  } = options;

  try {
    const { data: mediaRecord, error } = await supabase
      .from('media')
      .insert({
        url,
        storage_provider: 'external',
        storage_path: null,
        media_type: mediaType,
        mime_type: null,
        file_size_bytes: null,
        title: title || null,
        caption: caption || null,
        category,
      })
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    if (tags.length > 0) {
      await assignTags(mediaRecord.id, tags);
    }

    if (spaceId) {
      await linkToSpace(mediaRecord.id, spaceId, displayOrder);
    }

    return { success: true, media: mediaRecord };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// =============================================
// TAG MANAGEMENT
// =============================================

/**
 * Get all available tags
 */
async function getTags(group = null) {
  let query = supabase.from('media_tags').select('*').order('tag_group').order('name');

  if (group) {
    query = query.eq('tag_group', group);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching tags:', error);
    return [];
  }

  return data || [];
}

/**
 * Get all tags with usage counts (how many media items use each tag)
 */
async function getTagsWithUsage() {
  // Get tags with count of media_tag_assignments
  const { data, error } = await supabase
    .from('media_tags')
    .select(`
      *,
      media_tag_assignments(count)
    `)
    .order('tag_group')
    .order('name');

  if (error) {
    console.error('Error fetching tags with usage:', error);
    return [];
  }

  // Transform to include usage_count
  return (data || []).map(tag => ({
    ...tag,
    usage_count: tag.media_tag_assignments?.[0]?.count || 0
  }));
}

/**
 * Get tags grouped by tag_group
 */
async function getTagsGrouped() {
  const tags = await getTags();
  const grouped = {};

  for (const tag of tags) {
    const group = tag.tag_group || 'other';
    if (!grouped[group]) {
      grouped[group] = [];
    }
    grouped[group].push(tag);
  }

  return grouped;
}

/**
 * Assign tags to media by tag names
 */
async function assignTags(mediaId, tagNames) {
  if (!tagNames || tagNames.length === 0) return;

  // Get tag IDs from names
  const { data: tags } = await supabase
    .from('media_tags')
    .select('id, name')
    .in('name', tagNames);

  if (!tags || tags.length === 0) return;

  // Insert assignments
  const assignments = tags.map(tag => ({
    media_id: mediaId,
    tag_id: tag.id,
  }));

  await supabase
    .from('media_tag_assignments')
    .upsert(assignments, { onConflict: 'media_id,tag_id' });
}

/**
 * Remove tag from media
 */
async function removeTag(mediaId, tagId) {
  await supabase
    .from('media_tag_assignments')
    .delete()
    .eq('media_id', mediaId)
    .eq('tag_id', tagId);
}

/**
 * Create a new tag
 */
async function createTag(name, group = null, color = null, description = null) {
  // Normalize the name (lowercase, trim, replace spaces with hyphens)
  const normalizedName = name.trim().toLowerCase().replace(/\s+/g, '-');

  const { data, error } = await supabase
    .from('media_tags')
    .insert({
      name: normalizedName,
      tag_group: group || null,
      color: color || generateTagColor(),
      description: description || null,
    })
    .select()
    .single();

  if (error) {
    // Check if it's a duplicate
    if (error.code === '23505') {
      return { success: false, error: 'Tag already exists', duplicate: true };
    }
    return { success: false, error: error.message };
  }

  return { success: true, tag: data };
}

/**
 * Get all unique tag groups/categories
 */
async function getTagGroups() {
  const { data, error } = await supabase
    .from('media_tags')
    .select('tag_group')
    .not('tag_group', 'is', null);

  if (error) {
    console.error('Error fetching tag groups:', error);
    return [];
  }

  // Get unique groups
  const groups = [...new Set(data.map(t => t.tag_group))].filter(Boolean).sort();
  return groups;
}

/**
 * Generate a random tag color
 */
function generateTagColor() {
  const colors = [
    '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16',
    '#22C55E', '#10B981', '#14B8A6', '#06B6D4', '#0EA5E9',
    '#3B82F6', '#6366F1', '#8B5CF6', '#A855F7', '#D946EF',
    '#EC4899', '#F43F5E',
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

/**
 * Update a tag
 */
async function updateTag(tagId, updates) {
  const { data, error } = await supabase
    .from('media_tags')
    .update(updates)
    .eq('id', tagId)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, tag: data };
}

/**
 * Delete a tag
 */
async function deleteTag(tagId) {
  const { error } = await supabase
    .from('media_tags')
    .delete()
    .eq('id', tagId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}

// =============================================
// SPACE LINKING
// =============================================

/**
 * Link media to a space
 */
async function linkToSpace(mediaId, spaceId, displayOrder = 0, isPrimary = false) {
  const { error } = await supabase
    .from('media_spaces')
    .upsert({
      media_id: mediaId,
      space_id: spaceId,
      display_order: displayOrder,
      is_primary: isPrimary,
    }, { onConflict: 'media_id,space_id' });

  if (error) {
    console.error('Error linking to space:', error);
    return false;
  }

  return true;
}

/**
 * Unlink media from a space
 */
async function unlinkFromSpace(mediaId, spaceId) {
  console.log('[unlink] Unlinking media from space:', { mediaId, spaceId });

  const { error } = await supabase
    .from('media_spaces')
    .delete()
    .eq('media_id', mediaId)
    .eq('space_id', spaceId);

  if (error) {
    console.error('[unlink] Error unlinking from space:', error);

    // Log to error reporting service
    const isPermissionError = error.code === '42501' || error.message?.includes('permission') || error.message?.includes('policy');
    errorLogger.error('media', isPermissionError ? 'PERMISSION_DENIED' : 'UNLINK_FAILED', error.message, {
      mediaId,
      spaceId,
      errorCode: error.code,
    });

    // Check for RLS permission issues
    if (isPermissionError) {
      throw new Error('Permission denied - admin privileges required');
    }
    throw new Error(error.message || 'Failed to unlink media from space');
  }

  console.log('[unlink] Successfully unlinked media from space');
  return true;
}

/**
 * Reorder media within a space
 */
async function reorderInSpace(spaceId, mediaIds) {
  console.log('[reorder] Reordering media in space:', { spaceId, mediaIds });

  const results = await Promise.all(
    mediaIds.map(async (mediaId, index) => {
      const { error } = await supabase
        .from('media_spaces')
        .update({ display_order: index })
        .eq('space_id', spaceId)
        .eq('media_id', mediaId);

      if (error) {
        console.error(`[reorder] Failed to update order for media ${mediaId}:`, error);
        return { mediaId, success: false, error };
      }
      return { mediaId, success: true };
    })
  );

  const failures = results.filter(r => !r.success);
  if (failures.length > 0) {
    console.error('[reorder] Some updates failed:', failures);

    // Log to error reporting service
    errorLogger.error('media', 'REORDER_FAILED', `Failed to reorder ${failures.length} items`, {
      spaceId,
      failedMediaIds: failures.map(f => f.mediaId),
      totalItems: mediaIds.length,
      errors: failures.map(f => f.error?.message),
    });

    throw new Error(`Failed to reorder ${failures.length} items`);
  }

  console.log('[reorder] Successfully reordered', mediaIds.length, 'items');
}

/**
 * Set primary media for a space
 */
async function setPrimaryForSpace(spaceId, mediaId) {
  // Clear existing primary
  await supabase
    .from('media_spaces')
    .update({ is_primary: false })
    .eq('space_id', spaceId);

  // Set new primary
  await supabase
    .from('media_spaces')
    .update({ is_primary: true })
    .eq('space_id', spaceId)
    .eq('media_id', mediaId);
}

// =============================================
// QUERY FUNCTIONS
// =============================================

/**
 * Get media for a space
 */
async function getForSpace(spaceId) {
  const { data, error } = await supabase
    .from('media_spaces')
    .select(`
      display_order,
      is_primary,
      media:media_id (
        id, url, caption, title, media_type, category,
        media_tag_assignments ( tag:tag_id ( id, name, color, tag_group ) )
      )
    `)
    .eq('space_id', spaceId)
    .order('display_order');

  if (error) {
    console.error('Error fetching media for space:', error);
    return [];
  }

  // Flatten the response
  return (data || []).map(item => ({
    ...item.media,
    display_order: item.display_order,
    is_primary: item.is_primary,
    tags: item.media?.media_tag_assignments?.map(a => a.tag) || [],
  }));
}

/**
 * Search media by tags, category, etc.
 * @param {Object} options - Search options
 * @param {string} options.category - Filter by category
 * @param {string[]} options.tags - Filter by tag names
 * @param {string} options.mediaType - Filter by media type
 * @param {number} options.limit - Max results (default 50)
 * @param {number} options.offset - Pagination offset
 * @param {boolean} options.minimal - If true, skip joins for faster query (default false)
 */
async function search(options = {}) {
  const {
    category = null,
    tags = [],
    mediaType = null,
    limit = 50,
    offset = 0,
    minimal = false,
  } = options;

  // Use minimal query for faster library loading (no joins)
  // Full query with joins can timeout on cold Supabase connections
  const selectClause = minimal
    ? 'id, url, caption, title, media_type, category, uploaded_at'
    : `
      *,
      media_tag_assignments ( tag:tag_id ( id, name, color, tag_group ) ),
      media_spaces ( space_id, display_order, is_primary )
    `;

  let query = supabase
    .from('media')
    .select(selectClause)
    .eq('is_archived', false)
    .order('uploaded_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (category) {
    query = query.eq('category', category);
  }

  if (mediaType) {
    query = query.eq('media_type', mediaType);
  }

  // Add timeout to prevent indefinite hanging on slow connections
  // Use shorter timeout for minimal queries
  const timeoutMs = minimal ? 12000 : 22500; // Increased 50% for high-latency connections
  let data, error;
  try {
    const result = await withTimeout(query, timeoutMs, 'Media search timed out');
    data = result.data;
    error = result.error;
  } catch (timeoutError) {
    console.error('Search timeout:', timeoutError.message);
    throw timeoutError; // Let caller handle the error
  }

  if (error) {
    console.error('Search error:', error);
    return [];
  }

  let results = data || [];
  console.log('Search: query returned', results.length, 'items', minimal ? '(minimal)' : '(full)');

  // For minimal queries, skip tag filtering and return directly
  if (minimal) {
    return results.map(media => ({
      ...media,
      tags: [],
      spaces: [],
    }));
  }

  // Filter by tags if provided (post-query for simplicity)
  if (tags.length > 0) {
    results = results.filter(media => {
      const mediaTags = media.media_tag_assignments?.map(a => a.tag?.name) || [];
      return tags.some(t => mediaTags.includes(t));
    });
    console.log('Search: after tag filter for', tags, ':', results.length, 'items');
  }

  // Flatten tags
  return results.map(media => ({
    ...media,
    tags: media.media_tag_assignments?.map(a => a.tag) || [],
    spaces: media.media_spaces || [],
    media_tag_assignments: undefined,
    media_spaces: undefined,
  }));
}

/**
 * Get all media (paginated)
 */
async function getAll(options = {}) {
  return search(options);
}

// =============================================
// DELETE / ARCHIVE
// =============================================

/**
 * Archive media (soft delete)
 */
async function archive(mediaId) {
  const { error } = await supabase
    .from('media')
    .update({
      is_archived: true,
      archived_at: new Date().toISOString(),
    })
    .eq('id', mediaId);

  return !error;
}

/**
 * Permanently delete media
 */
async function deleteMedia(mediaId) {
  console.log('[delete] Starting delete for media:', mediaId);

  // Get media record first
  const { data: media, error: fetchError } = await supabase
    .from('media')
    .select('storage_provider, storage_path')
    .eq('id', mediaId)
    .single();

  if (fetchError) {
    console.error('[delete] Error fetching media record:', fetchError);
    return { success: false, error: `Failed to fetch media: ${fetchError.message}` };
  }

  if (!media) {
    console.warn('[delete] Media not found:', mediaId);
    return { success: false, error: 'Media not found' };
  }

  console.log('[delete] Found media record:', media);

  // Delete from storage if Supabase
  if (media.storage_provider === 'supabase' && media.storage_path) {
    console.log('[delete] Deleting from storage:', media.storage_path);
    const { error: storageError } = await supabase.storage
      .from(CONFIG.buckets.images)
      .remove([media.storage_path]);

    if (storageError) {
      console.error('[delete] Storage delete error:', storageError);
      // Continue anyway - DB record should still be deleted
    } else {
      console.log('[delete] Storage file deleted successfully');
    }
  }

  // Delete from database (cascades to assignments)
  console.log('[delete] Deleting from database...');
  const { error } = await supabase
    .from('media')
    .delete()
    .eq('id', mediaId);

  if (error) {
    console.error('[delete] Database delete error:', error);

    // Log to error reporting service
    const isPermissionError = error.code === '42501' || error.message?.includes('permission') || error.message?.includes('policy');
    errorLogger.error('media', isPermissionError ? 'PERMISSION_DENIED' : 'DELETE_FAILED', error.message, {
      mediaId,
      errorCode: error.code,
      storagePath: media.storage_path,
    });

    // Check for common RLS issues
    if (isPermissionError) {
      return {
        success: false,
        error: 'Permission denied - you may need admin privileges to delete media',
        errorCode: 'PERMISSION_DENIED',
      };
    }
    return { success: false, error: error.message };
  }

  console.log('[delete] Media deleted successfully');
  return { success: true };
}

// =============================================
// UTILITY FUNCTIONS
// =============================================

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Wrap a promise with a timeout
 */
function withTimeout(promise, ms, errorMessage = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), ms)
    )
  ]);
}

/**
 * Compute SHA-256 hash of file content for duplicate detection
 * @param {File|Blob} file - File to hash
 * @returns {Promise<string>} - Hex string of hash
 */
async function computeFileHash(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Check if a file with this content hash already exists
 * @param {string} hash - Content hash to check
 * @returns {Promise<{exists: boolean, media: object|null}>}
 */
async function checkDuplicateByHash(hash) {
  const { data, error } = await supabase
    .from('media')
    .select('id, url, caption')
    .eq('content_hash', hash)
    .eq('is_archived', false)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
    console.warn('[duplicate] Error checking hash:', error.message);
  }

  return {
    exists: !!data,
    media: data || null,
  };
}

/**
 * Get image dimensions from file (with timeout)
 */
function getImageDimensions(file, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;
    let objectUrl = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Getting image dimensions timed out'));
    }, timeout);

    const img = new Image();
    img.onload = () => {
      cleanup();
      resolve({ width: img.width, height: img.height });
    };
    img.onerror = () => {
      cleanup();
      reject(new Error('Failed to load image for dimensions'));
    };
    objectUrl = URL.createObjectURL(file);
    img.src = objectUrl;
  });
}

/**
 * Compress an image file
 * @param {File} file - The image file to compress
 * @param {Object} options - Compression options
 * @param {number} options.maxWidth - Maximum width (default 1920)
 * @param {number} options.maxHeight - Maximum height (default 1920)
 * @param {number} options.quality - JPEG quality 0-1 (default 0.8)
 * @returns {Promise<Blob>} - Compressed image as Blob
 */
async function compressImage(file, options = {}) {
  const {
    maxWidth = 1920,
    maxHeight = 1920,
    quality = 0.8,
    timeout = 30000, // 30 second timeout
  } = options;

  return new Promise((resolve, reject) => {
    let timeoutId = null;
    let objectUrl = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };

    // Set timeout to prevent indefinite hangs
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Image compression timed out'));
    }, timeout);

    const img = new Image();
    img.onload = () => {
      try {
        // Calculate new dimensions while maintaining aspect ratio
        let { width, height } = img;

        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }

        if (height > maxHeight) {
          width = (width * maxHeight) / height;
          height = maxHeight;
        }

        // Create canvas and draw resized image
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Convert to blob
        canvas.toBlob(
          (blob) => {
            cleanup();
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Failed to compress image'));
            }
          },
          'image/jpeg',
          quality
        );
      } catch (err) {
        cleanup();
        reject(new Error('Error during image compression: ' + err.message));
      }
    };

    img.onerror = () => {
      cleanup();
      reject(new Error('Failed to load image for compression'));
    };

    objectUrl = URL.createObjectURL(file);
    img.src = objectUrl;
  });
}

/**
 * Tag group priority order for display
 */
const TAG_GROUP_ORDER = ['space', 'purpose', 'condition', 'type', 'project', 'other'];

/**
 * Sort tag groups by priority
 */
function sortTagGroups(groupedTags) {
  const sorted = {};

  // Add groups in priority order
  for (const group of TAG_GROUP_ORDER) {
    if (groupedTags[group]) {
      sorted[group] = groupedTags[group];
    }
  }

  // Add any remaining groups not in the priority list
  for (const [group, tags] of Object.entries(groupedTags)) {
    if (!sorted[group]) {
      sorted[group] = tags;
    }
  }

  return sorted;
}

// =============================================
// EXPORTS
// =============================================

export const mediaService = {
  // Config
  CONFIG,

  // Error types
  UploadError,

  // Storage
  getStorageProvider,
  isSupported,
  isVideo,
  getStorageUsage,
  getStorageBreakdown,
  shouldWarnStorage,

  // Upload
  upload,
  addExternal,
  isTusAvailable,
  TUS_THRESHOLD_BYTES,
  computeFileHash,
  checkDuplicateByHash,

  // Tags
  getTags,
  getTagsWithUsage,
  getTagsGrouped,
  getTagGroups,
  assignTags,
  removeTag,
  createTag,
  updateTag,
  deleteTag,
  generateTagColor,
  sortTagGroups,
  TAG_GROUP_ORDER,

  // Image processing
  compressImage,

  // Space linking
  linkToSpace,
  unlinkFromSpace,
  reorderInSpace,
  setPrimaryForSpace,

  // Query
  getForSpace,
  search,
  getAll,

  // Delete
  archive,
  delete: deleteMedia,

  // Utils
  formatBytes,
};

// Also export for window access in non-module scripts
if (typeof window !== 'undefined') {
  window.mediaService = mediaService;
}
