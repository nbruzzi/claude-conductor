// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { join } from "node:path";

import { effectiveHome } from "./home";

type ComponentName =
  | "channels"
  | "identity"
  | "todos"
  | "handoffs"
  | "active-sessions"
  | "decision-logs"
  | "audits"
  | "memories";

type ComponentSpec = {
  readonly defaultSuffix: string;
  readonly envVar: string;
};

const COMPONENT_SPECS: { readonly [K in ComponentName]: ComponentSpec } = {
  channels: {
    defaultSuffix: "channels",
    envVar: "CLAUDE_CONDUCTOR_CHANNELS_DIR",
  },
  identity: {
    defaultSuffix: "identity",
    envVar: "CLAUDE_CONDUCTOR_IDENTITY_DIR",
  },
  todos: { defaultSuffix: "todos", envVar: "CLAUDE_CONDUCTOR_TODOS_DIR" },
  handoffs: {
    defaultSuffix: "handoffs",
    envVar: "CLAUDE_CONDUCTOR_HANDOFFS_DIR",
  },
  "active-sessions": {
    defaultSuffix: "active-sessions",
    envVar: "CLAUDE_CONDUCTOR_ACTIVE_SESSIONS_DIR",
  },
  // Plugin-internal artifacts (no dotfiles canonical) — keep conductor namespace
  // in the layer-3 fallback to avoid colliding with shared ~/.claude/ state.
  // Per Decision N (post-mortem on Decision J — namespace revert for v0.1.0).
  "decision-logs": {
    defaultSuffix: "conductor/decisions",
    envVar: "CLAUDE_CONDUCTOR_DECISION_LOGS_DIR",
  },
  audits: {
    defaultSuffix: "conductor/audits",
    envVar: "CLAUDE_CONDUCTOR_AUDITS_DIR",
  },
  memories: {
    defaultSuffix: "memories",
    envVar: "CLAUDE_CONDUCTOR_MEMORIES_DIR",
  },
};

const ROOT_ENV_VAR = "CLAUDE_CONDUCTOR_ROOT";
// Layer-3 fallback root — defaults to ~/.claude/ matching dotfiles canonical
// for the 6 components that have a dotfiles counterpart (channels, todos,
// identity, active-sessions, handoffs, memories). The 2 plugin-internal
// components (audits, decision-logs) embed `conductor/` in their defaultSuffix
// so they remain isolated even at this layer. Per Decision N.
const FALLBACK_ROOT_SUFFIX = ".claude";

function fallbackRoot(): string {
  return join(effectiveHome(), FALLBACK_ROOT_SUFFIX);
}

function resolveComponent(component: ComponentName): string {
  const spec = COMPONENT_SPECS[component];
  const componentEnv = process.env[spec.envVar];
  if (componentEnv && componentEnv.length > 0) {
    return componentEnv;
  }
  const rootEnv = process.env[ROOT_ENV_VAR];
  if (rootEnv && rootEnv.length > 0) {
    return join(rootEnv, spec.defaultSuffix);
  }
  return join(fallbackRoot(), spec.defaultSuffix);
}

export function channelsDir(): string {
  return resolveComponent("channels");
}

export function identityDir(): string {
  return resolveComponent("identity");
}

export function todosDir(): string {
  return resolveComponent("todos");
}

export function handoffsDir(): string {
  return resolveComponent("handoffs");
}

export function activeSessionsDir(): string {
  return resolveComponent("active-sessions");
}

export function decisionLogsDir(): string {
  return resolveComponent("decision-logs");
}

export function auditsDir(): string {
  return resolveComponent("audits");
}

export function memoriesDir(): string {
  return resolveComponent("memories");
}
