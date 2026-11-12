export interface Task {
  id: string;
  title: string;
  priority: 0 | 1 | 2;
  status: "todo" | "done";
}

export function parseTaskLines(text: string): Task[] {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function compareTasks(left: Task, right: Task): number {
  return left.priority - right.priority;
}

export class TaskCatalog {
  constructor(private readonly tasks: Task[]) {}

  static fromLines(text: string): TaskCatalog {
    return new TaskCatalog(parseTaskLines(text));
  }

  list(status?: Task["status"]): Task[] {
    return (status ? this.tasks.filter((task) => task.status === status) : this.tasks).sort(compareTasks);
  }

  complete(id: string): boolean {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return false;
    task.status = "done";
    return true;
  }
}
