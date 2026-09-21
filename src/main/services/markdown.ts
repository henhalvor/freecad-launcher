/**
 * Small, deliberately strict Markdown renderer for GitHub content.
 *
 * Raw HTML from the API is never passed through: the input is escaped and this
 * renderer only ever emits a fixed set of safe tags. Links are restricted to
 * HTTPS and images are rewritten to the local `freecad-media://` protocol.
 */

export const MEDIA_SCHEME = "freecad-media";

const SAFE_LINK = /^https:\/\//i;

export interface MarkdownOptions {
  /** Rewrite an https image URL into a local protocol URL. */
  rewriteImage?: (url: string) => string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return SAFE_LINK.test(trimmed) ? trimmed : null;
}

function inline(raw: string, options: MarkdownOptions): string {
  let text = escapeHtml(raw);

  // Images: ![alt](url)
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_match, alt: string, url: string) => {
      const href = safeHref(url);
      if (!href) return alt;
      const src = options.rewriteImage ? options.rewriteImage(href) : href;
      return `<img src="${src}" alt="${alt}" loading="lazy" />`;
    },
  );

  // Links: [label](url)
  text = text.replace(
    /\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_match, label: string, url: string) => {
      const href = safeHref(url);
      if (!href) return label;
      return `<a href="${href}" rel="noreferrer noopener" target="_blank">${label}</a>`;
    },
  );

  // Inline code: `code`
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`);

  // Bold then italic.
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  return text;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** Render Markdown to a sanitized HTML fragment. */
export function renderMarkdown(markdown: string, options: MarkdownOptions = {}): string {
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map((line) => inline(line, options)).join("<br />")}</p>`);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        code.push(lines[i]!);
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      i += 1;
      continue;
    }

    if (/^\s{0,3}(#{1,6})\s+/.test(line)) {
      flushParagraph();
      const match = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)!;
      const level = match[1]!.length;
      out.push(`<h${level}>${inline(match[2]!.trim(), options)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      out.push("<hr />");
      i += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"), options)}</blockquote>`);
      continue;
    }

    const listMatch = /^\s{0,3}([-*+]|\d+[.)])\s+/.exec(line);
    if (listMatch) {
      flushParagraph();
      const ordered = /\d/.test(listMatch[1]!);
      const items: string[] = [];
      let current = "";
      while (i < lines.length) {
        const itemLine = lines[i]!;
        const itemMatch = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/.exec(itemLine);
        if (itemMatch) {
          if (current) items.push(current);
          current = itemMatch[2]!;
          i += 1;
          continue;
        }
        if (isBlank(itemLine) || itemLine.trimStart().startsWith("```")) break;
        if (/^\s{0,3}(#{1,6})\s+/.test(itemLine)) break;
        current += ` ${itemLine.trim()}`;
        i += 1;
      }
      if (current) items.push(current);
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}>${items.map((item) => `<li>${inline(item, options)}</li>`).join("")}</${tag}>`,
      );
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return out.join("\n");
}

/** Decode a `freecad-media://` URL back to the original https URL. */
export function decodeMediaUrl(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return SAFE_LINK.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function encodeMediaUrl(url: string): string {
  // The payload lives in the path, not the host: URL hosts are lower-cased and
  // would corrupt the case-sensitive base64url data.
  return `${MEDIA_SCHEME}://media/${Buffer.from(url, "utf8").toString("base64url")}`;
}
