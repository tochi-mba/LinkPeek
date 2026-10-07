const HTML_ESCAPES: Record<string, string> = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"};

/** Escapes text for use inside HTML element content or a quoted attribute. */
export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

/** The words a page shows for a link: its text, its title and label, and the descriptions of any pictures inside it. */
export function linkText(anchor: HTMLAnchorElement) {
  const pictures = [...anchor.querySelectorAll("img")].flatMap(image => [image.alt, image.title]);
  return [anchor.textContent ?? "", anchor.title, anchor.getAttribute("aria-label") ?? "", ...pictures].join(" ").replace(/\s+/g, " ").trim();
}

type PolicyLike = {allowsFeature(feature: string): boolean; features?(): string[]};

/**
 * Whether the page's permissions policy lets this document use a feature.
 * A site can switch features off with a Permissions-Policy header, and using
 * one anyway logs a violation even when the failure is caught, so ask first.
 * A feature the browser's policy does not know about is not restricted.
 */
export function policyAllows(feature: string, doc: Document = document) {
  const {permissionsPolicy, featurePolicy} = doc as Document & {permissionsPolicy?: PolicyLike; featurePolicy?: PolicyLike};
  const policy = permissionsPolicy ?? featurePolicy;
  if (!policy) return true;
  if (policy.features && !policy.features().includes(feature)) return true;
  return policy.allowsFeature(feature);
}
