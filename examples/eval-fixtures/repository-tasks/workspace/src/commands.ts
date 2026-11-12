import { TaskCatalog } from "./legacy.js";

export function readyTitles(text: string): string {
  return TaskCatalog.fromLines(text).list("todo").map((task) => task.title).join(" ");
}
