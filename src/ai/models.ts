import {
  findEnvKeys,
  getEnvApiKey,
  getModel,
  getModels,
  type Model,
} from "@earendil-works/pi-ai";
import type { LlmProviderConfig } from "../types.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function findProviderConfig(
  provider: string,
  customProviders: LlmProviderConfig[] = [],
): LlmProviderConfig | undefined {
  return customProviders.find((item) => item.provider === provider);
}

function tryGetKnownModel(ref: { provider: string; model: string }): Model<any> | undefined {
  try {
    // getModel is heavily typed; config comes from DB/JSON, so cast through any.
    return (getModel as any)(ref.provider, ref.model) as Model<any>;
  } catch {
    return undefined;
  }
}

function tryGetProviderTemplate(provider: string): Model<any> | undefined {
  try {
    return ((getModels as any)(provider) as Model<any>[])[0];
  } catch {
    return undefined;
  }
}

function createCustomModel(
  ref: { provider: string; model: string },
  cfg: LlmProviderConfig,
): Model<any> {
  const exact = tryGetKnownModel(ref);
  const template = exact ?? tryGetProviderTemplate(ref.provider);
  const baseUrl = cfg.baseUrl?.trim() || template?.baseUrl;

  if (!baseUrl) {
    throw new Error(
      `Provider "${ref.provider}" is not known to pi-ai. Add a Base URL for this custom provider.`,
    );
  }

  return {
    id: ref.model,
    name: exact?.name ?? ref.model,
    api: template?.api ?? "openai-completions",
    provider: ref.provider,
    baseUrl,
    reasoning: template?.reasoning ?? false,
    thinkingLevelMap: template?.thinkingLevelMap,
    input: template?.input ?? ["text"],
    cost: template?.cost ?? ZERO_COST,
    contextWindow: template?.contextWindow ?? 128000,
    maxTokens: template?.maxTokens ?? 8192,
    headers: template?.headers,
    compat: template?.compat,
  };
}

export function resolveModel(
  ref: { provider: string; model: string },
  customProviders: LlmProviderConfig[] = [],
): Model<any> {
  const customProvider = findProviderConfig(ref.provider, customProviders);
  if (customProvider) return createCustomModel(ref, customProvider);

  const knownModel = tryGetKnownModel(ref);
  if (knownModel) return knownModel;

  throw new Error(
    `Model "${ref.model}" is not available for provider "${ref.provider}". Add it under Available providers first.`,
  );
}

export async function getApiKey(
  provider: string,
  customProviders: LlmProviderConfig[] = [],
): Promise<string | undefined> {
  const customKey = findProviderConfig(provider, customProviders)?.apiKey?.trim();
  return customKey || getEnvApiKey(provider);
}

export interface ProviderInfo {
  provider: string;
  envKeys: string[];
  hasKey: boolean;
  models: { id: string; name?: string }[];
}

export function listProviderInfo(customProviders: LlmProviderConfig[] = []): ProviderInfo[] {
  return customProviders.map((cfg) => {
    const envKeys = findEnvKeys(cfg.provider) ?? [];
    const hasKey = !!cfg.apiKey?.trim() || !!getEnvApiKey(cfg.provider);
    const models = cfg.models.map((id) => ({ id, name: id }));
    return { provider: cfg.provider, envKeys, hasKey, models };
  });
}
