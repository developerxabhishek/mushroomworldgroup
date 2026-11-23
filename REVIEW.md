# Code review: `orderService.js`

This is a review of the `placeOrder` service that was given in the brief. Every issue below has:

- **Where:** the part of the code it is in, with the exact snippet copied from the original
- **What's wrong:** why the code does not do what it should
- **What happens in production:** what the business actually sees
- **Fix:** how to correct it

The issues are ordered from most serious to least serious.

## Summary

| #  | Issue | Where | Severity |
|----|-------|-------|----------|
| 1  | `forEach` with an `async` callback | `placeOrder`, allocation loop | **High** |
| 2  | Read, change and save on the stock, so orders oversell | `placeOrder`, allocation loop | **High** |
| 3  | Stock is reduced before the order is accepted, with no transaction | `placeOrder`, loop and the insufficient-stock check | **High** |
| 4  | Delivery date compared at UTC midnight instead of the end of the day in IST | `placeOrder`, `Batch.find` filter | **High** |
| 5  | `batch.product.basePricePerKg` is `undefined`, so every price is `NaN` | `priceFor` | **High** |
| 6  | Reservation lasts 0.9 seconds and is never released | `placeOrder`, `Order.create` | **High** |
| 7  | No idempotency, so a retry creates a duplicate order | `placeOrder`, `Order.create` | Medium |
| 8  | Weight and money stored as floating point numbers | `placeOrder` and `priceFor` | Medium |
| 9  | Distributor tier discount and the 25% discount cap are missing | `priceFor` | Medium |
| 10 | No input validation | `placeOrder`, function arguments | Medium |
| 11 | Batches sorted by harvest time instead of expiry time | `placeOrder`, `Batch.find` sort | Low |
| 12 | Empty ₹0 orders, and out of stock comes back as a 500 | `placeOrder`, end of the function | Low |
| 13 | No ledger of stock movements | whole service | Low |

Issues 1 to 3 are the reason orders are going wrong today. Each of them on its own is enough to corrupt stock.

---

## 1. `forEach` with an `async` callback (High)

**Where:** `placeOrder`, the allocation loop

```js
batches.forEach(async (b) => {
  if (needed <= 0) return;
  const take = Math.min(b.remainingGrams, needed);
  b.remainingGrams -= take;
  await b.save();
  lines.push({ batchId: b._id, grams: take, price: priceFor(b, take) });
  needed -= take;
});

if (needed > 0 && !allowPartial) {
  throw new Error('Insufficient stock');
}
```

**What's wrong**

`forEach` does not wait for the promise that an `async` callback returns. Each callback runs until it reaches `await b.save()`, and then `forEach` moves straight on to the next batch. The two lines after the `await` (`lines.push(...)` and `needed -= take`) only run later, after the saves finish.

This has two effects:

- `needed` has not been reduced when the next batch is processed. Every batch takes `min(remainingGrams, needed)` against the **full** quantity, so stock is taken from every matching batch.
- `forEach` returns before any save has finished. At the `if (needed > 0 ...)` check, `lines` is still `[]` and `needed` is still the full amount.

**What happens in production**

Example: a distributor orders 5 kg and there are two 10 kg batches.

- Both batches lose 5 kg, so **10 kg leaves stock for a 5 kg order**.
- With `allowPartial: false`, `needed` is still 5000 at the check, so the order is rejected with "Insufficient stock". This happens **even when there is plenty of stock**, so every non-partial order fails. The saves have already been sent, so the stock is gone and there is no order.
- With `allowPartial: true`, the total is calculated from the empty `lines` array, so a **₹0 RESERVED order** is saved with no lines.
- If any of the saves fails, nothing is awaiting it. It becomes an unhandled promise rejection, which **crashes the Node process** on Node 15 and later, together with every other request in flight.

**Fix**

Never pass an `async` function to `forEach`. Work out the whole allocation first, in memory, with a normal loop and without writing anything. Then apply it in one transaction (see #2 and #3).

```js
const plan = [];
let needed = grams;
for (const b of batches) {
  if (needed === 0) break;
  const take = Math.min(b.remainingGrams, needed);
  plan.push({ batchId: b._id, take });
  needed -= take;
}
```

---

## 2. Read, change and save on the stock, so orders oversell (High)

**Where:** `placeOrder`, inside the allocation loop

```js
const take = Math.min(b.remainingGrams, needed);
b.remainingGrams -= take;
await b.save();
```

**What's wrong**

The batch is read with `find`, the subtraction is done in JavaScript, and the result is written back with `save()`. `save()` writes the number calculated from that earlier read, which may already be out of date. Nothing stops two requests from reading the same batch at the same moment. This is a classic lost update.

This problem remains even after #1 is fixed.

**What happens in production**

Two distributors each order 10 kg at the same moment, and there is one 10 kg batch:

1. Request A reads `remainingGrams = 10000`.
2. Request B reads `remainingGrams = 10000`.
3. A writes `0`, and B writes `0`.
4. Both orders succeed.

**20 kg is sold from a 10 kg batch.** This is fresh produce, so the shortfall cannot be made up and one distributor gets a short delivery. All it takes is two requests close together, so it will happen every time the system is busy.

**Fix**

Let MongoDB check the stock and reduce it in one atomic step:

```js
const res = await Batch.updateOne(
  { _id: batchId, remainingGrams: { $gte: take } }, // only if there is still enough
  { $inc: { remainingGrams: -take } },
  { session }
);
if (res.modifiedCount === 0) {
  // another order got there first: abort the transaction and retry or reject
}
```

If another request has already taken the stock, the filter does not match and nothing changes. Run this inside the same transaction as the order (see #3).

---

## 3. Stock is reduced before the order is accepted, with no transaction (High)

**Where:** `placeOrder`, the saves in the loop and the check after it

```js
await b.save();            // stock is already reduced here
...
if (needed > 0 && !allowPartial) {
  throw new Error('Insufficient stock');   // too late, nothing is put back
}
...
return Order.create({ ... });   // separate write, no transaction
```

**What's wrong**

The code reduces stock batch by batch first, and only afterwards checks whether there was enough. When it throws, nothing puts the stock back. The batch updates and `Order.create` are separate writes with no transaction around them. If anything fails partway through, such as a save error, an `Order.create` error or a server restart, some batches have been reduced and no order exists.

**What happens in production**

The rule says that with `allowPartial: false`, an order that cannot be filled must be rejected with **nothing** allocated. Here, a rejected order still uses up stock. The same thing happens if `Order.create` fails after the saves.

That stock is not linked to any order, so it is never released and never delivered. Over time the system shows less stock than is really in the cold room, and nobody can tell where it went.

**Fix**

Decide first, write second, and do all the writes in one transaction:

```js
// 1. plan in memory (see #1), then decide
if (needed > 0 && !allowPartial) throw new InsufficientStockError(); // nothing written yet

// 2. write everything or nothing
await session.withTransaction(async () => {
  for (const { batchId, take } of plan) {
    // atomic $inc from #2, with { session }
  }
  await Order.create([{ /* ... */ }], { session });
});
```

If any step fails, MongoDB rolls back all the writes.

---

## 4. Delivery date compared at UTC midnight instead of the end of the day in IST (High)

**Where:** `placeOrder`, the `Batch.find` filter

```js
const batches = await Batch.find({
  product,
  grade,
  expiresAt: { $gte: new Date(deliveryDate) },
  remainingGrams: { $gt: 0 },
})
```

**What's wrong**

JavaScript parses a date-only string such as `"2026-11-22"` as **midnight UTC**:

```js
new Date('2026-11-22')   // 2026-11-22T00:00:00.000Z  →  05:30 AM IST on the 22nd
```

That is the **start** of the delivery day in India. The rule says a batch must still be valid at the **end** of the delivery day, 23:59:59 IST.

**What happens in production**

Any batch that expires between 05:30 AM and midnight on the delivery day still passes the filter. Example: an oyster batch that expires at 2 PM on the 22nd gets allocated to an order delivering on the 22nd. The distributor receives mushrooms that go bad the day they arrive, sometimes before they reach the shop. That is a **food safety problem**, and it leads to returns and credit notes.

A delivery date in the past is accepted as well, along with stock that has already expired.

**Fix**

Treat the delivery date as a calendar date in IST and compare it with the end of that day:

```js
const endOfDeliveryDay = new Date(`${deliveryDate}T23:59:59.999+05:30`);

Batch.find({ product, grade, expiresAt: { $gt: endOfDeliveryDay }, remainingGrams: { $gt: 0 } })
```

Also check that `deliveryDate` is a real `YYYY-MM-DD` date and is not earlier than today in IST.

---

## 5. `batch.product.basePricePerKg` is `undefined`, so every price is `NaN` (High)

**Where:** `priceFor`

```js
function priceFor(batch, grams) {
  const perKg = batch.product.basePricePerKg;
  let price = (grams / 1000) * perKg;
  ...
}
```

**What's wrong**

The query filters on `product` as a plain value such as `"oyster"`, so `batch.product` is a string. If it were a reference, it would be an ObjectId that was never populated. Neither has a `basePricePerKg` property:

```js
'oyster'.basePricePerKg          // undefined
(5000 / 1000) * undefined        // NaN
```

**What happens in production**

Every line price is `NaN`, and so is the order total. Depending on the Order schema, one of two things happens:

- Saving the order fails, after the stock has already been taken (see #3).
- The order is saved with no usable price.

Either way, the distributor cannot be billed for what is sent.

**Fix**

Read the price from a product catalogue, either in config or in a `products` collection, keyed by the product code. If the price is missing, fail loudly instead of carrying on with `undefined`.

```js
const PRODUCTS = {
  oyster: { shelfLifeHours: 72,      basePricePerKgPaise: 30000 },
  button: { shelfLifeHours: 120,     basePricePerKgPaise: 20000 },
  dried:  { shelfLifeHours: 180 * 24, basePricePerKgPaise: 120000 },
};
const product = PRODUCTS[batch.product];
if (!product) throw new Error(`Unknown product ${batch.product}`);
```

---

## 6. Reservation lasts 0.9 seconds and is never released (High)

**Where:** `placeOrder`, the `Order.create` call

```js
return Order.create({
  ...
  status: 'RESERVED',
  reservedUntil: Date.now() + 15 * 60,
});
```

**What's wrong**

`Date.now()` returns **milliseconds**, so `15 * 60` adds 900 ms, not 15 minutes. The value is also stored as a plain number instead of a `Date`. On top of that, nothing in the service ever releases a reservation after it expires.

**What happens in production**

- If anything checks `reservedUntil`, every reservation has expired before the distributor can press confirm, so **no order can ever be confirmed**.
- If nothing checks it (and nothing here does), unconfirmed orders **hold their stock forever**. That stock stays reserved until the mushrooms rot, while other distributors are told there is none.

**Fix**

```js
reservedUntil: new Date(Date.now() + 15 * 60 * 1000)
```

Then add the missing parts:

- **A background job** that finds orders still `RESERVED` after `reservedUntil`, marks them `EXPIRED` and puts their grams back into the batches. The deadline is stored in the database, so the job still finds these orders after a server restart.
- **A check in confirm** that rejects an order once `reservedUntil` has passed, even if the job has not run yet.

---

## 7. No idempotency, so a retry creates a duplicate order (Medium)

**Where:** `placeOrder`, the `Order.create` call. There is no request key anywhere.

```js
return Order.create({ distributorId, lines, total, ... });
```

**What's wrong**

`placeOrder` has no way to tell that a request was already processed. There is no idempotency key and no check before `Order.create`, so every call creates a new order.

**What happens in production**

Distributors often order from phones on poor networks. If a request times out after the server has already created the order, the app or the person retries, and a **second order** is created that reserves the stock a second time. The distributor gets a duplicate, and that stock is blocked for everyone else until someone notices and cancels it.

**Fix**

- Require an `Idempotency-Key` header on every order request.
- Store the key, a hash of the request body and the response. Put a unique index on `{ distributorId, key }`, and save this record in the same transaction as the order.
- Same key with the same body: return the stored response and do not create a new order.
- Same key with a different body: reject the request with `422`.

---

## 8. Weight and money stored as floating point numbers (Medium)

**Where:** `placeOrder` and `priceFor`

```js
let needed = qtyKg * 1000;                                   // kg → grams, float
const total = lines.reduce((sum, l) => sum + l.price, 0);    // float rupees summed
return Math.round(price * 100) / 100;                        // rounding in float rupees
```

**What's wrong**

All of these are floating point numbers, and most decimal values cannot be stored exactly:

```js
1.005 * 1000                    // 1004.9999999999999  (not 1005 grams)
10.1 + 20.2 + 30.3              // 60.599999999999994
Math.round(1.005 * 100) / 100   // 1  (should be 1.01, a paisa is lost)
```

**What happens in production**

- Batches end up holding fractional grams such as `0.0000000001`. The query uses `remainingGrams > 0`, so these leftovers keep empty batches showing up as available stock.
- The order total does not always equal the sum of the line prices, and amounts are off by a paisa here and there. That is enough to break reconciliation with accounts and invoices.

**Fix**

Use whole numbers only: **grams** for weight and **paise** for money.

- Take the quantity in grams.
- Do the pricing in integer paise and round once per line.
- Make the total the integer sum of the line amounts.

---

## 9. Distributor tier discount and the 25% discount cap are missing (Medium)

**Where:** `priceFor`

```js
if (batch.grade === 'B') price = price * 0.85;
const hoursLeft = (batch.expiresAt - Date.now()) / 3600000;
if (hoursLeft < 24) price = price - price * 0.2;
return Math.round(price * 100) / 100;
```

**What's wrong**

`priceFor` applies the Grade B discount (15%) and the near-expiry discount (20%), but two pricing rules are missing completely:

- **Tier discount:** there is no Silver 0%, Gold 5% or Platinum 8% discount. The function does not even receive the distributor.
- **25% cap:** nothing stops the discounts from adding up past 25% of the base price. Grade B plus near expiry already comes to **32% off** (0.85 × 0.80 = 0.68). Platinum on top would make it about **37% off**.

**What happens in production**

- Gold and Platinum distributors are charged full price, more than their agreed rate. That leads to disputes and manual credit notes.
- Near-expiry Grade B stock is sold below the price floor the business set, so every one of those lines loses margin.

**Fix**

Pass the distributor's tier in. Apply the discounts in this order: base price, then Grade B, then tier, then near expiry. Then make sure the result never goes below 75% of the base price:

```js
let amount = base;                                    // paise for this line
if (grade === 'B') amount = amount * 85 / 100;
amount = amount * (100 - TIER_PCT[tier]) / 100;
if (hoursLeft < 24) amount = amount * 80 / 100;
amount = Math.max(Math.round(amount), Math.ceil(base * 75 / 100)); // 25% cap
```

Store the breakdown on each line so any price can be explained later.

---

## 10. No input validation (Medium)

**Where:** `placeOrder`, the function arguments are used directly

```js
async function placeOrder({ distributorId, product, grade, qtyKg, deliveryDate, allowPartial }) {
  const batches = await Batch.find({ product, grade, expiresAt: { $gte: new Date(deliveryDate) }, ... });
  let needed = qtyKg * 1000;
```

**What's wrong**

`qtyKg`, `deliveryDate`, `product` and `grade` are used exactly as they arrive. Nothing checks that they exist, have the right type or make sense.

**What happens in production**

| Input | Result |
|-------|--------|
| `qtyKg` missing or `"5kg"` | `needed` becomes `NaN`, so `remainingGrams` is set to `NaN` and `save()` rejects it. That rejection happens inside the un-awaited `forEach` (#1), so it is unhandled and **the process crashes**. |
| `qtyKg` is `0` or negative | The loop allocates nothing and the stock check is skipped, so an empty ₹0 RESERVED order is saved. |
| `deliveryDate` is `"22/11/2026"` | It becomes `Invalid Date`. The query fails and the client gets a 500 instead of a 400. |
| `product` or `grade` misspelled | Nothing matches, and the distributor is told "Insufficient stock" instead of "invalid product". |

**Fix**

Validate the request before doing anything else, and return `400` with a clear message if any check fails:

- the quantity is a positive integer number of grams
- `product` and `grade` come from the allowed lists
- `deliveryDate` is a real `YYYY-MM-DD` date
- `allowPartial` is a boolean

---

## 11. Batches sorted by harvest time instead of expiry time (Low)

**Where:** `placeOrder`, the sort on `Batch.find`

```js
}).sort({ harvestedAt: 1 });
```

**What's wrong**

The rule is to allocate from the batch that **expires first**, so the sort should be on `expiresAt`. There is also no tie-breaker, so batches with the same time come back in no fixed order.

**What happens in production**

Today it mostly gives the same result, because the query is for one product and expiry is just harvest time plus that product's shelf life. It breaks quietly as soon as a batch's expiry is set differently, for example after a quality check or a change in shelf life. Then stock that expires earlier is left behind and goes to waste. Without a tie-breaker, the batch that gets used first can also change from one request to the next.

**Fix**

```js
.sort({ expiresAt: 1, _id: 1 })
```

Add an index on `{ product: 1, grade: 1, expiresAt: 1 }` so the query stays fast.

---

## 12. Empty ₹0 orders, and out of stock comes back as a 500 (Low)

**Where:** `placeOrder`, the end of the function

```js
if (needed > 0 && !allowPartial) {
  throw new Error('Insufficient stock');
}
...
return Order.create({ distributorId, lines, total, status: 'RESERVED', ... });
```

**What's wrong**

- With `allowPartial: true` and no stock at all, nothing is allocated and the `!allowPartial` check does not throw. `Order.create` still runs, with no lines and a total of 0.
- Insufficient stock is reported with a plain `new Error(...)`. The route cannot tell it apart from a real crash, so the client most likely gets a **500**.

**What happens in production**

- Distributors see RESERVED orders with nothing in them, and these orders still count in reports and order numbers.
- The app cannot tell "out of stock" from "server broke", so it cannot show a useful message and may keep retrying a request that will never succeed.

**Fix**

- If nothing could be allocated, reject the order whatever `allowPartial` says.
- Use a dedicated error for insufficient stock and turn it into `409 { "error": "INSUFFICIENT_STOCK" }`. Keep 500 for real failures.

---

## 13. No ledger of stock movements (Low)

**Where:** the whole service. Stock is changed in place and nothing records it.

```js
b.remainingGrams -= take;
await b.save();
```

**What's wrong**

Stock is overwritten on the batch, and nothing records that it changed. There is no ledger for stock added, reserved, released or confirmed. The order also does not store the product, grade, delivery date, distributor tier or how each line price was worked out.

**What happens in production**

When the stock numbers are wrong (and with bugs #1 to #3 they will be), nobody can say why. There is no way to see which order took the grams or when, and no way to rebuild the correct figure. If a distributor questions an invoice line, there is nothing to show how that price was calculated.

**Fix**

- For every stock movement (`ADDED`, `RESERVED`, `RELEASED`, `CONFIRMED`), write a row to an append-only ledger in the same transaction as the stock change. Never update or delete these rows.
- Store the pricing inputs on each order line.
- With the ledger in place, stock can be rebuilt from it at any time and compared with the batches to catch mismatches.
