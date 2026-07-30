#!/usr/bin/env node
/**
 * Narrow LAN broker for the touchscreen's inline voice experience.
 *
 * The browser receives only the short-lived provider session returned by
 * talk.client.create. OpenClaw's gateway credential and persistent connection
 * remain on this Mac, which is also important because Talk tool calls are
 * owned by the connection that created them.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { loadConfig } from "../../openclaw/src/config/io.ts";
import { GatewayClient } from "../../openclaw/src/gateway/client.ts";
import { resolveGatewayClientBootstrap } from "../../openclaw/src/gateway/client-bootstrap.ts";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "../../openclaw/src/gateway/method-scopes.ts";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../openclaw/packages/gateway-protocol/src/client-info.ts";

const HOST = process.env.VOICE_BROKER_HOST?.trim() || "0.0.0.0";
const PORT = Number.parseInt(process.env.VOICE_BROKER_PORT || "18890", 10);
const ALLOWED_IPS = new Set(
  (process.env.VOICE_BROKER_ALLOWED_IPS || "127.0.0.1,::1,192.168.86.232")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const SESSION_KEY = "main";
const BODY_LIMIT = 128 * 1024;
const TOOL_TIMEOUT_MS = 120_000;
const HOME_ASSISTANT_KEYCHAIN_SERVICE = "pi-touchscreen-home-assistant-token";
const HOME_ASSISTANT_KEYCHAIN_ACCOUNT =
  process.env.HA_KEYCHAIN_ACCOUNT || "dan";

function loadHomeAssistantToken(): string {
  if (process.env.HA_TOKEN) return process.env.HA_TOKEN;
  try {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        HOME_ASSISTANT_KEYCHAIN_ACCOUNT,
        "-s",
        HOME_ASSISTANT_KEYCHAIN_SERVICE,
        "-w",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}

const HOME_ASSISTANT_URL = (
  process.env.HA_URL || "http://homeassistant.local:8123"
).replace(/\/+$/, "");
const HOME_ASSISTANT_TOKEN = loadHomeAssistantToken();
const SHOPPING_ENTITY_ID =
  process.env.SHOPPING_LIST_ENTITY || "todo.shopping_list";
const HOME_ASSISTANT_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;
type ShoppingItem = {
  id: string;
  text: string;
  completed: boolean;
};
type ShoppingSnapshot = {
  items: ShoppingItem[];
  activeCount: number;
  completedCount: number;
  syncedAt: string;
  source: string;
  outcome?: "added" | "duplicate" | "restored" | "updated" | "removed" | "cleared";
};
type RunWaiter = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let gatewayReady = false;
let gateway: GatewayClient | null = null;
const connectionWaiters = new Set<{
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
const runWaiters = new Map<string, RunWaiter>();
const completedRuns = new Map<string, { text?: string; error?: string; at: number }>();

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(?:token|secret|password|api[_-]?key)=\S+/gi,
      "[redacted credential]",
    );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function cleanItemText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
}

function normalizeItemText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");
}

async function homeAssistantJson(
  path: string,
  body?: JsonRecord,
): Promise<unknown> {
  if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
    throw new Error("Home Assistant shopping list is not configured");
  }
  const response = await fetch(`${HOME_ASSISTANT_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HOME_ASSISTANT_TIMEOUT_MS),
  });
  const text = await response.text();
  let result: unknown = {};
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      result = { detail: text.slice(0, 240) };
    }
  }
  if (!response.ok) {
    const detail = asRecord(result).message || asRecord(result).detail;
    throw new Error(
      `Home Assistant request failed (${response.status})${
        typeof detail === "string" && detail ? `: ${detail}` : ""
      }`,
    );
  }
  return result;
}

async function getShoppingSnapshot(): Promise<ShoppingSnapshot> {
  const result = asRecord(
    await homeAssistantJson("/api/services/todo/get_items?return_response", {
      entity_id: SHOPPING_ENTITY_ID,
    }),
  );
  const serviceResponse = asRecord(result.service_response);
  const entityResponse = asRecord(serviceResponse[SHOPPING_ENTITY_ID]);
  const rawItems = Array.isArray(entityResponse.items) ? entityResponse.items : [];
  const items = rawItems.flatMap((entry): ShoppingItem[] => {
    const item = asRecord(entry);
    const id = typeof item.uid === "string" ? item.uid : "";
    const text = cleanItemText(item.summary);
    if (!id || !text) return [];
    return [
      {
        id,
        text,
        completed: item.status === "completed",
      },
    ];
  });
  return {
    items,
    activeCount: items.filter((item) => !item.completed).length,
    completedCount: items.filter((item) => item.completed).length,
    syncedAt: new Date().toISOString(),
    source: SHOPPING_ENTITY_ID,
  };
}

async function callTodoService(
  service: "add_item" | "update_item" | "remove_item" | "remove_completed_items",
  data: JsonRecord,
): Promise<void> {
  await homeAssistantJson(`/api/services/todo/${service}`, {
    entity_id: SHOPPING_ENTITY_ID,
    ...data,
  });
}

async function addShoppingItem(value: unknown): Promise<ShoppingSnapshot> {
  const text = cleanItemText(value);
  if (!text) throw new Error("Item text is required");
  const before = await getShoppingSnapshot();
  const matching = before.items.find(
    (item) => normalizeItemText(item.text) === normalizeItemText(text),
  );
  if (matching && !matching.completed) {
    return { ...before, outcome: "duplicate" };
  }
  if (matching?.completed) {
    await callTodoService("update_item", {
      item: matching.id,
      status: "needs_action",
    });
    return { ...(await getShoppingSnapshot()), outcome: "restored" };
  }
  await callTodoService("add_item", { item: text });
  return { ...(await getShoppingSnapshot()), outcome: "added" };
}

async function updateShoppingItem(
  id: string,
  body: JsonRecord,
): Promise<ShoppingSnapshot> {
  const update: JsonRecord = { item: id };
  if (typeof body.completed === "boolean") {
    update.status = body.completed ? "completed" : "needs_action";
  }
  if (body.text !== undefined) {
    const text = cleanItemText(body.text);
    if (!text) throw new Error("Item text is required");
    update.rename = text;
  }
  if (Object.keys(update).length === 1) {
    throw new Error("No shopping-list changes were supplied");
  }
  await callTodoService("update_item", update);
  return { ...(await getShoppingSnapshot()), outcome: "updated" };
}

async function removeShoppingItem(id: string): Promise<ShoppingSnapshot> {
  await callTodoService("remove_item", { item: id });
  return { ...(await getShoppingSnapshot()), outcome: "removed" };
}

async function clearCompletedShoppingItems(): Promise<ShoppingSnapshot> {
  await callTodoService("remove_completed_items", {});
  return { ...(await getShoppingSnapshot()), outcome: "cleared" };
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const record = message as JsonRecord;
  if (typeof record.text === "string") return record.text.trim();
  if (!Array.isArray(record.content)) return "";
  return record.content
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
      const block = entry as JsonRecord;
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function settleRun(runId: string, result: { text?: string; error?: string }): void {
  const waiter = runWaiters.get(runId);
  if (waiter) {
    clearTimeout(waiter.timer);
    runWaiters.delete(runId);
    if (result.error) waiter.reject(new Error(result.error));
    else waiter.resolve(result.text || "OpenClaw finished with no text.");
    return;
  }
  completedRuns.set(runId, { ...result, at: Date.now() });
  for (const [id, cached] of completedRuns) {
    if (Date.now() - cached.at > 30_000) completedRuns.delete(id);
  }
}

function handleGatewayEvent(event: unknown): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const frame = event as JsonRecord;
  if (frame.event !== "chat" || !frame.payload || typeof frame.payload !== "object") return;
  const payload = frame.payload as JsonRecord;
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  if (!runId) return;
  if (payload.state === "final") {
    settleRun(runId, { text: extractMessageText(payload.message) });
  } else if (payload.state === "aborted") {
    settleRun(runId, {
      error:
        typeof payload.errorMessage === "string"
          ? payload.errorMessage
          : "OpenClaw tool call was cancelled",
    });
  } else if (payload.state === "error") {
    settleRun(runId, {
      error:
        typeof payload.errorMessage === "string"
          ? payload.errorMessage
          : "OpenClaw tool call failed",
    });
  }
}

async function connectGateway(): Promise<void> {
  const config = loadConfig({ skipPluginValidation: true, pin: false });
  const bootstrap = await resolveGatewayClientBootstrap({ config });
  gateway = new GatewayClient({
    url: bootstrap.url,
    origin: "http://127.0.0.1:18789",
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    instanceId: randomUUID(),
    clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
    clientDisplayName: "Pi touchscreen voice broker",
    clientVersion: "1.0.0",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    role: "operator",
    scopes: [...CLI_DEFAULT_OPERATOR_SCOPES],
    onEvent: handleGatewayEvent,
    onHelloOk: () => {
      gatewayReady = true;
      for (const waiter of connectionWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      connectionWaiters.clear();
      console.log("OpenClaw gateway connected");
    },
    onClose: () => {
      gatewayReady = false;
    },
    onConnectError: (error) => {
      gatewayReady = false;
      console.error(`OpenClaw gateway connection failed: ${safeError(error)}`);
    },
  });
  gateway.start();
  await waitForGateway();
}

function waitForGateway(timeoutMs = 15_000): Promise<void> {
  if (gatewayReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        connectionWaiters.delete(waiter);
        reject(new Error("OpenClaw gateway connection timed out"));
      }, timeoutMs),
    };
    connectionWaiters.add(waiter);
  });
}

async function requestGateway<T = JsonRecord>(
  method: string,
  params: JsonRecord,
  timeoutMs = 30_000,
): Promise<T> {
  if (!gateway) await connectGateway();
  await waitForGateway();
  if (!gateway) throw new Error("OpenClaw gateway is unavailable");
  return await gateway.request<T>(method, params, { timeoutMs });
}

function waitForRun(runId: string): Promise<string> {
  const cached = completedRuns.get(runId);
  if (cached) {
    completedRuns.delete(runId);
    return cached.error
      ? Promise.reject(new Error(cached.error))
      : Promise.resolve(cached.text || "OpenClaw finished with no text.");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runWaiters.delete(runId);
      reject(new Error("OpenClaw tool call timed out"));
    }, TOOL_TIMEOUT_MS);
    runWaiters.set(runId, { resolve, reject, timer });
  });
}

function normalizeRemoteAddress(request: IncomingMessage): string {
  const address = request.socket.remoteAddress || "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as JsonRecord;
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!ALLOWED_IPS.has(normalizeRemoteAddress(request))) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  const path = new URL(request.url || "/", "http://voice-broker.local").pathname;
  if (request.method === "GET" && path === "/health") {
    sendJson(response, gatewayReady ? 200 : 503, {
      ok: gatewayReady,
      service: "openclaw-voice-broker",
      shoppingConfigured: Boolean(HOME_ASSISTANT_URL && HOME_ASSISTANT_TOKEN),
    });
    return;
  }
  if (request.method === "GET" && path === "/shopping") {
    try {
      sendJson(response, 200, await getShoppingSnapshot());
    } catch (error) {
      sendJson(response, 502, { error: safeError(error) });
    }
    return;
  }

  const shoppingItemPrefix = "/shopping/items/";
  const isShoppingWrite =
    (request.method === "POST" && path === "/shopping/items") ||
    (request.method === "POST" && path === "/shopping/clear-completed") ||
    ((request.method === "PATCH" || request.method === "DELETE") &&
      path.startsWith(shoppingItemPrefix));
  if (isShoppingWrite) {
    const body = await readJson(request);
    try {
      if (request.method === "POST" && path === "/shopping/items") {
        sendJson(response, 200, await addShoppingItem(body.text));
        return;
      }
      if (request.method === "POST" && path === "/shopping/clear-completed") {
        sendJson(response, 200, await clearCompletedShoppingItems());
        return;
      }
      let id = "";
      try {
        id = decodeURIComponent(path.slice(shoppingItemPrefix.length)).trim();
      } catch {
        sendJson(response, 400, { error: "Invalid shopping item id" });
        return;
      }
      if (!id || id.length > 200) {
        sendJson(response, 400, { error: "Invalid shopping item id" });
        return;
      }
      if (request.method === "PATCH") {
        sendJson(response, 200, await updateShoppingItem(id, body));
        return;
      }
      sendJson(response, 200, await removeShoppingItem(id));
      return;
    } catch (error) {
      const message = safeError(error);
      const status =
        message.includes("required") || message.includes("supplied") ? 400 : 502;
      sendJson(response, status, { error: message });
    }
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const body = await readJson(request);
  if (path === "/session") {
    const session = await requestGateway("talk.client.create", {
      sessionKey: SESSION_KEY,
    });
    sendJson(response, 200, session);
    return;
  }
  if (path === "/tool") {
    const callId = typeof body.callId === "string" ? body.callId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!callId || name !== "openclaw_agent_consult") {
      sendJson(response, 400, { error: "Invalid Talk tool call" });
      return;
    }
    try {
      const started = await requestGateway<{ runId?: string; idempotencyKey?: string }>(
        "talk.client.toolCall",
        {
          sessionKey: SESSION_KEY,
          callId,
          name,
          args:
            body.args && typeof body.args === "object" && !Array.isArray(body.args)
              ? body.args
              : {},
        },
      );
      const runId = started.runId || started.idempotencyKey;
      if (!runId) throw new Error("OpenClaw did not return a tool run id");
      sendJson(response, 200, { result: await waitForRun(runId) });
    } catch (error) {
      sendJson(response, 200, { error: safeError(error) });
    }
    return;
  }
  if (path === "/control") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const mode = typeof body.mode === "string" ? body.mode.trim() : "";
    if (!text || !["status", "steer", "cancel", "followup"].includes(mode)) {
      sendJson(response, 400, { error: "Invalid Talk control request" });
      return;
    }
    try {
      const result = await requestGateway(
        "talk.client.steer",
        { sessionKey: SESSION_KEY, text, mode },
        30_000,
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 200, { error: safeError(error) });
    }
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

const server = createServer((request, response) => {
  void route(request, response).catch((error) => {
    console.error(`Voice broker request failed: ${safeError(error)}`);
    if (!response.headersSent) sendJson(response, 502, { error: safeError(error) });
    else response.end();
  });
});
server.requestTimeout = TOOL_TIMEOUT_MS + 15_000;
server.headersTimeout = 15_000;

async function runSelfTest(): Promise<void> {
  await connectGateway();
  const session = await requestGateway<JsonRecord>("talk.client.create", {
    sessionKey: SESSION_KEY,
  });
  if (
    session.transport !== "webrtc" ||
    typeof session.clientSecret !== "string" ||
    !session.clientSecret
  ) {
    throw new Error("Self-test did not receive a valid WebRTC voice session");
  }
  const callId = `broker-self-test-${randomUUID()}`;
  const started = await requestGateway<{ runId?: string; idempotencyKey?: string }>(
    "talk.client.toolCall",
    {
      sessionKey: SESSION_KEY,
      callId,
      name: "openclaw_agent_consult",
      args: {
        question:
          "This is a voice broker connectivity check. Reply with a brief confirmation only.",
        responseStyle: "One short sentence.",
      },
    },
  );
  const runId = started.runId || started.idempotencyKey;
  if (!runId) throw new Error("Self-test consult did not return a run id");
  const result = await waitForRun(runId);
  if (!result.trim()) throw new Error("Self-test consult returned no text");
  console.log("Voice broker self-test passed: WebRTC session and agent consult are healthy");
  gateway?.stop();
}

if (process.env.VOICE_BROKER_SELF_TEST === "1") {
  void runSelfTest().then(
    () => process.exit(0),
    (error) => {
      console.error(`Voice broker self-test failed: ${safeError(error)}`);
      gateway?.stop();
      process.exit(1);
    },
  );
} else {
  server.listen(PORT, HOST, () => {
    console.log(`Touchscreen voice broker listening on ${HOST}:${PORT}`);
    void connectGateway().catch((error) => {
      console.error(`Initial OpenClaw connection failed: ${safeError(error)}`);
    });
  });
}

function shutdown(): void {
  gateway?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
