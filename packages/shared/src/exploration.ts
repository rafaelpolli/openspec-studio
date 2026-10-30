import { z } from "zod";

// Explorations: conversations with the agent before a change exists (add-workspace-explore).

export type ExplorationStatus = "ativa" | "virou-change" | "descartada";

export interface ExplorationSummary {
  id: string;
  workspaceId: string;
  /** Null until the agent suggests one (or the user writes one). */
  title: string | null;
  status: ExplorationStatus;
  /** The change it became. */
  change?: string;
  /** The exploration it continues from. */
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  /** The first words of the first message, shown while there is no title. */
  preview: string;
}

export type MessageRole = "usuario" | "agente";
export type MessageStatus = "respondendo" | "concluida" | "interrompida" | "falhou";

export interface ExplorationMessage {
  id: number;
  role: MessageRole;
  text: string;
  status: MessageStatus;
  createdAt: string;
}

/** What "Virar change" proposes, reviewed by the user before the change is created. */
export const ChangeDraft = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use kebab-case: letras minúsculas, dígitos e hífens"),
  description: z.string().trim().min(3),
  decisions: z.array(z.object({ question: z.string().trim().min(1), answer: z.string().trim().min(1) })),
});
export type ChangeDraft = z.infer<typeof ChangeDraft>;

export interface Exploration extends ExplorationSummary {
  messages: ExplorationMessage[];
  /** The last draft the agent wrote for "Virar change". */
  draft?: ChangeDraft;
  /** The agent is answering, or writing the draft. */
  busy: boolean;
  /** Why the last draft request produced no draft. */
  draftError?: string;
}

export const MessageInput = z.object({ text: z.string().trim().min(1) });
export const TitleInput = z.object({ title: z.string().trim().min(1).max(80) });
export const NewExplorationInput = z.object({ from: z.string().optional() });
