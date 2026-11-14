export const receiptLabel = "Receipt";

export function describeOrder(order) {
  return `${receiptLabel}: ${order.id}`;
}

// Eligibility rules for the payment processor.
export function eligible(order) {
  return order.status === "paid";
}
