import { formatMoney, parseMoney } from "./money.mjs";

export function invoiceTotal(items) {
  const total = items.reduce((sum, item) => sum + parseMoney(item.price) * 100, 0);
  return formatMoney(total / 100);
}
