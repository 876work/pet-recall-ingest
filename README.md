# pet-recall-ingest

Cloudflare Worker that pulls US recall notices from USDA FSIS and openFDA, runs
LLM extraction over the messy product text, and writes normalized records to D1.

The app never talks to a `.gov` endpoint. It reads from this.

## Setup

```bash
npm install
npx wrangler d1 create pet-recall          # paste the id into wrangler.toml
npm run db:init

npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENFDA_API_KEY    # open.fda.gov/apis/authentication
npx wrangler secret put ADMIN_TOKEN        # openssl rand -hex 32

npm run deploy
```

Backfill, then check what landed:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://pet-recall-ingest.<you>.workers.dev/admin/ingest?days=730"

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://pet-recall-ingest.<you>.workers.dev/admin/stats"
```

`/admin/ingest` extracts 25 records per call. Call `/admin/extract` repeatedly
to drain the rest of a backfill, or just let cron work through it.

## Verify before you trust it

**1. The FSIS field map.** This is the single most likely thing to be wrong.
`src/sources/fsis.ts` maps Drupal `field_*` keys, and those names were correct
at time of writing but are not contractually stable. Run:

```bash
curl -s 'https://www.fsis.usda.gov/fsis/api/recall/v/1' | head -c 4000
```

and reconcile against the `FIELDS` constant. Everything downstream is driven by
that one object, so a mismatch is a one-line fix. Official docs:
fsis.usda.gov/science-data/developer-resources/recall-api

**2. Extraction quality.** Pull twenty pet food records and read them against
the source text by hand. Do not skip this.

```sql
SELECT r.id, p.brand_raw, p.product_name, p.package_sizes, r.extraction_confidence
FROM recalls r JOIN recall_products p ON p.recall_id = r.id
WHERE r.category = 'pet_food' ORDER BY r.recall_date DESC LIMIT 40;
```

**3. UPC yield.** This number decides whether the pantry feature works at all.

```sql
SELECT COUNT(DISTINCT recall_id) FROM recall_upcs;
SELECT COUNT(*) FROM recalls WHERE category = 'pet_food';
```

If the ratio is poor, the exact-match path is weaker than hoped and the product
needs to lean harder on brand-following. Better to learn that now than after
building three screens around scanning.

## Design decisions worth knowing

**Raw text is never dropped.** `raw_json` and `raw_description` are permanent.
Your extraction prompt will be wrong in ways you only see after a hundred real
records. Bump `EXTRACTION_VERSION` in `src/extract.ts`, then:

```sql
UPDATE recalls SET extraction_version = NULL WHERE extraction_version < 2;
```

and the whole corpus re-extracts on the next cron. Costs cents.

**Content hashing gates LLM spend.** The hash covers description, reason, title
and firm — not status. A recall closing does not trigger re-extraction.

**No fuzzy brand matching.** Aliases are resolved through the hand-maintained
`brand_aliases` table only. Fuzzy matching produces confident wrong answers, and
telling someone their pet food is fine when it is not is the failure that ends
the app. Expect to spend an hour a month on that table.

**Failed extractions park at version 0**, not NULL, so they stop blocking the
queue but stay findable: `SELECT * FROM recalls WHERE extraction_version = 0`.

**Lot codes are stored but never matched on.** They are printed inconsistently
in places nobody looks. Show them; let the user check.

## Cost

Roughly 2,000 records on initial backfill, then 10–30 a week. Haiku at
temperature 0 over a few thousand tokens each. Backfill is a few dollars at
most, steady state is cents per month. This is not where your money goes.

## Not built yet

- Read API for the app (`/recalls`, `/upc/:code`, `/brands`)
- Notification drain — `notify_queue` fills up but nothing empties it
- Confidence tiering at match time (UPC exact / brand+product / brand only)
- Required disclaimer text: not affiliated with FDA, USDA, or any agency
