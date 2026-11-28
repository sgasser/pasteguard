import { describe, expect, test } from "bun:test";
import { incrementAndGenerate } from "./context";
import { ConversationStore } from "./conversation-store";

const formatPlaceholder = (type: string, count: number) => `[[${type}_${count}]]`;

describe("ConversationStore", () => {
  test("returns a fresh context for a new conversation", () => {
    const store = new ConversationStore();
    const context = store.get("conv-a");

    expect(context.mapping).toEqual({});
    expect(context.reverseMapping).toEqual({});
    expect(context.counters).toEqual({});
  });

  test("returns the same context instance across calls for one conversation", () => {
    const store = new ConversationStore();
    expect(store.get("conv-a")).toBe(store.get("conv-a"));
  });

  test("mutations to the returned context persist", () => {
    const store = new ConversationStore();
    const context = store.get("conv-a");
    incrementAndGenerate("PERSON", context, formatPlaceholder);

    expect(store.get("conv-a").counters.PERSON).toBe(1);
  });

  test("isolates contexts between conversations", () => {
    const store = new ConversationStore();
    const a = store.get("conv-a");
    const b = store.get("conv-b");

    expect(a).not.toBe(b);
    a.mapping["[[PERSON_1]]"] = "John";
    expect(b.mapping).toEqual({});
  });

  describe("TTL", () => {
    test("keeps conversations within the TTL", () => {
      let nowMs = 0;
      const store = new ConversationStore({ ttlMs: 1000, now: () => nowMs });
      const initial = store.get("conv-a");

      nowMs = 999;
      expect(store.get("conv-a")).toBe(initial);
    });

    test("evicts conversations once the TTL has elapsed", () => {
      let nowMs = 0;
      const store = new ConversationStore({ ttlMs: 1000, now: () => nowMs });
      const initial = store.get("conv-a");

      nowMs = 1000;
      const fresh = store.get("conv-a");
      expect(fresh).not.toBe(initial);
      expect(fresh.mapping).toEqual({});
    });

    test("accessing a conversation extends its lifetime", () => {
      let nowMs = 0;
      const store = new ConversationStore({ ttlMs: 1000, now: () => nowMs });
      const initial = store.get("conv-a");

      nowMs = 900;
      store.get("conv-a");
      nowMs = 1800; // only 900ms since the last access
      expect(store.get("conv-a")).toBe(initial);
    });
  });

  describe("capacity", () => {
    test("evicts the least recently used conversation when full", () => {
      const store = new ConversationStore({ maxConversations: 2 });
      const a = store.get("conv-a");
      const b = store.get("conv-b");
      store.get("conv-a"); // touch a: b is now least recently used

      store.get("conv-c"); // exceeds capacity: evicts b

      expect(store.get("conv-a")).toBe(a);
      expect(store.get("conv-b")).not.toBe(b);
      expect(store.size).toBe(2);
    });
  });

  test("delete and clear forget conversations", () => {
    const store = new ConversationStore();
    const a = store.get("conv-a");
    store.get("conv-b");
    expect(store.size).toBe(2);

    store.delete("conv-a");
    expect(store.get("conv-a")).not.toBe(a);

    store.clear();
    expect(store.size).toBe(0);
  });
});
