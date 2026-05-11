import {
  findEnvKeys,
  getEnvApiKey,
  getModel,
  getModels,
  getProviders,
  type Model,
} from "@earendil-works/pi-ai";

export function resolveModel(ref: { provider: string; model: string }): Model<any> {
  // getModel is heavily typed; config comes from DB/JSON, so cast through any.
  return (getModel as any)(ref.provider, ref.model) as Model<any>;
}

export async function getApiKey(provider: string): Promise<string | undefined> {
  return getEnvApiKey(provider);
}

export interface ProviderInfo {
  provider: string;
  envKeys: string[];
  hasKey: boolean;
  models: { id: string; name?: string }[];
}

export function listProviderInfo(): ProviderInfo[] {
  return getProviders().map((provider) => {
    const envKeys = findEnvKeys(provider) ?? [];
    const hasKey = !!getEnvApiKey(provider);
    let models: { id: string; name?: string }[] = [];
    try {
      models = (getModels as any)(provider).map((m: any) => ({
        id: m.id ?? m.name,
        name: m.name ?? m.id,
      }));
    } catch {
      models = [];
    }
    return { provider, envKeys, hasKey, models };
  });
}
