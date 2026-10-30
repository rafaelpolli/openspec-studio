/**
 * A local OpenAI-compatible chat endpoint that answers with scripted tool calls, so the real
 * engine can be exercised (permissions, tools, events) without a real LLM (task 6.8).
 *
 * Each agent turn asks for the next tool call; once the script is exhausted the model replies
 * with plain text and the session goes idle. Requests without tools (e.g. title generation)
 * get a short text answer.
 */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  output: string;
}

export interface MockLlm {
  url: string;
  /** OpenCode provider config that points at this endpoint, as provider `mock`, model `m`. */
  providerConfig: Record<string, unknown>;
  model: { providerID: string; modelID: string };
  /** Tool results the engine sent back, in order. */
  results: ToolResult[];
  /** Replaces the script and clears the recorded results, for the next session. */
  setScript(script: ToolCall[]): void;
  stop(): Promise<void>;
}

type Message = { role: string; content?: unknown; tool_call_id?: string };

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  const body = {
    id: "mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((p) => (p as { text?: string }).text ?? "").join("");
  return "";
}

/**
 * `scriptFor` picks the script from the latest user prompt, so one endpoint can play several
 * sessions (e.g. one script per apply task); the step restarts when the prompt changes.
 */
export function startMockLlm(
  initial: ToolCall[] = [],
  scriptFor?: (prompt: string) => ToolCall[],
  /** Where to listen; an engine inside a container reaches the host at the Docker gateway. */
  hostname = "127.0.0.1",
): MockLlm {
  let script = initial;
  /** With `scriptFor`, each prompt keeps its own script and step: sessions can run at the same time. */
  const byPrompt = new Map<string, { script: ToolCall[]; step: number }>();
  let calls = 0;
  const results: ToolResult[] = [];
  const names = new Map<string, string>();
  let step = 0;

  const server = Bun.serve({
    hostname,
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const body = (await req.json()) as { messages: Message[]; tools?: unknown[] };
      let out: string[];
      if (!body.tools?.length) {
        out = [chunk({ role: "assistant", content: "teste" }), chunk({}, "stop")];
      } else {
        for (const m of body.messages) {
          if (m.role === "tool" && m.tool_call_id && names.has(m.tool_call_id)) {
            results.push({ tool: names.get(m.tool_call_id)!, output: text(m.content) });
            names.delete(m.tool_call_id);
          }
        }
        let state = { script, step };
        if (scriptFor) {
          const last = [...body.messages].reverse().find((m) => m.role === "user");
          const current = text(last?.content);
          if (!byPrompt.has(current)) byPrompt.set(current, { script: scriptFor(current), step: 0 });
          state = byPrompt.get(current)!;
        }
        const call = state.script[state.step];
        if (call) {
          const id = `call_${calls++}`;
          state.step++;
          if (!scriptFor) step = state.step;
          names.set(id, call.tool);
          out = [
            chunk({
              role: "assistant",
              tool_calls: [
                { index: 0, id, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args) } },
              ],
            }),
            chunk({}, "tool_calls"),
          ];
        } else {
          out = [chunk({ role: "assistant", content: "pronto" }), chunk({}, "stop")];
        }
      }
      return new Response(out.join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const url = `http://${hostname}:${server.port}/v1`;
  return {
    url,
    providerConfig: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: url, apiKey: "mock" },
        models: { m: { name: "Mock", tool_call: true, limit: { context: 100000, output: 4096 } } },
      },
    },
    model: { providerID: "mock", modelID: "m" },
    results,
    setScript(next) {
      script = next;
      step = 0;
      byPrompt.clear();
      results.length = 0;
      names.clear();
    },
    stop: () => server.stop(true),
  };
}
