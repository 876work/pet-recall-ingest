# pet-recall-ingest

Cloudflare Worker that pulls US food recall notices from the FDA, runs LLM
extraction over the messy product text, writes normalized records to D1, and
serves them to the Clearbowl iOS app. It also delivers the push notifications.

The app never talks to a `.gov` endpoint. It reads from this.

**FDA only.** There are two sources, both FDA:

| Source | id prefix | What it is |
| --- | --- | --- |
| openFDA food enforcement | `fda:` | `api.fda.gov/food/enforcement.json` — classified reports, land weeks after the event |
| FDA press releases | `fda_press:` | the recalls RSS feed — company announcements, same day |

USDA FSIS was removed and is not coming back on the current approach: the
endpoint returns an Akamai 403 against Worker egress and the adapter never
produced a single record. `src/sources/fsis.ts` is gone, no row in the database
carries that source, and nothing downstream should claim USDA coverage. The app
says FDA-only everywhere; keep this in step with it.

Pet food comes from the food enforcement endpoint, not `/animalandveterinary/`
— that one is adverse events, not recalls. There is no reliable "is this pet
food" field, so ingest pulls the whole window and lets the extractor classify.

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

`EXPO_ACCESS_TOKEN` is optional and only needed if the Expo project turns on
enhanced push security. Unset, delivery is unauthenticated as normal.

## What it exposes

Public, no auth — the app has no account to authenticate with:

`GET /recalls/search` searches extracted public title, identifier, event ID,
product, brand, recalling firm, reason and exact UPC fields. It returns grouped
recall events with the same nested products/variants shape as `/recalls` and
uses `limit`/`offset` paging (25 by default, 100 maximum). Exact IDs and UPCs
rank first, then product/brand phrases, then firm/reason matches. Empty `q` is
rejected. Search terms are not logged. Text matching uses the existing D1
recall, product and brand tables; exact UPC matching uses the existing UPC
index. The current corpus is a few thousand rows, so substring matches use
bounded table scans instead of an additional full-text index.

| Route | Notes |
| --- | --- |
| `GET /recalls` | filtered feed; edge-cached |
| `GET /recalls/search?q=...` | paginated public recall-event search; 60-second edge cache; category, classification, status and source filters |
| `GET /brands` | brand list for following |
| `GET /upc/:code` | barcode lookup, tiered `upc_exact` → `brand_product` → `brand_only` |
| `POST /devices/register` | full mirror of one device's brands and pantry barcodes |
| `POST /devices/unregister` | |
| `GET /health` | |

Admin, `Authorization: Bearer $ADMIN_TOKEN`:

| Route | Notes |
| --- | --- |
| `GET /admin/ingest` | fetch + upsert + extract; `?days=` window |
| `GET /admin/extract` | drain the extraction backlog; asks for ≤25, see the subrequest note below |
| `GET /admin/notify` | drain the notify queue, looped |
| `GET /admin/stats` | corpus counts and the last ingest run |

Cron runs `0 */6 * * *`: ingest, then extract, then notify — in that order,
because the notifier skips any queued recall that is not extracted yet.

### The subrequest ceiling

A Worker invocation gets **50 subrequests** on the free plan, and one ingest run
has to fit ingest *and* extraction inside that. `EXTRACT_BATCH` asks for 25
records, but that is a request, not a guarantee: when the budget runs out the
remaining records fail with `Too many subrequests by single Worker invocation`
and park at extraction version 0. Do not read "25 per call" as throughput.

Roughly, per run:

| | subrequests |
| --- | --- |
| openFDA pagination | ~6 (100 records per page) |
| press RSS feed | 1 |
| press bodies | one per release **whose body we do not already hold** |
| stored-body lookup | 1 D1 read |
| extraction | 1 Anthropic call per record, plus its D1 writes |

Fetching every press body on every run cost 20 subrequests and left almost
nothing for extraction — one run managed 3 records and failed 22. Bodies are
now fetched once (see below), so steady state spends ~8 before extraction
begins and new releases are the only ones that cost a page fetch.

Backfill, then check what landed:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://pet-recall-ingest.<you>.workers.dev/admin/ingest?days=730"

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://pet-recall-ingest.<you>.workers.dev/admin/stats"
```

`./drain.sh` loops `/admin/extract` until the backlog is empty. It reads
`ADMIN_TOKEN` from the environment.

## Verify before you trust it

**1. The press-release body fetch.** This is the single most likely thing to
break, because it depends on FDA's page markup. `src/sources/fda_press.ts`
fetches each release and takes the text inside
`<article id="main-content">`; the RSS `description` is only a ~300 character
blurb and the UPC table sits far below it. If FDA restructures that page the
container match fails, every record silently falls back to the blurb, and UPC
yield collapses. Check for it:

```sql
SELECT COUNT(*), AVG(LENGTH(raw_description))
FROM recalls WHERE id LIKE 'fda_press:%';
```

Full notices average several thousand characters. If that average drops toward
300, the selector has stopped matching. `raw_json` carries a `body_fetched`
flag per record for the same reason.

Note the feed is a **rolling window of 20 items** with no pagination. A release
that ages out before its body is fetched keeps its blurb permanently — there is
no way to go back for it through this feed.

**2. Extraction quality.** Pull records and read them against the source text by
hand. Do not skip this.

```sql
SELECT r.id, p.brand_raw, p.product_name, p.package_sizes, r.extraction_confidence
FROM recalls r JOIN recall_products p ON p.recall_id = r.id
ORDER BY r.recall_date DESC LIMIT 40;
```

**3. UPC yield.** This number decides whether the pantry feature works at all.

```sql
SELECT COUNT(DISTINCT recall_id) FROM recall_upcs;
SELECT COUNT(*) FROM recalls;
```

**4. Failed extractions.** These park at version 0, and — despite what the
comment in `store.ts` says — that does **not** take them out of the queue:
`pendingExtraction` selects `extraction_version IS NULL OR extraction_version <
EXTRACTION_VERSION`, and `0 < 2`. They are retried on every run, sorted to the
front by `recall_date DESC`.

That is what makes a budget failure self-healing, and it is also why a record
that fails for a real reason will retry forever. Check the count periodically:

```sql
SELECT COUNT(*) FROM recalls WHERE extraction_version = 0;
```

## Design decisions worth knowing

**Raw text is never dropped.** `raw_json` and `raw_description` are permanent.
Your extraction prompt will be wrong in ways you only see after a hundred real
records. Bump `EXTRACTION_VERSION` in `src/extract.ts`, then:

```sql
UPDATE recalls SET extraction_version = NULL WHERE extraction_version < 3;
```

and the whole corpus re-extracts on the next cron. Costs cents.

**Content hashing gates LLM spend.** The hash covers description, reason, title
and firm — not status. A recall closing does not trigger re-extraction. It also
means a press release whose body arrives for the first time reads as changed and
re-queues itself; one whose fetch failed hashes identically and costs nothing.

**A press-release body is fetched once.** After the first fetch the text is
stored, and later runs reuse it verbatim rather than re-reading the page. The
reuse has to be verbatim: `description` feeds the content hash, so handing back
the short RSS blurb for a record whose stored description is the full body would
read as a change, overwrite the good text, and reset extraction — every run.
Revisions are not missed, because FDA publishes them as a new feed item with a
new slug, which arrives as its own record.

**One recall is many rows.** openFDA splits an event across one enforcement
report per product or lot. The read API and the notifier both group on the same
event key before doing anything user-facing, or a single recall would arrive as
sixteen notifications.

**The two sources do not share an identity.** A recall can appear as a press
release and then as an enforcement report weeks later. `read.ts` de-duplicates
them on exact keys only — a shared UPC, or a shared resolved brand plus product
— and treats the enforcement report as canonical because it carries the recall
number, classification and status.

**No fuzzy brand matching.** Aliases resolve through the hand-maintained
`brand_aliases` table only. Fuzzy matching produces confident wrong answers, and
telling someone their pet food is fine when it is not is the failure that ends
the app. Expect to spend an hour a month on that table.

**Lot codes are stored but never matched on.** They are printed inconsistently
in places nobody looks. Show them; let the user check.

**Delivery is at-least-once.** If a push fails, the event's queue rows stay
pending and the next cron retries, which can re-notify a device that already
got it. A repeated recall alert is an annoyance; a dropped one is the product
failing. Recalls older than 21 days drain without notifying, so a backfill does
not alarm anyone about food they have already eaten.

**Push alerts only ever target a followed brand or a saved pantry barcode.**
There is no "notify everyone" path. A device with neither is registered and
receives nothing — which is correct, and is why the app sells brand following
and the pantry rather than the alerts themselves.

## Cost

Extraction is `claude-haiku-4-5-20251001` at temperature 0 over a few thousand
tokens per record. The initial backfill was a few dollars; steady state is cents
per month at 10–30 new records a week. This is not where your money goes.

Ingest costs one subrequest per press release whose body is not already
stored. In steady state that is only the new ones; a run where all twenty feed
items are already held costs a single D1 read instead.

## Corpus at time of writing

Snapshot, not a contract. Re-run `/admin/stats` for current numbers.

| | |
| --- | --- |
| Recalls | 836 (811 enforcement, 25 press) |
| With at least one UPC | 334 |
| Brands | 449 |
| Parked at extraction version 0 | 22 |

## Known gaps

- Press releases that age out of the 20-item RSS window before their body is
  fetched keep the ~300 character blurb permanently. Recovering them needs a
  route into FDA's archive that this feed does not provide.
- The 22 records parked at extraction version 0 have never been triaged.
- No USDA/FSIS coverage, deliberately — see the top of this file.
