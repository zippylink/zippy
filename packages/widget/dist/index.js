// ../../libs/ui/src/tokens/index.ts
var colors = {
  light: {
    background: "#ffffff",
    foreground: "#0a0a0b",
    card: "#ffffff",
    cardForeground: "#0a0a0b",
    popover: "#ffffff",
    popoverForeground: "#0a0a0b",
    primary: "#6d5efc",
    primaryForeground: "#ffffff",
    secondary: "#f4f4f6",
    secondaryForeground: "#1a1a20",
    muted: "#f4f4f6",
    mutedForeground: "#6b6b76",
    accent: "#f0eefe",
    accentForeground: "#3a2fb8",
    destructive: "#e5484d",
    destructiveForeground: "#ffffff",
    border: "#e6e6ea",
    input: "#e6e6ea",
    ring: "#6d5efc"
  },
  dark: {
    background: "#0b0b0e",
    foreground: "#f4f4f6",
    card: "#141418",
    cardForeground: "#f4f4f6",
    popover: "#141418",
    popoverForeground: "#f4f4f6",
    primary: "#8b7dff",
    primaryForeground: "#0b0b0e",
    secondary: "#22222a",
    secondaryForeground: "#f4f4f6",
    muted: "#22222a",
    mutedForeground: "#a1a1ad",
    accent: "#2a2540",
    accentForeground: "#d7d1ff",
    destructive: "#ff6369",
    destructiveForeground: "#0b0b0e",
    border: "#26262e",
    input: "#2c2c35",
    ring: "#8b7dff"
  }
};

// src/config.ts
var DEFAULTS = {
  endpoint: "",
  label: "Feedback",
  color: colors.light.primary,
  position: "bottom-right"
};
function resolveConfig(options = {}) {
  return {
    endpoint: options.endpoint ?? DEFAULTS.endpoint,
    label: options.label ?? DEFAULTS.label,
    color: options.color ?? DEFAULTS.color,
    position: options.position ?? DEFAULTS.position
  };
}
function buildPayload(message, url, now = /* @__PURE__ */ new Date()) {
  return { message: message.trim(), url, at: now.toISOString() };
}

// src/widget.ts
var ROOT_ID = "stack-widget-root";
function mountFeedback(options = {}) {
  if (typeof document === "undefined") return;
  if (document.getElementById(ROOT_ID)) return;
  const cfg = resolveConfig(options);
  const side = cfg.position === "bottom-left" ? "left: 20px" : "right: 20px";
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.style.cssText = `position: fixed; bottom: 20px; ${side}; z-index: 2147483647; font-family: system-ui, sans-serif;`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = cfg.label;
  button.setAttribute("aria-label", `Open ${cfg.label} form`);
  button.style.cssText = `background: ${cfg.color}; color: #fff; border: 0; border-radius: 9999px; padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.2);`;
  const panel = document.createElement("form");
  panel.hidden = true;
  panel.style.cssText = `display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; padding: 12px; width: 260px; background: #fff; color: #111; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.25);`;
  const input = document.createElement("textarea");
  input.rows = 3;
  input.placeholder = "What's on your mind?";
  input.setAttribute("aria-label", "Your feedback");
  input.style.cssText = "resize: vertical; border: 1px solid #e6e6ea; border-radius: 8px; padding: 8px; font: inherit;";
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Send";
  send.style.cssText = `background: ${cfg.color}; color: #fff; border: 0; border-radius: 8px; padding: 8px; font-weight: 600; cursor: pointer;`;
  panel.append(input, send);
  root.append(panel, button);
  document.body.appendChild(root);
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) input.focus();
  });
  panel.addEventListener("submit", (e) => {
    e.preventDefault();
    const payload = buildPayload(input.value, location.href);
    if (!payload.message) return;
    if (cfg.endpoint) {
      void fetch(cfg.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => void 0);
    }
    input.value = "";
    panel.hidden = true;
  });
}
export {
  DEFAULTS,
  buildPayload,
  mountFeedback,
  resolveConfig
};
