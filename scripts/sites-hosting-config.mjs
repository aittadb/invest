const PROJECT_ID_PATTERN = /^appgprj_[A-Za-z0-9]+$/u;
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

export function parseActiveSitesHostingConfiguration(source) {
  const value = JSON.parse(source);
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

function isBinding(value) {
  return value === null ||
    typeof value === "string" && BINDING_PATTERN.test(value);
}
