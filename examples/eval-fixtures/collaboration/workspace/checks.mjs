import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function check(root, revised) {
  const { summarizePaidOrders } = await import(pathToFileURL(join(root, "src/summary.mjs")));
  const row = (sku, quantity, status = "paid") => Object.freeze({ sku, quantity, status });
  const rows = Object.freeze([
    row("  Ab-1 ", 2), row("other", 3), row("ignored", 20, "draft"),
    row("Ab-1", 5), row("ab-1", 7), row("OTHER", 9),
  ]);
  assert.deepEqual(summarizePaidOrders([]), []);
  assert.deepEqual(summarizePaidOrders([row("ignored", 1, "draft")]), []);
  assert.deepEqual(summarizePaidOrders([{ ...row("ignored", 1, "draft"), paid: true }]), []);
  assert.deepEqual(summarizePaidOrders(rows), revised
    ? [{ sku: "Ab-1", quantity: 14 }, { sku: "other", quantity: 12 }]
    : [{ sku: "Ab-1", quantity: 7 }, { sku: "other", quantity: 3 }, { sku: "ab-1", quantity: 7 }, { sku: "OTHER", quantity: 9 }]);
  assert.deepEqual(summarizePaidOrders([row("__proto__", 2), row("__proto__", 4)]), [
    { sku: "__proto__", quantity: 6 },
  ]);
}
