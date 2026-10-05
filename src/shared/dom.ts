const HTML_ESCAPES: Record<string, string> = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"};

/** Escapes text for use inside HTML element content or a quoted attribute. */
export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}
