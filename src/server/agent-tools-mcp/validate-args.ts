/**
 * Runtime contract validation for Bridge tool arguments.
 *
 * The declared `inputSchema` of a Bridge tool is advisory on every invocation
 * path: the SDK native tool bridge (`bridge-native-tools.ts`) hands the raw
 * argument object straight to the handler. Without this check each handler has
 * to re-derive its own contract, and anything it forgets to check reaches a
 * store or a native call unvalidated.
 *
 * This validates the JSON Schema subset the Bridge tools actually declare.
 * `SUPPORTED_SCHEMA_KEYWORDS` is asserted against the live tool registry by a
 * test, so introducing a keyword this validator does not understand fails CI
 * instead of silently widening the contract.
 */

export const SUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  // annotations — ignored by validation
  "description",
  "title",
  "default",
  "examples",
  "format",
  // structure
  "type",
  "enum",
  "const",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  // bounds
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

export const SUPPORTED_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      // Fail closed: an unrecognized type declaration must not silently disable
      // validation. The registry audit rejects these at build time.
      return false;
  }
}

function declaredTypeList(declaredType: unknown): string[] {
  return (Array.isArray(declaredType) ? declaredType : [declaredType])
    .filter((entry): entry is string => typeof entry === "string");
}

function matchesDeclaredType(declaredType: unknown, value: unknown): boolean {
  const types = declaredTypeList(declaredType);
  return types.length === 0 || types.some((type) => matchesType(value, type));
}

/** Name the offending value: its property path, or the argument object itself. */
function at(path: string, message: string): string {
  return `${path || "input"} ${message}`;
}

function validateValue(schema: unknown, value: unknown, path: string): string | undefined {
  if (!isRecord(schema)) return undefined;

  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map((branch) => validateValue(branch, value, path));
    if (branchErrors.every((error) => error !== undefined)) {
      // Prefer the branch the value was clearly aiming for (matching top-level
      // type), so an object missing a field reports that instead of a vague
      // "no branch matched".
      const targeted = schema.anyOf.findIndex((branch) => isRecord(branch) && matchesDeclaredType(branch.type, value));
      if (targeted >= 0) return branchErrors[targeted];
      return at(path, `does not match any allowed shape (received ${describeType(value)})`);
    }
  }

  const declaredType = schema.type;
  if ((typeof declaredType === "string" || Array.isArray(declaredType)) && !matchesDeclaredType(declaredType, value)) {
    const types = declaredTypeList(declaredType);
    if (types.length > 0) {
      return at(path, `must be ${types.join(" or ")} (received ${describeType(value)})`);
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    return at(path, `must be one of: ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }

  if ("const" in schema && value !== schema.const) {
    return at(path, `must be ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return at(path, `must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return at(path, `must be <= ${schema.maximum}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return at(path, `must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return at(path, `must be at most ${schema.maxLength} characters`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return at(path, `must have at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return at(path, `must have at most ${schema.maxItems} item(s)`);
    }
    if (isRecord(schema.items)) {
      for (const [index, item] of value.entries()) {
        const error = validateValue(schema.items, item, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }

  if (isRecord(value)) {
    const error = validateObject(schema, value, path);
    if (error) return error;
  }

  return undefined;
}

function validateObject(schema: JsonSchema, value: Record<string, unknown>, path: string): string | undefined {
  const properties = isRecord(schema.properties) ? schema.properties : undefined;

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key !== "string") continue;
      if (value[key] === undefined) {
        return at(path, `is missing required property: ${key}`);
      }
    }
  }

  if (schema.additionalProperties === false) {
    const unknown = Object.keys(value).filter((key) => !properties || !(key in properties));
    if (unknown.length > 0) {
      return at(path, `has unknown propert${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}`);
    }
  }

  if (!properties) return undefined;

  for (const [key, propertySchema] of Object.entries(properties)) {
    const propertyValue = value[key];
    if (propertyValue === undefined) continue;
    const error = validateValue(propertySchema, propertyValue, path ? `${path}.${key}` : key);
    if (error) return error;
  }

  return undefined;
}

/**
 * Validate a tool argument object against its declared schema.
 * Returns a human-readable message describing the first violation, or
 * `undefined` when the arguments satisfy the declared contract.
 */
export function validateToolArguments(schema: unknown, args: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  if (!isRecord(args)) {
    return `arguments must be an object (received ${describeType(args)})`;
  }
  return validateValue(schema, args, "");
}

/** Collect schema keywords this validator does not understand (used by the registry coverage test). */
export function findUnsupportedSchemaKeywords(schema: unknown, path = ""): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) => findUnsupportedSchemaKeywords(entry, `${path}[${index}]`));
  }
  if (!isRecord(schema)) return [];

  const found: string[] = [];
  for (const [keyword, value] of Object.entries(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      found.push(path ? `${path}.${keyword}` : keyword);
      continue;
    }
    if (keyword === "type") {
      const unknownTypes = declaredTypeList(value).filter((type) => !SUPPORTED_SCHEMA_TYPES.has(type));
      for (const type of unknownTypes) {
        found.push(path ? `${path}.type:${type}` : `type:${type}`);
      }
      continue;
    }
    if (keyword === "properties" && isRecord(value)) {
      for (const [property, propertySchema] of Object.entries(value)) {
        found.push(...findUnsupportedSchemaKeywords(propertySchema, path ? `${path}.${property}` : property));
      }
      continue;
    }
    if (keyword === "items" || keyword === "anyOf") {
      found.push(...findUnsupportedSchemaKeywords(value, path ? `${path}.${keyword}` : keyword));
    }
  }
  return found;
}
