import { stableUnique } from "./unique.mjs";
export function uniqueBatches(batches) {
  return batches.map((batch) => stableUnique(batch).reverse());
}
