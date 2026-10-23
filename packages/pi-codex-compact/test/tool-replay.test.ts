import assert from "node:assert/strict";
import { test } from "vitest";
import { expandRemoteCompactionPayload, rewriteCheckpointMarker } from "../src/protocol.js";

const marker = "checkpoint-marker";
const markerItem = { role: "user", content: [{ type: "input_text", text: marker }] };
const checkpoint = { type: "compaction", encrypted_content: "opaque-tools-fixture" };
const retained = { role: "user", content: [{ type: "input_text", text: "retained history" }] };
const reasoning = { type: "reasoning", id: "rs_tools", summary: [], encrypted_content: "signed-reasoning" };
const handoff = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Next: inspect pending changes." }],
};
const removal = {
  role: "developer",
  content: "The following tools are no longer available. Do not call them:\n- bash",
};
const incremental = {
  role: "developer",
  content:
    "This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.",
};
const declarations = {
  type: "additional_tools",
  role: "developer",
  tools: [
    {
      type: "function",
      name: "bash",
      description: "Execute a command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      strict: false,
    },
    { type: "custom", name: "edit", format: { type: "grammar", syntax: "lark", definition: 'start: "edit"' } },
  ],
};

for (const [protocol, history] of [
  ["remote-v2", [retained, checkpoint]],
  ["responses-compact", [retained, checkpoint]],
  ["context-management", [checkpoint, reasoning, handoff]],
] as const) {
  test.each(["auto", "none"])(
    `${protocol} restores inline tools after the checkpoint with tool_choice=%s`,
    (choice) => {
      const instructions = { role: "developer", content: "Stable system instructions" };
      const redefinition = {
        ...declarations,
        tools: [{ ...declarations.tools[0], description: "Updated command tool" }],
      };
      const laterTools = { ...declarations, tools: [{ type: "function", name: "read", parameters: {} }] };
      const removal = {
        role: "developer",
        content: "The following tools are no longer available. Do not call them:\n- edit",
      };
      const suffix = [retained, laterTools, removal];
      const payload = {
        model: "fixture",
        tools: [{ type: "web_search", external_web_access: true }],
        tool_choice: choice,
        input: [declarations, instructions, redefinition, markerItem, ...suffix],
      };
      const original = structuredClone({ payload, history });
      const rewritten = rewriteCheckpointMarker(payload, marker, history);
      const index = history.indexOf(checkpoint);
      assert.deepEqual(rewritten, {
        ...payload,
        input: [
          ...history.slice(0, index + 1),
          declarations,
          instructions,
          redefinition,
          ...history.slice(index + 1),
          ...suffix,
        ],
      });
      assert.deepEqual({ payload, history }, original, "caller payload and persisted checkpoint stay unchanged");
      assert.deepEqual(rewriteCheckpointMarker(payload, marker, history), rewritten, "replay is deterministic");

      const nextTurn = { role: "user", content: [{ type: "input_text", text: "Continue" }] };
      const next = rewriteCheckpointMarker({ ...payload, input: [...payload.input, nextTurn] }, marker, history);
      assert.deepEqual(
        next.input,
        [...(rewritten.input as unknown[]), nextTurn],
        "ordinary turns retain the exact prefix",
      );
    },
  );

  const redeclaration = { ...declarations, tools: [declarations.tools[0]] };
  for (const [label, updates] of [
    ["removal", [removal]],
    ["combined prompt and removal", [{ role: "system", content: `Updated instructions\n\n${removal.content}` }]],
    ["removal then redeclaration", [removal, incremental, redeclaration]],
    ["redeclaration then removal", [incremental, redeclaration, removal]],
  ] as const) {
    test(`${protocol} keeps pre-marker ${label} ordered with its tool declarations`, () => {
      const initial = { role: "developer", content: "Instructions before the first tool declaration" };
      const payload = { input: [initial, declarations, ...updates, markerItem, retained] };
      const original = structuredClone(payload);
      const index = history.indexOf(checkpoint);
      const expected = [
        initial,
        ...history.slice(0, index + 1),
        declarations,
        ...updates,
        ...history.slice(index + 1),
        retained,
      ];
      assert.deepEqual(rewriteCheckpointMarker(payload, marker, history).input, expected);
      assert.deepEqual(payload, original);
      const later = { role: "user", content: [{ type: "input_text", text: "Next turn" }] };
      assert.deepEqual(rewriteCheckpointMarker({ input: [...payload.input, later] }, marker, history).input, [
        ...expected,
        later,
      ]);
    });
  }
}

test("already post-checkpoint declarations stay anchored and top-level tools remain untouched", () => {
  const payload = {
    tools: [{ type: "function", name: "bash", parameters: {} }],
    input: [markerItem, retained, declarations],
  };
  assert.deepEqual(rewriteCheckpointMarker(payload, marker, [checkpoint]), {
    ...payload,
    input: [checkpoint, retained, declarations],
  });
});

test("requests without a checkpoint do not move inline tool declarations", () => {
  const payload = { input: [declarations, markerItem, retained] };
  assert.deepEqual(expandRemoteCompactionPayload(payload), payload);
  assert.deepEqual(rewriteCheckpointMarker(payload, marker, [retained]), {
    input: [declarations, retained, retained],
  });
});
