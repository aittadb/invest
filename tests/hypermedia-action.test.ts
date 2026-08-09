import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionContractError,
  MAX_ACTION_FIELDS,
  actionWhenAllowed,
  currentActions,
  defineAction,
  toHtmlFormAction,
  toHypermediaAction,
  type ActionDefinition,
  type ActionField,
  type ActionJsonValue,
  type ActionMethod,
  type TextActionField,
} from "../domain/hypermedia-action.ts";

test("defines bounded safe and mutating action contracts", () => {
  const browse = defineAction({
    name: "filter-applications",
    title: "Filter applications",
    method: "GET",
    href: "/owner/applications",
    requestMediaType: "text/html",
    fields: [textField("query", "query")],
  });
  const replace = defineAction(jsonMutationDefinition("PUT"));

  assert.equal(toHypermediaAction(browse).method, "GET");
  assert.equal(toHypermediaAction(replace).type, "application/json");
  assert.deepEqual(
    toHypermediaAction(replace).fields.map((field) => field.type),
    ["string", "integer", "boolean", "choice"],
  );
  assert.ok(Object.isFrozen(replace));
  assert.ok(Object.isFrozen(replace.fields));
  assert.ok(Object.isFrozen(replace.fields[3]));
  assert.ok(
    replace.fields[3]?.type === "choice" &&
      Object.isFrozen(replace.fields[3].choices),
  );
});

test("rejects unsafe, unbounded, duplicate, and secret-bearing definitions", () => {
  assert.throws(
    () => defineAction({ ...jsonMutationDefinition("POST"), href: "javascript:alert(1)" }),
    ActionContractError,
  );
  assert.throws(
    () =>
      defineAction({
        ...jsonMutationDefinition("POST"),
        fields: Array.from(
          { length: MAX_ACTION_FIELDS + 1 },
          (_, index) => textField(`field-${index}`, "body"),
        ),
      }),
    ActionContractError,
  );
  assert.throws(
    () =>
      defineAction({
        ...jsonMutationDefinition("POST"),
        fields: [textField("note", "body"), textField("note", "body")],
      }),
    ActionContractError,
  );
  assert.throws(
    () =>
      defineAction({
        ...jsonMutationDefinition("POST"),
        fields: [
          {
            ...textField("csrf-token", "body"),
            sensitive: true,
            defaultValue: "must-not-be-advertised",
          },
        ],
      }),
    ActionContractError,
  );
  assert.throws(
    () =>
      defineAction({
        ...jsonMutationDefinition("POST"),
        fields: [{ ...textField("note", "body"), maxLength: 0 }],
      }),
    ActionContractError,
  );
});

test("projects one transition as equivalent JSON action and HTML form models", () => {
  const action = defineAction(formMutationDefinition("PATCH"));
  const json = toHypermediaAction(action);
  const html = toHtmlFormAction(action);

  assert.deepEqual(
    {
      name: json.name,
      title: json.title,
      target: json.href,
      method: json.method,
      fields: json.fields.map((field) => ({
        name: field.name,
        title: field.title,
        required: field.required,
        type: field.type,
      })),
    },
    {
      name: html.name,
      title: html.title,
      target: html.action,
      method: html.effectiveMethod,
      fields: html.fields.map((field, index) => ({
        name: field.name,
        title: field.label,
        required: field.required,
        type: json.fields[index]?.type,
      })),
    },
  );
  assert.equal(html.method, "POST");
  assert.equal(html.encoding, "application/x-www-form-urlencoded");
  assert.deepEqual(html.hiddenFields, [{ name: "_method", value: "PATCH" }]);
  assert.deepEqual(
    {
      min: json.fields[1]?.minimum,
      max: json.fields[1]?.maximum,
      step: json.fields[1]?.step,
    },
    {
      min: html.fields[1]?.minimum,
      max: html.fields[1]?.maximum,
      step: html.fields[1]?.step,
    },
  );
  assert.deepEqual(
    json.fields[3]?.choices?.map((choice) => choice.value),
    html.fields[3]?.choices?.map((choice) => choice.value),
  );
});

test("projects hidden concurrency fields and repeated configured choices", () => {
  const action = defineAction({
    name: "edit-founder-application",
    title: "Save application",
    method: "PATCH",
    href: "/participant/founder-interest",
    requestMediaType: "application/x-www-form-urlencoded",
    fields: [
      {
        name: "operation-id",
        title: "Operation identifier",
        type: "string",
        format: "text",
        location: "body",
        required: true,
        presentation: "hidden",
        minLength: 1,
        maxLength: 127,
        value: "founder-operation:edit",
      },
      {
        name: "secondary-areas",
        title: "Secondary contribution areas",
        type: "choice",
        location: "body",
        required: false,
        multiple: true,
        choices: [
          { value: "area:product", title: "Product" },
          { value: "area:operations", title: "Operations" },
        ],
        values: ["area:product"],
      },
    ],
  });

  const json = toHypermediaAction(action);
  const html = toHtmlFormAction(action);
  assert.deepEqual(
    {
      presentation: json.fields[0]?.presentation,
      value: json.fields[0]?.value,
      multiple: json.fields[1]?.multiple,
      values: json.fields[1]?.values,
    },
    {
      presentation: html.fields[0]?.presentation,
      value: html.fields[0]?.value,
      multiple: html.fields[1]?.multiple,
      values: html.fields[1]?.values,
    },
  );
  assert.equal(html.fields[0]?.inputType, "hidden");
  assert.equal(html.fields[1]?.control, "select");
  assert.equal(Object.isFrozen(json.fields[1]?.values), true);
  assert.equal(Object.isFrozen(html.fields[1]?.values), true);
});

test("keeps JSON-only actions valid without pretending native form parity", () => {
  const action = defineAction(jsonMutationDefinition("DELETE"));

  assert.equal(toHypermediaAction(action).method, "DELETE");
  assert.throws(() => toHtmlFormAction(action), ActionContractError);

  const headerAction = defineAction({
    ...jsonMutationDefinition("POST"),
    fields: [
      {
        ...textField("confirmation", "header"),
        sensitive: true,
      },
    ],
  });
  assert.throws(() => toHtmlFormAction(headerAction), ActionContractError);
});

test("projects bounded structured JSON fields without flattening their value", () => {
  const source = {
    name: "Northstar",
    sections: [{ id: "opening", enabled: true }],
  };
  const action = defineAction({
    name: "save-campaign",
    title: "Save campaign",
    method: "POST",
    href: "/owner/campaign",
    requestMediaType: "application/json",
    fields: [{
      name: "public-campaign",
      title: "Public campaign",
      type: "json",
      shape: "object",
      location: "body",
      required: true,
      maxBytes: 4_096,
      value: source,
    }],
  });
  source.name = "Changed after definition";

  const projected = toHypermediaAction(action).fields[0];
  assert.equal(projected?.type, "json");
  assert.equal(projected?.json_shape, "object");
  assert.deepEqual(projected?.value, {
    name: "Northstar",
    sections: [{ id: "opening", enabled: true }],
  });
  assert.equal(Object.isFrozen(projected?.value), true);
  assert.throws(() => toHtmlFormAction(action), ActionContractError);

  assert.throws(() => defineAction({
    name: "save-campaign",
    title: "Save campaign",
    method: "POST",
    href: "/owner/campaign",
    requestMediaType: "application/json",
    fields: [{
      name: "public-campaign",
      title: "Public campaign",
      type: "json",
      shape: "array",
      location: "body",
      required: true,
      maxBytes: 4_096,
      value: source,
    }],
  }), ActionContractError);

  const cyclic: Record<string, ActionJsonValue> = {};
  cyclic.self = cyclic;
  for (const invalid of [new Date(), cyclic]) {
    assert.throws(() => defineAction({
      name: "save-campaign",
      title: "Save campaign",
      method: "POST",
      href: "/owner/campaign",
      requestMediaType: "application/json",
      fields: [{
        name: "public-campaign",
        title: "Public campaign",
        type: "json",
        shape: "object",
        location: "body",
        required: true,
        maxBytes: 4_096,
        value: invalid as ActionJsonValue,
      }],
    }), ActionContractError);
  }
});

test("projects only transitions currently allowed for this caller and state", () => {
  let privateFactoryCalls = 0;
  const withdraw = actionWhenAllowed(true, () =>
    defineAction(formMutationDefinition("POST"))
  );
  const reject = actionWhenAllowed(false, () => {
    privateFactoryCalls += 1;
    return defineAction({
      ...formMutationDefinition("POST"),
      name: "reject-indication",
      href: "/owner/indications/private-id/reject",
    });
  });

  const actions = currentActions(withdraw, reject);
  assert.deepEqual(actions.map((action) => action.name), ["update-indication"]);
  assert.equal(privateFactoryCalls, 0);
  assert.ok(Object.isFrozen(actions));
});

function jsonMutationDefinition(method: ActionMethod): ActionDefinition {
  return {
    name: "update-indication",
    title: "Update indication",
    method,
    href: "/participant/indications/example",
    requestMediaType: "application/json",
    fields: mutationFields(),
  };
}

function formMutationDefinition(method: ActionMethod): ActionDefinition {
  return {
    ...jsonMutationDefinition(method),
    requestMediaType: "application/x-www-form-urlencoded",
  };
}

function mutationFields(): readonly ActionField[] {
  return [
    {
      ...textField("note", "body"),
      format: "multiline",
      minLength: 0,
      maxLength: 1_000,
      maxBytes: 4_000,
    },
    {
      name: "amount",
      title: "Amount",
      type: "integer",
      location: "body",
      required: true,
      minimum: 10_000,
      maximum: 1_000_000,
      step: 10_000,
      value: 20_000,
    },
    {
      name: "confirm",
      title: "Confirm",
      type: "boolean",
      location: "body",
      required: true,
      defaultValue: false,
    },
    {
      name: "timing",
      title: "Timing",
      type: "choice",
      location: "body",
      required: true,
      choices: [
        { value: "formation", title: "At formation" },
        { value: "later", title: "Later" },
      ],
      value: "formation",
    },
  ];
}

function textField(
  name: string,
  location: ActionField["location"],
): TextActionField {
  return {
    name,
    title: name === "query" ? "Search" : "Note",
    type: "string",
    format: "text",
    location,
    required: false,
    maxLength: 200,
  };
}
