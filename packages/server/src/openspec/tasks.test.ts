import { describe, expect, test } from "bun:test";
import { parseTasks } from "./tasks.ts";

describe("parseTasks", () => {
  test("groups tasks by section and reads ids, text and line numbers", () => {
    const md = "# Tasks\n\n## 1. Setup\n\n- [x] 1.1 Create repo\n- [ ] 1.2 Install deps\n\n## 2. Core\n\n- [ ] 2.1 Build it\n";
    const list = parseTasks(md);
    expect(list.sections.map((s) => s.title)).toEqual(["1. Setup", "2. Core"]);
    expect(list.sections[0]!.tasks[0]).toEqual({ id: "1.1", text: "Create repo", done: true, line: 5 });
    expect(list.sections[1]!.tasks[0]).toEqual({ id: "2.1", text: "Build it", done: false, line: 10 });
    expect(list.total).toBe(3);
    expect(list.complete).toBe(1);
  });

  test("a box holding only x counts as done, in any case and spacing", () => {
    const md = ["- [x] a", "- [X] b", "- [ X] c", "- [x ] d", "* [x] e"].join("\n");
    expect(parseTasks(md).sections[0]!.tasks.map((t) => t.done)).toEqual([true, true, true, true, true]);
  });

  test("every other marker is unfinished", () => {
    const md = ["- [ ] a", "- [] b", "- [~] c", "- [-] d", "- [xx] e"].join("\n");
    const list = parseTasks(md);
    expect(list.total).toBe(5);
    expect(list.complete).toBe(0);
  });

  test("lines without a checkbox are not tasks", () => {
    const md = "## Workflow follow-up\n\n- Archive the change\nSome text\n- [ ] 1.1 Real task\n";
    const list = parseTasks(md);
    expect(list.total).toBe(1);
    expect(list.sections[0]!.tasks[0]!.text).toBe("Real task");
  });

  test("tasks before the first heading go to an untitled section; ids are optional", () => {
    const list = parseTasks("- [ ] No number here\n");
    expect(list.sections[0]).toEqual({
      title: null,
      tasks: [{ id: null, text: "No number here", done: false, line: 1 }],
    });
  });

  test("handles CRLF line endings", () => {
    expect(parseTasks("## A\r\n- [x] 1.1 One\r\n").complete).toBe(1);
  });
});
