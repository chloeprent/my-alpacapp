/**
 * Error Logger Service
 *
 * Captures client-side errors and sends them to a Supabase Edge Function
 * for email notification and storage. Helps diagnose issues in production.
 */

import { supabase, SUPABASE_URL } from './supabase.js';

// =============================================
// CONFIGURATION
// =============================================

const CONFIG = {
  // Edge function endpoint for error reporting
  edgeFunctionUrl: `${SUPABASE_URL}/functions/v1/error-report`,

  // Batch errors to avoid spam (send at most every N seconds)
  batchIntervalMs: 30000, // 30 seconds

  // Max errors to batch before force-sending
  maxBatchSize: 10,

  // Sampling rate for non-critical errors (1 = 100%, 0.1 = 10%)
  samplingRate: {
    critical: 1.0,    // Always send critical errors
    error: 1.0,       // Always send errors
    warning: 0.5,     // 50% of warnings
    info: 0.1,        // 10% of info
  },

  // Don't send these error codes (too noisy or expected)
  ignoredCodes: [
    'ABORTED',        // User cancelled
    'TUS_UNAVAILABLE', // Expected fallback
  ],

  // Max context string length
  maxContextLength: 5000,
};

// =============================================
// STATE
// =============================================

let errorBatch = [];
let batchTimer = null;
let sessionId = generateSessionId();
let userContext = {};

function generateSessionId() {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

// =============================================
// CONTEXT HELPERS
// =============================================

/**
 * Set user context for error reports
 */
function setUserContext(context) {
  userContext = {
    ...userContext,
    ...context,
  };
}

/**
 * Get browser/environment info
 */
function getEnvironmentInfo() {
  const info = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    screenSize: `${window.screen.width}x${window.screen.height}`,
    viewportSize: `${window.innerWidth}x${window.innerHeight}`,
    url: window.location.href,
    referrer: document.referrer,
    timestamp: new Date().toISOString(),
    sessionId,
  };

  // Add connection info if available
  if (navigator.connection) {
    info.connection = {
      effectiveType: navigator.connection.effectiveType,
      downlink: navigator.connection.downlink,
      rtt: navigator.connection.rtt,
    };
  }

  return info;
}

// =============================================
// ERROR CAPTURE
// =============================================

/**
 * Log an error with context
 *
 * @param {string} category - Error category (e.g., 'upload', 'media', 'auth')
 * @param {string} code - Error code (e.g., 'DB_TIMEOUT', 'NETWORK_ERROR')
 * @param {string} message - Human-readable error message
 * @param {Object} details - Additional error details
 * @param {string} severity - 'critical', 'error', 'warning', 'info'
 */
function logError(category, code, message, details = {}, severity = 'error') {
  // Check if this error code should be ignored
  if (CONFIG.ignoredCodes.includes(code)) {
    console.log(`[error-logger] Ignoring error code: ${code}`);
    return;
  }

  // Apply sampling
  const sampleRate = CONFIG.samplingRate[severity] || 1.0;
  if (Math.random() > sampleRate) {
    console.log(`[error-logger] Sampled out ${severity} error`);
    return;
  }

  const errorEntry = {
    id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    category,
    code,
    message: truncate(message, 500),
    details: sanitizeDetails(details),
    severity,
    environment: getEnvironmentInfo(),
    user: userContext,
    stack: new Error().stack?.split('\n').slice(2, 8).join('\n'), // Capture call stack
  };

  console.log(`[error-logger] Captured ${severity}:`, { category, code, message });

  errorBatch.push(errorEntry);

  // Force send if batch is full or critical error
  if (errorBatch.length >= CONFIG.maxBatchSize || severity === 'critical') {
    sendBatch();
  } else {
    // Schedule batch send
    scheduleBatchSend();
  }
}

/**
 * Convenience methods for different severity levels
 */
function logCritical(category, code, message, details = {}) {
  logError(category, code, message, details, 'critical');
}

function logWarning(category, code, message, details = {}) {
  logError(category, code, message, details, 'warning');
}

function logInfo(category, code, message, details = {}) {
  logError(category, code, message, details, 'info');
}

// =============================================
// BATCH SENDING
// =============================================

function scheduleBatchSend() {
  if (batchTimer) return;

  batchTimer = setTimeout(() => {
    batchTimer = null;
    sendBatch();
  }, CONFIG.batchIntervalMs);
}

async function sendBatch() {
  if (errorBatch.length === 0) return;

  // Clear timer
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  // Take current batch and reset
  const batch = [...errorBatch];
  errorBatch = [];

  console.log(`[error-logger] Sending batch of ${batch.length} errors`);

  try {
    // Get auth token if available
    let authToken = null;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      authToken = session?.access_token;
    } catch (e) {
      // Continue without auth
    }

    const response = await fetch(CONFIG.edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        errors: batch,
        summary: {
          count: batch.length,
          categories: [...new Set(batch.map(e => e.category))],
          severities: batch.reduce((acc, e) => {
            acc[e.severity] = (acc[e.severity] || 0) + 1;
            return acc;
          }, {}),
        },
      }),
    });

    if (!response.ok) {
      console.warn('[error-logger] Failed to send batch:', response.status);
      // Put errors back in batch for retry (but limit to prevent infinite growth)
      if (errorBatch.length < CONFIG.maxBatchSize * 2) {
        errorBatch = [...batch, ...errorBatch];
      }
    } else {
      console.log('[error-logger] Batch sent successfully');
    }
  } catch (e) {
    console.warn('[error-logger] Exception sending batch:', e.message);
    // Put errors back in batch for retry
    if (errorBatch.length < CONFIG.maxBatchSize * 2) {
      errorBatch = [...batch, ...errorBatch];
    }
  }
}

// =============================================
// UTILITY FUNCTIONS
// =============================================

function truncate(str, maxLength) {
  if (!str) return str;
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

function sanitizeDetails(details) {
  // Remove sensitive data and truncate large values
  const sanitized = {};

  const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'credential'];

  for (const [key, value] of Object.entries(details)) {
    // Skip sensitive keys
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    // Handle different value types
    if (value === null || value === undefined) {
      sanitized[key] = value;
    } else if (typeof value === 'string') {
      sanitized[key] = truncate(value, CONFIG.maxContextLength);
    } else if (typeof value === 'object') {
      try {
        const json = JSON.stringify(value);
        sanitized[key] = json.length > CONFIG.maxContextLength
          ? truncate(json, CONFIG.maxContextLength)
          : value;
      } catch (e) {
        sanitized[key] = '[Unserializable]';
      }
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// =============================================
// GLOBAL ERROR HANDLERS
// =============================================

/**
 * Set up global error handlers for uncaught errors
 */
function setupGlobalHandlers() {
  // Uncaught errors
  window.addEventListener('error', (event) => {
    logError(
      'global',
      'UNCAUGHT_ERROR',
      event.message,
      {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
      'critical'
    );
  });

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const message = event.reason?.message || event.reason?.toString() || 'Unknown rejection';
    logError(
      'global',
      'UNHANDLED_REJECTION',
      message,
      {
        reason: event.reason?.stack || event.reason?.toString(),
      },
      'critical'
    );
  });

  console.log('[error-logger] Global error handlers installed');
}

// =============================================
// FETCH MONITORING
// =============================================

/**
 * Wrap a fetch call to automatically log errors.
 * Use this for edge function calls, API calls, etc.
 *
 * @param {string} url - The URL being fetched
 * @param {RequestInit} options - Fetch options
 * @param {Object} context - Additional context for error logging
 * @param {string} context.category - Error category (default: 'fetch')
 * @param {string} context.operation - What this fetch is doing (e.g., 'generate_fact', 'send_sms')
 * @returns {Promise<Response>} The fetch response
 */
async function monitorFetch(url, options = {}, context = {}) {
  const category = context.category || 'fetch';
  const operation = context.operation || 'unknown';

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      // Try to get error body for context
      let errorBody = '';
      try {
        errorBody = await response.clone().text();
        errorBody = errorBody.substring(0, 500);
      } catch (e) {
        // ignore
      }

      // Determine if this is an edge function call
      const isEdgeFunction = url.includes('/functions/v1/');
      const code = isEdgeFunction ? 'EDGE_FUNCTION_ERROR' : 'FETCH_ERROR';
      const severity = response.status >= 500 ? 'critical' : 'error';

      logError(
        category,
        code,
        `${options.method || 'GET'} ${url} returned ${response.status}`,
        {
          status: response.status,
          statusText: response.statusText,
          operation,
          responseBody: errorBody,
          requestUrl: url,
        },
        severity
      );
    }

    return response;
  } catch (err) {
    // Network error, CORS error, etc.
    logError(
      category,
      'NETWORK_ERROR',
      `${options.method || 'GET'} ${url} failed: ${err.message}`,
      {
        operation,
        errorName: err.name,
        requestUrl: url,
      },
      'error'
    );

    throw err; // Re-throw so caller still handles it
  }
}

/**
 * Monitor Supabase query errors. Call after any supabase query.
 *
 * @param {Object} result - Supabase query result { data, error }
 * @param {string} operation - What this query is doing (e.g., 'load_spaces', 'update_assignment')
 * @param {string} category - Error category (default: 'supabase')
 * @returns {Object} The same result, passed through
 */
function monitorSupabase(result, operation, category = 'supabase') {
  if (result.error) {
    logError(
      category,
      `SUPABASE_${result.error.code || 'ERROR'}`,
      `${operation}: ${result.error.message}`,
      {
        operation,
        code: result.error.code,
        hint: result.error.hint,
        details: result.error.details,
      },
      'error'
    );
  }
  return result;
}

// =============================================
// FLUSH ON PAGE UNLOAD
// =============================================

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (errorBatch.length > 0) {
      // Use sendBeacon for reliable delivery during page unload
      const payload = JSON.stringify({
        errors: errorBatch,
        summary: {
          count: errorBatch.length,
          isUnloadFlush: true,
        },
      });

      navigator.sendBeacon?.(CONFIG.edgeFunctionUrl, payload);
    }
  });
}

// =============================================
// EXPORTS
// =============================================

export const errorLogger = {
  // Main logging functions
  log: logError,
  error: logError,
  critical: logCritical,
  warning: logWarning,
  info: logInfo,

  // Monitored operations (auto-log errors from fetch/supabase calls)
  monitorFetch,
  monitorSupabase,

  // Context
  setUserContext,

  // Setup
  setupGlobalHandlers,

  // Manual flush
  flush: sendBatch,

  // For testing
  _getBatchSize: () => errorBatch.length,
  _getSessionId: () => sessionId,
};

// Also export for window access
if (typeof window !== 'undefined') {
  window.errorLogger = errorLogger;
}
