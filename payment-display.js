const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DISPLAY_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loadQrImage(filename) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024 || stat.size < 24) throw new Error('Invalid QR image');
  const data = fs.readFileSync(filename);
  const png = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!png && !jpeg) throw new Error('QR must be PNG or JPEG');
  return { data, type: png ? 'image/png' : 'image/jpeg' };
}

function createPaymentDisplay({
  secret = process.env.PAYMENT_DISPLAY_SECRET || '',
  imagePath = process.env.VIPPS_QR_IMAGE_PATH || path.join(__dirname, 'public/images/vipps-qr.png'),
  broadcast = () => {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  const router = express.Router();
  let active = null;
  let timer = null;
  // Bounded replay protection: duplicates never create a fresh 30-second window.
  const seen = new Map();
  const inactive = () => ({ type: 'payment-display', active: false });
  function snapshot() {
    if (active && active.expiresAt <= now()) clear(active.requestId);
    return active ? { type: 'payment-display', active: true, ...active } : inactive();
  }
  function clear(requestId) {
    if (!active || active.requestId !== requestId) return;
    cancel(timer);
    active = null;
    timer = null;
    broadcast({ ...inactive(), requestId });
  }
  function authenticate(req, res, next) {
    if (secret.length < 32) return res.status(503).json({ error: 'TV-betaling er ikke konfigurert.' });
    const provided = req.get('authorization') || '';
    const expected = `Bearer ${secret}`;
    const digest = text => crypto.createHash('sha256').update(text).digest();
    if (!crypto.timingSafeEqual(digest(provided), digest(expected))) {
      return res.status(401).json({ error: 'Ingen tilgang.' });
    }
    next();
  }
  router.get('/payment-qr', (_req, res) => {
    try {
      const image = loadQrImage(imagePath);
      res.set('Cache-Control', 'no-store').type(image.type).send(image.data);
    } catch {
      res.status(503).json({ error: 'Installer Vipps QR-bildet på TV-serveren.' });
    }
  });
  router.post('/payment-display', authenticate, express.json({ limit: '1kb', strict: true }), (req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['amount', 'requestId', 'deadline'].includes(key)) ||
        !Number.isSafeInteger(body.amount) || body.amount <= 0 || !UUID.test(body.requestId || '') ||
        !Number.isSafeInteger(body.deadline) || body.deadline <= now() || body.deadline > now() + 10_000) {
      return res.status(400).json({ error: 'Ugyldig betalingsvisning.' });
    }
    try { loadQrImage(imagePath); } catch {
      return res.status(503).json({ error: 'Installer Vipps QR-bildet på TV-serveren.' });
    }
    for (const [id, entry] of seen) if (entry.keepUntil <= now()) seen.delete(id);
    if (seen.has(body.requestId)) {
      const previous = seen.get(body.requestId);
      if (previous.amount !== body.amount) return res.status(409).json({ error: 'Forespørselen er allerede brukt.' });
      return res.json({ accepted: true, requestId: body.requestId, expiresAt: previous.expiresAt });
    }
    if (seen.size >= 1000) return res.status(429).json({ error: 'For mange forespørsler. Prøv igjen senere.' });
    cancel(timer);
    active = { requestId: body.requestId, amount: body.amount, currency: 'NOK', expiresAt: now() + DISPLAY_MS };
    seen.set(active.requestId, { amount: active.amount, expiresAt: active.expiresAt, keepUntil: now() + 60_000 });
    const id = active.requestId;
    timer = schedule(() => clear(id), DISPLAY_MS);
    timer?.unref?.();
    broadcast(snapshot());
    res.json({ accepted: true, requestId: id, expiresAt: active.expiresAt });
  });
  router.use((err, _req, res, _next) => {
    res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: 'Ugyldig betalingsforespørsel.' });
  });
  return { router, snapshot, close() { cancel(timer); active = null; seen.clear(); } };
}

module.exports = { createPaymentDisplay, loadQrImage, DISPLAY_MS };
