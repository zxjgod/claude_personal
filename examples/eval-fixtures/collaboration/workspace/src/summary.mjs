import { normalizeSku } from "./sku.mjs";

export function summarizePaidOrders(rows) {
  return rows.map(({ sku, quantity }) => ({ sku: normalizeSku(sku), quantity }));
}
