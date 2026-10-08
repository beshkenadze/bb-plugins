import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import type { TtlSetting } from "./cache-model";

const TTL_OPTIONS: TtlSetting[] = ["auto", "5m", "1h"];

/** One source for the server's settings form and the app's defaults. */
export const SETTINGS = {
  claudeCodeTtl: {
    type: "select",
    label: "Claude Code cache lifetime",
    description:
      "auto: 1 hour on a Claude subscription within its plan, otherwise 5 minutes. Pin it if you set CLAUDE_CODE_PROMPT_CACHE_TTL or ENABLE_PROMPT_CACHING_1H.",
    options: TTL_OPTIONS,
    default: "auto",
  },
  codexTtl: {
    type: "select",
    label: "Codex cache lifetime",
    description: "auto: 5 minutes, the shortest time OpenAI keeps an idle prompt cache (it can last up to an hour).",
    options: TTL_OPTIONS,
    default: "auto",
  },
  piTtl: {
    type: "select",
    label: "Pi cache lifetime",
    description: "auto: 5 minutes. Pick 1h if Pi is set up for long cache retention.",
    options: TTL_OPTIONS,
    default: "auto",
  },
  warnSeconds: {
    type: "number",
    label: "Warn before expiry (seconds)",
    description: "From this many seconds left, the badge turns red and the banner asks you to reply.",
    default: 60,
  },
  compactAtTokens: {
    type: "number",
    label: "Banner Compact from (tokens)",
    description: "The composer banner offers Compact once the cache expired on a context this large or larger. The badge details offer it on any expired cache.",
    default: 100_000,
  },
  banner: {
    type: "boolean",
    label: "Banner above the composer",
    description: "Warn above the composer when the cache is about to expire or has expired.",
    default: true,
  },
} satisfies PluginSettingDescriptors;

const TTL_KEY_BY_PROVIDER = {
  "claude-code": "claudeCodeTtl",
  codex: "codexTtl",
  pi: "piTtl",
} as const;

type TtlProvider = keyof typeof TTL_KEY_BY_PROVIDER;

export interface CacheSettings {
  ttl: Record<TtlProvider, TtlSetting>;
  warnMs: number;
  compactAtTokens: number;
  banner: boolean;
}

type SettingValues = Record<string, string | number | boolean> | undefined;

function ttlValue(values: SettingValues, provider: TtlProvider): TtlSetting {
  const value = values?.[TTL_KEY_BY_PROVIDER[provider]];
  return TTL_OPTIONS.find((option) => option === value) ?? "auto";
}

function nonNegative(values: SettingValues, key: "warnSeconds" | "compactAtTokens"): number {
  const value = values?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : SETTINGS[key].default;
}

/** Parses `useSettings().values`: untrusted, and undefined while loading. */
export function readSettings(values: SettingValues): CacheSettings {
  const banner = values?.banner;
  return {
    ttl: { "claude-code": ttlValue(values, "claude-code"), codex: ttlValue(values, "codex"), pi: ttlValue(values, "pi") },
    warnMs: nonNegative(values, "warnSeconds") * 1_000,
    compactAtTokens: nonNegative(values, "compactAtTokens"),
    banner: typeof banner === "boolean" ? banner : SETTINGS.banner.default,
  };
}

export function ttlSettingFor(settings: CacheSettings, providerId: string): TtlSetting {
  return Object.hasOwn(settings.ttl, providerId) ? settings.ttl[providerId as TtlProvider] : "auto";
}
