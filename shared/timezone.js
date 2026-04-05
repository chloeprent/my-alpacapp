/**
 * Timezone utilities for YOUR_APP_NAME
 * All dates should be displayed in Austin, Texas timezone (America/Chicago)
 * regardless of the user's browser timezone.
 */

const AUSTIN_TIMEZONE = 'America/Chicago';

/**
 * Format a date string or Date object in Austin timezone
 * @param {string|Date} dateInput - Date string (ISO/YYYY-MM-DD) or Date object
 * @param {Object} options - Intl.DateTimeFormat options (without timeZone)
 * @returns {string} Formatted date string in Austin timezone
 */
export function formatDateAustin(dateInput, options = {}) {
  if (!dateInput) return null;

  let date;
  if (typeof dateInput === 'string') {
    // Check if it's a date-only string (YYYY-MM-DD) - parse as local date to avoid UTC shift
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      const [year, month, day] = dateInput.split('-');
      date = new Date(year, month - 1, day, 12, 0, 0, 0); // Noon to avoid DST issues
    } else {
      date = new Date(dateInput);
    }
  } else {
    date = dateInput;
  }
  if (isNaN(date.getTime())) return null;

  const defaultOptions = { month: 'short', day: 'numeric' };
  const formatOptions = { ...defaultOptions, ...options, timeZone: AUSTIN_TIMEZONE };

  return date.toLocaleDateString('en-US', formatOptions);
}

/**
 * Format a date with time in Austin timezone
 * @param {string|Date} dateInput - Date string or Date object
 * @param {boolean} includeTime - Whether to include time
 * @returns {string} Formatted date/time string
 */
export function formatDateTimeFull(dateInput, includeTime = true) {
  if (!dateInput) return '-';

  let date;
  if (typeof dateInput === 'string') {
    // Check if it's a date-only string (YYYY-MM-DD) - parse as local date to avoid UTC shift
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      const [year, month, day] = dateInput.split('-');
      date = new Date(year, month - 1, day, 12, 0, 0, 0); // Noon to avoid DST issues
    } else {
      date = new Date(dateInput);
    }
  } else {
    date = dateInput;
  }
  if (isNaN(date.getTime())) return '-';

  const options = includeTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: AUSTIN_TIMEZONE }
    : { year: 'numeric', month: 'short', day: 'numeric', timeZone: AUSTIN_TIMEZONE };

  return date.toLocaleDateString('en-US', options);
}

/**
 * Get today's date at midnight in Austin timezone
 * Returns a Date object representing the start of today in Austin
 * @returns {Date} Date object for today at 00:00:00 in Austin timezone
 */
export function getAustinToday() {
  const now = new Date();
  // Get the current date string in Austin timezone
  const austinDateStr = now.toLocaleDateString('en-US', {
    timeZone: AUSTIN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  // Parse it back to get midnight in Austin (MM/DD/YYYY format)
  const [month, day, year] = austinDateStr.split('/');
  // Create a date at noon to avoid DST edge cases, then set to midnight
  const austinToday = new Date(year, month - 1, day, 12, 0, 0, 0);
  austinToday.setHours(0, 0, 0, 0);
  return austinToday;
}

/**
 * Get today's date as YYYY-MM-DD string in Austin timezone
 * Useful for date input default values
 * @returns {string} Date string in YYYY-MM-DD format
 */
export function getAustinTodayISO() {
  const now = new Date();
  const austinDateStr = now.toLocaleDateString('en-CA', {
    timeZone: AUSTIN_TIMEZONE
  }); // en-CA gives YYYY-MM-DD format
  return austinDateStr;
}

/**
 * Parse a date string (YYYY-MM-DD) as Austin timezone date
 * This ensures the date is interpreted as Austin midnight, not UTC
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {Date} Date object representing midnight Austin time
 */
export function parseAustinDate(dateStr) {
  if (!dateStr) return null;
  // Add time component to interpret as local date, not UTC
  const [year, month, day] = dateStr.split('-');
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

/**
 * Compare if a date is before today in Austin timezone
 * @param {string|Date} dateInput - Date to compare
 * @returns {boolean} True if date is before today in Austin
 */
export function isBeforeAustinToday(dateInput) {
  if (!dateInput) return false;
  const date = typeof dateInput === 'string' ? parseAustinDate(dateInput) : dateInput;
  const today = getAustinToday();
  return date < today;
}

/**
 * Compare if a date is today or after in Austin timezone
 * @param {string|Date} dateInput - Date to compare
 * @returns {boolean} True if date is today or in the future in Austin
 */
export function isTodayOrAfterAustin(dateInput) {
  if (!dateInput) return true; // No end date means ongoing
  const date = typeof dateInput === 'string' ? parseAustinDate(dateInput) : dateInput;
  const today = getAustinToday();
  return date >= today;
}

/**
 * Get day of week in Austin timezone
 * @param {string|Date} dateInput - Date to get weekday for
 * @param {string} format - 'long', 'short', or 'narrow'
 * @returns {string} Day of week name
 */
export function getAustinWeekday(dateInput, format = 'short') {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  return date.toLocaleDateString('en-US', { weekday: format, timeZone: AUSTIN_TIMEZONE });
}

/**
 * Get month and year in Austin timezone
 * @param {string|Date} dateInput - Date to format
 * @returns {string} Month and year (e.g., "Feb '25")
 */
export function getAustinMonthYear(dateInput) {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: AUSTIN_TIMEZONE
  });
}

/**
 * Check if two dates are the same day in Austin timezone
 * @param {Date} date1 - First date
 * @param {Date} date2 - Second date
 * @returns {boolean} True if same day in Austin timezone
 */
export function isSameAustinDay(date1, date2) {
  if (!date1 || !date2) return false;
  const d1Str = date1.toLocaleDateString('en-US', { timeZone: AUSTIN_TIMEZONE });
  const d2Str = date2.toLocaleDateString('en-US', { timeZone: AUSTIN_TIMEZONE });
  return d1Str === d2Str;
}

/**
 * Format a date for lease documents (e.g., "Oct 23, 2025")
 * @param {string|Date} dateInput - Date to format
 * @returns {string} Formatted date string
 */
export function formatLeaseDate(dateInput) {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: AUSTIN_TIMEZONE
  });
}

/**
 * Format a date for formal documents (e.g., "23 day of October 2025")
 * @param {string|Date} dateInput - Date to format
 * @returns {string} Formal date string
 */
export function formatFormalDate(dateInput) {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const day = parseInt(date.toLocaleDateString('en-US', { day: 'numeric', timeZone: AUSTIN_TIMEZONE }));
  const month = date.toLocaleDateString('en-US', { month: 'long', timeZone: AUSTIN_TIMEZONE });
  const year = date.toLocaleDateString('en-US', { year: 'numeric', timeZone: AUSTIN_TIMEZONE });
  return `${day} day of ${month} ${year}`;
}

/**
 * Format a date for long display (e.g., "Tuesday, February 4, 2025")
 * @param {string|Date} dateInput - Date to format
 * @returns {string} Long formatted date string
 */
export function formatLongDate(dateInput) {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: AUSTIN_TIMEZONE
  });
}

// Export the timezone constant for direct use if needed
export { AUSTIN_TIMEZONE };
