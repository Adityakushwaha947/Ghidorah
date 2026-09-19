export class GidorahError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GidorahError";
  }
}

export function publicError(error: unknown): string {
  if (error instanceof GidorahError) return `${error.code}: ${error.message}`;
  return "internal_failure: The operation failed; no further execution is authorized.";
}
