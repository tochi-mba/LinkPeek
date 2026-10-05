/** The REX Technologies ink/signal palette. Dark only; never re-picked per product. */
export const REX = {
  ink: "#080A09",
  panel: "#111512",
  raised: "#181E19",
  line: "#29302A",
  text: "#F2F5EE",
  muted: "#858D83",
  signal: "#D7FF3F",
  live: "#FF774D"
} as const;

/** Base styles for a Shadow DOM root so host-page CSS cannot leak in. */
export const rexCss = `
:host { all: initial; color-scheme: dark; font-family: Inter, "Segoe UI", system-ui, -apple-system, sans-serif; }
*, *::before, *::after { box-sizing: border-box; }
button, input, select { font: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid ${REX.signal}; outline-offset: 2px; }
`;
