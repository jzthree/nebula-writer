/**
 * Model / reasoning catalog for the local AI CLIs.
 *
 * Nothing here is hard-coded to a model generation: the choices offered in
 * the UI are discovered from the CLIs that are actually installed, so they
 * move when `claude update` / `npm i -g @openai/codex` do.
 *
 *  - Codex: `codex debug models` renders the CLI's live model catalog (slugs,
 *    display names, supported reasoning levels, defaults). Falls back to the
 *    models_cache.json the CLI keeps in its home.
 *  - Claude Code: `claude --help` documents the `--model` aliases and the
 *    `--effort` levels; the full model ids ship inside the binary, which is
 *    scanned once per build (cached by size + mtime). Defaults come from the
 *    settings.json the CLI will read.
 *
 * Catalogs are cached per binary (path + size + mtime + version) with a short
 * TTL, so a CLI upgrade is picked up on the next request without a restart.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AiModelChoice, AiModelOptions, AiProviderCatalog, AiReasoningChoice, LocalAiProviderName } from "../src/shared";
import { resolveWriterCliHome } from "./cli-home";
import { resolveCliCommand, type CliProviderName } from "./cli-runtime";

const CATALOG_TTL_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 12_000;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
const REASONING_ID_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;
const CLAUDE_MODEL_ID = /claude-(?:fable|opus|sonnet|haiku)-\d+(?:-\d{1,2}(?!\d))?(?:-\d{8})?/g;
const CLAUDE_FAMILY_RANK: Record<string, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };
const CLAUDE_MODEL_LIMIT = 12;
const REASONING_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/* ------------------------------------------------------------------------ */
/* Request options                                                          */
/* ------------------------------------------------------------------------ */

export function validateModelOptions(value: unknown): { modelOptions: AiModelOptions | null } | { error: string } {
  if (value === undefined || value === null) {
    return { modelOptions: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "modelOptions must be an object with optional model / reasoning strings." };
  }
  const raw = value as Record<string, unknown>;
  const model = optionalId(raw.model, MODEL_ID_PATTERN);
  const reasoning = optionalId(raw.reasoning, REASONING_ID_PATTERN);
  if (model === false) {
    return { error: "modelOptions.model must be a model id such as 'opus', 'claude-opus-5', or 'gpt-5.5' (letters, digits, . _ : - [ ])." };
  }
  if (reasoning === false) {
    return { error: "modelOptions.reasoning must be a reasoning level such as low, medium, high, xhigh, or max." };
  }
  if (!model && !reasoning) {
    return { modelOptions: null };
  }
  return { modelOptions: { model: model || null, reasoning: reasoning || null } };
}

function optionalId(value: unknown, pattern: RegExp): string | null | false {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return pattern.test(trimmed) ? trimmed : false;
}

/** CLI arguments that select the model and reasoning level for a run. */
export function modelCliArgs(provider: CliProviderName, modelOptions: AiModelOptions | null | undefined): string[] {
  if (!modelOptions) {
    return [];
  }
  const args: string[] = [];
  if (provider === "claude") {
    if (modelOptions.model) {
      args.push("--model", modelOptions.model);
    }
    if (modelOptions.reasoning) {
      args.push("--effort", modelOptions.reasoning);
    }
    return args;
  }
  if (modelOptions.model) {
    args.push("-m", modelOptions.model);
  }
  if (modelOptions.reasoning) {
    // -c values are TOML; the id charset excludes quotes and backslashes.
    args.push("-c", `model_reasoning_effort="${modelOptions.reasoning}"`);
  }
  return args;
}

export function describeModelOptions(modelOptions: AiModelOptions | null | undefined): string {
  if (!modelOptions || (!modelOptions.model && !modelOptions.reasoning)) {
    return "";
  }
  return [modelOptions.model, modelOptions.reasoning ? reasoningLabel(modelOptions.reasoning).toLowerCase() : null].filter(Boolean).join(" · ");
}

/* ------------------------------------------------------------------------ */
/* Claude Code                                                              */
/* ------------------------------------------------------------------------ */

export interface ClaudeHelpInfo {
  supportsModel: boolean;
  supportsEffort: boolean;
  aliases: string[];
  exampleModels: string[];
  effortLevels: string[];
}

/** Read the documented `--model` aliases and `--effort` levels out of `claude --help`. */
export function parseClaudeHelp(help: string): ClaudeHelpInfo {
  const options = splitHelpOptions(help);
  const modelText = options.get("--model") ?? "";
  const effortText = options.get("--effort") ?? "";
  const quoted = [...modelText.matchAll(/'([A-Za-z0-9._:[\]-]+)'/g)].map((match) => match[1]);
  const aliases = unique(quoted.filter((value) => !value.startsWith("claude-")));
  const exampleModels = unique(quoted.filter((value) => value.startsWith("claude-")));
  const levelsMatch = /\(([a-z0-9 ,]+)\)/.exec(effortText);
  const effortLevels = levelsMatch
    ? unique(levelsMatch[1].split(",").map((part) => part.trim()).filter((part) => REASONING_ID_PATTERN.test(part)))
    : [];
  return {
    supportsModel: Boolean(modelText),
    supportsEffort: Boolean(effortText),
    aliases,
    exampleModels,
    effortLevels
  };
}

/** Split `--flag <value>  description...` help output into flag → description. */
function splitHelpOptions(help: string): Map<string, string> {
  const options = new Map<string, string>();
  let current: string | null = null;
  for (const line of help.split(/\r?\n/)) {
    const flagMatch = /^\s{1,6}(?:-[A-Za-z],\s+)?(--[A-Za-z][A-Za-z0-9-]*)(?:\s+(?:<[^>]+>|\[[^\]]+\]))?\s*(.*)$/.exec(line);
    if (flagMatch) {
      current = flagMatch[1];
      options.set(current, flagMatch[2].trim());
      continue;
    }
    if (current && /^\s{8,}\S/.test(line)) {
      options.set(current, `${options.get(current) ?? ""} ${line.trim()}`.trim());
      continue;
    }
    if (!line.trim()) {
      current = null;
    }
  }
  return options;
}

/** Model ids embedded in a chunk of the Claude Code binary (or any text). */
export function extractClaudeModelIds(text: string): string[] {
  return unique([...text.matchAll(CLAUDE_MODEL_ID)].map((match) => match[0]));
}

interface ClaudeModelKey {
  id: string;
  family: string;
  major: number;
  minor: number;
  dated: boolean;
}

function parseClaudeModelId(id: string): ClaudeModelKey | null {
  const match = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/.exec(id);
  if (!match) {
    return null;
  }
  return {
    id,
    family: match[1],
    major: Number(match[2]),
    minor: match[3] !== undefined ? Number(match[3]) : 0,
    dated: match[4] !== undefined
  };
}

/**
 * Order discovered ids newest-first per family and drop the noise: dated
 * snapshots when an undated id exists for the same version, and anything
 * older than the 4.x generation (Claude Code no longer offers those).
 */
export function rankClaudeModelIds(ids: string[], limit = CLAUDE_MODEL_LIMIT): string[] {
  const keys = ids.map(parseClaudeModelId).filter((key): key is ClaudeModelKey => key !== null && key.major >= 4);
  const undated = new Set(keys.filter((key) => !key.dated).map((key) => `${key.family}-${key.major}-${key.minor}`));
  const kept = keys.filter((key) => !key.dated || !undated.has(`${key.family}-${key.major}-${key.minor}`));
  kept.sort((a, b) => {
    if (b.major !== a.major) {
      return b.major - a.major;
    }
    if (b.minor !== a.minor) {
      return b.minor - a.minor;
    }
    const familyDelta = (CLAUDE_FAMILY_RANK[a.family] ?? 9) - (CLAUDE_FAMILY_RANK[b.family] ?? 9);
    if (familyDelta !== 0) {
      return familyDelta;
    }
    return Number(a.dated) - Number(b.dated);
  });
  return unique(kept.map((key) => key.id)).slice(0, limit);
}

export function claudeModelLabel(id: string): string {
  const key = parseClaudeModelId(id.replace(/\[.*$/, ""));
  if (!key) {
    return id;
  }
  const family = key.family.charAt(0).toUpperCase() + key.family.slice(1);
  const version = key.minor ? `${key.major}.${key.minor}` : String(key.major);
  const suffix = /\[1m\]$/i.test(id) ? " · 1M" : key.dated ? ` (${id.slice(-8)})` : "";
  return `Claude ${family} ${version}${suffix}`;
}

export function parseClaudeSettingsDefaults(json: string): { model: string | null; reasoning: string | null } {
  try {
    const parsed = JSON.parse(json) as { model?: unknown; effortLevel?: unknown };
    return {
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null,
      reasoning: typeof parsed.effortLevel === "string" && parsed.effortLevel.trim() ? parsed.effortLevel.trim() : null
    };
  } catch {
    return { model: null, reasoning: null };
  }
}

/** Scan a binary for Claude model ids without loading it whole (190 MB). */
export async function scanFileForClaudeModelIds(path: string): Promise<string[]> {
  const found = new Set<string>();
  const handle = await open(path, "r");
  try {
    const chunkSize = 4 * 1024 * 1024;
    const overlap = 64;
    const buffer = Buffer.alloc(chunkSize + overlap);
    let position = 0;
    let carry = "";
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
      if (bytesRead === 0) {
        break;
      }
      const text = carry + buffer.toString("latin1", 0, bytesRead);
      for (const id of extractClaudeModelIds(text)) {
        found.add(id);
      }
      carry = text.slice(-overlap);
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return [...found];
}

/* ------------------------------------------------------------------------ */
/* Codex                                                                    */
/* ------------------------------------------------------------------------ */

interface CodexCatalogModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

/** Parse `codex debug models` / models_cache.json into choices. */
export function parseCodexModelCatalog(payload: unknown): { models: AiModelChoice[]; levels: AiReasoningChoice[] } {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
      ? (payload as { models: unknown[] }).models
      : [];
  const models: AiModelChoice[] = [];
  const levelDescriptions = new Map<string, string | null>();
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as CodexCatalogModel;
    if (typeof raw.slug !== "string" || !MODEL_ID_PATTERN.test(raw.slug)) {
      continue;
    }
    const supported = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : [];
    const reasoningLevels: string[] = [];
    for (const level of supported) {
      const effort = level && typeof level === "object" ? (level as { effort?: unknown; description?: unknown }) : null;
      if (effort && typeof effort.effort === "string" && REASONING_ID_PATTERN.test(effort.effort)) {
        reasoningLevels.push(effort.effort);
        if (!levelDescriptions.has(effort.effort)) {
          levelDescriptions.set(effort.effort, typeof effort.description === "string" ? effort.description : null);
        }
      }
    }
    models.push({
      id: raw.slug,
      label: typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name.trim() : raw.slug,
      description: typeof raw.description === "string" ? raw.description : null,
      source: "catalog",
      reasoningLevels: reasoningLevels.length ? reasoningLevels : null,
      defaultReasoning: typeof raw.default_reasoning_level === "string" ? raw.default_reasoning_level : null,
      hidden: raw.visibility === "hide" || raw.visibility === "hidden"
    });
  }
  models.sort((a, b) => Number(a.hidden) - Number(b.hidden));
  const levels = sortReasoning([...levelDescriptions.keys()]).map((id) => ({ id, label: reasoningLabel(id), description: levelDescriptions.get(id) ?? null }));
  return { models, levels };
}

/** `model = "..."` and `model_reasoning_effort = "..."` from a Codex config.toml (top-level table only). */
export function parseCodexConfigDefaults(toml: string): { model: string | null; reasoning: string | null } {
  let model: string | null = null;
  let reasoning: string | null = null;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      break;
    }
    const match = /^(model|model_reasoning_effort)\s*=\s*"([^"]*)"/.exec(line);
    if (!match) {
      continue;
    }
    if (match[1] === "model" && MODEL_ID_PATTERN.test(match[2])) {
      model = match[2];
    } else if (match[1] === "model_reasoning_effort" && REASONING_ID_PATTERN.test(match[2])) {
      reasoning = match[2];
    }
  }
  return { model, reasoning };
}

/* ------------------------------------------------------------------------ */
/* Shared helpers                                                           */
/* ------------------------------------------------------------------------ */

export function reasoningLabel(id: string): string {
  switch (id) {
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Max";
    case "ultra":
      return "Ultra";
    default:
      return id.charAt(0).toUpperCase() + id.slice(1);
  }
}

export function sortReasoning(ids: string[]): string[] {
  return unique(ids).sort((a, b) => {
    const ia = REASONING_ORDER.indexOf(a);
    const ib = REASONING_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/* ------------------------------------------------------------------------ */
/* Discovery                                                                */
/* ------------------------------------------------------------------------ */

export interface CatalogDiscoveryOptions {
  refresh?: boolean;
  /** Environment the CLI would run with (CLAUDE_CONFIG_DIR / CODEX_HOME confinement). */
  childEnv?: (provider: CliProviderName) => NodeJS.ProcessEnv;
  home?: string;
}

interface CacheEntry {
  key: string;
  at: number;
  catalog: AiProviderCatalog;
}

const cache = new Map<CliProviderName, CacheEntry>();
const inflight = new Map<CliProviderName, Promise<AiProviderCatalog>>();
const binaryScanCache = new Map<string, string[]>();

export function clearModelCatalogCache(): void {
  cache.clear();
  binaryScanCache.clear();
}

export async function getProviderCatalogs(options: CatalogDiscoveryOptions = {}): Promise<AiProviderCatalog[]> {
  return Promise.all((["claude", "codex"] as const).map((provider) => getProviderCatalog(provider, options)));
}

export async function getProviderCatalog(provider: CliProviderName, options: CatalogDiscoveryOptions = {}): Promise<AiProviderCatalog> {
  const resolved = resolveCliCommand(provider);
  const version = resolved.path ? commandVersion(resolved.path) : null;
  const key = cacheKey(resolved.path, version);
  const cached = cache.get(provider);
  if (cached && cached.key === key && !options.refresh && Date.now() - cached.at < CATALOG_TTL_MS) {
    return cached.catalog;
  }
  const pending = inflight.get(provider);
  if (pending && !options.refresh) {
    return pending;
  }
  const task = (async () => {
    const env = options.childEnv?.(provider) ?? process.env;
    const home = options.home ?? homedir();
    const catalog = !resolved.available || !resolved.command || !resolved.path
      ? unavailableCatalog(provider, resolved.detail)
      : provider === "claude"
        ? await discoverClaude(resolved.command, resolved.path, version, env, home)
        : await discoverCodex(resolved.command, resolved.path, version, env, home);
    cache.set(provider, { key, at: Date.now(), catalog });
    return catalog;
  })();
  inflight.set(provider, task);
  try {
    return await task;
  } finally {
    if (inflight.get(provider) === task) {
      inflight.delete(provider);
    }
  }
}

function cacheKey(path: string | null, version: string | null): string {
  if (!path) {
    return "missing";
  }
  try {
    const real = realpathSync(path);
    const stat = statSync(real);
    return `${real}|${stat.size}|${Math.round(stat.mtimeMs)}|${version ?? ""}`;
  } catch {
    return `${path}|${version ?? ""}`;
  }
}

function unavailableCatalog(provider: LocalAiProviderName, detail: string): AiProviderCatalog {
  return {
    provider,
    available: false,
    version: null,
    path: null,
    models: [],
    reasoning: null,
    defaults: { model: null, reasoning: null, source: null },
    allowsCustomModel: true,
    discoveredAt: new Date().toISOString(),
    notes: [detail]
  };
}

async function discoverClaude(command: string, path: string, version: string | null, env: NodeJS.ProcessEnv, home: string): Promise<AiProviderCatalog> {
  const notes: string[] = [];
  const help = await runCommand(command, ["--help"], env).catch((error: unknown) => {
    notes.push(`claude --help failed: ${errorMessage(error)}`);
    return "";
  });
  const info = parseClaudeHelp(help);
  if (help && !info.supportsModel) {
    notes.push("This Claude Code build does not document a --model flag; custom model ids are passed through anyway.");
  }

  let binaryIds: string[] = [];
  try {
    const real = realpathSync(path);
    const stat = statSync(real);
    const scanKey = `${real}|${stat.size}|${Math.round(stat.mtimeMs)}`;
    const cachedScan = binaryScanCache.get(scanKey);
    if (cachedScan) {
      binaryIds = cachedScan;
    } else {
      binaryIds = await scanFileForClaudeModelIds(real);
      binaryScanCache.set(scanKey, binaryIds);
    }
  } catch (error) {
    notes.push(`Could not scan the Claude Code binary for model ids: ${errorMessage(error)}`);
  }
  const ranked = rankClaudeModelIds(binaryIds);
  const families = unique(ranked.map((id) => parseClaudeModelId(id)?.family).filter((family): family is string => Boolean(family)));
  const aliases = unique([...info.aliases, ...families]).sort((a, b) => (CLAUDE_FAMILY_RANK[a] ?? 9) - (CLAUDE_FAMILY_RANK[b] ?? 9));

  const defaults = readClaudeDefaults(env, home);
  const models: AiModelChoice[] = [
    ...aliases.map((alias) => ({
      id: alias,
      label: `${alias.charAt(0).toUpperCase() + alias.slice(1)} (latest)`,
      description: `Claude Code alias for the newest ${alias} model`,
      source: "alias" as const
    })),
    ...ranked.map((id) => ({ id, label: claudeModelLabel(id), description: null, source: "binary" as const }))
  ];
  if (defaults.model && !models.some((model) => model.id === defaults.model)) {
    models.push({ id: defaults.model, label: claudeModelLabel(defaults.model), description: "Configured in Claude Code's settings.json", source: "settings" });
  }
  const levels = info.effortLevels.length ? info.effortLevels : [];
  if (help && !levels.length) {
    notes.push("This Claude Code build does not document an --effort flag; reasoning control is unavailable.");
  }
  return {
    provider: "claude",
    available: true,
    version,
    path,
    models,
    reasoning: levels.length ? { control: "effort", levels: sortReasoning(levels).map((id) => ({ id, label: reasoningLabel(id), description: null })) } : null,
    defaults: { model: defaults.model, reasoning: defaults.reasoning, source: defaults.source },
    allowsCustomModel: true,
    discoveredAt: new Date().toISOString(),
    notes
  };
}

function readClaudeDefaults(env: NodeJS.ProcessEnv, home: string): { model: string | null; reasoning: string | null; source: string | null } {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const settingsPath = join(configDir, "settings.json");
  const fromEnv = env.ANTHROPIC_MODEL?.trim() || null;
  let model: string | null = fromEnv;
  let reasoning: string | null = null;
  let source: string | null = fromEnv ? "ANTHROPIC_MODEL" : null;
  if (existsSync(settingsPath)) {
    try {
      const parsed = parseClaudeSettingsDefaults(readFileSync(settingsPath, "utf8"));
      if (!model && parsed.model) {
        model = parsed.model;
        source = settingsPath;
      }
      if (parsed.reasoning) {
        reasoning = parsed.reasoning;
        source = source ?? settingsPath;
      }
    } catch {
      // Unreadable settings: defaults stay unknown.
    }
  }
  return { model, reasoning, source };
}

async function discoverCodex(command: string, path: string, version: string | null, env: NodeJS.ProcessEnv, home: string): Promise<AiProviderCatalog> {
  const notes: string[] = [];
  const codexHome = env.CODEX_HOME?.trim() || resolveWriterCliHome("codex", env, home)?.dir || join(home, ".codex");
  let payload: unknown = null;
  let catalogSource = "codex debug models";
  const raw = await runCommand(command, ["debug", "models"], env).catch((error: unknown) => {
    notes.push(`codex debug models failed: ${errorMessage(error)}`);
    return "";
  });
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      notes.push("codex debug models did not return JSON.");
    }
  }
  if (!payload) {
    for (const dir of unique([codexHome, join(home, ".codex")])) {
      const cachePath = join(dir, "models_cache.json");
      if (existsSync(cachePath)) {
        try {
          payload = JSON.parse(readFileSync(cachePath, "utf8"));
          catalogSource = cachePath;
          break;
        } catch {
          // Try the next location.
        }
      }
    }
  }
  const parsed = parseCodexModelCatalog(payload);
  if (!parsed.models.length) {
    notes.push("No Codex model catalog found; type a model id manually.");
  } else {
    notes.push(`Catalog from ${catalogSource}.`);
  }
  const defaults = readCodexDefaults(codexHome, home);
  if (defaults.model && !parsed.models.some((model) => model.id === defaults.model)) {
    parsed.models.push({ id: defaults.model, label: defaults.model, description: "Configured in config.toml", source: "settings" });
  }
  return {
    provider: "codex",
    available: true,
    version,
    path,
    models: parsed.models,
    reasoning: parsed.levels.length ? { control: "model_reasoning_effort", levels: parsed.levels } : null,
    defaults,
    allowsCustomModel: true,
    discoveredAt: new Date().toISOString(),
    notes
  };
}

function readCodexDefaults(codexHome: string, home: string): { model: string | null; reasoning: string | null; source: string | null } {
  for (const dir of unique([codexHome, join(home, ".codex")])) {
    const configPath = join(dir, "config.toml");
    if (!existsSync(configPath)) {
      continue;
    }
    try {
      const parsed = parseCodexConfigDefaults(readFileSync(configPath, "utf8"));
      if (parsed.model || parsed.reasoning) {
        return { ...parsed, source: configPath };
      }
    } catch {
      // Unreadable config: keep looking.
    }
  }
  return { model: null, reasoning: null, source: null };
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim().split("\n")[0] || error.message));
        return;
      }
      resolvePromise(String(stdout));
    });
  });
}

const versionCache = new Map<string, { key: string; version: string | null }>();

function commandVersion(path: string): string | null {
  let key = path;
  try {
    const real = realpathSync(path);
    const stat = statSync(real);
    key = `${real}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  } catch {
    // Fall through with the plain path as the key.
  }
  const cached = versionCache.get(path);
  if (cached && cached.key === key) {
    return cached.version;
  }
  let version: string | null = null;
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const output = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "pipe"] });
    const line = output.split(/\r?\n/).find((part) => /\d+\.\d+/.test(part));
    version = line ? line.trim() : null;
  } catch {
    version = null;
  }
  versionCache.set(path, { key, version });
  return version;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
