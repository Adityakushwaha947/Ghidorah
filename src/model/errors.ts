import type { ModelError } from "../contracts/model.js";

const messages: Record<ModelError["code"], string> = {
  version_mismatch: "Unsupported model seam version.",
  invalid_request: "Invalid model request or call options.",
  unsupported: "The model route, tool or parameter is not supported.",
  timeout: "The model dispatch deadline expired.",
  aborted: "The model dispatch was cancelled.",
  provider_failure: "The provider returned invalid output or failed.",
  unavailable: "The model route or mandatory dispatch journal is unavailable.",
  incomplete_stream: "The model stream ended without a complete response.",
};

export class ModelGatewayError extends Error implements ModelError {
  constructor(
    readonly code: ModelError["code"],
    readonly requestId: string,
  ) {
    super(messages[code]);
    this.name = "ModelGatewayError";
  }
}
