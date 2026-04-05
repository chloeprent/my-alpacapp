/**
 * Payment String Parser
 * Parses bank transaction strings to extract payment details
 */

export interface ParsedPayment {
  date: Date | null;
  method: string | null;
  sender_name: string | null;
  amount: number | null;
  balance: number | null;
  raw_string: string;
}

/**
 * Parse a payment string from bank transaction data
 *
 * Example input:
 * "02/02/2026
 * CREDIT
 * ZELLE FROM KYMBERLY DELIOU$1,195.00$7,965.45"
 */
export function parsePaymentString(paymentString: string): ParsedPayment {
  const lines = paymentString.trim().split('\n');
  const result: ParsedPayment = {
    date: null,
    method: null,
    sender_name: null,
    amount: null,
    balance: null,
    raw_string: paymentString
  };

  let transactionType: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try to parse date (MM/DD/YYYY format)
    const dateMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dateMatch) {
      const [, month, day, year] = dateMatch;
      result.date = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
      continue;
    }

    // Check for transaction type keywords
    if (/^(CREDIT|DEBIT|CHECK|ACH|WIRE)$/i.test(trimmed)) {
      transactionType = trimmed.toUpperCase();
      continue;
    }

    // Parse the transaction line with amounts
    // Patterns to handle:
    // "ZELLE FROM KYMBERLY DELIOU$1,195.00$7,965.45"
    // "VENMO FROM JOHN DOE $500.00 $1,234.56"
    // "ZELLE FROM NAME$AMOUNT$BALANCE"

    // Extract amounts (one or two dollar amounts at the end)
    const amountPattern = /\$?([\d,]+\.?\d*)\s*\$?([\d,]+\.?\d*)?\s*$/;
    const amountMatch = trimmed.match(amountPattern);

    if (amountMatch) {
      const [fullMatch, amount1, amount2] = amountMatch;

      // Get the description part (everything before the amounts)
      const description = trimmed.slice(0, trimmed.length - fullMatch.length).trim();

      // Extract sender name from description
      // Common patterns: "ZELLE FROM NAME", "VENMO FROM NAME", "TRANSFER FROM NAME"
      const fromMatch = description.match(/(?:ZELLE|VENMO|TRANSFER|PAYMENT|ACH|DEPOSIT)\s+(?:FROM\s+)?(.+)/i);
      if (fromMatch) {
        result.sender_name = fromMatch[1].trim();
        // Extract payment method from description
        const methodMatch = description.match(/^(ZELLE|VENMO|ACH|CHECK|WIRE|PAYPAL)/i);
        if (methodMatch) {
          result.method = methodMatch[1].toLowerCase();
        }
      } else {
        // Use full description as sender name if no pattern matched
        result.sender_name = description || null;
      }

      // Parse amounts
      result.amount = parseFloat(amount1.replace(/,/g, ''));
      if (amount2) {
        result.balance = parseFloat(amount2.replace(/,/g, ''));
      }
    }
  }

  // If we found a transaction type but no specific method, use it
  if (!result.method && transactionType === 'CREDIT') {
    // Default to 'other' for generic credits
    result.method = 'other';
  }

  return result;
}

/**
 * Normalize a name for consistent matching
 * - Lowercase
 * - Trim whitespace
 * - Collapse multiple spaces
 * - Remove special characters
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '');
}
