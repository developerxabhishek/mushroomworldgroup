const express = require('express');
const { validateBatchInput, validateOrderInput, isValidHeader } = require('./lib/validation');
const { createBatch, toBatchResponse } = require('./services/batches');
const { placeOrder, confirmOrder } = require('./services/orders');
const { reconcile } = require('./services/reconcile');

const badRequest = (res, message) => res.status(400).json({ error: 'INVALID_INPUT', message });

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  app.post('/batches', async (req, res) => {
    const { value, error } = validateBatchInput(req.body);
    if (error) return badRequest(res, error);
    const batch = await createBatch(value);
    res.status(201).json(toBatchResponse(batch));
  });

  app.post('/orders', async (req, res) => {
    const distributorId = req.get('X-Distributor-Id');
    const idempotencyKey = req.get('Idempotency-Key');
    if (!isValidHeader(distributorId)) return badRequest(res, 'X-Distributor-Id header is required');
    if (!isValidHeader(idempotencyKey)) return badRequest(res, 'Idempotency-Key header is required');

    const { value, error } = validateOrderInput(req.body);
    if (error) return badRequest(res, error);

    const result = await placeOrder({
      distributorId: distributorId.trim(),
      idempotencyKey: idempotencyKey.trim(),
      input: value,
    });
    res.status(result.status).json(result.body);
  });

  app.post('/orders/:id/confirm', async (req, res) => {
    const result = await confirmOrder({ orderId: req.params.id });
    res.status(result.status).json(result.body);
  });

  app.get('/reconcile', async (req, res) => {
    res.status(200).json(await reconcile());
  });

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

  
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return badRequest(res, 'body is not valid JSON');
    if (err.type === 'entity.too.large') return badRequest(res, 'body too large');
    console.error(err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}

module.exports = { createApp };
