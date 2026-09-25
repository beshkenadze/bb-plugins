import { describe, expect, it } from "vitest";
import { buildWorkerPrompt, collectHistory, extractPrompt, MAX_HISTORY_CHARS } from "./worker";

describe("extractPrompt", () => {
  it("returns the trimmed text inside <prompt> tags", () => {
    expect(extractPrompt("Sure.\n<prompt>\n  Fix it  \n</prompt>")).toBe("Fix it");
  });

  it("returns null without tags, with empty tags, or without output", () => {
    expect(extractPrompt("Fix it")).toBeNull();
    expect(extractPrompt("<prompt>   </prompt>")).toBeNull();
    expect(extractPrompt(null)).toBeNull();
  });
});

describe("collectHistory", () => {
  const rows = [
    { kind: "conversation", role: "user", initiator: "user", id: "m1", text: "first question" },
    {
      kind: "turn",
      id: "t1",
      children: [
        { kind: "work", id: "w1" },
        { kind: "conversation", role: "assistant", id: "m2", text: "first answer" },
      ],
    },
    { kind: "conversation", role: "user", initiator: "system", id: "m3", text: "child thread finished" },
    { kind: "conversation", role: "assistant", id: "m2", text: "first answer" },
    { kind: "conversation", role: "user", initiator: "user", id: "m4", text: "second question" },
  ];

  it("keeps user and assistant messages in order, skipping system rows and duplicates", () => {
    expect(collectHistory(rows, 10)).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "first answer" },
      { role: "user", text: "second question" },
    ]);
  });

  it("keeps only the last `limit` messages", () => {
    expect(collectHistory(rows, 1)).toEqual([{ role: "user", text: "second question" }]);
  });

  it("returns nothing for limit 0", () => {
    expect(collectHistory(rows, 0)).toEqual([]);
  });

  it("truncates long messages", () => {
    const long = { kind: "conversation", role: "assistant", id: "x", text: "a".repeat(MAX_HISTORY_CHARS + 10) };
    const [message] = collectHistory([long], 1);
    expect(message?.text).toHaveLength(MAX_HISTORY_CHARS + 1);
    expect(message?.text.endsWith("…")).toBe(true);
  });
});

describe("buildWorkerPrompt", () => {
  it("wraps history and draft and appends extra instructions", () => {
    const prompt = buildWorkerPrompt({
      draft: "fix it",
      history: [{ role: "user", text: "hi" }],
      extraInstructions: "  Answer in English.  ",
    });
    expect(prompt).toContain("<draft>\nfix it\n</draft>");
    expect(prompt).toContain("<history>\n<user>\nhi\n</user>\n</history>");
    expect(prompt).toContain("\nAnswer in English.\n");
  });

  it("omits the extra instructions line when it is blank", () => {
    const prompt = buildWorkerPrompt({ draft: "fix it", history: [], extraInstructions: "   " });
    expect(prompt).toContain("inside <prompt>…</prompt>.\n\n<history>\n\n</history>");
  });
});
