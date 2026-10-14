// Controller-issued tokens have a recognizable format, including the legacy
// pair of UUIDs. Redact them after revocation and restart without retaining every
// idle worker's credential forever in the controller's in-memory secret set.
const controllerToken =
  /\b(?:mc_token_[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/g;
const entireControllerToken = new RegExp(
  `^(?:${controllerToken.source.replace(/^\\b|\\b$/g, "")})$`,
);
/** Instance-scoped redaction. Credential references remain intact; values do not. */
export class Redactor {
  private secrets = new Set<string>();
  private orderedSecrets: string[] = [];
  register(value: string) {
    if (
      value.length >= 8 &&
      !entireControllerToken.test(value) &&
      !this.secrets.has(value)
    ) {
      this.secrets.add(value);
      this.orderedSecrets = [...this.secrets].sort(
        (a, b) => b.length - a.length,
      );
    }
  }
  text(value: string) {
    let result = value;
    for (const secret of this.orderedSecrets)
      result = result.split(secret).join("[REDACTED]");
    return result
      .replace(controllerToken, "[REDACTED]")
      .replace(/(?:Bearer\s+)[^\s"']+/gi, "Bearer [REDACTED]")
      .replace(
        /\b(?:sk-(?:proj-)?[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,
        "[REDACTED]",
      );
  }
  value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.value(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [
          key,
          typeof v === "string" &&
          /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passphrase|client[-_]?secret|private[-_]?key|bearer|token)$/i.test(
            key,
          )
            ? "[REDACTED]"
            : this.value(v),
        ]),
      );
    return value;
  }
  json(value: unknown) {
    return JSON.stringify(this.value(value));
  }
}
