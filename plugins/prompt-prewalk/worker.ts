export const MAX_DRAFT_CHARS = 20_000;
export const MAX_HISTORY_CHARS = 2_000;

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

const RULES = [
  "You rewrite a user's request to a coding agent so it is clearer and more actionable.",
  "Rules:",
  "- Keep the user's intent, language, and every concrete detail (paths, names, numbers).",
  "- Do not invent requirements. Put real ambiguities as explicit open questions at the end.",
  "- Do not answer the request. Do not run tools. Do not read or modify files.",
  "- Output ONLY the rewritten prompt inside <prompt>…</prompt>.",
];

export function buildWorkerPrompt(input: {
  draft: string;
  history: readonly HistoryMessage[];
  extraInstructions: string;
}): string {
  const extra = input.extraInstructions.trim();
  const history = input.history.map(({ role, text }) => `<${role}>\n${text}\n</${role}>`).join("\n");
  return [
    ...RULES,
    ...(extra === "" ? [] : [extra]),
    "",
    `<history>\n${history}\n</history>`,
    "",
    `<draft>\n${input.draft}\n</draft>`,
  ].join("\n");
}

export function extractPrompt(output: string | null): string | null {
  return output?.match(/<prompt>([\s\S]*?)<\/prompt>/)?.[1]?.trim() || null;
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;

function flatten(rows: readonly unknown[]): Row[] {
  return rows
    .filter(isRow)
    .flatMap((row) => [row, ...(Array.isArray(row.children) ? flatten(row.children) : [])]);
}

function truncate(text: string): string {
  return text.length > MAX_HISTORY_CHARS ? `${text.slice(0, MAX_HISTORY_CHARS)}…` : text;
}

/** Timeline rows → the last `limit` human and assistant messages, oldest first. */
export function collectHistory(rows: readonly unknown[], limit: number): HistoryMessage[] {
  if (limit <= 0) return [];
  const seen = new Set<string>();
  const messages: HistoryMessage[] = [];
  for (const row of flatten(rows)) {
    if (row.kind !== "conversation" || typeof row.id !== "string" || typeof row.text !== "string") continue;
    const role =
      row.role === "assistant" ? "assistant" : row.role === "user" && row.initiator === "user" ? "user" : null;
    const text = row.text.trim();
    if (role === null || text === "" || seen.has(row.id)) continue;
    seen.add(row.id);
    messages.push({ role, text: truncate(text) });
  }
  return messages.slice(-limit);
}
