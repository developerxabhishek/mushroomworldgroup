# Perishable Stock & Order Allocation

Node.js + Express + MongoDB API that allocates perishable mushroom stock to distributor orders.
It is built so stock can never be oversold, every stock movement is recorded, and unconfirmed
reservations come back automatically.

- Part A – code review: [REVIEW.md](REVIEW.md)
- Part B – the API: [src/](src/), race script: [scripts/race.js](scripts/race.js), tests: [tests/](tests/)
- Part C – change request: `allowSubstitute` and 30-minute reservations for Platinum
- Part D – recording: link is in the email

---

## How to run

You need **Node.js 18+**. Run `npm install` first.

### Tests and race script (no MongoDB install needed)

```bash
npm test        # allocation, pricing, IST delivery-date rule + Part C tests
npm run race    # 10 kg of stock, 50 parallel orders of 1 kg each
```

Both start their own temporary MongoDB replica set (`mongodb-memory-server`), which is deleted
when they finish. The first run downloads a MongoDB binary, so it needs internet once.

`npm run race` prints something like this, and exits with code 1 if stock was ever oversold:

```
Responses         : {"201":10,"409":40}
Total allocated   : 10000 g
Left in batch     : 0 g
Ledger reconciles : true
PASS: never allocated more than 10 kg
```

Every run uses a fresh database, so it gives the same result however many times you run it.

### The API server

The server needs MongoDB running as a **replica set** (a single node is enough), because
multi-document transactions only work on a replica set.

```bash
# terminal 1: start a single-node replica set
mkdir -p .mongo-data
mongod --replSet rs0 --port 27018 --dbpath .mongo-data --bind_ip 127.0.0.1

# terminal 2: initialise it (only the first time), then start the API
mongosh --port 27018 --eval 'rs.initiate()'
npm start       # → API listening on :3000
```

Settings can go in a `.env` file (`cp .env.example .env`) or be passed as environment variables.
Without a `.env` the defaults below are used, which match the commands above.

| Variable | Default |
|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27018/perishable?directConnection=true` |
| `PORT` | `3000` |
| `SWEEP_INTERVAL_MS` (how often expired reservations are released) | `10000` |

Distributor tiers are read from the `distributors` collection (see assumptions). To make a
distributor Platinum:

```bash
mongosh "mongodb://127.0.0.1:27018/perishable?directConnection=true" \
  --eval 'db.distributors.insertOne({ _id: "dist-42", tier: "PLATINUM" })'
```

Example requests:

```bash
curl -X POST localhost:3000/batches -H 'Content-Type: application/json' \
  -d '{"product":"oyster","grade":"A","grams":50000,"harvestedAt":"2026-11-23T06:00:00+05:30"}'

curl -X POST localhost:3000/orders -H 'Content-Type: application/json' \
  -H 'X-Distributor-Id: dist-42' -H 'Idempotency-Key: order-001' \
  -d '{"product":"oyster","grade":"A","grams":12500,"deliveryDate":"2026-11-24","allowPartial":false}'

curl -X POST localhost:3000/orders/<orderId>/confirm
curl localhost:3000/reconcile
```

---

## What I finished

**Part A:** [REVIEW.md](REVIEW.md) lists 13 issues, most serious first. Each has where it is, what is
wrong, what happens in production, how serious it is, and the fix.

**Part B:** all business rules and the full API contract.

- Expiry = harvest time + shelf life (oyster 72 h, button 120 h, dried 180 days).
- A batch is used only if it is still valid at 23:59:59 IST on the delivery date.
- First-expiry-first allocation. An order can be split across batches. Grades A and B are never mixed.
- `allowPartial: false` with short stock gives 409, and nothing is allocated.
- Grams and paise everywhere, integers only. Pricing is done in exact integer maths (BigInt) and
  rounded once per line.
- Pricing: base → Grade B −15% → tier (Silver 0%, Gold 5%, Platinum 8%) → −20% if less than 24 h
  left. The total discount on a line is never more than 25%. Order total = exact sum of the lines.
- Orders stay `RESERVED` for 15 minutes. A sweeper releases expired ones every 10 s and once at
  startup. The deadline is stored in the database, so this still works after a restart.
  Confirm also checks the time itself, so a late confirm gets 410 even before the sweeper runs.
- Every stock movement (`ADDED`, `RESERVED`, `RELEASED`, `CONFIRMED`) is written to an append-only
  ledger, and `GET /reconcile` rebuilds stock from it.
- Idempotency: same key + same body returns the original response, and a different body returns 422.
  Concurrent requests with the same key create only one order (unique index + retry).
- **No overselling:** each order runs in a MongoDB transaction. Stock is taken with a guarded update
  `updateOne({ _id, remainingGrams: { $gte: take } }, { $inc: { remainingGrams: -take } })`. If two
  requests touch the same batch at the same moment, one hits a write conflict, retries, and sees the
  new stock. Stock can never go below zero.
- `scripts/race.js` and tests for allocation, pricing and the IST delivery-date rule.

**Part C:**

- `allowSubstitute: true`: if Grade A is short, the rest is filled from Grade B at Grade B price.
  Substituted lines are marked in the response:
  ```json
  "lines": [
    { "batchId": "…", "grams": 6000, "amountPaise": 180000 },
    { "batchId": "…", "grams": 4000, "amountPaise": 102000, "grade": "B", "substituted": true }
  ]
  ```
- Platinum distributors get a 30-minute reservation. Everyone else still gets 15.
- Tests: [tests/substitute.test.js](tests/substitute.test.js) and
  [tests/platinum-reservation.test.js](tests/platinum-reservation.test.js). The Part B tests are
  unchanged and still pass.

---

## What I skipped

Nothing that the brief asks for was skipped: Parts A, B and C are done, along with
`scripts/race.js` and the tests. The Part D recording is linked in the email.

These are things a production system would also need. The brief does not ask for them,
so I left them out:

- **Authentication.** `X-Distributor-Id` is trusted as sent. Anyone can confirm any order if they
  know its id.
- **Database-level protection for the ledger.** Updates and deletes are blocked in the app
  (Mongoose hooks). Someone with direct database access could still change it. In production the
  app's database user would get insert-only rights on the ledger.
- **Expiring idempotency keys.** They are kept forever, because the brief says the same key always
  returns the original response. In production I would expire them after a day or so.

---

## Assumptions and decisions

Things the brief does not specify, or that I had to decide:

1. **Base prices are not given.** I assumed oyster ₹300/kg, button ₹200/kg and dried ₹1200/kg
   (`30000`, `20000` and `120000` paise). They are in [src/config.js](src/config.js).
2. **Where the distributor tier comes from is not given.** The request only has `X-Distributor-Id`.
   The tier is read from the `distributors` collection by that id. An unknown distributor is treated
   as **Silver** (no discount).
3. **Discounts are applied one after another, not added**, because the brief uses arrows
   (base → B → tier → expiry). Grade B + Gold is 0.85 × 0.95 = 19.25% off, not 20%. If a line goes
   below 75% of base it is raised to 75%, and that floor is rounded **up**, so the discount can never
   pass 25%. Each line is rounded once, half up, to whole paise. The total is the integer sum of the
   rounded lines.
4. **Boundaries:** "less than 24 hours left" is measured at the time of order, and exactly 24 h left
   gets no discount. A batch expiring exactly at 23:59:59 IST on the delivery day is not used.
5. **Delivery dates in the past are not rejected.** The brief's own example date (`2026-11-22`) is
   already in the past, so rejecting it could fail your test suite. The end-of-day rule still
   decides which batches can be used.
6. **Missing `allowPartial` or `allowSubstitute`** is treated as `false`.
7. **No stock at all** gives 409 even with `allowPartial: true`, so we never create an empty ₹0 order.
8. **`harvestedAt` must include a timezone** (`Z` or `+05:30`). Without one, the same text means
   different times on different servers, and the expiry would be wrong.
9. **Responses the brief does not define:** `POST /batches` returns 201 with `batchId`, `product`,
   `grade`, `grams`, `remainingGrams`, `harvestedAt` and `expiresAt`. A 400 has the body
   `{ "error": "INVALID_INPUT", "message": "…" }`. `GET /reconcile` always returns 200 with
   `{ ok, batchesChecked, mismatches: [{ batchId, ledgerGrams, batchGrams, diffGrams }] }`.
10. **Confirm:** an unknown or malformed order id gives 404 `{ "error": "ORDER_NOT_FOUND" }`.
    Confirming an already confirmed order returns 200 again, so a retry is safe. No headers are
    required, because the contract lists none for this route.
11. **Idempotency keys are per distributor** (`X-Distributor-Id` + `Idempotency-Key`). The body is
    compared after validation, so field order does not matter. A replay returns the original
    response, even if it was a 409 and stock has arrived since.
12. **Part C, `allowSubstitute`:** it only applies to Grade A orders, and a Grade B order is never
    filled from Grade A. All usable Grade A is used first, then Grade B, first-expiry-first.
    "Grade B price" means the normal Grade B pricing (−15%, tier, near-expiry, 25% cap). Only
    substituted lines get the extra `"grade": "B", "substituted": true`, so normal lines keep the
    Part B shape. If A + B together are still short, `allowPartial` decides as before.
13. **Part C, Platinum reservation:** the length is fixed when the order is placed. If a
    distributor becomes Platinum later, existing reservations keep their original deadline.
