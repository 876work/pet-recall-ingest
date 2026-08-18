import type { Extraction, RawRecord } from './types';
import { findUpcsInText, normalizeUpc } from './normalize';

/**
 * Bump this whenever you change SYSTEM_PROMPT or the schema. Records carrying
 * an older version can then be re-extracted with:
 *   UPDATE recalls SET extraction_version = NULL WHERE extraction_version < N;
 */
export const EXTRACTION_VERSION = 2;

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You extract structured product data from US food recall notices.

The input is free text written by a recalling company or a government agency. It is inconsistent, often contains HTML remnants, and frequently lists many product variants in one blob.

Return ONLY a JSON object. No markdown, no code fences, no preamble.

Schema:
{
  "category": "pet_food" | "human_food" | "drug" | "device" | "other",
  "species": string[],          // ["dog"], ["cat"], ["dog","cat"], or [] if not pet food or unspecified
  "products": [
    {
      "brand": string | null,
      "product_name": string | null,      // the variant, e.g. "Chicken & Rice Formula Adult"
      "package_sizes": string[],          // e.g. ["4 lb", "16 oz"]
      "lot_codes": string[],
      "establishment_number": string | null
    }
  ],
  "upcs": string[],             // digits only, no dashes or spaces
  "confidence": "high" | "medium" | "low"
}

Rules, in order of importance:

1. NEVER GUESS. If a field is not stated in the text, use null or an empty array. A missing value is correct; an invented value is a safety failure. This is used to warn people about contaminated food.

2. Copy values verbatim from the text. Do not expand abbreviations, correct spelling, infer a full brand name from a partial one, or add a product line you recognize but that is not written.

3. Separate brand from product name. "Acme Naturals Grain-Free Salmon Recipe" is brand "Acme Naturals", product_name "Grain-Free Salmon Recipe". If you cannot tell where the brand ends, put the whole string in brand and leave product_name null.

3a. The RECALLING FIRM line is metadata about who is conducting the recall. It is not a brand. Never copy it into the brand field. If the PRODUCT TEXT names no brand, brand is null — even when that leaves the product with a name and nothing else. A firm name sitting in the brand field becomes a brand people are matched against later, which is worse than an empty field.

4. One entry per distinct product variant. If the notice lists six flavors of one brand, return six products. If it describes one product in six package sizes, return one product with six package_sizes.

4a. lot_codes: at most 50 per product. Some notices list hundreds of batch codes. Those codes are never matched against and the complete list is always kept in the source text, so transcribing all of them buys nothing and a long enough list will truncate this response and lose the entire extraction. When a product has more than 50, give the first 50 in the order written, then make the final array element exactly "TRUNCATED - full lot list in source notice". Never apply this cap to upcs or package_sizes.

5. UPCs: extract every 12, 13 or 14 digit barcode number. Strip dashes and spaces. Do not include lot codes, establishment numbers, phone numbers, case counts, or "best by" dates as UPCs.

6. category: "pet_food" covers dog, cat and other companion animal food, treats and supplements. Livestock feed is "other". If a notice covers both human and pet products, choose based on the majority of the products listed.

6a. "pet_food" requires stated evidence that an animal is the consumer. Do not infer it from vocabulary. Ask one question of the text: does this notice say an animal eats this? Only these count as evidence:
   - a named species — "for dogs", "cat treat", "canine", "feline", "puppy formula"
   - feeding directions addressed to an animal — "feed 1 cup per 10 lbs of body weight"
   - a product form stated to be for animals — "bully stick for dogs", "kibble", "pet treat", "dog chew"
   - pet retail or distribution context — sold in pet stores, the pet aisle, or a veterinary channel
If none of these appear, the category is not "pet_food".

6b. A pet-related word inside a product name is not evidence. A name is a label, not a description of who eats it. "Fibroid Bully" is a product name; "bully stick for dogs" is a description of the product. Likewise "Squirrel Brand" is a nut mix for people, "Animal Crackers" is a human cookie, "Puppy Chow" is a human snack mix. When the only thing pointing at pets is a word inside the name, the answer is not "pet_food".

6c. A human health claim in the product name disqualifies "pet_food" unless 6a evidence is also present. Names invoking menopause, prostate, diabetes, fibroid, blood pressure, libido, fertility or similar human conditions describe a product sold to people. A genuine veterinary diet for a condition always states its species as well — so where species is stated, 6a wins and the product may still be "pet_food".

6d. When no 6a evidence is present, classify the product by what the notice actually describes and set confidence to "low" if you are unsure, so a human can review it. Do not resolve ambiguity by defaulting either way.

7. confidence: "high" when brands, products and UPCs are clearly enumerated. "medium" when products are identifiable but details are partial. "low" when the text is vague, truncated, or you extracted almost nothing.`;

export async function extract(
  apiKey: string,
  record: RawRecord,
): Promise<Extraction> {
  const userText = [
    record.title ? `TITLE: ${record.title}` : null,
    record.recallingFirm ? `RECALLING FIRM: ${record.recallingFirm}` : null,
    record.reason ? `REASON: ${record.reason}` : null,
    `\nPRODUCT TEXT:\n${record.description}`,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      // Headroom for genuinely product-dense notices. Rule 4a is what actually
      // bounds the output; this is the margin behind it, since a response that
      // hits the ceiling truncates mid-JSON and loses the whole extraction.
      max_tokens: 8000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userText.slice(0, 60_000) },
        // Prefill forces the response to open as JSON and kills preamble.
        { role: 'assistant', content: '{' },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text =
    '{' +
    body.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');

  return coerce(parseJson(text), record);
}

function parseJson(text: string): unknown {
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Model occasionally trails a stray token. Take the outermost object.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('No JSON object in response');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

/**
 * Never trust model output shape. Coerce everything, and union the model's
 * UPCs with a regex sweep of the raw text so a missed one still gets caught.
 */
function coerce(parsed: unknown, record: RawRecord): Extraction {
  const p = (parsed ?? {}) as Record<string, unknown>;

  const modelUpcs = arr(p.upcs)
    .map((u) => normalizeUpc(String(u)))
    .filter((u): u is string => u !== null);

  const upcs = [...new Set([...modelUpcs, ...findUpcsInText(record.description)])];

  const products = arr(p.products).map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    return {
      brand: nullableStr(item.brand),
      product_name: nullableStr(item.product_name),
      package_sizes: arr(item.package_sizes).map(String),
      lot_codes: arr(item.lot_codes).map(String),
      establishment_number: nullableStr(item.establishment_number),
    };
  });

  const category = ['pet_food', 'human_food', 'drug', 'device', 'other'].includes(
    String(p.category),
  )
    ? (p.category as Extraction['category'])
    : 'other';

  const confidence = ['high', 'medium', 'low'].includes(String(p.confidence))
    ? (p.confidence as Extraction['confidence'])
    : 'low';

  return {
    category,
    species: arr(p.species).map(String),
    products,
    upcs,
    // No products extracted means we learned nothing useful, whatever it claims.
    confidence: products.length === 0 ? 'low' : confidence,
  };
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function nullableStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 && s.toLowerCase() !== 'null' ? s : null;
}
