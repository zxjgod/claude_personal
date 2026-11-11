import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const { parseMoney, formatMoney } = await import(pathToFileURL(join(root, "src/money.mjs")));
const { invoiceTotal } = await import(pathToFileURL(join(root, "src/invoice.mjs")));
for (const [text, cents] of [["0", 0], [" 12.34 ", 1234], ["1.2", 120], ["001.01", 101], ["0.29", 29]])
  assert.equal(parseMoney(text), cents);
for (const value of ["-1", "1.234", "1e2", "bad", "2x", "", ".", "9007199254740992", 1, null])
  assert.throws(() => parseMoney(value));
assert.equal(formatMoney(0), "0.00");
assert.equal(formatMoney(1234), "12.34");
for (const value of [-1, 1.5, NaN, Infinity, "100", Number.MAX_SAFE_INTEGER + 1])
  assert.throws(() => formatMoney(value));
assert.equal(invoiceTotal([]), "0.00");
assert.equal(invoiceTotal([{ price: "0.10" }, { price: "0.20" }, { price: "1.05" }]), "1.35");
assert.equal(invoiceTotal([{ price: "0.29" }]), "0.29");
