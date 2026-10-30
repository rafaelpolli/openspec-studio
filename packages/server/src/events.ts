import type { ServerEvent } from "@studio/shared";

type Listener = (event: ServerEvent) => void;

/** In-process pub/sub that fans server events out to connected UI clients. */
export class EventBus {
  readonly #listeners = new Set<Listener>();

  publish(event: ServerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get size(): number {
    return this.#listeners.size;
  }
}
