/**
 * Minimal parser/serializer for the XML dialect FreeCAD writes to `user.cfg`.
 *
 * The subset is deliberately small: an optional declaration, comments,
 * elements with double- or single-quoted attributes, self-closing tags and
 * text nodes. This avoids a native or heavyweight XML dependency while still
 * round-tripping real FreeCAD configuration files.
 */

export interface XmlElement {
  type: "element";
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  type: "text";
  value: string;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlDocument {
  declaration: string | null;
  root: XmlElement;
}

const NAME_START = /[A-Za-z_:]/;

function parseAttributes(source: string): { attributes: Record<string, string>; rest: string } {
  const attributes: Record<string, string> = {};
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    if (i >= source.length) break;
    if (source[i] === "/" || source[i] === ">") break;
    let name = "";
    while (i < source.length && !/[\s=/>]/.test(source[i]!)) {
      name += source[i];
      i += 1;
    }
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    let value = "";
    if (source[i] === "=") {
      i += 1;
      while (i < source.length && /\s/.test(source[i]!)) i += 1;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === "&") {
            const semi = source.indexOf(";", i);
            const entity = semi >= 0 ? source.slice(i, semi + 1) : "";
            value += decodeEntity(entity);
            i += entity.length || 1;
          } else {
            value += source[i];
            i += 1;
          }
        }
        i += 1;
      }
    }
    if (name) attributes[name] = value;
  }
  return { attributes, rest: source.slice(i) };
}

function decodeEntity(entity: string): string {
  switch (entity) {
    case "&lt;":
      return "<";
    case "&gt;":
      return ">";
    case "&amp;":
      return "&";
    case "&quot;":
      return '"';
    case "&apos;":
      return "'";
    default:
      return entity;
  }
}

function encodeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function encodeAttribute(value: string): string {
  return encodeText(value).replace(/"/g, "&quot;");
}

export function parseXml(source: string): XmlDocument {
  const declarationMatch = /^\s*<\?xml[^?]*\?>/.exec(source);
  const declaration = declarationMatch ? declarationMatch[0].trim() : null;
  let i = declarationMatch ? declarationMatch[0].length : 0;
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;
    if (stack.length > 0 && lt > i) {
      const text = source.slice(i, lt);
      if (text.trim()) stack[stack.length - 1]!.children.push({ type: "text", value: text });
    }
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("</", lt)) {
      const end = source.indexOf(">", lt);
      i = end < 0 ? source.length : end + 1;
      stack.pop();
      continue;
    }
    const end = source.indexOf(">", lt);
    if (end < 0) break;
    const inner = source.slice(lt + 1, end);
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    let nameEnd = 0;
    while (nameEnd < body.length && !/[\s/>]/.test(body[nameEnd]!)) nameEnd += 1;
    const name = body.slice(0, nameEnd);
    if (!name || !NAME_START.test(name[0]!)) {
      i = end + 1;
      continue;
    }
    const { attributes } = parseAttributes(body.slice(nameEnd));
    const element: XmlElement = { type: "element", name, attributes, children: [] };
    if (stack.length === 0) {
      root = element;
    } else {
      stack[stack.length - 1]!.children.push(element);
    }
    if (!selfClosing) stack.push(element);
    i = end + 1;
  }

  if (!root) throw new Error("XML document has no root element");
  return { declaration, root };
}

function serializeElement(element: XmlElement, indent: number): string {
  const pad = "  ".repeat(indent);
  const attrs = Object.entries(element.attributes)
    .map(([key, value]) => ` ${key}="${encodeAttribute(value)}"`)
    .join("");
  if (element.children.length === 0) return `${pad}<${element.name}${attrs}/>`;
  const onlyText = element.children.every((child) => child.type === "text");
  if (onlyText) {
    const text = element.children.map((child) => (child as XmlText).value).join("");
    if (!text.includes("\n")) {
      return `${pad}<${element.name}${attrs}>${encodeText(text.trim())}</${element.name}>`;
    }
  }
  const inner = element.children
    .map((child) =>
      child.type === "text"
        ? `${"  ".repeat(indent + 1)}${encodeText(child.value.trim())}`
        : serializeElement(child, indent + 1),
    )
    .filter((line) => line.trim() !== "")
    .join("\n");
  return `${pad}<${element.name}${attrs}>\n${inner}\n${pad}</${element.name}>`;
}

export function serializeXml(document: XmlDocument): string {
  const head = document.declaration ?? '<?xml version="1.0" encoding="UTF-8"?>';
  return `${head}\n${serializeElement(document.root, 0)}\n`;
}

export function findChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find(
    (child): child is XmlElement => child.type === "element" && child.name === name,
  );
}

export function findGroup(element: XmlElement, groupName: string): XmlElement | undefined {
  return element.children.find(
    (child): child is XmlElement =>
      child.type === "element" &&
      child.name === "FCParamGroup" &&
      child.attributes.Name === groupName,
  );
}

export function ensureGroup(parent: XmlElement, groupName: string): XmlElement {
  const existing = findGroup(parent, groupName);
  if (existing) return existing;
  const group: XmlElement = {
    type: "element",
    name: "FCParamGroup",
    attributes: { Name: groupName },
    children: [],
  };
  parent.children.push(group);
  return group;
}

/**
 * Ensure `BaseApp/Preferences/Mod/Start/ShowOnStartup = 0` in a FreeCAD
 * `user.cfg` document, creating the group chain when missing.
 */
export function disableStartPageInConfig(source: string): string {
  const document = parseXml(source);
  let group: XmlElement = ensureGroup(document.root, "BaseApp");
  group = ensureGroup(group, "Preferences");
  group = ensureGroup(group, "Mod");
  group = ensureGroup(group, "Start");
  const existing = findChild(group, "FCBool");
  const target =
    group.children.find(
      (child): child is XmlElement =>
        child.type === "element" &&
        child.name === "FCBool" &&
        child.attributes.Name === "ShowOnStartup",
    ) ?? existing;
  if (target) {
    target.attributes.Value = "0";
  } else {
    group.children.push({
      type: "element",
      name: "FCBool",
      attributes: { Name: "ShowOnStartup", Value: "0" },
      children: [],
    });
  }
  return serializeXml(document);
}
