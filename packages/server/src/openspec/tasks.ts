import type { TaskChecklist, TaskItem, TaskSection } from "@studio/shared";

const CHECKBOX = /^\s*[-*]\s+\[([^\]]*)\]\s+(.*)$/;
const HEADING = /^##\s+(.*?)\s*$/;
const TASK_ID = /^(\d+(?:\.\d+)*)\s+/;

/**
 * Parses a tasks.md checklist the way OpenSpec apply tracks it: a box holding only
 * `x` (any case, any spacing) is done; every other marker is unfinished; lines
 * without a checkbox are not tasks.
 */
export function parseTasks(markdown: string): TaskChecklist {
  const sections: TaskSection[] = [];
  let current: TaskSection | undefined;

  markdown.split(/\r?\n/).forEach((raw, index) => {
    const heading = HEADING.exec(raw);
    if (heading) {
      current = { title: heading[1]!, tasks: [] };
      sections.push(current);
      return;
    }
    const box = CHECKBOX.exec(raw);
    if (!box) return;
    if (!current) {
      current = { title: null, tasks: [] };
      sections.push(current);
    }
    const body = box[2]!.trim();
    const id = TASK_ID.exec(body);
    const task: TaskItem = {
      id: id ? id[1]! : null,
      text: id ? body.slice(id[0].length).trim() : body,
      done: box[1]!.trim().toLowerCase() === "x",
      line: index + 1,
    };
    current.tasks.push(task);
  });

  const all = sections.flatMap((s) => s.tasks);
  return { sections, total: all.length, complete: all.filter((t) => t.done).length };
}
