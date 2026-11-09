/**
 * Credential-free, deterministic stand-in for the DSH SDK JSON-RPC profile.
 * Exercises the real published @deepseek-ai/dsh-sdk-client transport.
 * No model API, files, commands or network calls are performed here.
 */
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let ordinal = 0;
let serverRequestId = 1000;
const awaiting = new Map();
const response = (id, result) => send({ jsonrpc: "2.0", id, result });
const error = (id, message) => send({
  jsonrpc: "2.0", id, error: { code: -32000, message },
});
function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function event(sessionId, type, data) {
  notify("session.event", {
    sessionId, event: { seq: ++ordinal, type, data, time: Date.now() },
  });
}
function sendRequest(method, params) {
  return new Promise((resolve) => {
    const id = ++serverRequestId;
    awaiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function terminal(sessionId, reason, text) {
  event(sessionId, "assistant/message", {
    turn: 1, step: 1,
    message: { id: "fake-assistant", content: [{ type: "text", text }] },
    stream: [],
  });
  event(sessionId, "turn/end", { turn: 1, reason: { kind: reason } });
  notify("session.status", { sessionId, status: "idle" });
}
async function execute(sessionId, messageId, prompt) {
  event(sessionId, "agent/inbox/spliced", {
    inserted: [{ id: messageId, content: [{ type: "text", text: prompt }] }],
  });
  event(sessionId, "turn/start", { turn: 1 });

  if (prompt === "crash") {
    process.exit(23);
  }
  if (prompt === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 450));
    terminal(sessionId, "completed", "slow-finished");
    return;
  }
  if (prompt === "approve") {
    const decision = await sendRequest("approval/request", {
      sessionId, toolName: "fake-read-only", callId: "fake-call-1",
      reason: "Credential-free test tool approval",
    });
    const outcome = decision?.outcome ?? "rejected";
    event(sessionId, "tool/call", {
      turn: 1, step: 1, callId: "fake-call-1", name: "fake-read-only",
      arguments: "{\"path\":\"virtual\"}",
    });
    event(sessionId, "tool/result", {
      turn: 1, step: 1,
      message: { toolCallId: "fake-call-1",
        content: [{ type: "text", text: outcome }], isError: outcome !== "allowed-once" },
    });
    terminal(sessionId, "completed", "permission-" + outcome);
    return;
  }
  if (prompt === "question") {
    const answer = await sendRequest("user-question/ask", {
      sessionId, requestId: "fake-question-1",
      questions: [{
        id: "q1", header: "Confirm", question: "Proceed with simulated operation?",
        options: [{ label: "Yes" }, { label: "No" }],
      }],
    });
    terminal(sessionId, "completed", "question-" +
      (answer?.cancelled ? "cancelled" : answer?.answers?.[0]?.selected?.[0] ?? "no-answer"));
    return;
  }
  if (prompt === "non-success") {
    terminal(sessionId, "max-tokens", "partial-output");
    return;
  }
  terminal(sessionId, "completed", "echo:" + prompt);
}

lines.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === undefined) {
    const handler = awaiting.get(request.id);
    if (handler !== undefined) {
      awaiting.delete(request.id);
      handler(request.result ?? { cancelled: true });
    }
    return;
  }
  const { id, method, params = {} } = request;
  if (method === "initialize") {
    if (!params.cwd || !params.provider || !params.model || params.approvalRequests !== true) {
      error(id, "Missing SDK initialization configuration");
      return;
    }
    response(id, { serverInfo: { name: "fake-dsh-sdk-runtime", version: "0.0.0-test" } });
    return;
  }
  if (method === "session/query") {
    const messageId = "test-message-" + (++ordinal);
    response(id, { kind: "prompt", messageId });
    setImmediate(() => void execute(
      params.sessionId, messageId,
      params.contentBlocks?.filter((x) => x.type === "text").map((x) => x.text).join("") ?? "",
    ));
    return;
  }
  if (method === "session/resume") {
    if (params.sessionId === "missing") error(id, "Session does not exist");
    else response(id, {});
    return;
  }
  if (method === "shutdown") {
    // Flush the JSON-RPC acknowledgement before ending the fake child.
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n",
      () => process.exit(0));
    return;
  }
  error(id, "Unsupported method: " + method);
});
lines.on("close", () => { process.exitCode = 0; });
