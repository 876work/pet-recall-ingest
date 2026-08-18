/**
 * 'fda' is the openFDA enforcement report; 'fda_press' is the same-day company
 * announcement. They are separate sources because they carry separate ids —
 * a recall can appear in both and there is no key that joins them.
 *
 * 'fsis' was removed along with its adapter; the endpoint blocks Worker egress
 * and it never produced a record, so no row in the database carries it.
 */
export type Source = 'fda' | 'fda_press';

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  OPENFDA_API_KEY: string;
  ADMIN_TOKEN: string;
  /**
   * Optional. Expo only requires an access token when a project turns on
   * enhanced push security; unset, delivery is unauthenticated as normal.
   */
  EXPO_ACCESS_TOKEN?: string;
}

/** Normalized shape both source adapters produce. */
export interface RawRecord {
  source: Source;
  sourceId: string;
  title: string | null;
  /** The messy free text we run extraction against. */
  description: string;
  reason: string | null;
  classification: string | null;
  status: string | null;
  recallDate: string | null;
  recallingFirm: string | null;
  states: string[];
  url: string | null;
  raw: unknown;
}

export type Category = 'pet_food' | 'human_food' | 'drug' | 'device' | 'other';

export interface ExtractedProduct {
  brand: string | null;
  product_name: string | null;
  package_sizes: string[];
  lot_codes: string[];
  establishment_number: string | null;
}

export interface Extraction {
  category: Category;
  species: string[];
  products: ExtractedProduct[];
  upcs: string[];
  confidence: 'high' | 'medium' | 'low';
}
