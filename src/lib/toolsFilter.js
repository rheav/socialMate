// Pure (DOM-free, component-free) tool-registry selector — kept separate from
// tools.jsx so unit tests never pull the React component tree.

// Given any tool array + platform, the platform's non-global tools (order preserved).
export const filterToolsForPlatform = (tools, platform) =>
  tools.filter((t) => t.platforms !== "global" && t.platforms.includes(platform));

// The warmer is its own top-level tab (Aquecer), so the platform workspace
// (Pesquisa) must not list it as a sub-tool — while the registry keeps carrying it,
// because the Aquecer tab renders it and the platform picker still names it in the
// per-platform blurb.
export const WORKSPACE_EXCLUDED = ["warm"];
export const workspaceToolsForPlatform = (tools, platform) =>
  filterToolsForPlatform(tools, platform).filter((t) => !WORKSPACE_EXCLUDED.includes(t.id));
