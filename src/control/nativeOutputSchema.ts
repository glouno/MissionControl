type Schema = Record<string, any>;

/** Native strict output requires closed objects and every property in required.
 * Optional input fields travel as explicit null and are restored before parsing.
 * Keep the original schema intact: it remains the authority for validation.
 */
export function nativeOutputSchema(input: Schema): Schema {
  const output = structuredClone(input);
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.properties) {
      const required = new Set(node.required ?? []);
      for (const [key, value] of Object.entries(node.properties)) {
        if (!required.has(key))
          node.properties[key] = { anyOf: [value, { type: "null" }] };
      }
      node.required = Object.keys(node.properties);
      node.additionalProperties = false;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(output);
  return output;
}

/** Only nulls standing for originally optional fields become absent values. */
export function normalizeNativeOutput(input: unknown, schema: Schema): unknown {
  const resolve = (node: Schema, value: unknown): Schema => {
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
      const target = node.$ref
        .slice(2)
        .split("/")
        .reduce(
          (root: any, key: string) =>
            root?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
          schema,
        );
      if (target) return resolve(target, value);
    }
    const branches = node.anyOf ?? node.oneOf;
    if (branches) {
      const type = Array.isArray(value)
        ? "array"
        : value === null
          ? "null"
          : typeof value;
      const match = branches.find((branch: Schema) => {
        const resolved = resolve(branch, value);
        return (
          resolved.type === type || (type === "object" && resolved.properties)
        );
      });
      if (match) return resolve(match, value);
    }
    return node;
  };
  const visit = (value: any, definition: Schema): any => {
    const node = resolve(definition, value);
    if (Array.isArray(value))
      return value.map((entry) => visit(entry, node.items ?? {}));
    if (value && typeof value === "object") {
      const required = new Set(node.required ?? []);
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key, entry]) =>
              !(entry === null && node.properties?.[key] && !required.has(key)),
          )
          .map(([key, entry]) => [
            key,
            visit(entry, node.properties?.[key] ?? {}),
          ]),
      );
    }
    return value;
  };
  return visit(input, schema);
}
