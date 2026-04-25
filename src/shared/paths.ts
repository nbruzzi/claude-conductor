// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { homedir } from "node:os";
import { join } from "node:path";

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
  "decision-logs": {
    defaultSuffix: "decisions",
    envVar: "CLAUDE_CONDUCTOR_DECISION_LOGS_DIR",
  },
  audits: { defaultSuffix: "audits", envVar: "CLAUDE_CONDUCTOR_AUDITS_DIR" },
  memories: {
    defaultSuffix: "memories",
    envVar: "CLAUDE_CONDUCTOR_MEMORIES_DIR",
  },
};

const ROOT_ENV_VAR = "CLAUDE_CONDUCTOR_ROOT";
const FALLBACK_ROOT_SUFFIX = join(".claude", "conductor");

function fallbackRoot(): string {
  return join(homedir(), FALLBACK_ROOT_SUFFIX);
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
