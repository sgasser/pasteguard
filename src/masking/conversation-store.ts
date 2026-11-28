/**
 * In-memory placeholder context store keyed by conversation ID.
 *
 * When a client supplies a conversation ID (e.g. `conversation_id` on
 * `POST /api/mask`), the placeholder context created for that conversation is
 * kept between requests. Values seen earlier in the conversation keep their
 * placeholder, and numbering continues where the previous request left off.
 *
 * State is in-memory only: it is lost when the process restarts. Idle
 * conversations are evicted after `ttlMs` and the least recently used
 * conversation is evicted once `maxConversations` is exceeded.
 */

import { getConfig } from "../config";
import { createPlaceholderContext, type PlaceholderContext } from "./context";

export interface ConversationStoreOptions {
  /** Idle time before a conversation is forgotten. Default: 24 hours. */
  ttlMs?: number;
  /** Maximum number of tracked conversations. Default: 10,000. */
  maxConversations?: number;
  /** Clock used for TTL checks. Injectable for tests. */
  now?: () => number;
}

interface ConversationEntry {
  context: PlaceholderContext;
  lastSeenAt: number;
}

export class ConversationStore {
  // Map iteration order is insertion order. `get` re-inserts accessed
  // conversations, so the first key is always the least recently used one.
  private readonly entries = new Map<string, ConversationEntry>();
  private readonly ttlMs: number;
  private readonly maxConversations: number;
  private readonly now: () => number;

  constructor(options: ConversationStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxConversations = options.maxConversations ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Returns the placeholder context for a conversation, creating a fresh one
   * on first use. The returned object is owned by the store and safe to
   * mutate in place; the store keeps tracking the same instance.
   */
  get(conversationId: string): PlaceholderContext {
    this.evictExpired();
    const existing = this.entries.get(conversationId);
    if (existing) {
      this.entries.delete(conversationId);
      existing.lastSeenAt = this.now();
      this.entries.set(conversationId, existing);
      return existing.context;
    }

    const entry: ConversationEntry = {
      context: createPlaceholderContext(),
      lastSeenAt: this.now(),
    };
    this.entries.set(conversationId, entry);
    this.evictLeastRecentlyUsed();
    return entry.context;
  }

  /** Forgets one conversation. */
  delete(conversationId: string): void {
    this.entries.delete(conversationId);
  }

  /** Forgets every conversation. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.lastSeenAt >= this.ttlMs) {
        this.entries.delete(id);
      }
    }
  }

  private evictLeastRecentlyUsed(): void {
    while (this.entries.size > this.maxConversations) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

let defaultStore: ConversationStore | undefined;

/**
 * Default store used by the HTTP routes. Created lazily on first use from
 * the `conversation_persistence` configuration (TTL and capacity).
 */
export function getConversationStore(): ConversationStore {
  if (!defaultStore) {
    const { conversation_persistence } = getConfig();
    defaultStore = new ConversationStore({
      ttlMs: conversation_persistence.ttl_hours * 60 * 60 * 1000,
      maxConversations: conversation_persistence.max_conversations,
    });
  }
  return defaultStore;
}
