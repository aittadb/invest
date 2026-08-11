const PROJECT_ID_PATTERN = /^appgprj_[A-Za-z0-9]+$/u;
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

export function parseActiveSitesHostingConfiguration(source) {
  const value = JSON.parse(source);
  assertUniqueTopLevelMembers(source);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "d1,project_id,r2" ||
    typeof value.project_id !== "string" ||
    !PROJECT_ID_PATTERN.test(value.project_id) ||
    !isBinding(value.d1) ||
    !isBinding(value.r2) ||
    value.d1 !== null && value.r2 !== null && value.d1 === value.r2
  ) {
    throw new Error("The active Sites hosting configuration is invalid");
  }
  return Object.freeze({
    project_id: value.project_id,
    d1: value.d1,
    r2: value.r2,
  });
}

function assertUniqueTopLevelMembers(source) {
  let index = skipWhitespace(source, 0);
  if (source[index] !== "{") return;
  index = skipWhitespace(source, index + 1);
  const seen = new Set();
  while (source[index] !== "}") {
    const token = readJsonString(source, index);
    const name = JSON.parse(source.slice(index, token.end));
    if (seen.has(name)) {
      throw new Error("The active Sites hosting configuration is invalid");
    }
    seen.add(name);
    index = skipWhitespace(source, token.end);
    if (source[index] !== ":") {
      throw new Error("The active Sites hosting configuration is invalid");
    }
    index = skipJsonValue(source, index + 1);
    if (source[index] === ",") {
      index = skipWhitespace(source, index + 1);
      continue;
    }
    if (source[index] !== "}") {
      throw new Error("The active Sites hosting configuration is invalid");
    }
  }
}

function readJsonString(source, start) {
  if (source[start] !== '"') {
    throw new Error("The active Sites hosting configuration is invalid");
  }
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === '"') {
      return Object.freeze({ end: index + 1 });
    }
  }
  throw new Error("The active Sites hosting configuration is invalid");
}

function skipJsonValue(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = skipWhitespace(source, start); index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      if (character === "}" && depth === 0) return index;
      depth -= 1;
    } else if (character === "," && depth === 0) {
      return index;
    }
  }
  throw new Error("The active Sites hosting configuration is invalid");
}

function skipWhitespace(source, start) {
  let index = start;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  return index;
}

function isBinding(value) {
  return value === null ||
    typeof value === "string" && BINDING_PATTERN.test(value);
}
