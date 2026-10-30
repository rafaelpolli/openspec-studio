import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProvidersResponse } from "@studio/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProvidersPage } from "./ProvidersPage.tsx";

interface Call {
  method: string;
  url: string;
  body?: unknown;
}
let calls: Call[] = [];
let state: ProvidersResponse;
const realFetch = globalThis.fetch;

/** A minimal backend for the Providers screen. */
function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url === "/api/providers") return json(state);
    const key = /^\/api\/providers\/([^/]+)\/key$/.exec(url);
    if (method === "PUT" && key) {
      const p = state.providers.find((x) => x.id === key[1])!;
      p.configured = true;
      p.models = [{ id: "claude-x", name: "Claude X" }];
      return new Response(null, { status: 204 });
    }
    const del = /^\/api\/providers\/([^/]+)$/.exec(url);
    if (method === "DELETE" && del) {
      const p = state.providers.find((x) => x.id === del[1])!;
      p.configured = false;
      p.models = [];
      return json({ applied: true });
    }
    if (method === "PUT" && url === "/api/settings/default-model") {
      state.defaultModel = (body as { model: string }).model;
      return json({ applied: true });
    }
    return json({ error: { code: "not_found", message: url } }, 404);
  }) as typeof fetch;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProvidersPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  state = {
    defaultModel: null,
    providers: [
      { id: "anthropic", name: "Anthropic", configured: false, methods: [{ index: 0, type: "api", label: "API key" }], models: [] },
      {
        id: "openai",
        name: "OpenAI",
        configured: false,
        methods: [
          { index: 0, type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
          { index: 1, type: "api", label: "Manually enter API Key" },
        ],
        models: [],
      },
    ],
  };
  installFetch();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const card = (name: string) => screen.getByRole("listitem", { name });

describe("Providers screen (6.7)", () => {
  test("lists providers with status and offers API key and OAuth methods", async () => {
    renderPage();
    await screen.findByRole("listitem", { name: "Anthropic" });
    expect(within(card("Anthropic")).getByText("não configurado")).toBeTruthy();
    expect(within(card("OpenAI")).getByRole("button", { name: "ChatGPT Pro/Plus (browser)" })).toBeTruthy();
    expect(within(card("OpenAI")).getByLabelText("Chave de API de OpenAI")).toBeTruthy();
  });

  test("Chave de API: saves the key, clears the field and shows the provider as configured", async () => {
    renderPage();
    await screen.findByRole("listitem", { name: "Anthropic" });
    const input = within(card("Anthropic")).getByLabelText("Chave de API de Anthropic") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "sk-ant-secret" } });
    fireEvent.click(within(card("Anthropic")).getByRole("button", { name: "Salvar chave" }));

    await waitFor(() => expect(within(card("Anthropic")).getByText("configurado")).toBeTruthy());
    expect(calls.find((c) => c.method === "PUT")).toEqual({
      method: "PUT",
      url: "/api/providers/anthropic/key",
      body: { key: "sk-ant-secret" },
    });
    expect(input.value).toBe("");
    // Reabrir a tela: the key is indicated as saved but never displayed.
    expect(within(card("Anthropic")).getByText("Credencial salva.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("sk-ant-secret");
  });

  test("Escolher modelo padrão and Remover", async () => {
    state.providers[0]!.configured = true;
    state.providers[0]!.models = [{ id: "claude-x", name: "Claude X" }];
    renderPage();
    const select = (await screen.findByLabelText("Modelo padrão das novas sessões")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "anthropic/claude-x" } });
    await waitFor(() => expect(select.value).toBe("anthropic/claude-x"));
    expect(calls.find((c) => c.url === "/api/settings/default-model")?.body).toEqual({ model: "anthropic/claude-x" });

    fireEvent.click(within(card("Anthropic")).getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(within(card("Anthropic")).getByText("não configurado")).toBeTruthy());
    expect(screen.queryByLabelText("Modelo padrão das novas sessões")).toBeNull();
  });

  test("filters the provider list", async () => {
    renderPage();
    await screen.findByRole("listitem", { name: "Anthropic" });
    fireEvent.change(screen.getByLabelText("Filtrar provedores"), { target: { value: "open" } });
    expect(screen.queryByRole("listitem", { name: "Anthropic" })).toBeNull();
    expect(screen.getByRole("listitem", { name: "OpenAI" })).toBeTruthy();
  });
});
