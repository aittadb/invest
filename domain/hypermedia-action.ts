export const MAX_ACTION_FIELDS = 32;
export const MAX_ACTION_CHOICES = 64;
export const MAX_ACTION_HREF_LENGTH = 2_048;
export const MAX_ACTION_TEXT_LENGTH = 10_000;
export const MAX_ACTION_FIELD_BYTES = 65_536;

export type ActionMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ActionRequestMediaType =
  | "text/html"
  | "application/x-www-form-urlencoded"
  | "application/json";

export type ActionFieldLocation = "path" | "query" | "header" | "body";

type ActionFieldBase = Readonly<{
  name: string;
  title: string;
  location: ActionFieldLocation;
  required: boolean;
  sensitive?: boolean;
  presentation?: "control" | "hidden";
}>;

export type TextActionField = ActionFieldBase &
  Readonly<{
    type: "string";
    format?: "text" | "email" | "url" | "multiline";
    minLength?: number;
    maxLength: number;
    maxBytes?: number;
    value?: string;
    defaultValue?: string;
  }>;

export type IntegerActionField = ActionFieldBase &
  Readonly<{
    type: "integer";
    minimum: number;
    maximum: number;
    step?: number;
    value?: number;
    defaultValue?: number;
  }>;

export type BooleanActionField = ActionFieldBase &
  Readonly<{
    type: "boolean";
    value?: boolean;
    defaultValue?: boolean;
  }>;

export type ChoiceActionField = ActionFieldBase &
  Readonly<{
    type: "choice";
    choices: readonly Readonly<{ value: string; title: string }>[];
    multiple?: boolean;
    value?: string;
    defaultValue?: string;
    values?: readonly string[];
    defaultValues?: readonly string[];
  }>;

export type ActionField =
  | TextActionField
  | IntegerActionField
  | BooleanActionField
  | ChoiceActionField;

export type ActionDefinition = Readonly<{
  name: string;
  title: string;
  method: ActionMethod;
  href: string;
  requestMediaType: ActionRequestMediaType;
  fields: readonly ActionField[];
}>;

export type ActionContract = ActionDefinition;

export type HypermediaActionField = Readonly<{
  name: string;
  title: string;
  type: ActionField["type"];
  location: ActionFieldLocation;
  required: boolean;
  sensitive?: boolean;
  presentation?: "control" | "hidden";
  format?: TextActionField["format"];
  min_length?: number;
  max_length?: number;
  max_bytes?: number;
  minimum?: number;
  maximum?: number;
  step?: number;
  value?: string | number | boolean;
  default?: string | number | boolean;
  multiple?: boolean;
  values?: readonly string[];
  default_values?: readonly string[];
  choices?: readonly Readonly<{ value: string; title: string }>[];
}>;

export type HypermediaAction = Readonly<{
  name: string;
  title: string;
  method: ActionMethod;
  href: string;
  type: ActionRequestMediaType;
  fields: readonly HypermediaActionField[];
}>;

export type HtmlFormField = Readonly<{
  name: string;
  label: string;
  control: "input" | "textarea" | "select";
  inputType?: "text" | "email" | "url" | "number" | "checkbox" | "hidden";
  required: boolean;
  sensitive: boolean;
  presentation?: "control" | "hidden";
  minLength?: number;
  maxLength?: number;
  maxBytes?: number;
  minimum?: number;
  maximum?: number;
  step?: number;
  value?: string | number | boolean;
  defaultValue?: string | number | boolean;
  multiple?: boolean;
  values?: readonly string[];
  defaultValues?: readonly string[];
  choices?: readonly Readonly<{ value: string; label: string }>[];
}>;

export type HtmlFormAction = Readonly<{
  name: string;
  title: string;
  action: string;
  method: "GET" | "POST";
  effectiveMethod: ActionMethod;
  encoding: "application/x-www-form-urlencoded" | null;
  hiddenFields: readonly Readonly<{ name: "_method"; value: string }>[];
  fields: readonly HtmlFormField[];
}>;

export class ActionContractError extends Error {
  constructor() {
    super("The action contract is invalid.");
    this.name = "ActionContractError";
  }
}

export function defineAction(definition: ActionDefinition): ActionContract {
  validateAction(definition);
  return freezeAction(definition);
}

export function actionWhenAllowed(
  allowed: boolean,
  create: () => ActionContract,
): ActionContract | null {
  return allowed ? create() : null;
}

export function currentActions(
  ...actions: readonly (ActionContract | null)[]
): readonly ActionContract[] {
  return Object.freeze(actions.filter((action): action is ActionContract => action !== null));
}

export function toHypermediaAction(action: ActionContract): HypermediaAction {
  return Object.freeze({
    name: action.name,
    title: action.title,
    method: action.method,
    href: action.href,
    type: action.requestMediaType,
    fields: Object.freeze(action.fields.map(toHypermediaField)),
  });
}

export function toHtmlFormAction(action: ActionContract): HtmlFormAction {
  if (!isFormCompatible(action)) throw new ActionContractError();

  const safe = action.method === "GET";
  const hiddenFields = safe || action.method === "POST"
    ? []
    : [{ name: "_method" as const, value: action.method }];

  return Object.freeze({
    name: action.name,
    title: action.title,
    action: action.href,
    method: safe ? "GET" : "POST",
    effectiveMethod: action.method,
    encoding: safe ? null : "application/x-www-form-urlencoded",
    hiddenFields: Object.freeze(hiddenFields.map((field) => Object.freeze(field))),
    fields: Object.freeze(action.fields.map(toHtmlField)),
  });
}

function validateAction(action: ActionDefinition): void {
  if (!isStableName(action.name) || !isBoundedTitle(action.title)) fail();
  if (!isAllowedHref(action.href) || !isActionMethod(action.method)) fail();
  if (!isRequestMediaType(action.requestMediaType)) fail();
  if (!Array.isArray(action.fields) || action.fields.length > MAX_ACTION_FIELDS) fail();

  const safe = action.method === "GET";
  if (safe && action.requestMediaType !== "text/html") fail();
  if (!safe && action.requestMediaType === "text/html") fail();

  const names = new Set<string>();
  for (const field of action.fields) {
    if (names.has(field.name) || field.name === "_method") fail();
    names.add(field.name);
    validateField(field);
    if (safe && field.location === "body") fail();
  }
}

function validateField(field: ActionField): void {
  if (!isStableName(field.name) || !isBoundedTitle(field.title)) fail();
  if (!isFieldLocation(field.location)) fail();
  if (typeof field.required !== "boolean") fail();
  if (field.sensitive !== undefined && typeof field.sensitive !== "boolean") fail();
  if (
    field.presentation !== undefined &&
    field.presentation !== "control" &&
    field.presentation !== "hidden"
  ) {
    fail();
  }

  if (
    field.sensitive &&
    (field.value !== undefined ||
      field.defaultValue !== undefined ||
      (field.type === "choice" &&
        (field.values !== undefined || field.defaultValues !== undefined)))
  ) {
    fail();
  }

  if (
    field.presentation === "hidden" &&
    (field.location !== "body" ||
      field.sensitive === true ||
      (field.type !== "string" && field.type !== "integer") ||
      (field.value === undefined && field.defaultValue === undefined))
  ) {
    fail();
  }

  switch (field.type) {
    case "string":
      validateTextField(field);
      return;
    case "integer":
      validateIntegerField(field);
      return;
    case "boolean":
      if (field.value !== undefined && typeof field.value !== "boolean") fail();
      if (field.defaultValue !== undefined && typeof field.defaultValue !== "boolean") fail();
      return;
    case "choice":
      validateChoiceField(field);
      return;
    default:
      fail();
  }
}

function validateTextField(field: TextActionField): void {
  const minimum = field.minLength ?? 0;
  if (!isIntegerWithin(minimum, 0, MAX_ACTION_TEXT_LENGTH)) fail();
  if (!isIntegerWithin(field.maxLength, 1, MAX_ACTION_TEXT_LENGTH)) fail();
  if (minimum > field.maxLength) fail();
  if (
    field.maxBytes !== undefined &&
    !isIntegerWithin(field.maxBytes, 1, MAX_ACTION_FIELD_BYTES)
  ) {
    fail();
  }
  if (
    field.format !== undefined &&
    !["text", "email", "url", "multiline"].includes(field.format)
  ) {
    fail();
  }

  for (const value of [field.value, field.defaultValue]) {
    if (value === undefined) continue;
    if (typeof value !== "string") fail();
    if (value.length < minimum || value.length > field.maxLength) fail();
    if (field.maxBytes !== undefined && new TextEncoder().encode(value).length > field.maxBytes) {
      fail();
    }
  }
}

function validateIntegerField(field: IntegerActionField): void {
  if (!Number.isSafeInteger(field.minimum) || !Number.isSafeInteger(field.maximum)) fail();
  if (field.minimum > field.maximum) fail();
  const step = field.step ?? 1;
  if (!Number.isSafeInteger(step) || step <= 0) fail();

  for (const value of [field.value, field.defaultValue]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value)) fail();
    if (value < field.minimum || value > field.maximum) fail();
    if ((value - field.minimum) % step !== 0) fail();
  }
}

function validateChoiceField(field: ChoiceActionField): void {
  if (
    !Array.isArray(field.choices) ||
    field.choices.length === 0 ||
    field.choices.length > MAX_ACTION_CHOICES
  ) {
    fail();
  }

  const values = new Set<string>();
  for (const choice of field.choices) {
    if (!isBoundedValue(choice.value) || !isBoundedTitle(choice.title)) fail();
    if (values.has(choice.value)) fail();
    values.add(choice.value);
  }

  for (const value of [field.value, field.defaultValue]) {
    if (value !== undefined && !values.has(value)) fail();
  }

  if (field.multiple !== undefined && typeof field.multiple !== "boolean") {
    fail();
  }

  if (field.multiple === true) {
    if (field.value !== undefined || field.defaultValue !== undefined) fail();
    validateChoiceValues(field.values, values);
    validateChoiceValues(field.defaultValues, values);
  } else if (field.values !== undefined || field.defaultValues !== undefined) {
    fail();
  }
}

function validateChoiceValues(
  selected: readonly string[] | undefined,
  choices: ReadonlySet<string>,
): void {
  if (selected === undefined) return;
  if (!Array.isArray(selected) || selected.length > choices.size) fail();

  const seen = new Set<string>();
  for (const value of selected) {
    if (!choices.has(value) || seen.has(value)) fail();
    seen.add(value);
  }
}

function isFormCompatible(action: ActionContract): boolean {
  if (action.method === "GET") {
    return action.requestMediaType === "text/html" &&
      action.fields.every((field) => field.location === "query");
  }

  return action.requestMediaType === "application/x-www-form-urlencoded" &&
    action.fields.every((field) => field.location === "body");
}

function toHypermediaField(field: ActionField): HypermediaActionField {
  const common = {
    name: field.name,
    title: field.title,
    type: field.type,
    location: field.location,
    required: field.required,
    ...(field.sensitive === undefined ? {} : { sensitive: field.sensitive }),
    ...(field.presentation === undefined
      ? {}
      : { presentation: field.presentation }),
  };

  switch (field.type) {
    case "string":
      return Object.freeze({
        ...common,
        ...(field.format === undefined ? {} : { format: field.format }),
        ...(field.minLength === undefined ? {} : { min_length: field.minLength }),
        max_length: field.maxLength,
        ...(field.maxBytes === undefined ? {} : { max_bytes: field.maxBytes }),
        ...(field.value === undefined ? {} : { value: field.value }),
        ...(field.defaultValue === undefined ? {} : { default: field.defaultValue }),
      });
    case "integer":
      return Object.freeze({
        ...common,
        minimum: field.minimum,
        maximum: field.maximum,
        ...(field.step === undefined ? {} : { step: field.step }),
        ...(field.value === undefined ? {} : { value: field.value }),
        ...(field.defaultValue === undefined ? {} : { default: field.defaultValue }),
      });
    case "boolean":
      return Object.freeze({
        ...common,
        ...(field.value === undefined ? {} : { value: field.value }),
        ...(field.defaultValue === undefined ? {} : { default: field.defaultValue }),
      });
    case "choice":
      return Object.freeze({
        ...common,
        choices: Object.freeze(
          field.choices.map((choice) => Object.freeze({ ...choice })),
        ),
        ...(field.multiple === undefined ? {} : { multiple: field.multiple }),
        ...(field.value === undefined ? {} : { value: field.value }),
        ...(field.defaultValue === undefined ? {} : { default: field.defaultValue }),
        ...(field.values === undefined
          ? {}
          : { values: Object.freeze([...field.values]) }),
        ...(field.defaultValues === undefined
          ? {}
          : { default_values: Object.freeze([...field.defaultValues]) }),
      });
  }
}

function toHtmlField(field: ActionField): HtmlFormField {
  const common = {
    name: field.name,
    label: field.title,
    required: field.required,
    sensitive: field.sensitive ?? false,
    ...(field.presentation === undefined
      ? {}
      : { presentation: field.presentation }),
  };

  switch (field.type) {
    case "string": {
      const multiline = field.format === "multiline";
      const hidden = field.presentation === "hidden";
      const inputType = hidden
        ? "hidden" as const
        : field.format === "email" || field.format === "url"
          ? field.format
          : "text" as const;
      return Object.freeze({
        ...common,
        control: multiline && !hidden ? "textarea" : "input",
        ...(multiline && !hidden
          ? {}
          : { inputType }),
        ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
        maxLength: field.maxLength,
        ...(field.maxBytes === undefined ? {} : { maxBytes: field.maxBytes }),
        ...(field.value === undefined ? {} : { value: field.value }),
        ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
      });
    }
    case "integer":
      return Object.freeze({
        ...common,
        control: "input",
        inputType: field.presentation === "hidden" ? "hidden" : "number",
        minimum: field.minimum,
        maximum: field.maximum,
        step: field.step ?? 1,
        ...(field.value === undefined ? {} : { value: field.value }),
        ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
      });
    case "boolean":
      return Object.freeze({
        ...common,
        control: "input",
        inputType: "checkbox",
        ...(field.value === undefined ? {} : { value: field.value }),
        ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
      });
    case "choice":
      return Object.freeze({
        ...common,
        control: "select",
        choices: Object.freeze(
          field.choices.map((choice) =>
            Object.freeze({ value: choice.value, label: choice.title })
          ),
        ),
        ...(field.multiple === undefined ? {} : { multiple: field.multiple }),
        ...(field.value === undefined ? {} : { value: field.value }),
        ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
        ...(field.values === undefined
          ? {}
          : { values: Object.freeze([...field.values]) }),
        ...(field.defaultValues === undefined
          ? {}
          : { defaultValues: Object.freeze([...field.defaultValues]) }),
      });
  }
}

function freezeAction(action: ActionDefinition): ActionContract {
  return Object.freeze({
    name: action.name,
    title: action.title,
    method: action.method,
    href: action.href,
    requestMediaType: action.requestMediaType,
    fields: Object.freeze(action.fields.map(freezeField)),
  });
}

function freezeField(field: ActionField): ActionField {
  if (field.type !== "choice") return Object.freeze({ ...field });

  return Object.freeze({
    ...field,
    choices: Object.freeze(
      field.choices.map((choice) => Object.freeze({ ...choice })),
    ),
    ...(field.values === undefined
      ? {}
      : { values: Object.freeze([...field.values]) }),
    ...(field.defaultValues === undefined
      ? {}
      : { defaultValues: Object.freeze([...field.defaultValues]) }),
  });
}

function isStableName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function isBoundedTitle(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    value.trim() === value &&
    !hasControlCharacter(value);
}

function isBoundedValue(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value &&
    !hasControlCharacter(value);
}

function isAllowedHref(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ACTION_HREF_LENGTH) {
    return false;
  }

  if (value.startsWith("/") && !value.startsWith("//")) {
    return !value.includes("#") && !hasControlCharacter(value);
  }

  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

function isActionMethod(value: unknown): value is ActionMethod {
  return typeof value === "string" &&
    ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(value);
}

function isRequestMediaType(value: unknown): value is ActionRequestMediaType {
  return typeof value === "string" &&
    [
      "text/html",
      "application/x-www-form-urlencoded",
      "application/json",
    ].includes(value);
}

function isFieldLocation(value: unknown): value is ActionFieldLocation {
  return typeof value === "string" &&
    ["path", "query", "header", "body"].includes(value);
}

function isIntegerWithin(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) &&
    typeof value === "number" &&
    value >= minimum &&
    value <= maximum;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }

  return false;
}

function fail(): never {
  throw new ActionContractError();
}
