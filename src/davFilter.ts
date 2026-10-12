import ICAL from "ical.js";

const list = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const invalid = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 403 }); };
function textMatches(value: string, query: any) {
  const collation = query?.["@_collation"] ?? "i;unicode-casemap";
  if (!["i;unicode-casemap", "i;ascii-casemap", "i;octet"].includes(collation)) invalid("Deze tekstvergelijking wordt niet ondersteund");
  const normalize = (s: string) => collation === "i;octet" ? s : collation === "i;ascii-casemap" ? s.replace(/[A-Z]/g, (c) => c.toLowerCase()) : s.toLowerCase().normalize("NFC");
  const needle = normalize(String(typeof query === "object" ? query["#text"] ?? "" : query));
  const haystack = normalize(value);
  const type = query?.["@_match-type"] ?? "contains";
  const matched = type === "equals" ? haystack === needle : type === "starts-with" ? haystack.startsWith(needle) : type === "ends-with" ? haystack.endsWith(needle) : type === "contains" ? haystack.includes(needle) : invalid("Deze zoekwijze wordt niet ondersteund");
  return query?.["@_negate-condition"] === "yes" ? !matched : matched;
}
function propertyMatches(values: string[], query: any) {
  if (Object.hasOwn(query, "param-filter")) invalid("Zoeken op afzonderlijke eigenschapparameters wordt niet ondersteund");
  if (Object.hasOwn(query, "is-not-defined")) return !values.length;
  if (!values.length) return false;
  const tests = list(query["text-match"]);
  if (!tests.length) return true;
  return query["@_test"] === "anyof" ? tests.some((test) => values.some((value) => textMatches(value, test))) : tests.every((test) => values.some((value) => textMatches(value, test)));
}
function propertiesMatch(filters: any[], values: (name: string) => string[], any: boolean) {
  if (!filters.length) return true;
  const check = (filter: any) => {
    const name = String(filter["@_name"] ?? "").toUpperCase();
    if (!/^[A-Z0-9-]{1,80}$/.test(name)) invalid("Ongeldige eigenschap in zoekverzoek");
    return propertyMatches(values(name), filter);
  };
  return any ? filters.some(check) : filters.every(check);
}
function componentMatches(component: ICAL.Component, filter: any): boolean {
  const name = String(filter["@_name"] ?? "").toLowerCase();
  if (component.name !== name) return false;
  const children = list(filter["comp-filter"]);
  return propertiesMatch(list(filter["prop-filter"]), (property) => component.getAllProperties(property.toLowerCase()).map((p) => String(p.getFirstValue() ?? "")), false)
    && children.every((child) => Object.hasOwn(child, "is-not-defined") ? !component.getAllSubcomponents(String(child["@_name"] ?? "").toLowerCase()).length : component.getAllSubcomponents().some((c) => componentMatches(c, child)));
}
/** Bounded query support; reject unsupported parameter filters instead of silently ignoring them. */
export function davFilterMatches(data: string, calendar: boolean, filter: any) {
  if (!filter || typeof filter !== "object") return true;
  if (calendar) {
    const root = new ICAL.Component(ICAL.parse(data));
    return list(filter["comp-filter"]).every((query) => componentMatches(root, query));
  }
  const lines = data.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  return propertiesMatch(list(filter["prop-filter"]), (name) => lines.flatMap((line) => {
    const matched = /^(?:[^:;.]+\.)?([^:;]+)(?:;[^:]*)?:(.*)$/.exec(line);
    return matched?.[1].toUpperCase() === name ? [matched[2].replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1")] : [];
  }), filter["@_test"] !== "allof");
}
