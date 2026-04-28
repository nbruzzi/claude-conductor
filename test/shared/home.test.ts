// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";

import { effectiveHome } from "../../src/shared/home";

describe("effectiveHome", () => {
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env["HOME"];
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
  });

  it("returns homedir() when HOME is unset", () => {
    delete process.env["HOME"];
    expect(effectiveHome()).toBe(homedir());
  });

  it("returns homedir() when HOME is empty string", () => {
    process.env["HOME"] = "";
    expect(effectiveHome()).toBe(homedir());
  });

  it("returns the set value when HOME is a non-empty path", () => {
    process.env["HOME"] = "/tmp/test-home";
    expect(effectiveHome()).toBe("/tmp/test-home");
  });

  it("preserves trailing slash when HOME ends in /", () => {
    process.env["HOME"] = "/tmp/test-home/";
    expect(effectiveHome()).toBe("/tmp/test-home/");
  });

  it("returns / when HOME is /", () => {
    process.env["HOME"] = "/";
    expect(effectiveHome()).toBe("/");
  });
});
