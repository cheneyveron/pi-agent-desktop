import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ProviderCredentialType, ProviderListingInput } from "@/lib/provider-listing";
import { readModelsConfig } from "./models-config-store";

/**
 * Provider ids declared in models.json that are not built-in providers.
 *
 * `readModelsConfig()` accepts the same JSONC forms as pi. A damaged or
 * unreadable file must not empty the auth lists, so this returns an empty set
 * and lets the credential-source fallback in `buildApiKeyProviderList` handle
 * what it can.
 */
export function customModelsJsonProviderIds(
  modelsPath?: string,
): ReadonlySet<string> {
  // Use the SDK's full list, including dynamic built-ins such as Radius that
  // have no static catalog entry.
  const builtin = new Set(builtinProviders().map((provider) => provider.id));
  try {
    const config = readModelsConfig(modelsPath);
    const providers = config.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      return new Set();
    }
    return new Set(Object.keys(providers).filter((id) => !builtin.has(id)));
  } catch {
    return new Set();
  }
}

/**
 * Adapter between `ModelRuntime` and the pure listing helpers in
 * `lib/provider-listing.ts`.
 */
export async function collectProviderListingInputs(
  modelRuntime: ModelRuntime,
  customProviderIds: ReadonlySet<string> = new Set(),
): Promise<ProviderListingInput[]> {
  const models = modelRuntime.getModels();

  const credentialTypes = new Map<string, ProviderCredentialType>();
  try {
    for (const credential of await modelRuntime.listCredentials()) {
      if (credential.type === "api_key" || credential.type === "oauth") {
        credentialTypes.set(credential.providerId, credential.type);
      }
    }
  } catch {
    // A damaged auth.json must not empty the provider list; fall back to the
    // per-provider auth status only.
  }

  return modelRuntime.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    isCustomProvider: customProviderIds.has(provider.id),
    hasApiKeyLogin: Boolean(provider.auth.apiKey?.login),
    hasOAuth: Boolean(provider.auth.oauth),
    ...(provider.auth.oauth?.name ? { oauthName: provider.auth.oauth.name } : {}),
    status: modelRuntime.getProviderAuthStatus(provider.id),
    ...(credentialTypes.has(provider.id)
      ? { credentialType: credentialTypes.get(provider.id) }
      : {}),
    modelCount: models.filter((model) => model.provider === provider.id).length,
  }));
}
