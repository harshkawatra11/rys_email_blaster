// Shared allowlist for the rich-text email template. Mirrored (by hand) in
// the DOMPurify config in public/index.html — keep the two in sync since the
// client pass is UX only; this server pass is the actual security boundary.
const sanitizeHtml = require("sanitize-html");

const TEMPLATE_SANITIZE_OPTIONS = {
  allowedTags: [
    "b", "strong", "i", "em", "u", "s",
    "p", "br", "div", "span",
    "ul", "ol", "li",
    "blockquote", "h1", "h2", "h3", "a",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    "*": ["style"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedStyles: {
    "*": {
      "font-weight": [/^.*$/],
      "font-style": [/^.*$/],
      "text-decoration": [/^.*$/],
      "text-decoration-line": [/^.*$/],
      color: [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/, /^[a-zA-Z]+$/],
      "text-align": [/^(left|right|center|justify)$/],
    },
  },
  disallowedTagsMode: "discard",
  exclusiveFilter: (frame) => ["script", "style", "iframe", "object", "embed", "form", "input", "link", "meta", "img", "table"].includes(frame.tag),
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
  },
};

function sanitizeTemplateHtml(html) {
  return sanitizeHtml(html || "", TEMPLATE_SANITIZE_OPTIONS);
}

module.exports = { sanitizeTemplateHtml, TEMPLATE_SANITIZE_OPTIONS };
