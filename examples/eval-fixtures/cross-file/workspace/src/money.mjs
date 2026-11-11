export function parseMoney(value) {
  return parseFloat(value);
}

export function formatMoney(cents) {
  return cents.toFixed(2);
}
