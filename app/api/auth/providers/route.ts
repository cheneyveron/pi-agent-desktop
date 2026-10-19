import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import {
  collectProviderListingInputs,
  customModelsJsonProviderIds,
} from "@/lib/provider-listing-runtime";
import { createModelRuntimeWithExtensions } from "@/lib/model-runtime";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
export async function GET() {
  const modelRuntime = await createModelRuntimeWithExtensions();
  // ModelsConfig renders custom models.json providers itself. Pass their ids
  // so an auth.json credential cannot also put them in the API-key list.
  const inputs = await collectProviderListingInputs(
    modelRuntime,
    customModelsJsonProviderIds(),
  );
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
}
