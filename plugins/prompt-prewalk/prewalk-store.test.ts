import { describe, expect, it } from "vitest";
import { getPrewalkState, IDLE, scopeKey, setPrewalkState } from "./prewalk-store";

describe("scopeKey", () => {
  it("gives each composer surface its own key", () => {
    expect(scopeKey({ kind: "thread", threadId: "t1" })).toBe("thread:t1");
    expect(scopeKey({ kind: "new-thread", projectId: "p1" })).toBe("new-thread");
    expect(scopeKey({ kind: "new-thread", projectId: null })).toBe("new-thread");
    expect(scopeKey({ kind: "queued-message", threadId: "t1", queuedMessageId: "q1" })).toBe("queued:q1");
  });
});

describe("prewalk state", () => {
  it("defaults to idle and keeps states per key", () => {
    expect(getPrewalkState("thread:s1")).toBe(IDLE);
    setPrewalkState("thread:s1", { status: "running", requestId: "r1" });
    expect(getPrewalkState("thread:s1")).toEqual({ status: "running", requestId: "r1" });
    expect(getPrewalkState("thread:s2")).toBe(IDLE);
    setPrewalkState("thread:s1", IDLE);
    expect(getPrewalkState("thread:s1")).toBe(IDLE);
  });
});
