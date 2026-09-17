/**
 * Compose-style `${VAR}` expansion.
 *
 * Implemented here rather than deferred to `docker compose config` so the
 * synchronous library path produces the same credentials the container gets,
 * on a machine where docker is not running.
 *
 * Supports `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR-default}`,
 * `${VAR:?message}`, `${VAR?message}` and `$$` escaping, per the Compose spec.
 */
const PATTERN = /\$(\$|\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export interface InterpolationResult {
  value: string;
  /** Names that had no value and no default. */
  missing: string[];
}

export const interpolate = (
  input: string,
  lookup: Record<string, string | undefined>,
): InterpolationResult => {
  const missing: string[] = [];

  const value = input.replace(PATTERN, (_match, body: string, braced?: string, bare?: string) => {
    if (body === "$") return "$";

    const expression = braced ?? bare ?? "";
    const operator = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)(:?[-?])([\s\S]*)$/);
    const name = operator ? operator[1]! : expression;
    const current = lookup[name];
    const isSet = current !== undefined && (operator?.[2]?.startsWith(":") ? current !== "" : true);

    if (isSet) return current!;
    if (!operator) {
      missing.push(name);
      return "";
    }
    // `-` supplies a default; `?` means the author wants it to be an error, which
    // for our purposes is the same as unknown.
    if (operator[2]!.endsWith("-")) return operator[3]!;
    missing.push(name);
    return "";
  });

  return { value, missing };
};

/** Expand every string in a parsed YAML document, in place. */
export const interpolateDeep = <T>(
  input: T,
  lookup: Record<string, string | undefined>,
  missing: Set<string>,
): T => {
  if (typeof input === "string") {
    const result = interpolate(input, lookup);
    for (const name of result.missing) missing.add(name);
    return result.value as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => interpolateDeep(item, lookup, missing)) as unknown as T;
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = interpolateDeep(value, lookup, missing);
    }
    return out as unknown as T;
  }
  return input;
};
