import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const source = "src/orders.mjs";
export const userLabel = "User's draft receipt";
export const load = (root) => import(pathToFileURL(join(root, source)));

export async function check(root, { quantity, currency, label }) {
  const { eligible, receiptLabel, describeOrder } = await load(root);
  assert.equal(receiptLabel, label);
  assert.equal(describeOrder({ id: "example" }), label + ": example");
  for (const status of ["paid", "draft", "cancelled"])
    for (const count of [-1, 0, 1, 7])
      for (const code of ["CNY", "USD", "cny", ""]) {
        const order = Object.freeze({ status, quantity: count, currency: code });
        assert.equal(
          eligible(order),
          status === "paid" && (!quantity || count > 0) && (!currency || code === "CNY"),
          JSON.stringify(order),
        );
      }
}
