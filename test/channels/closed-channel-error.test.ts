// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nbruzzi

/**
 * `ChannelClosedError` discriminator-class regression.
 *
 * Plan v3 MAJOR-3 fold (b) — typed exception so callers can
 * `catch (err) { if (err instanceof ChannelClosedError) { ... } }`
 * rather than substring-matching `Error.message` for "is closed".
 *
 * Assertion axes:
 *   (a) `appendMessage` throws `ChannelClosedError` when the channel's
 *       `metadata.closed_at` is set.
 *   (b) The thrown error is `instanceof ChannelClosedError` AND
 *       `instanceof Error` (subclass property holds — existing generic
 *       `catch (err)` callers still catch unchanged, so the contract is
 *       backwards-compatible).
 *   (c) The error message includes the channel id + the `closed_at`
 *       timestamp (lets log-readers correlate the throw with the close
 *       event without parsing JSON metadata separately).
 *   (d) `api.ts` value re-export resolves to the *same* class identity
 *       as the direct `./index.ts` import — callers using the curated
 *       surface (`claude-conductor/channels/api`) can still discriminate
 *       via `instanceof` without a divergent class-object trap.
 *   (e) Legacy substring-match consumers (e.g. `index.test.ts`'s
 *       `rejects.toThrow(/closed/u)`) still pass — backwards-compat
 *       regression guard.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMessage,
  ChannelClosedError,
  closeChannel,
  createChannel,
  type ChannelMessage,
} from "../../src/channels/index.ts";
import * as api from "../../src/channels/api.ts";

const SESSION = "sess-cce-test";

let tmpRoot: string;
let prevChannelsDir: string | undefined;
let prevSessionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "channels-cce-test-"));
  prevChannelsDir = process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  prevSessionId = process.env["CLAUDE_SESSION_ID"];
  process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = tmpRoot;
});

afterEach(() => {
  if (prevChannelsDir !== undefined) {
    process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"] = prevChannelsDir;
  } else {
    delete process.env["CLAUDE_CONDUCTOR_CHANNELS_DIR"];
  }
  if (prevSessionId !== undefined) {
    process.env["CLAUDE_SESSION_ID"] = prevSessionId;
  } else {
    delete process.env["CLAUDE_SESSION_ID"];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    ts: new Date().toISOString(),
    from: SESSION,
    kind: "note",
    body: "hello",
    ...overrides,
  };
}

async function setupClosedChannel(channelId: string): Promise<string> {
  await createChannel({ channelId, handoffId: channelId, sessionId: SESSION });
  const closed = await closeChannel({ channelId, sessionId: SESSION });
  if (closed.closed_at === undefined) {
    throw new Error(
      `test setup: closeChannel should have set closed_at on '${channelId}'`,
    );
  }
  return closed.closed_at;
}

describe("ChannelClosedError", () => {
  it("appendMessage throws ChannelClosedError when channel is closed (axis a)", async () => {
    await setupClosedChannel("c-cce-a");
    let thrown: unknown;
    try {
      await appendMessage({ channelId: "c-cce-a", message: msg() });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ChannelClosedError);
  });

  it("thrown error is also instanceof Error — backwards-compatible catch (axis b)", async () => {
    await setupClosedChannel("c-cce-b");
    let thrown: unknown;
    try {
      await appendMessage({ channelId: "c-cce-b", message: msg() });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBeInstanceOf(ChannelClosedError);
    // `.name` field is set so structured logs surface the discriminator
    // even when stack traces are stripped.
    expect((thrown as ChannelClosedError).name).toBe("ChannelClosedError");
  });

  it("error message includes channel id + closed_at timestamp (axis c)", async () => {
    const closedAt = await setupClosedChannel("c-cce-c");
    let thrown: unknown;
    try {
      await appendMessage({ channelId: "c-cce-c", message: msg() });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ChannelClosedError);
    const errMessage = (thrown as ChannelClosedError).message;
    expect(errMessage).toContain("c-cce-c");
    expect(errMessage).toContain("is closed");
    expect(errMessage).toContain(closedAt);
  });

  it("api.ts re-export resolves to the same class identity (axis d)", async () => {
    // Reference-equality on the class object: throws thrown through
    // `appendMessage` (via either surface) must be `instanceof` both
    // import paths' `ChannelClosedError`.
    expect(api.ChannelClosedError).toBe(ChannelClosedError);

    await setupClosedChannel("c-cce-d");
    let thrown: unknown;
    try {
      await api.appendMessage({ channelId: "c-cce-d", message: msg() });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(api.ChannelClosedError);
    expect(thrown).toBeInstanceOf(ChannelClosedError);
  });

  it("legacy substring-match consumers still pass — backwards-compat (axis e)", async () => {
    // Regression guard: the existing test at
    // `test/channels/index.test.ts` asserts `rejects.toThrow(/closed/u)`.
    // The new typed throw must keep that working — `Error.message`
    // continues to contain "closed" so pre-typed-error consumers
    // discover no behavior change.
    await setupClosedChannel("c-cce-legacy");
    expect(
      appendMessage({ channelId: "c-cce-legacy", message: msg() }),
    ).rejects.toThrow(/closed/u);
  });

  it("error message includes operator-actionable recovery hint (axis f, ALPHA-MINOR-1 fold)", async () => {
    // Sibling-pattern with `NatoExhaustedError` which includes a "Recovery:"
    // hint citing the operator-facing CLI verb. ChannelClosedError gains the
    // same shape so operators hitting the throw know the next-step recovery
    // path without consulting the runbook. Verify both verb hints land in
    // the message text.
    await setupClosedChannel("c-cce-f");
    let thrown: unknown;
    try {
      await appendMessage({ channelId: "c-cce-f", message: msg() });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ChannelClosedError);
    const errMessage = (thrown as ChannelClosedError).message;
    expect(errMessage).toContain("Recovery:");
    expect(errMessage).toContain("channels create");
    expect(errMessage).toContain("channels list");
    // Axis-e backwards-compat preserved by the recovery-hint addition —
    // "closed" substring still present (validates the additive composition).
    expect(errMessage).toContain("closed");
  });
});
