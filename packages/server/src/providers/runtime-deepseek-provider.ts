import type { ProviderCredentialStatus } from "@fosil/contracts";
import { DeepSeekResponsesProvider, type DeepSeekResponsesOptions } from "./deepseek-responses.js";
import { ModelProviderRequestError, type ModelProvider } from "./model-provider.js";

/**
 * Process-local credential owner. The browser can replace the credential but can
 * never read it back; each request snapshots one immutable provider delegate.
 */
export class RuntimeDeepSeekProvider implements ModelProvider {
  private readonly metadataProvider: DeepSeekResponsesProvider;
  private provider: DeepSeekResponsesProvider | null = null;
  private source: ProviderCredentialStatus["source"] = "none";

  constructor(apiKey: string | null, private readonly options: Omit<DeepSeekResponsesOptions, "apiKey"> = {}) {
    this.metadataProvider = new DeepSeekResponsesProvider({ ...options, apiKey: "fosil-unconfigured" });
    if (apiKey !== null) this.configure(apiKey, "environment");
  }

  status(): ProviderCredentialStatus {
    return { configured: this.provider !== null, source: this.source };
  }

  configure(apiKey: string, source: "environment" | "webui" = "webui"): void {
    const next = new DeepSeekResponsesProvider({ ...this.options, apiKey });
    this.provider = next;
    this.source = source;
  }

  describeRequest(request: Parameters<NonNullable<ModelProvider["describeRequest"]>>[0]) {
    return (this.provider ?? this.metadataProvider).describeRequest(request);
  }

  async *stream(request: Parameters<ModelProvider["stream"]>[0], options: Parameters<ModelProvider["stream"]>[1]) {
    const provider = this.provider;
    if (!provider) {
      throw new ModelProviderRequestError("provider_error", {
        code: "provider_credential_missing",
        message: "DeepSeek API key is not configured; add it in WebUI settings before starting another run",
        details: null
      });
    }
    yield* provider.stream(request, options);
  }
}
