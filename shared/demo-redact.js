/**
 * Demo mode redaction: only applies when current user has role 'demo'.
 * Does not change behavior for any other role.
 *
 * Each unique real value is deterministically mapped to a unique fake value
 * so that the same person always shows the same fake name, but different
 * people show different fake names.
 */

import { getAuthState } from './auth.js';

// =============================================
// FAKE DATA POOLS (50 each)
// =============================================

const FAKE_FIRST_NAMES = [
  'Ava', 'Ben', 'Cora', 'Dante', 'Elena', 'Felix', 'Greta', 'Hugo', 'Iris', 'Jude',
  'Kira', 'Leo', 'Mila', 'Nico', 'Opal', 'Pavel', 'Quinn', 'Rosa', 'Soren', 'Tala',
  'Uri', 'Vera', 'Wren', 'Xena', 'Yael', 'Zara', 'Amir', 'Bea', 'Cal', 'Dina',
  'Eli', 'Faye', 'Gus', 'Hana', 'Ivan', 'Jade', 'Kai', 'Luna', 'Max', 'Noor',
  'Olga', 'Pete', 'Rae', 'Sam', 'Teo', 'Uma', 'Vic', 'Willa', 'Xavi', 'Yuki',
];

const FAKE_LAST_NAMES = [
  'Aldrin', 'Beckett', 'Crane', 'Dalton', 'Ember', 'Frost', 'Grove', 'Holt', 'Ivory', 'Jarvis',
  'Keene', 'Lark', 'Mercer', 'Nolan', 'Oakes', 'Pratt', 'Quill', 'Reeves', 'Stone', 'Thorne',
  'Vance', 'Wolfe', 'Yates', 'Ziegler', 'Ash', 'Blake', 'Cross', 'Drake', 'Ellis', 'Finch',
  'Gill', 'Hayes', 'Inman', 'Joyce', 'Knox', 'Lane', 'Marsh', 'Nash', 'Ott', 'Penn',
  'Ridge', 'Shaw', 'Tate', 'Vale', 'Webb', 'York', 'Zane', 'Bond', 'Cole', 'Drew',
];

const FAKE_EMAIL_DOMAINS = [
  'outlook.com', 'yahoo.com', 'proton.me', 'icloud.com', 'fastmail.com',
  'hotmail.com', 'zoho.com', 'aol.com', 'mail.com', 'tutanota.com',
];

// =============================================
// DETERMINISTIC HASH → INDEX MAPPING
// =============================================

/** Simple string hash (djb2) → positive integer */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Caches: same real value always maps to same fake value within a session
const _nameCache = new Map();
const _emailCache = new Map();
const _amountCache = new Map();
const _dateCache = new Map();

function pickFakeName(realValue) {
  const key = String(realValue).toLowerCase().trim();
  if (_nameCache.has(key)) return _nameCache.get(key);
  const h = hashStr(key);
  const first = FAKE_FIRST_NAMES[h % FAKE_FIRST_NAMES.length];
  const last = FAKE_LAST_NAMES[(h >>> 4) % FAKE_LAST_NAMES.length];
  const fake = `${first} ${last}`;
  _nameCache.set(key, fake);
  return fake;
}

function pickFakeEmail(realValue) {
  const key = String(realValue).toLowerCase().trim();
  if (_emailCache.has(key)) return _emailCache.get(key);
  const h = hashStr(key);
  const first = FAKE_FIRST_NAMES[h % FAKE_FIRST_NAMES.length].toLowerCase();
  const last = FAKE_LAST_NAMES[(h >>> 4) % FAKE_LAST_NAMES.length].toLowerCase();
  const domain = FAKE_EMAIL_DOMAINS[(h >>> 8) % FAKE_EMAIL_DOMAINS.length];
  const num = (h % 90) + 10; // 10-99
  const fake = `${first}.${last}${num}@${domain}`;
  _emailCache.set(key, fake);
  return fake;
}

function pickFakeAmount(realValue) {
  const key = String(realValue).trim();
  if (_amountCache.has(key)) return _amountCache.get(key);
  // Parse numeric value, apply 50-150% random-ish multiplier based on hash
  const numStr = key.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  const num = parseFloat(numStr);
  if (isNaN(num) || num === 0) {
    _amountCache.set(key, '$0.00');
    return '$0.00';
  }
  const h = hashStr(key);
  const multiplier = 0.5 + ((h % 100) / 100); // 0.50 to 1.49
  const fakeNum = Math.round(num * multiplier * 100) / 100;
  const fake = '$' + fakeNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  _amountCache.set(key, fake);
  return fake;
}

function pickFakeDate(realValue) {
  const key = String(realValue).trim();
  if (_dateCache.has(key)) return _dateCache.get(key);
  const d = new Date(key);
  if (isNaN(d.getTime())) {
    _dateCache.set(key, realValue);
    return realValue; // can't parse, return as-is
  }
  // Shift date by hash-based offset (-90 to +90 days)
  const h = hashStr(key);
  const offsetDays = (h % 181) - 90;
  const fakeDate = new Date(d.getTime() + offsetDays * 86400000);
  const fake = fakeDate.toISOString().split('T')[0]; // YYYY-MM-DD
  _dateCache.set(key, fake);
  return fake;
}

// =============================================
// PUBLIC API
// =============================================

/**
 * @returns {boolean} True only if current user role is 'demon'. Other roles unchanged.
 */
export function isDemoUser() {
  const state = getAuthState();
  return state?.appUser?.role === 'demo';
}

/**
 * Redact a value for demo mode. Each unique real value maps to a unique fake value.
 * Types: 'name' | 'email' | 'amount' | 'date' | 'password' | 'code' | 'generic'
 * @param {string} value - Original value
 * @param {'name'|'email'|'amount'|'date'|'password'|'code'|'generic'} [type]
 * @returns {string}
 */
export function redactString(value, type = 'generic') {
  if (!isDemoUser()) return value ?? '';
  const str = String(value ?? '').trim();
  if (!str) return '';

  switch (type) {
    case 'name': return pickFakeName(str);
    case 'email': return pickFakeEmail(str);
    case 'amount': return pickFakeAmount(str);
    case 'date': return pickFakeDate(str);
    case 'password':
    case 'code':
      return '\u2022\u2022\u2022\u2022\u2022\u2022'; // ••••••
    case 'generic':
    default:
      return '\u2022\u2022\u2022\u2022\u2022\u2022';
  }
}

/**
 * Mask every Nth character of a string (for demo). Returns original when not demo.
 * @param {string} value
 * @param {number} [everyNth]
 * @returns {string}
 */
export function maskString(value, everyNth = 4) {
  if (!isDemoUser()) return value ?? '';
  const str = String(value ?? '');
  if (!str) return str;
  return [...str].map((ch, i) => ((i + 1) % everyNth === 0 ? '\u2587' : ch)).join('');
}

/**
 * Redact common fields on an object for demo. Only runs when isDemoUser().
 * @param {object} obj - Single object
 * @param {object} schema - Map of field name to type
 * @returns {object} New object with redacted values, or same reference when not demo
 */
export function redactObject(obj, schema) {
  if (!obj || !isDemoUser()) return obj;
  const out = { ...obj };
  for (const [key, type] of Object.entries(schema)) {
    if (key in out && out[key] != null) out[key] = redactString(out[key], type);
  }
  return out;
}

/**
 * Redact an array of objects for demo.
 * @param {object[]} list
 * @param {object} schema - Same as redactObject
 * @returns {object[]}
 */
export function redactList(list, schema) {
  if (!list || !isDemoUser()) return list ?? [];
  return (list || []).map(item => redactObject(item, schema));
}
