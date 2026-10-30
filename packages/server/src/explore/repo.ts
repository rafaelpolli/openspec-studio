import type { Database } from "bun:sqlite";
import type { ChangeDraft, ExplorationMessage, ExplorationStatus, ExplorationSummary, MessageRole, MessageStatus } from "@studio/shared";

interface Row {
  id: string;
  workspace_id: string;
  title: string | null;
  title_by_user: number;
  status: ExplorationStatus;
  change_name: string | null;
  parent_id: string | null;
  summary: string | null;
  draft_json: string | null;
  created_at: string;
  updated_at: string;
  preview: string | null;
}

/** An exploration as stored, with what the summary in the list does not carry. */
export interface ExplorationRecord extends ExplorationSummary {
  titleByUser: boolean;
  summary?: string;
  draft?: ChangeDraft;
}

const PREVIEW = 60;
const SELECT = `SELECT e.*, (SELECT substr(text, 1, ${PREVIEW}) FROM exploration_messages m
  WHERE m.exploration_id = e.id AND m.role = 'usuario' ORDER BY m.id LIMIT 1) AS preview FROM explorations e`;

function toRecord(r: Row): ExplorationRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    titleByUser: r.title_by_user === 1,
    status: r.status,
    ...(r.change_name ? { change: r.change_name } : {}),
    ...(r.parent_id ? { parentId: r.parent_id } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.draft_json ? { draft: JSON.parse(r.draft_json) as ChangeDraft } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    preview: r.preview ?? "",
  };
}

const now = () => new Date().toISOString();

/** The explorations of each workspace and their messages (add-workspace-explore D2). */
export class ExplorationRepo {
  constructor(private readonly db: Database) {}

  create(workspaceId: string, parentId?: string): ExplorationRecord {
    const id = crypto.randomUUID();
    const t = now();
    this.db
      .query("INSERT INTO explorations (id, workspace_id, status, parent_id, created_at, updated_at) VALUES (?, ?, 'ativa', ?, ?, ?)")
      .run(id, workspaceId, parentId ?? null, t, t);
    return this.get(id)!;
  }

  get(id: string): ExplorationRecord | undefined {
    const row = this.db.query<Row, [string]>(`${SELECT} WHERE e.id = ?`).get(id);
    return row ? toRecord(row) : undefined;
  }

  /** The workspace's explorations, the most recently active first. */
  list(workspaceId: string): ExplorationRecord[] {
    return this.db.query<Row, [string]>(`${SELECT} WHERE e.workspace_id = ? ORDER BY e.updated_at DESC, e.rowid DESC`).all(workspaceId).map(toRecord);
  }

  /** The agent's title only while the user has not written one; the user's always. */
  setTitle(id: string, title: string, byUser: boolean): void {
    if (byUser) this.db.query("UPDATE explorations SET title = ?, title_by_user = 1, updated_at = ? WHERE id = ?").run(title, now(), id);
    else this.db.query("UPDATE explorations SET title = ?, updated_at = ? WHERE id = ? AND title_by_user = 0").run(title, now(), id);
  }

  setStatus(id: string, status: ExplorationStatus, extra: { change?: string; summary?: string } = {}): void {
    this.db
      .query("UPDATE explorations SET status = ?, change_name = COALESCE(?, change_name), summary = COALESCE(?, summary), updated_at = ? WHERE id = ?")
      .run(status, extra.change ?? null, extra.summary ?? null, now(), id);
  }

  setDraft(id: string, draft: ChangeDraft): void {
    this.db.query("UPDATE explorations SET draft_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(draft), now(), id);
  }

  messages(id: string): ExplorationMessage[] {
    return this.db
      .query<{ id: number; role: MessageRole; text: string; status: MessageStatus; created_at: string }, [string]>(
        "SELECT id, role, text, status, created_at FROM exploration_messages WHERE exploration_id = ? ORDER BY id",
      )
      .all(id)
      .map((m) => ({ id: m.id, role: m.role, text: m.text, status: m.status, createdAt: m.created_at }));
  }

  addMessage(id: string, role: MessageRole, text: string, status: MessageStatus): number {
    const t = now();
    const res = this.db
      .query("INSERT INTO exploration_messages (exploration_id, role, text, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, role, text, status, t);
    this.db.query("UPDATE explorations SET updated_at = ? WHERE id = ?").run(t, id);
    return Number(res.lastInsertRowid);
  }

  updateMessage(messageId: number, text: string, status: MessageStatus): void {
    this.db.query("UPDATE exploration_messages SET text = ?, status = ? WHERE id = ?").run(text, status, messageId);
  }

  /** After a restart nothing is answering: an answer in progress was interrupted. */
  interruptRunning(): void {
    this.db.query("UPDATE exploration_messages SET status = 'interrompida' WHERE status = 'respondendo'").run();
  }
}
