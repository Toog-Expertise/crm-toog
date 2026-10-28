'use strict';
// Limite simple en mémoire : au plus `max` actions par `windowMs` pour une clé donnée.
const buckets = new Map();

function hit(key, max, windowMs) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { buckets.set(key, list); return false; }
  list.push(now);
  buckets.set(key, list);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, list] of buckets) if (!list.some((t) => now - t < 3600e3)) buckets.delete(k);
}, 600e3).unref();

module.exports = { hit };
