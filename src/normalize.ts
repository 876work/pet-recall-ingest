/**
 * Normalization helpers.
 *
 * The brand logic here is deliberately conservative. It collapses casing,
 * punctuation and a few corporate suffixes, and nothing else. Real brand
 * families ("Purina" vs "Nestle Purina" vs "Purina Pro Plan") are resolved by
 * the hand-maintained brand_aliases table, not by clever string matching.
 * Fuzzy brand matching produces confident wrong answers, which is the worst
 * possible failure mode for a safety app.
 */

const CORPORATE_SUFFIXES = [
  'inc', 'incorporated', 'llc', 'l l c', 'ltd', 'limited', 'co', 'company',
  'corp', 'corporation', 'holdings', 'group', 'brands', 'foods', 'usa',
];

export function normalizeBrand(input: string | null | undefined): string | null {
  if (!input) return null;

  let s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip accents: Nestlé -> Nestle
    .replace(/[^a-z0-9\s]/g, ' ')      // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trailing corporate suffixes, repeatedly ("Acme Foods Inc" -> "acme")
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of CORPORATE_SUFFIXES) {
      if (s.endsWith(' ' + suffix)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }

  return s.length > 0 ? s : null;
}

/**
 * Reduce a UPC/GTIN to a comparable form, rejecting anything that is not a
 * real barcode.
 *
 * Barcode scanners hand you EAN-13 for US products, which is just the UPC-A
 * with a leading zero. Recall notices print UPC-A. Without this they never
 * match and your highest-confidence path silently never fires.
 *
 * Every GTIN carries a mod-10 check digit, and validating it is what keeps
 * digit runs that merely look like barcodes out of recall_upcs — dates, batch
 * numbers, two codes run together. An invented UPC produces a confident wrong
 * match, which is the one failure this app cannot afford.
 */
export function normalizeUpc(input: string): string | null {
  const digits = input.replace(/\D/g, '');

  // GTIN-14 / EAN-13 -> UPC-12 when the extra leading digits are zeros
  let s = digits;
  while (s.length > 12 && s.startsWith('0')) s = s.slice(1);

  // Retail barcode lengths on US food packaging. GTIN-8 is deliberately not
  // accepted: it is rare here and short enough that dates and lot numbers pass
  // the check digit by chance often enough to matter. Anything else — an
  // 11-digit random-weight scale code, a truncated print — cannot match a scan
  // anyway, so storing it only adds noise.
  if (s.length !== 12 && s.length !== 13 && s.length !== 14) return null;

  return hasValidCheckDigit(s) ? s : null;
}

/** Standard GTIN mod-10: weights alternate 3,1 leftwards from the check digit. */
function hasValidCheckDigit(gtin: string): boolean {
  let sum = 0;
  let weight = 3;

  for (let i = gtin.length - 2; i >= 0; i--) {
    const d = gtin.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    sum += d * weight;
    weight = weight === 3 ? 1 : 3;
  }

  return (10 - (sum % 10)) % 10 === gtin.charCodeAt(gtin.length - 1) - 48;
}

/**
 * Pull anything UPC-shaped out of free text as a fallback.
 *
 * The character class holds digits and hyphens only. It must never include
 * whitespace: a run allowed to cross a space will swallow whatever number
 * follows a real UPC — a list marker, the next date — and emit a barcode that
 * appears nowhere in the source text.
 */
export function findUpcsInText(text: string): string[] {
  const candidates = text.match(/\b\d[\d-]{10,16}\d\b/g) ?? [];
  const out = new Set<string>();

  for (const c of candidates) {
    const n = normalizeUpc(c);
    if (n) out.add(n);
  }

  return [...out];
}

export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Two-letter state codes mentioned in a distribution string. */
const STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR','VI','GU',
]);

export function parseStates(input: string | null | undefined): string[] {
  if (!input) return [];
  if (/nationwide|all states|nation wide/i.test(input)) return ['NATIONWIDE'];
  const tokens = input.toUpperCase().match(/\b[A-Z]{2}\b/g) ?? [];
  return [...new Set(tokens.filter((t) => STATE_CODES.has(t)))];
}
