// Visitor Identity - persists name/email/phone in localStorage
// Used to auto-fill followup forms across the site

const STORAGE_KEY = 'property_visitor';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function saveVisitor({ name, email, phone }) {
  const data = getVisitor();
  if (name) data.name = name;
  if (email) data.email = email;
  if (phone) data.phone = phone;
  data.savedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function getVisitor() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (data.savedAt && Date.now() - data.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return {};
    }
    return data;
  } catch {
    return {};
  }
}
