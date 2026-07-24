import {
  MAX_ELICITATION_FIELDS,
  MAX_ELICITATION_LABEL_LENGTH,
  MAX_ELICITATION_MESSAGE_LENGTH,
  MAX_ELICITATION_OPTION_LENGTH,
  MAX_ELICITATION_OPTIONS,
  MAX_ELICITATION_SCHEMA_LENGTH,
  MAX_ELICITATION_STRING_LENGTH,
  MAX_ELICITATION_URL_LENGTH,
  type ElicitationEnumField,
  type ElicitationFieldValue,
  type ElicitationMultiSelectField,
  type ElicitationSchema,
  type ElicitationSchemaField,
  type ElicitationTextField,
  type ElicitationTitledEnumField,
  type NativeElicitationResult,
  type PendingElicitationRequestView,
} from "./elicitation-types.js";
import type {
  NativeUserInputResponse,
  PendingUserInputRequestView,
} from "./user-input-types.js";

export type PendingInteractionErrorCode =
  | "invalid_request"
  | "invalid_response"
  | "request_not_found"
  | "unsupported"
  | "backend_unavailable";

interface PendingInteractionErrorOptions {
  statusCode?: number;
}

export class PendingInteractionError extends Error {
  readonly code: PendingInteractionErrorCode;
  readonly statusCode: number;

  constructor(
    code: PendingInteractionErrorCode,
    message: string,
    options: PendingInteractionErrorOptions = {},
  ) {
    super(message);
    this.name = "PendingInteractionError";
    this.code = code;
    this.statusCode = options.statusCode ?? 400;
  }
}

const DANGEROUS_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_BASE_KEYS = new Set(["type", "title", "description"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeError(
  code: PendingInteractionErrorCode,
  message: string,
  options: PendingInteractionErrorOptions = {},
): PendingInteractionError {
  return new PendingInteractionError(code, message, options);
}

function validateString(
  value: unknown,
  fieldName: string,
  maxLength: number,
  code: PendingInteractionErrorCode = "invalid_request",
): string {
  if (typeof value !== "string") {
    throw makeError(code, `${fieldName} must be a string`);
  }
  if (!value.trim()) {
    throw makeError(code, `${fieldName} is required`);
  }
  if (value.length > maxLength) {
    throw makeError(code, `${fieldName} must be at most ${maxLength} characters`);
  }
  return value;
}

function normalizeIdentifier(value: unknown, fieldName: string): string {
  return validateString(value, fieldName, 500).trim();
}

function normalizeOptionalLabel(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return validateString(value, fieldName, MAX_ELICITATION_LABEL_LENGTH);
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  fieldName: string,
): void {
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey) {
    throw makeError("invalid_request", `${fieldName} contains unsupported property ${unknownKey}`);
  }
}

function normalizeNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw makeError("invalid_request", `${fieldName} must be a non-negative integer`);
  }
  return Number(value);
}

function normalizeFiniteNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw makeError("invalid_request", `${fieldName} must be a finite number`);
  }
  return value;
}

function normalizeStringOptions(
  value: unknown,
  fieldName: string,
  maxLength = MAX_ELICITATION_OPTION_LENGTH,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ELICITATION_OPTIONS) {
    throw makeError(
      "invalid_request",
      `${fieldName} must contain between 1 and ${MAX_ELICITATION_OPTIONS} strings`,
    );
  }
  const options = value.map((item, index) => (
    validateString(item, `${fieldName}[${index}]`, maxLength)
  ));
  if (new Set(options).size !== options.length) {
    throw makeError("invalid_request", `${fieldName} cannot contain duplicate values`);
  }
  return options;
}

function normalizeTitledOptions(
  value: unknown,
  fieldName: string,
): Array<{ const: string; title: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ELICITATION_OPTIONS) {
    throw makeError(
      "invalid_request",
      `${fieldName} must contain between 1 and ${MAX_ELICITATION_OPTIONS} options`,
    );
  }
  const options = value.map((item, index) => {
    if (!isRecord(item)) {
      throw makeError("invalid_request", `${fieldName}[${index}] must be an object`);
    }
    assertOnlyKeys(item, new Set(["const", "title"]), `${fieldName}[${index}]`);
    return {
      const: validateString(
        item.const,
        `${fieldName}[${index}].const`,
        MAX_ELICITATION_OPTION_LENGTH,
      ),
      title: validateString(
        item.title,
        `${fieldName}[${index}].title`,
        MAX_ELICITATION_LABEL_LENGTH,
      ),
    };
  });
  if (new Set(options.map((option) => option.const)).size !== options.length) {
    throw makeError("invalid_request", `${fieldName} cannot contain duplicate values`);
  }
  return options;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isUri(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validateStringFormat(
  value: string,
  format: unknown,
  fieldName: string,
  code: PendingInteractionErrorCode,
): void {
  if (format === undefined) return;
  const valid = format === "email"
    ? isEmail(value)
    : format === "uri"
      ? isUri(value)
      : format === "date"
        ? isDate(value)
        : format === "date-time"
          ? isDateTime(value)
          : false;
  if (!valid) {
    throw makeError(code, `${fieldName} must be a valid ${String(format)}`);
  }
}

function normalizeFieldValue(
  field: ElicitationSchemaField,
  value: unknown,
  fieldName: string,
  code: PendingInteractionErrorCode,
): ElicitationFieldValue {
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw makeError(code, `${fieldName} must be a boolean`);
    return value;
  }

  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw makeError(code, `${fieldName} must be a finite number`);
    }
    if (field.type === "integer" && !Number.isInteger(value)) {
      throw makeError(code, `${fieldName} must be an integer`);
    }
    if (field.minimum !== undefined && value < field.minimum) {
      throw makeError(code, `${fieldName} must be at least ${field.minimum}`);
    }
    if (field.maximum !== undefined && value > field.maximum) {
      throw makeError(code, `${fieldName} must be at most ${field.maximum}`);
    }
    return value;
  }

  if (field.type === "array") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw makeError(code, `${fieldName} must be an array of strings`);
    }
    if (field.minItems !== undefined && value.length < field.minItems) {
      throw makeError(code, `${fieldName} must contain at least ${field.minItems} values`);
    }
    if (field.maxItems !== undefined && value.length > field.maxItems) {
      throw makeError(code, `${fieldName} must contain at most ${field.maxItems} values`);
    }
    const allowed = "enum" in field.items
      ? field.items.enum
      : field.items.anyOf.map((option) => option.const);
    if (value.some((item) => !allowed.includes(item))) {
      throw makeError(code, `${fieldName} contains an unsupported value`);
    }
    if (new Set(value).size !== value.length) {
      throw makeError(code, `${fieldName} cannot contain duplicate values`);
    }
    return [...value];
  }

  if (field.type !== "string") {
    throw makeError(code, `${fieldName} has an unsupported field type`);
  }
  if (typeof value !== "string") throw makeError(code, `${fieldName} must be a string`);
  if (value.length > MAX_ELICITATION_STRING_LENGTH) {
    throw makeError(code, `${fieldName} must be at most ${MAX_ELICITATION_STRING_LENGTH} characters`);
  }
  if ("enum" in field && !field.enum.includes(value)) {
    throw makeError(code, `${fieldName} must match one of the available options`);
  }
  if ("oneOf" in field && !field.oneOf.some((option) => option.const === value)) {
    throw makeError(code, `${fieldName} must match one of the available options`);
  }
  if (!("enum" in field) && !("oneOf" in field)) {
    if (field.minLength !== undefined && value.length < field.minLength) {
      throw makeError(code, `${fieldName} must be at least ${field.minLength} characters`);
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      throw makeError(code, `${fieldName} must be at most ${field.maxLength} characters`);
    }
    validateStringFormat(value, field.format, fieldName, code);
  }
  return value;
}

function normalizeField(input: unknown, fieldName: string): ElicitationSchemaField {
  if (!isRecord(input)) {
    throw makeError("invalid_request", `${fieldName} must be an object`);
  }
  const type = input.type;
  const title = normalizeOptionalLabel(input.title, `${fieldName}.title`);
  const description = normalizeOptionalLabel(input.description, `${fieldName}.description`);
  const base = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };

  if (type === "boolean") {
    assertOnlyKeys(input, new Set([...FIELD_BASE_KEYS, "default"]), fieldName);
    if (input.default !== undefined && typeof input.default !== "boolean") {
      throw makeError("invalid_request", `${fieldName}.default must be a boolean`);
    }
    return { type, ...base, ...(input.default !== undefined ? { default: input.default } : {}) };
  }

  if (type === "number" || type === "integer") {
    assertOnlyKeys(
      input,
      new Set([...FIELD_BASE_KEYS, "minimum", "maximum", "default"]),
      fieldName,
    );
    const minimum = normalizeFiniteNumber(input.minimum, `${fieldName}.minimum`);
    const maximum = normalizeFiniteNumber(input.maximum, `${fieldName}.maximum`);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw makeError("invalid_request", `${fieldName}.minimum cannot exceed maximum`);
    }
    const field: ElicitationSchemaField = {
      type,
      ...base,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
    };
    if (input.default !== undefined) {
      field.default = normalizeFieldValue(field, input.default, `${fieldName}.default`, "invalid_request") as number;
    }
    return field;
  }

  if (type === "array") {
    assertOnlyKeys(
      input,
      new Set([...FIELD_BASE_KEYS, "minItems", "maxItems", "items", "default"]),
      fieldName,
    );
    const minItems = normalizeNonNegativeInteger(input.minItems, `${fieldName}.minItems`);
    const maxItems = normalizeNonNegativeInteger(input.maxItems, `${fieldName}.maxItems`);
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      throw makeError("invalid_request", `${fieldName}.minItems cannot exceed maxItems`);
    }
    if (maxItems !== undefined && maxItems > MAX_ELICITATION_OPTIONS) {
      throw makeError(
        "invalid_request",
        `${fieldName}.maxItems cannot exceed ${MAX_ELICITATION_OPTIONS}`,
      );
    }
    if (!isRecord(input.items)) {
      throw makeError("invalid_request", `${fieldName}.items must be an object`);
    }
    let items: ElicitationMultiSelectField["items"];
    if (Object.hasOwn(input.items, "enum")) {
      assertOnlyKeys(input.items, new Set(["type", "enum"]), `${fieldName}.items`);
      if (input.items.type !== "string") {
        throw makeError("invalid_request", `${fieldName}.items.type must be string`);
      }
      items = {
        type: "string",
        enum: normalizeStringOptions(input.items.enum, `${fieldName}.items.enum`),
      };
    } else if (Object.hasOwn(input.items, "anyOf")) {
      assertOnlyKeys(input.items, new Set(["anyOf"]), `${fieldName}.items`);
      items = {
        anyOf: normalizeTitledOptions(input.items.anyOf, `${fieldName}.items.anyOf`),
      };
    } else {
      throw makeError("invalid_request", `${fieldName}.items must define enum or anyOf`);
    }
    const field: ElicitationMultiSelectField = {
      type,
      ...base,
      items,
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
    };
    if (input.default !== undefined) {
      field.default = normalizeFieldValue(
        field,
        input.default,
        `${fieldName}.default`,
        "invalid_request",
      ) as string[];
    }
    return field;
  }

  if (type !== "string") {
    throw makeError("invalid_request", `${fieldName}.type is unsupported`);
  }

  if (Object.hasOwn(input, "enum")) {
    assertOnlyKeys(
      input,
      new Set([...FIELD_BASE_KEYS, "enum", "enumNames", "default"]),
      fieldName,
    );
    const options = normalizeStringOptions(input.enum, `${fieldName}.enum`);
    let enumNames: string[] | undefined;
    if (input.enumNames !== undefined) {
      enumNames = normalizeStringOptions(
        input.enumNames,
        `${fieldName}.enumNames`,
        MAX_ELICITATION_LABEL_LENGTH,
      );
      if (enumNames.length !== options.length) {
        throw makeError("invalid_request", `${fieldName}.enumNames must match enum length`);
      }
    }
    const field: ElicitationEnumField = {
      type,
      ...base,
      enum: options,
      ...(enumNames ? { enumNames } : {}),
    };
    if (input.default !== undefined) {
      field.default = normalizeFieldValue(
        field,
        input.default,
        `${fieldName}.default`,
        "invalid_request",
      ) as string;
    }
    return field;
  }

  if (Object.hasOwn(input, "oneOf")) {
    assertOnlyKeys(input, new Set([...FIELD_BASE_KEYS, "oneOf", "default"]), fieldName);
    const field: ElicitationTitledEnumField = {
      type,
      ...base,
      oneOf: normalizeTitledOptions(input.oneOf, `${fieldName}.oneOf`),
    };
    if (input.default !== undefined) {
      field.default = normalizeFieldValue(
        field,
        input.default,
        `${fieldName}.default`,
        "invalid_request",
      ) as string;
    }
    return field;
  }

  assertOnlyKeys(
    input,
    new Set([...FIELD_BASE_KEYS, "minLength", "maxLength", "format", "default"]),
    fieldName,
  );
  const minLength = normalizeNonNegativeInteger(input.minLength, `${fieldName}.minLength`);
  const maxLength = normalizeNonNegativeInteger(input.maxLength, `${fieldName}.maxLength`);
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw makeError("invalid_request", `${fieldName}.minLength cannot exceed maxLength`);
  }
  if (maxLength !== undefined && maxLength > MAX_ELICITATION_STRING_LENGTH) {
    throw makeError(
      "invalid_request",
      `${fieldName}.maxLength cannot exceed ${MAX_ELICITATION_STRING_LENGTH}`,
    );
  }
  const format = input.format;
  if (
    format !== undefined
    && format !== "email"
    && format !== "uri"
    && format !== "date"
    && format !== "date-time"
  ) {
    throw makeError("invalid_request", `${fieldName}.format is unsupported`);
  }
  const field: ElicitationTextField = {
    type,
    ...base,
    ...(minLength !== undefined ? { minLength } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(format !== undefined ? { format } : {}),
  };
  if (input.default !== undefined) {
    field.default = normalizeFieldValue(
      field,
      input.default,
      `${fieldName}.default`,
      "invalid_request",
    ) as string;
  }
  return field;
}

function normalizePropertyName(value: unknown, fieldName: string): string {
  const name = validateString(value, fieldName, 100);
  if (DANGEROUS_PROPERTY_NAMES.has(name) || /[\u0000-\u001f\u007f]/.test(name)) {
    throw makeError("invalid_request", `${fieldName} is not allowed`);
  }
  return name;
}

function normalizeSchema(input: unknown): ElicitationSchema {
  if (!isRecord(input)) {
    throw makeError("invalid_request", "requestedSchema must be an object");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw makeError("invalid_request", "requestedSchema must be JSON serializable");
  }
  if (serialized.length > MAX_ELICITATION_SCHEMA_LENGTH) {
    throw makeError(
      "invalid_request",
      `requestedSchema must be at most ${MAX_ELICITATION_SCHEMA_LENGTH} characters`,
    );
  }
  assertOnlyKeys(input, new Set(["type", "properties", "required"]), "requestedSchema");
  if (input.type !== undefined && input.type !== "object") {
    throw makeError("invalid_request", "requestedSchema.type must be object");
  }
  if (!isRecord(input.properties)) {
    throw makeError("invalid_request", "requestedSchema.properties must be an object");
  }
  const entries = Object.entries(input.properties);
  if (entries.length > MAX_ELICITATION_FIELDS) {
    throw makeError(
      "invalid_request",
      `requestedSchema.properties cannot contain more than ${MAX_ELICITATION_FIELDS} fields`,
    );
  }
  const properties: Record<string, ElicitationSchemaField> = Object.create(null);
  for (const [rawName, field] of entries) {
    const name = normalizePropertyName(rawName, "requestedSchema property name");
    properties[name] = normalizeField(field, `requestedSchema.properties.${name}`);
  }

  let required: string[] | undefined;
  if (input.required !== undefined) {
    if (!Array.isArray(input.required) || input.required.some((name) => typeof name !== "string")) {
      throw makeError("invalid_request", "requestedSchema.required must be an array of strings");
    }
    required = input.required.map((name, index) => (
      normalizePropertyName(name, `requestedSchema.required[${index}]`)
    ));
    if (new Set(required).size !== required.length) {
      throw makeError("invalid_request", "requestedSchema.required cannot contain duplicates");
    }
    const unknown = required.find((name) => !Object.hasOwn(properties, name));
    if (unknown) {
      throw makeError("invalid_request", `requestedSchema.required references unknown field ${unknown}`);
    }
  }

  return {
    type: "object",
    properties,
    ...(required?.length ? { required } : {}),
  };
}

function normalizeHttpsUrl(value: unknown): string {
  const raw = validateString(value, "url", MAX_ELICITATION_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw makeError("invalid_request", "url must be valid");
  }
  if (parsed.protocol !== "https:") {
    throw makeError("invalid_request", "url must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw makeError("invalid_request", "url cannot contain embedded credentials");
  }
  return raw;
}

function normalizeUserInputChoices(rawChoices: unknown): string[] | undefined {
  if (rawChoices === undefined) return undefined;
  if (!Array.isArray(rawChoices)) {
    throw makeError("invalid_request", "choices must be an array of strings");
  }
  const choices: string[] = [];
  const seen = new Set<string>();
  for (const rawChoice of rawChoices) {
    if (typeof rawChoice !== "string") {
      throw makeError("invalid_request", "choices must be an array of strings");
    }
    const choice = rawChoice.trim();
    if (!choice) {
      throw makeError("invalid_request", "choices cannot contain blank values");
    }
    if (seen.has(choice)) {
      throw makeError("invalid_request", "choices cannot contain duplicates after trimming");
    }
    seen.add(choice);
    choices.push(choice);
  }
  return choices.length > 0 ? choices : undefined;
}

export function normalizeInteractionIdentifier(value: unknown, fieldName: string): string {
  return normalizeIdentifier(value, fieldName);
}

export function normalizePendingUserInputRequest(
  input: unknown,
  requestedAt?: string,
): PendingUserInputRequestView {
  if (!isRecord(input)) {
    throw makeError("invalid_request", "User input request must be an object");
  }
  const requestId = normalizeIdentifier(input.requestId, "requestId");
  const question = normalizeIdentifier(input.question, "question");
  const allowFreeform = input.allowFreeform ?? true;
  if (typeof allowFreeform !== "boolean") {
    throw makeError("invalid_request", "allowFreeform must be a boolean");
  }
  const choices = normalizeUserInputChoices(input.choices);
  if (!allowFreeform && !choices?.length) {
    throw makeError("invalid_request", "User input requests without choices must allow freeform answers");
  }
  const toolCallId = typeof input.toolCallId === "string" && input.toolCallId.trim()
    ? input.toolCallId.trim()
    : undefined;
  return {
    requestId,
    question,
    allowFreeform,
    ...(choices ? { choices } : {}),
    ...(requestedAt ? { requestedAt } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

export function validateUserInputResponse(
  view: PendingUserInputRequestView,
  payload: unknown,
): NativeUserInputResponse {
  if (!isRecord(payload)) {
    throw makeError("invalid_response", "User input response must be an object");
  }
  assertOnlyKeys(payload, new Set(["answer", "wasFreeform"]), "User input response");
  if (typeof payload.answer !== "string") {
    throw makeError("invalid_response", "Response answer must be a string");
  }
  if (!payload.answer.trim()) {
    throw makeError("invalid_response", "Response answer cannot be blank");
  }
  if (typeof payload.wasFreeform !== "boolean") {
    throw makeError("invalid_response", "Response wasFreeform must be a boolean");
  }
  const response = {
    answer: payload.answer,
    wasFreeform: payload.wasFreeform,
  };
  const choices = view.choices ?? [];
  const matchesChoice = choices.includes(response.answer);
  if (response.wasFreeform && !view.allowFreeform) {
    throw makeError("invalid_response", "Freeform answers are not allowed for this request");
  }
  if (choices.length > 0 && !response.wasFreeform && !matchesChoice) {
    throw makeError("invalid_response", "Choice responses must match one of the request choices");
  }
  if (choices.length > 0 && !view.allowFreeform && !matchesChoice) {
    throw makeError("invalid_response", "Response answer must match one of the request choices");
  }
  return response;
}

export function normalizePendingElicitationRequest(
  input: unknown,
  requestedAt?: string,
): PendingElicitationRequestView {
  if (!isRecord(input)) {
    throw makeError("invalid_request", "Elicitation request must be an object");
  }
  const requestId = normalizeIdentifier(input.requestId, "requestId");
  const mode = input.mode ?? "form";
  if (mode !== "form" && mode !== "url") {
    throw makeError("invalid_request", "Elicitation mode must be form or url");
  }
  const message = validateString(input.message, "message", MAX_ELICITATION_MESSAGE_LENGTH);
  const source = input.elicitationSource === undefined
    ? undefined
    : validateString(input.elicitationSource, "elicitationSource", MAX_ELICITATION_LABEL_LENGTH);
  const common = {
    requestId,
    message,
    mode,
    ...(requestedAt ? { requestedAt } : {}),
    ...(source ? { elicitationSource: source } : {}),
  };
  if (mode === "url") {
    if (input.requestedSchema !== undefined) {
      throw makeError("invalid_request", "URL elicitation cannot include requestedSchema");
    }
    return { ...common, mode, url: normalizeHttpsUrl(input.url) };
  }
  if (input.url !== undefined) {
    throw makeError("invalid_request", "Form elicitation cannot include url");
  }
  return {
    ...common,
    mode,
    requestedSchema: normalizeSchema(input.requestedSchema),
  };
}

export function validateElicitationResponse(
  view: PendingElicitationRequestView,
  payload: unknown,
): NativeElicitationResult {
  if (!isRecord(payload)) {
    throw makeError("invalid_response", "Elicitation response must be an object");
  }
  assertOnlyKeys(payload, new Set(["action", "content"]), "Elicitation response");
  const action = payload.action;
  if (action !== "accept" && action !== "decline" && action !== "cancel") {
    throw makeError("invalid_response", "Elicitation action must be accept, decline, or cancel");
  }
  if (action !== "accept") {
    if (payload.content !== undefined) {
      throw makeError("invalid_response", "Declined or canceled responses cannot include content");
    }
    return { action };
  }
  if (view.mode === "url") {
    if (payload.content !== undefined) {
      throw makeError("invalid_response", "URL elicitation responses cannot include content");
    }
    return { action };
  }
  if (!isRecord(payload.content)) {
    throw makeError("invalid_response", "Accepted form responses must include content");
  }
  const schema = view.requestedSchema;
  if (!schema) {
    throw makeError("invalid_response", "Pending form elicitation schema is unavailable");
  }
  const content: Record<string, ElicitationFieldValue> = Object.create(null);
  for (const key of Object.keys(payload.content)) {
    if (DANGEROUS_PROPERTY_NAMES.has(key) || !Object.hasOwn(schema.properties, key)) {
      throw makeError("invalid_response", `Elicitation response contains unknown field ${key}`);
    }
    content[key] = normalizeFieldValue(
      schema.properties[key],
      payload.content[key],
      key,
      "invalid_response",
    );
  }
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(content, required)) {
      throw makeError("invalid_response", `Elicitation response is missing required field ${required}`);
    }
  }
  return { action, content };
}
