/**
 * The local agent CLIs Writer can drive, and how each is named and set up.
 * Everything that differs between providers in labels or instructions reads
 * from here, so a new CLI is one entry, never a ternary that silently treats
 * it as one of the others.
 */

export const LOCAL_AI_PROVIDERS = ["codex", "claude", "antigravity"] as const;
export type LocalAiProvider = (typeof LOCAL_AI_PROVIDERS)[number];

export interface LocalAiProviderInfo {
  /** Short name: "Codex". */
  name: string;
  /** Name of the CLI itself: "Codex CLI". */
  cliName: string;
  /** The command that runs it. */
  executable: string;
  install: string;
  /** How to sign in once on this machine. */
  login: string;
  /** Writer's inline terminal can run it with Writer's tools. */
  terminal: boolean;
}

export const LOCAL_AI_PROVIDER_INFO: Record<LocalAiProvider, LocalAiProviderInfo> = {
  codex: { name: "Codex", cliName: "Codex CLI", executable: "codex", install: "npm install -g @openai/codex", login: "codex login", terminal: true },
  claude: { name: "Claude Code", cliName: "Claude Code", executable: "claude", install: "npm install -g @anthropic-ai/claude-code", login: "claude", terminal: true },
  antigravity: { name: "Antigravity", cliName: "Antigravity CLI", executable: "agy", install: "install the Antigravity CLI (agy) from antigravity.google", login: "agy", terminal: false }
};

export function isLocalAiProvider(value: unknown): value is LocalAiProvider {
  return typeof value === "string" && (LOCAL_AI_PROVIDERS as readonly string[]).includes(value);
}

/** "Codex", "Claude Code", "Antigravity"; "Demo provider" and unknown names as given. */
export function providerName(provider: string): string {
  if (isLocalAiProvider(provider)) return LOCAL_AI_PROVIDER_INFO[provider].name;
  return provider === "demo" ? "Demo provider" : provider;
}

export function providerCliName(provider: string): string {
  if (isLocalAiProvider(provider)) return LOCAL_AI_PROVIDER_INFO[provider].cliName;
  return provider === "demo" ? "Demo provider" : provider;
}
