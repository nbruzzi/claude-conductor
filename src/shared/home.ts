// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { homedir } from "node:os";

/**
 * Resolve the home directory honoring $HOME first, then os.homedir(). Tests
 * mutate $HOME for isolation; os.homedir() is cached at process start and
 * does NOT pick up later mutations on macOS/Linux. Single source of truth
 * for HOME resolution across plugin code (paths.ts + the *-store hook checks).
 */
export function effectiveHome(): string {
  const env = process.env["HOME"];
  if (env !== undefined && env.length > 0) return env;
  return homedir();
}
