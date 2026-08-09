# Investor App Hypermedia Contract

Status: `0.1` preview

Investor App URLs identify application resources, not separate HTML pages and JSON endpoints. The request `Accept` header selects the representation for the current caller and resource state.

## Representations

Human interface:

```http
GET / HTTP/1.1
Accept: text/html
```

Versioned hypermedia JSON:

```http
GET / HTTP/1.1
Accept: application/vnd.aittadb-invest+json; version=0.1
```

`application/json` is accepted as a compatibility request. JSON responses report the selected contract in `Investor-App-API-Version` and `api_version`. An explicit unsupported vendor-media version returns `406 Not Acceptable` instead of silently selecting another contract.

Representation selection never uses `User-Agent`. Responses that can vary by representation include `Vary: Accept`.

## Equivalent Capabilities

| Resource concept | Hypermedia JSON | HTML |
| --- | --- | --- |
| Current state | `data` | Text, values, lists, and tables |
| Relationship | `links` entry | Link |
| Available transition | `actions` entry | Link, form, or button |
| Accepted input | Typed action `fields` | Labeled form controls and validation attributes |

Both representations must call the same identity, authorization, validation, domain, and repository services. HTML is not a demonstration client, and JSON is not a reduced export.

## Document Shape

The public campaign resource currently has this shape:

```json
{
  "api_version": "0.1",
  "type": "investment-pre-registration",
  "id": "northstar-robotics",
  "data": {
    "published": true,
    "name": "Northstar Robotics",
    "phase_label": "Investment pre-registration",
    "status": "open",
    "status_label": "Pre-registration open",
    "participation_paths": ["investor", "founder"],
    "interest_is_binding": false
  },
  "links": [
    {
      "rel": ["self"],
      "href": "https://example.com/"
    }
  ],
  "actions": [
    {
      "name": "sign-in",
      "title": "Register your interest",
      "method": "GET",
      "href": "https://example.com/signin-with-chatgpt?return_to=%2F",
      "type": "text/html",
      "fields": []
    }
  ]
}
```

`data` contains the state visible to the current caller. Links use stable semantic `rel` values and server-supplied targets. Actions use stable semantic names and describe only transitions available now.

Mutation actions will also declare their request media type and typed fields. Fields can describe body, path, query, or header location; required state; sensitivity; current or default value; allowed choices; and length, numeric, or byte constraints.

## Identity and Authorization

The signed-out campaign document contains only public state and sign-in transitions. A valid participant session can add links and actions for the private package and that participant's records. An owner session can add owner operations only after a separate owner authorization decision.

Omitting a control is not authorization. Every target independently enforces identity, actor role, resource ownership, workflow state, same-origin and CSRF rules for browser mutations, and input validation. Inaccessible foreign records use the same non-disclosing response as missing records.

## Errors

Application errors use stable codes and generic public messages. They must not include private package content, participant identity, notes, credentials, backend identifiers, or internal causes. HTML presents the same recovery links or forms supplied as JSON `links` and `actions`.

## Protocol Exceptions

OAuth 2.0 and OpenID Connect endpoints keep their standards-defined media types and response structures where wrapping them would break interoperability. Application resources around those protocol operations still follow this hypermedia contract.

## Route Definition of Done

Every new human-facing resource must include:

1. One canonical URI.
2. HTML and versioned JSON projections from the same authorized domain state.
3. Equivalent links, forms, and actions for the same caller.
4. Content-negotiation, authorization, negative-path, and non-disclosure tests.
5. `406` behavior for unsupported explicit contract versions.
6. Documentation for stable resource type, link relations, action names, and fields.
