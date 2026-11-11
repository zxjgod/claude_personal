export function normalizeLineItems(items) {
  return items.filter((item) => item.quantity > 0);
}

export function calculateOrder(items) {
  return normalizeLineItems(items).reduce((sum, item) => sum + item.quantity * item.price, 0);
}
