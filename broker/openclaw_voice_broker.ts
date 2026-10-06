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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";

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
const SESSION_KEY = "agent:main:main";
const TOUCHSCREEN_VAD_THRESHOLD = 0.62;
const TOUCHSCREEN_VAD_SILENCE_MS = 650;
const TOUCHSCREEN_VAD_PREFIX_MS = 300;
const BODY_LIMIT = 128 * 1024;
const CAMERA_BODY_LIMIT = 4 * 1024 * 1024;
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
const SHOPPING_ACTIVITY_PATH =
  process.env.SHOPPING_ACTIVITY_PATH ||
  join(process.env.HOME || "/Users/dan", ".openclaw", "logs", "shopping-activity.jsonl");
const SHOPPING_ACTIVITY_LIMIT = 100;
const SHOPPING_SETTINGS_PATH =
  process.env.SHOPPING_SETTINGS_PATH ||
  join(process.env.HOME || "/Users/dan", ".openclaw", "config", "shopping-settings.json");
const SHOPPING_NOTIFY_SERVICES = (
  process.env.SHOPPING_NOTIFY_SERVICES || "notify.mobile_app_dans_phone"
)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => /^notify\.mobile_app_[a-z0-9_]+$/.test(entry));
const HOUSEHOLD_WEATHER_ENTITY =
  process.env.HOUSEHOLD_WEATHER_ENTITY?.trim() || "weather.home";
const HOUSEHOLD_CALENDAR_ENTITIES = (
  process.env.HOUSEHOLD_CALENDAR_ENTITIES ||
  "calendar.birthdays,calendar.waste_calendar_5_daisy_terrace,calendar.holidays_in_united_kingdom"
)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => /^calendar\.[a-z0-9_]+$/.test(entry));
const HOUSEHOLD_CONTROL_ENTITIES = (
  process.env.HOUSEHOLD_CONTROL_ENTITIES ||
  "light.downstairs,light.upstairs,light.living_room,light.kitchen"
)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => /^light\.[a-z0-9_]+$/.test(entry));
const OPENAI_KEY_PATH =
  process.env.OPENAI_KEY_PATH ||
  join(process.env.HOME || "/Users/dan", ".openclaw", "secrets", "openai-api-key");
const OPENAI_VISION_MODEL =
  process.env.OPENAI_VISION_MODEL?.trim() || "gpt-5.6-luna";
const OPENAI_RESPONSES_URL =
  process.env.OPENAI_RESPONSES_URL?.trim() ||
  "https://api.openai.com/v1/responses";
const OPENAI_TIMEOUT_MS = 60_000;

function loadOpenAiApiKey(): string {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  try {
    return readFileSync(OPENAI_KEY_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

const OPENAI_API_KEY = loadOpenAiApiKey();

type JsonRecord = Record<string, unknown>;
type ShoppingItem = {
  id: string;
  text: string;
  completed: boolean;
  name: string;
  quantity?: number;
  unit?: string;
  category: ShoppingCategory;
};
type ShoppingCategory =
  | "produce"
  | "bakery"
  | "chilled"
  | "meat-fish"
  | "pantry"
  | "drinks"
  | "household"
  | "personal"
  | "other";
type ShoppingSnapshot = {
  items: ShoppingItem[];
  activeCount: number;
  completedCount: number;
  syncedAt: string;
  source: string;
  revision: string;
  outcome?:
    | "added"
    | "duplicate"
    | "restored"
    | "updated"
    | "removed"
    | "cleared"
    | "batch"
    | "organized"
    | "shared";
};
type ShoppingActivity = {
  id: string;
  at: string;
  action: string;
  source: string;
  itemId?: string;
  text?: string;
  detail?: string;
};
type CameraShoppingAnalysis = {
  kind:
    | "product"
    | "barcode"
    | "handwritten-list"
    | "receipt"
    | "groceries"
    | "unknown";
  summary: string;
  barcode: string | null;
  items: Array<{
    text: string;
    confidence: number;
    evidence: string;
  }>;
  warnings: string[];
  model: string;
};
type ShoppingReminderSettings = {
  enabled: boolean;
  zoneEntityId: string | null;
  personEntityId: string;
  notifyService: string;
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
const shoppingEventClients = new Set<ServerResponse>();
const shoppingActivities: ShoppingActivity[] = [];
const recentLocalShoppingEvents = new Map<string, number>();
let homeAssistantSocket: WebSocket | null = null;
let homeAssistantReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shoppingRevision = 0;
let shoppingReminderSettings: ShoppingReminderSettings = {
  enabled: false,
  zoneEntityId: null,
  personEntityId: "person.dan",
  notifyService: SHOPPING_NOTIFY_SERVICES[0] || "",
};

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

const SHOPPING_CATEGORIES: Array<{
  category: ShoppingCategory;
  pattern: RegExp;
}> = [
  {
    category: "produce",
    pattern:
      /\b(?:apple|apples|avocado|banana|bananas|berry|berries|broccoli|cabbage|carrot|carrots|cauliflower|celery|coriander|cucumber|fruit|garlic|ginger|grape|grapes|herb|herbs|leek|leeks|lemon|lemons|lettuce|lime|limes|mushroom|mushrooms|onion|onions|orange|oranges|pepper|peppers|potato|potatoes|salad|spinach|spring onion|tomato|tomatoes|veg|vegetable|vegetables)\b/i,
  },
  {
    category: "bakery",
    pattern:
      /\b(?:bagel|bagels|bread|bun|buns|cake|cakes|croissant|croissants|loaf|pastry|pastries|pitta|roll|rolls|tortilla|wrap|wraps)\b/i,
  },
  {
    category: "chilled",
    pattern:
      /\b(?:butter|cheese|cream|crème|egg|eggs|hummus|margarine|milk|oat milk|tofu|yoghurt|yogurt)\b/i,
  },
  {
    category: "meat-fish",
    pattern:
      /\b(?:bacon|beef|chicken|fish|ham|lamb|meat|pork|prawn|prawns|salmon|sausage|sausages|steak|tuna|turkey)\b/i,
  },
  {
    category: "drinks",
    pattern:
      /\b(?:beer|cider|coffee|cola|cordial|drink|drinks|juice|lemonade|squash|tea|tonic|water|wine)\b/i,
  },
  {
    category: "household",
    pattern:
      /\b(?:bin bag|bin bags|bleach|cleaner|cleaning|detergent|dishwasher|foil|kitchen roll|laundry|paper towel|paper towels|soap powder|sponge|sponges|toilet roll|toilet rolls|washing up)\b/i,
  },
  {
    category: "personal",
    pattern:
      /\b(?:conditioner|deodorant|floss|nappy|nappies|razor|razors|shampoo|shower gel|soap|toothbrush|toothpaste)\b/i,
  },
  {
    category: "pantry",
    pattern:
      /\b(?:biscuit|biscuits|cereal|chocolate|flour|jam|ketchup|mustard|oil|olive oil|pasta|pepper|rice|salt|sauce|spice|spices|sugar|tin|tinned|vinegar)\b/i,
  },
];

function parseShoppingText(text: string): {
  name: string;
  quantity?: number;
  unit?: string;
  category: ShoppingCategory;
} {
  const cleaned = cleanItemText(text);
  const units =
    "kg|g|gram|grams|l|litre|litres|liter|liters|ml|cl|pack|packs|packet|packets|bottle|bottles|tin|tins|can|cans|box|boxes|bag|bags|dozen";
  let name = cleaned;
  let quantity: number | undefined;
  let unit: string | undefined;
  const prefix = cleaned.match(
    new RegExp(
      `^(\\d+(?:[.,]\\d+)?)(?:\\s*(${units})\\b\\s*|\\s*[x×]\\s*|\\s+)(?:of\\s+)?(.+)$`,
      "i",
    ),
  );
  const suffix = cleaned.match(/^(.+?)\s+[x×]\s*(\d+(?:[.,]\d+)?)$/i);
  if (prefix?.[3]) {
    quantity = Number.parseFloat(prefix[1].replace(",", "."));
    unit = prefix[2]?.toLocaleLowerCase("en-GB");
    name = prefix[3].trim();
  } else if (suffix?.[2]) {
    quantity = Number.parseFloat(suffix[2].replace(",", "."));
    name = suffix[1].trim();
  }
  const category =
    SHOPPING_CATEGORIES.find((entry) => entry.pattern.test(name))?.category ||
    "other";
  return {
    name,
    ...(Number.isFinite(quantity) ? { quantity } : {}),
    ...(unit ? { unit } : {}),
    category,
  };
}

function shoppingProductKey(text: string): string {
  const parsed = parseShoppingText(text);
  return `${normalizeItemText(parsed.name)}|${parsed.unit || ""}`;
}

function cleanSource(value: unknown): string {
  const source = typeof value === "string" ? value.trim() : "";
  return /^(?:touchscreen|openclaw|camera|home-assistant|system|mobile)$/.test(source)
    ? source
    : "touchscreen";
}

function isShoppingTestActivity(activity: Partial<ShoppingActivity>): boolean {
  return /\bintegration\b.*\b20\d{6}\b/i.test(
    `${activity.text || ""} ${activity.detail || ""}`,
  );
}

function loadShoppingActivities(): void {
  if (!existsSync(SHOPPING_ACTIVITY_PATH)) return;
  try {
    const lines = readFileSync(SHOPPING_ACTIVITY_PATH, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-SHOPPING_ACTIVITY_LIMIT);
    for (const line of lines) {
      const parsed = JSON.parse(line) as ShoppingActivity;
      if (
        parsed?.id &&
        parsed?.at &&
        parsed?.action &&
        !isShoppingTestActivity(parsed)
      ) {
        shoppingActivities.push(parsed);
      }
    }
  } catch (error) {
    console.error(`Could not load shopping activity: ${safeError(error)}`);
  }
}

function loadShoppingReminderSettings(): void {
  if (!existsSync(SHOPPING_SETTINGS_PATH)) return;
  try {
    const value = asRecord(
      JSON.parse(readFileSync(SHOPPING_SETTINGS_PATH, "utf8")),
    );
    const zoneEntityId =
      typeof value.zoneEntityId === "string" &&
      /^zone\.[a-z0-9_]+$/.test(value.zoneEntityId) &&
      value.zoneEntityId !== "zone.home"
        ? value.zoneEntityId
        : null;
    const personEntityId =
      typeof value.personEntityId === "string" &&
      /^person\.[a-z0-9_]+$/.test(value.personEntityId)
        ? value.personEntityId
        : "person.dan";
    const notifyService =
      typeof value.notifyService === "string" &&
      SHOPPING_NOTIFY_SERVICES.includes(value.notifyService)
        ? value.notifyService
        : SHOPPING_NOTIFY_SERVICES[0] || "";
    shoppingReminderSettings = {
      enabled: value.enabled === true && Boolean(zoneEntityId && notifyService),
      zoneEntityId,
      personEntityId,
      notifyService,
    };
  } catch (error) {
    console.error(`Could not load shopping settings: ${safeError(error)}`);
  }
}

function saveShoppingReminderSettings(settings: ShoppingReminderSettings): void {
  mkdirSync(dirname(SHOPPING_SETTINGS_PATH), { recursive: true, mode: 0o700 });
  const temporaryPath = `${SHOPPING_SETTINGS_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, SHOPPING_SETTINGS_PATH);
  shoppingReminderSettings = settings;
}

function recordShoppingActivity(
  activity: Omit<ShoppingActivity, "id" | "at">,
): ShoppingActivity {
  const entry: ShoppingActivity = {
    id: randomUUID(),
    at: new Date().toISOString(),
    ...activity,
  };
  if (isShoppingTestActivity(entry)) return entry;
  shoppingActivities.push(entry);
  if (shoppingActivities.length > SHOPPING_ACTIVITY_LIMIT) shoppingActivities.shift();
  try {
    mkdirSync(dirname(SHOPPING_ACTIVITY_PATH), { recursive: true, mode: 0o700 });
    appendFileSync(SHOPPING_ACTIVITY_PATH, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    console.error(`Could not append shopping activity: ${safeError(error)}`);
  }
  return entry;
}

function markLocalShoppingEvent(action: string, itemId?: string): void {
  recentLocalShoppingEvents.set(`${action}:${itemId || "*"}`, Date.now());
  for (const [key, at] of recentLocalShoppingEvents) {
    if (Date.now() - at > 5_000) recentLocalShoppingEvents.delete(key);
  }
}

function wasRecentLocalShoppingEvent(action: string, itemId?: string): boolean {
  const now = Date.now();
  return [...recentLocalShoppingEvents].some(
    ([key, at]) =>
      now - at < 5_000 &&
      (key === `${action}:${itemId || "*"}` ||
        key.endsWith(":*") ||
        (itemId && key.endsWith(`:${itemId}`))),
  );
}

function sendShoppingEvent(
  response: ServerResponse,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastShoppingSnapshot(
  snapshot: ShoppingSnapshot,
  activity?: ShoppingActivity,
): void {
  for (const response of shoppingEventClients) {
    try {
      if (activity) sendShoppingEvent(response, "activity", activity);
      sendShoppingEvent(response, "snapshot", snapshot);
    } catch {
      shoppingEventClients.delete(response);
    }
  }
}

loadShoppingActivities();
loadShoppingReminderSettings();

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
    const parsed = parseShoppingText(text);
    return [
      {
        id,
        text,
        completed: item.status === "completed",
        ...parsed,
      },
    ];
  });
  shoppingRevision += 1;
  return {
    items,
    activeCount: items.filter((item) => !item.completed).length,
    completedCount: items.filter((item) => item.completed).length,
    syncedAt: new Date().toISOString(),
    source: SHOPPING_ENTITY_ID,
    revision: `${Date.now()}-${shoppingRevision}`,
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

function completeShoppingMutation(
  snapshot: ShoppingSnapshot,
  outcome: ShoppingSnapshot["outcome"],
  activity: Omit<ShoppingActivity, "id" | "at">,
  homeAssistantAction: string,
): ShoppingSnapshot {
  const result = { ...snapshot, outcome };
  const entry = recordShoppingActivity(activity);
  markLocalShoppingEvent(homeAssistantAction, activity.itemId);
  broadcastShoppingSnapshot(result, entry);
  return result;
}

async function addShoppingItem(
  value: unknown,
  sourceValue: unknown = "touchscreen",
): Promise<ShoppingSnapshot> {
  const text = cleanItemText(value);
  if (!text) throw new Error("Item text is required");
  const source = cleanSource(sourceValue);
  const before = await getShoppingSnapshot();
  const matching = before.items.find(
    (item) => shoppingProductKey(item.text) === shoppingProductKey(text),
  );
  if (matching && !matching.completed) {
    return { ...before, outcome: "duplicate" };
  }
  if (matching?.completed) {
    markLocalShoppingEvent("update", matching.id);
    await callTodoService("update_item", {
      item: matching.id,
      status: "needs_action",
      ...(normalizeItemText(matching.text) !== normalizeItemText(text)
        ? { rename: text }
        : {}),
    });
    return completeShoppingMutation(
      await getShoppingSnapshot(),
      "restored",
      {
        action: "restored",
        source,
        itemId: matching.id,
        text,
      },
      "update",
    );
  }
  markLocalShoppingEvent("add");
  await callTodoService("add_item", { item: text });
  const snapshot = await getShoppingSnapshot();
  const added = snapshot.items.find(
    (item) =>
      !before.items.some((previous) => previous.id === item.id) &&
      shoppingProductKey(item.text) === shoppingProductKey(text),
  );
  return completeShoppingMutation(
    snapshot,
    "added",
    {
      action: "added",
      source,
      itemId: added?.id,
      text,
    },
    "add",
  );
}

async function updateShoppingItem(
  id: string,
  body: JsonRecord,
): Promise<ShoppingSnapshot> {
  const source = cleanSource(body.source);
  const before = await getShoppingSnapshot();
  const existing = before.items.find((item) => item.id === id);
  if (!existing) return { ...before, outcome: "updated" };
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
  markLocalShoppingEvent("update", id);
  await callTodoService("update_item", update);
  const text =
    typeof update.rename === "string" ? update.rename : existing.text;
  const action =
    typeof body.completed === "boolean"
      ? body.completed
        ? "completed"
        : "restored"
      : "renamed";
  return completeShoppingMutation(
    await getShoppingSnapshot(),
    "updated",
    { action, source, itemId: id, text },
    "update",
  );
}

async function removeShoppingItem(
  id: string,
  sourceValue: unknown = "touchscreen",
): Promise<ShoppingSnapshot> {
  const source = cleanSource(sourceValue);
  const before = await getShoppingSnapshot();
  const existing = before.items.find((item) => item.id === id);
  if (!existing) return { ...before, outcome: "removed" };
  markLocalShoppingEvent("remove", id);
  await callTodoService("remove_item", { item: id });
  return completeShoppingMutation(
    await getShoppingSnapshot(),
    "removed",
    {
      action: "removed",
      source,
      itemId: id,
      text: existing.text,
    },
    "remove",
  );
}

async function clearCompletedShoppingItems(
  sourceValue: unknown = "touchscreen",
): Promise<ShoppingSnapshot> {
  const source = cleanSource(sourceValue);
  const before = await getShoppingSnapshot();
  markLocalShoppingEvent("clear");
  await callTodoService("remove_completed_items", {});
  return completeShoppingMutation(
    await getShoppingSnapshot(),
    "cleared",
    {
      action: "cleared-completed",
      source,
      detail: `${before.completedCount} completed ${
        before.completedCount === 1 ? "item" : "items"
      }`,
    },
    "clear",
  );
}

function cleanShoppingTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry): string[] => {
    const text =
      typeof entry === "string"
        ? cleanItemText(entry)
        : cleanItemText(asRecord(entry).text);
    const key = shoppingProductKey(text);
    if (!text || seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}

async function addShoppingItems(
  value: unknown,
  sourceValue: unknown = "openclaw",
): Promise<ShoppingSnapshot & { added: string[]; skipped: string[] }> {
  const texts = cleanShoppingTexts(value).slice(0, 60);
  if (!texts.length) throw new Error("At least one shopping item is required");
  const added: string[] = [];
  const skipped: string[] = [];
  let snapshot = await getShoppingSnapshot();
  for (const text of texts) {
    const result = await addShoppingItem(text, sourceValue);
    snapshot = result;
    if (result.outcome === "duplicate") skipped.push(text);
    else added.push(text);
  }
  return { ...snapshot, outcome: "batch", added, skipped };
}

async function reconcileShoppingItems(
  value: unknown,
  commit: boolean,
  sourceValue: unknown = "openclaw",
): Promise<JsonRecord> {
  const proposed = cleanShoppingTexts(value).slice(0, 60);
  if (!proposed.length) throw new Error("At least one shopping item is required");
  const before = await getShoppingSnapshot();
  const existingKeys = new Set(
    before.items
      .filter((item) => !item.completed)
      .map((item) => shoppingProductKey(item.text)),
  );
  const missing = proposed.filter((text) => !existingKeys.has(shoppingProductKey(text)));
  const alreadyListed = proposed.filter((text) =>
    existingKeys.has(shoppingProductKey(text)),
  );
  if (!commit || !missing.length) {
    return {
      proposed,
      missing,
      alreadyListed,
      committed: false,
      snapshot: before,
    };
  }
  const snapshot = await addShoppingItems(missing, sourceValue);
  return {
    proposed,
    missing,
    alreadyListed,
    committed: true,
    snapshot,
  };
}

function formatMergedShoppingText(
  item: ShoppingItem,
  quantity: number,
): string {
  const formatted = Number.isInteger(quantity)
    ? String(quantity)
    : String(Number(quantity.toFixed(2)));
  return `${formatted}${item.unit ? ` ${item.unit}` : " ×"} ${item.name}`;
}

async function organizeShoppingItems(
  sourceValue: unknown = "touchscreen",
): Promise<ShoppingSnapshot & { duplicatesRemoved: number }> {
  const source = cleanSource(sourceValue);
  const before = await getShoppingSnapshot();
  const groups = new Map<string, ShoppingItem[]>();
  for (const item of before.items.filter((entry) => !entry.completed)) {
    const key = shoppingProductKey(item.text);
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  let duplicatesRemoved = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keeper, ...duplicates] = group;
    const quantities = group.map((item) => item.quantity);
    if (quantities.every((quantity) => typeof quantity === "number")) {
      const total = quantities.reduce<number>(
        (sum, quantity) => sum + (quantity || 0),
        0,
      );
      const mergedText = formatMergedShoppingText(keeper, total);
      if (normalizeItemText(keeper.text) !== normalizeItemText(mergedText)) {
        markLocalShoppingEvent("update", keeper.id);
        await callTodoService("update_item", {
          item: keeper.id,
          rename: mergedText,
        });
      }
    }
    for (const duplicate of duplicates) {
      markLocalShoppingEvent("remove", duplicate.id);
      await callTodoService("remove_item", { item: duplicate.id });
      duplicatesRemoved += 1;
    }
  }
  const snapshot = await getShoppingSnapshot();
  if (!duplicatesRemoved) {
    return { ...snapshot, outcome: "organized", duplicatesRemoved };
  }
  const result = completeShoppingMutation(
    snapshot,
    "organized",
    {
      action: "organized",
      source,
      detail: `${duplicatesRemoved} duplicate ${
        duplicatesRemoved === 1 ? "item" : "items"
      } removed`,
    },
    "update_list",
  );
  return { ...result, duplicatesRemoved };
}

function shoppingNotificationMessage(snapshot: ShoppingSnapshot): string {
  const active = snapshot.items.filter((item) => !item.completed);
  const visible = active.slice(0, 12).map((item) => `• ${item.text}`);
  if (active.length > visible.length) {
    visible.push(`…and ${active.length - visible.length} more`);
  }
  return visible.length ? visible.join("\n") : "The house shopping list is empty.";
}

async function sendShoppingNotification(
  service: string,
  title: string,
  snapshot: ShoppingSnapshot,
): Promise<void> {
  if (!SHOPPING_NOTIFY_SERVICES.includes(service)) {
    throw new Error("That household notification target is not configured");
  }
  const serviceName = service.slice("notify.".length);
  await homeAssistantJson(`/api/services/notify/${serviceName}`, {
    title,
    message: shoppingNotificationMessage(snapshot),
    data: {
      url: "/shopping-list",
      clickAction: "/shopping-list",
      tag: "house-shopping-list",
      group: "house-shopping",
    },
  });
}

async function shareShoppingList(
  sourceValue: unknown = "touchscreen",
  notifyServiceValue?: unknown,
): Promise<JsonRecord> {
  const source = cleanSource(sourceValue);
  const notifyService =
    typeof notifyServiceValue === "string" &&
    SHOPPING_NOTIFY_SERVICES.includes(notifyServiceValue)
      ? notifyServiceValue
      : SHOPPING_NOTIFY_SERVICES[0] || "";
  if (!notifyService) {
    throw new Error("No household notification target is configured");
  }
  const snapshot = await getShoppingSnapshot();
  await sendShoppingNotification(notifyService, "House shopping", snapshot);
  const activity = recordShoppingActivity({
    action: "shared",
    source,
    detail: `List sent to ${notifyService.replace("notify.mobile_app_", "")}`,
  });
  const result = { ...snapshot, outcome: "shared" as const };
  broadcastShoppingSnapshot(result, activity);
  return { sentTo: notifyService, snapshot: result };
}

function friendlyEntityName(state: JsonRecord): string {
  const attributes = asRecord(state.attributes);
  return typeof attributes.friendly_name === "string"
    ? cleanItemText(attributes.friendly_name)
    : typeof state.entity_id === "string"
      ? state.entity_id
      : "";
}

async function getShoppingHousehold(): Promise<JsonRecord> {
  const states = await homeAssistantJson("/api/states");
  const stateList = Array.isArray(states) ? states.map(asRecord) : [];
  const zones = stateList
    .filter(
      (state) =>
        typeof state.entity_id === "string" &&
        state.entity_id.startsWith("zone.") &&
        state.entity_id !== "zone.home",
    )
    .map((state) => ({
      entityId: state.entity_id,
      name: friendlyEntityName(state),
    }));
  const people = stateList
    .filter(
      (state) =>
        typeof state.entity_id === "string" &&
        state.entity_id.startsWith("person."),
    )
    .map((state) => ({
      entityId: state.entity_id,
      name: friendlyEntityName(state),
    }));
  return {
    settings: shoppingReminderSettings,
    zones,
    people,
    notificationTargets: SHOPPING_NOTIFY_SERVICES.map((service) => ({
      service,
      name: service
        .replace("notify.mobile_app_", "")
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase("en-GB")),
    })),
  };
}

async function updateShoppingHousehold(body: JsonRecord): Promise<JsonRecord> {
  const household = await getShoppingHousehold();
  const zones = Array.isArray(household.zones) ? household.zones.map(asRecord) : [];
  const people = Array.isArray(household.people)
    ? household.people.map(asRecord)
    : [];
  const requestedZone =
    typeof body.zoneEntityId === "string" ? body.zoneEntityId.trim() : "";
  const zoneEntityId = zones.some((zone) => zone.entityId === requestedZone)
    ? requestedZone
    : null;
  const requestedPerson =
    typeof body.personEntityId === "string" ? body.personEntityId.trim() : "";
  const personEntityId = people.some(
    (person) => person.entityId === requestedPerson,
  )
    ? requestedPerson
    : shoppingReminderSettings.personEntityId;
  const requestedNotify =
    typeof body.notifyService === "string" ? body.notifyService.trim() : "";
  const notifyService = SHOPPING_NOTIFY_SERVICES.includes(requestedNotify)
    ? requestedNotify
    : shoppingReminderSettings.notifyService;
  const enabled = body.enabled === true;
  if (enabled && (!zoneEntityId || !personEntityId || !notifyService)) {
    throw new Error(
      "Choose a household member, shopping zone, and phone before enabling reminders",
    );
  }
  const settings = {
    enabled,
    zoneEntityId,
    personEntityId,
    notifyService,
  };
  saveShoppingReminderSettings(settings);
  const activity = recordShoppingActivity({
    action: enabled ? "reminders-enabled" : "reminders-disabled",
    source: cleanSource(body.source),
    detail: enabled && zoneEntityId ? `Arrival reminder at ${zoneEntityId}` : undefined,
  });
  broadcastShoppingSnapshot(await getShoppingSnapshot(), activity);
  return await getShoppingHousehold();
}

function stateMatchesShoppingZone(state: string, zoneEntityId: string): boolean {
  const zoneName = zoneEntityId.slice("zone.".length).replaceAll("_", " ");
  return normalizeItemText(state).replaceAll("_", " ") === zoneName;
}

async function maybeSendShoppingArrivalReminder(
  entityId: string,
  oldState: string,
  newState: string,
): Promise<void> {
  const settings = shoppingReminderSettings;
  if (
    !settings.enabled ||
    !settings.zoneEntityId ||
    entityId !== settings.personEntityId ||
    oldState === newState ||
    !stateMatchesShoppingZone(newState, settings.zoneEntityId)
  ) {
    return;
  }
  const snapshot = await getShoppingSnapshot();
  if (!snapshot.activeCount) return;
  await sendShoppingNotification(
    settings.notifyService,
    `${snapshot.activeCount} ${
      snapshot.activeCount === 1 ? "item" : "items"
    } to pick up`,
    snapshot,
  );
  const activity = recordShoppingActivity({
    action: "arrival-reminder",
    source: "system",
    detail: `${settings.personEntityId} entered ${settings.zoneEntityId}`,
  });
  broadcastShoppingSnapshot(snapshot, activity);
}

function dateValue(value: unknown): string {
  const record = asRecord(value);
  if (typeof record.dateTime === "string") return record.dateTime;
  if (typeof record.date === "string") return record.date;
  return "";
}

let forecastCache: { at: number; days: JsonRecord[] } = { at: 0, days: [] };
const FORECAST_CACHE_MS = 30 * 60_000;

/** The daily forecast for the household weather entity, cached for half an hour. */
async function getWeatherForecast(): Promise<JsonRecord[]> {
  if (Date.now() - forecastCache.at < FORECAST_CACHE_MS) return forecastCache.days;
  try {
    const result = asRecord(
      await homeAssistantJson("/api/services/weather/get_forecasts?return_response", {
        entity_id: HOUSEHOLD_WEATHER_ENTITY,
        type: "daily",
      }),
    );
    const response = asRecord(asRecord(result.service_response)[HOUSEHOLD_WEATHER_ENTITY]);
    const days = (Array.isArray(response.forecast) ? response.forecast : [])
      .map(asRecord)
      .flatMap((entry): JsonRecord[] => {
        if (typeof entry.datetime !== "string") return [];
        return [
          {
            date: entry.datetime,
            condition: typeof entry.condition === "string" ? entry.condition : "unknown",
            high: typeof entry.temperature === "number" ? entry.temperature : null,
            low: typeof entry.templow === "number" ? entry.templow : null,
            precipitation:
              typeof entry.precipitation_probability === "number"
                ? entry.precipitation_probability
                : null,
            windSpeed: typeof entry.wind_speed === "number" ? entry.wind_speed : null,
          },
        ];
      })
      .slice(0, 7);
    forecastCache = { at: Date.now(), days };
  } catch (error) {
    console.error(`Weather forecast unavailable: ${safeError(error)}`);
    forecastCache = { at: Date.now() - FORECAST_CACHE_MS + 5 * 60_000, days: forecastCache.days };
  }
  return forecastCache.days;
}

async function getHouseholdHub(): Promise<JsonRecord> {
  const states = await homeAssistantJson("/api/states");
  const stateList = Array.isArray(states) ? states.map(asRecord) : [];
  const byEntityId = new Map(
    stateList.flatMap((state): Array<[string, JsonRecord]> =>
      typeof state.entity_id === "string" ? [[state.entity_id, state]] : [],
    ),
  );
  const weatherState = byEntityId.get(HOUSEHOLD_WEATHER_ENTITY);
  const weatherAttributes = asRecord(weatherState?.attributes);
  const now = new Date();
  const end = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1_000);
  const calendarResults = await Promise.all(
    HOUSEHOLD_CALENDAR_ENTITIES.map(async (entityId) => {
      try {
        const events = await homeAssistantJson(
          `/api/calendars/${encodeURIComponent(entityId)}?start=${encodeURIComponent(
            now.toISOString(),
          )}&end=${encodeURIComponent(end.toISOString())}`,
        );
        return (Array.isArray(events) ? events : []).flatMap((entry): JsonRecord[] => {
          const event = asRecord(entry);
          const start = dateValue(event.start);
          const summary = cleanItemText(event.summary);
          if (!start || !summary) return [];
          return [
            {
              calendar: entityId,
              summary,
              start,
              end: dateValue(event.end),
              allDay: Boolean(asRecord(event.start).date),
            },
          ];
        });
      } catch {
        return [];
      }
    }),
  );
  const events = calendarResults
    .flat()
    .sort((left, right) => String(left.start).localeCompare(String(right.start)))
    .slice(0, 8);
  const forecast = weatherState ? await getWeatherForecast() : [];
  const controls = HOUSEHOLD_CONTROL_ENTITIES.flatMap((entityId): JsonRecord[] => {
    const state = byEntityId.get(entityId);
    if (!state || state.state === "unavailable") return [];
    return [
      {
        entityId,
        name: friendlyEntityName(state),
        state: state.state,
        active: state.state === "on",
      },
    ];
  });
  return {
    weather: weatherState
      ? {
          entityId: HOUSEHOLD_WEATHER_ENTITY,
          name: friendlyEntityName(weatherState),
          condition:
            typeof weatherState.state === "string" ? weatherState.state : "unknown",
          temperature:
            typeof weatherAttributes.temperature === "number"
              ? weatherAttributes.temperature
              : null,
          unit:
            typeof weatherAttributes.temperature_unit === "string"
              ? weatherAttributes.temperature_unit
              : "°C",
          humidity:
            typeof weatherAttributes.humidity === "number"
              ? weatherAttributes.humidity
              : null,
          // The frame paints the air: cloud, wind and its direction, where the
          // integration provides them.
          cloudCoverage:
            typeof weatherAttributes.cloud_coverage === "number"
              ? weatherAttributes.cloud_coverage
              : null,
          windSpeed:
            typeof weatherAttributes.wind_speed === "number"
              ? weatherAttributes.wind_speed
              : null,
          windSpeedUnit:
            typeof weatherAttributes.wind_speed_unit === "string"
              ? weatherAttributes.wind_speed_unit
              : null,
          windBearing:
            typeof weatherAttributes.wind_bearing === "number"
              ? weatherAttributes.wind_bearing
              : null,
        }
      : null,
    forecast,
    events,
    controls,
    refreshedAt: new Date().toISOString(),
  };
}

async function toggleHouseholdControl(body: JsonRecord): Promise<JsonRecord> {
  const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
  if (!HOUSEHOLD_CONTROL_ENTITIES.includes(entityId)) {
    throw new Error("That household control is not available on this screen");
  }
  await homeAssistantJson("/api/services/light/toggle", { entity_id: entityId });
  return await getHouseholdHub();
}

const CAMERA_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "summary", "barcode", "items", "warnings"],
  properties: {
    kind: {
      type: "string",
      enum: [
        "product",
        "barcode",
        "handwritten-list",
        "receipt",
        "groceries",
        "unknown",
      ],
    },
    summary: { type: "string" },
    barcode: { type: ["string", "null"] },
    items: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "confidence", "evidence"],
        properties: {
          text: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string" },
        },
      },
    },
    warnings: {
      type: "array",
      maxItems: 10,
      items: { type: "string" },
    },
  },
} as const;

function extractOpenAiOutputText(value: unknown): string {
  const response = asRecord(value);
  const output = Array.isArray(response.output) ? response.output : [];
  return output
    .flatMap((entry) => {
      const content = asRecord(entry).content;
      return Array.isArray(content) ? content : [];
    })
    .map((entry) => {
      const block = asRecord(entry);
      return block.type === "output_text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter(Boolean)
    .join("");
}

function cleanBarcode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[^0-9A-Za-z-]/g, "").slice(0, 64);
}

function normalizeCameraAnalysis(value: unknown): CameraShoppingAnalysis {
  const result = asRecord(value);
  const allowedKinds = new Set<CameraShoppingAnalysis["kind"]>([
    "product",
    "barcode",
    "handwritten-list",
    "receipt",
    "groceries",
    "unknown",
  ]);
  const kind = allowedKinds.has(result.kind as CameraShoppingAnalysis["kind"])
    ? (result.kind as CameraShoppingAnalysis["kind"])
    : "unknown";
  const seen = new Set<string>();
  const items = (Array.isArray(result.items) ? result.items : [])
    .flatMap((entry): CameraShoppingAnalysis["items"] => {
      const item = asRecord(entry);
      const text = cleanItemText(item.text);
      const key = shoppingProductKey(text);
      if (!text || seen.has(key)) return [];
      seen.add(key);
      const confidence =
        typeof item.confidence === "number" && Number.isFinite(item.confidence)
          ? Math.max(0, Math.min(item.confidence, 1))
          : 0;
      return [
        {
          text,
          confidence,
          evidence: cleanItemText(item.evidence),
        },
      ];
    })
    .slice(0, 40);
  const warnings = (Array.isArray(result.warnings) ? result.warnings : [])
    .map(cleanItemText)
    .filter(Boolean)
    .slice(0, 10);
  const barcode = cleanBarcode(result.barcode);
  return {
    kind,
    summary:
      cleanItemText(result.summary) ||
      (items.length ? `${items.length} shopping items found` : "Nothing clear enough to add"),
    barcode: barcode || null,
    items,
    warnings,
    model: OPENAI_VISION_MODEL,
  };
}

async function analyzeShoppingCamera(body: JsonRecord): Promise<CameraShoppingAnalysis> {
  if (!OPENAI_API_KEY) {
    throw new Error("Camera shopping analysis is not configured");
  }
  const imageBase64 =
    typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
  if (
    !imageBase64 ||
    imageBase64.length > 3_500_000 ||
    !/^[A-Za-z0-9+/=\r\n]+$/.test(imageBase64)
  ) {
    throw new Error("A valid JPEG camera frame is required");
  }
  const detectedBarcode = cleanBarcode(body.barcode);
  const prompt = [
    "Analyse this single Raspberry Pi camera frame for a UK household shopping list.",
    "It may show one packaged product, loose groceries, a barcode, a handwritten list, or a receipt.",
    "Return only products that are visibly supported by the image. Do not invent obscured text or ingredients.",
    "For a product, make `text` a concise buyable item name, including a visible quantity only when useful.",
    "For a handwritten list, transcribe each legible shopping line. For a receipt, infer replenishable grocery products, not prices, totals, discounts, dates, or payment lines.",
    "Use confidence below 0.65 for uncertain candidates and explain the visible evidence briefly.",
    detectedBarcode
      ? `A local barcode scanner read ${detectedBarcode}; include it as barcode and use it as supporting evidence.`
      : "If barcode digits are clearly legible, return them; otherwise barcode must be null.",
  ].join(" ");
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      store: false,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${imageBase64}`,
              detail: "high",
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "camera_shopping_analysis",
          description:
            "Grounded shopping products visible in a household camera frame.",
          strict: true,
          schema: CAMERA_ANALYSIS_SCHEMA,
        },
      },
    }),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });
  const responseText = await response.text();
  let payload: unknown = {};
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`Camera analysis returned an invalid response (${response.status})`);
  }
  if (!response.ok) {
    const error = asRecord(asRecord(payload).error);
    const message = typeof error.message === "string" ? error.message : "";
    throw new Error(
      `Camera analysis failed (${response.status})${message ? `: ${message}` : ""}`,
    );
  }
  const outputText = extractOpenAiOutputText(payload);
  if (!outputText) throw new Error("Camera analysis returned no result");
  try {
    return normalizeCameraAnalysis(JSON.parse(outputText));
  } catch {
    throw new Error("Camera analysis returned invalid structured data");
  }
}

function homeAssistantWebSocketUrl(): string {
  const url = new URL(HOME_ASSISTANT_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/websocket";
  url.search = "";
  return url.toString();
}

function scheduleHomeAssistantReconnect(): void {
  if (homeAssistantReconnectTimer) return;
  homeAssistantReconnectTimer = setTimeout(() => {
    homeAssistantReconnectTimer = null;
    connectHomeAssistantEvents();
  }, 2_500);
  homeAssistantReconnectTimer.unref();
}

function connectHomeAssistantEvents(): void {
  if (
    !HOME_ASSISTANT_TOKEN ||
    homeAssistantSocket?.readyState === WebSocket.OPEN ||
    homeAssistantSocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }
  let socket: WebSocket;
  try {
    socket = new WebSocket(homeAssistantWebSocketUrl());
  } catch (error) {
    console.error(`Home Assistant event connection failed: ${safeError(error)}`);
    scheduleHomeAssistantReconnect();
    return;
  }
  homeAssistantSocket = socket;
  socket.addEventListener("message", (message) => {
    let frame: JsonRecord;
    try {
      frame = asRecord(JSON.parse(String(message.data)));
    } catch {
      return;
    }
    if (frame.type === "auth_required") {
      socket.send(
        JSON.stringify({ type: "auth", access_token: HOME_ASSISTANT_TOKEN }),
      );
      return;
    }
    if (frame.type === "auth_ok") {
      socket.send(
        JSON.stringify({
          id: 1,
          type: "subscribe_events",
          event_type: "shopping_list_updated",
        }),
      );
      socket.send(
        JSON.stringify({
          id: 2,
          type: "subscribe_events",
          event_type: "state_changed",
        }),
      );
      console.log("Home Assistant shopping and household events connected");
      return;
    }
    if (frame.type === "auth_invalid") {
      console.error("Home Assistant event authentication failed");
      socket.close();
      return;
    }
    if (frame.type !== "event") return;
    const event = asRecord(frame.event);
    const data = asRecord(event.data);
    if (event.event_type === "state_changed") {
      const entityId =
        typeof data.entity_id === "string" ? data.entity_id : "";
      const oldStateValue = asRecord(data.old_state).state;
      const newStateValue = asRecord(data.new_state).state;
      const oldState =
        typeof oldStateValue === "string" ? oldStateValue : "";
      const newState =
        typeof newStateValue === "string" ? newStateValue : "";
      if (entityId && newState) {
        void maybeSendShoppingArrivalReminder(entityId, oldState, newState).catch(
          (error) => {
            console.error(`Could not send shopping reminder: ${safeError(error)}`);
          },
        );
      }
      return;
    }
    if (event.event_type !== "shopping_list_updated") return;
    const item = asRecord(data.item);
    const action = typeof data.action === "string" ? data.action : "updated";
    const itemId =
      typeof item.id === "string"
        ? item.id
        : typeof item.uid === "string"
          ? item.uid
          : undefined;
    const text =
      typeof item.name === "string"
        ? cleanItemText(item.name)
        : typeof item.summary === "string"
          ? cleanItemText(item.summary)
          : undefined;
    void getShoppingSnapshot()
      .then((snapshot) => {
        let activity: ShoppingActivity | undefined;
        if (!wasRecentLocalShoppingEvent(action, itemId)) {
          activity = recordShoppingActivity({
            action,
            source: "home-assistant",
            itemId,
            text,
          });
        }
        broadcastShoppingSnapshot(snapshot, activity);
      })
      .catch((error) => {
        console.error(`Could not refresh shopping event: ${safeError(error)}`);
      });
  });
  socket.addEventListener("close", () => {
    if (homeAssistantSocket === socket) homeAssistantSocket = null;
    scheduleHomeAssistantReconnect();
  });
  socket.addEventListener("error", () => {
    socket.close();
  });
}

async function openShoppingEventStream(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  shoppingEventClients.add(response);
  sendShoppingEvent(response, "connected", {
    at: new Date().toISOString(),
    homeAssistantConnected:
      homeAssistantSocket?.readyState === WebSocket.OPEN,
  });
  try {
    sendShoppingEvent(response, "snapshot", await getShoppingSnapshot());
  } catch (error) {
    sendShoppingEvent(response, "error", { error: safeError(error) });
  }
  const cleanup = () => shoppingEventClients.delete(response);
  request.on("close", cleanup);
  response.on("close", cleanup);
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
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    instanceId: randomUUID(),
    // This is a persistent headless broker, not the browser control UI.
    // Advertising the UI identity makes the gateway enforce bundled UI build IDs.
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Pi touchscreen voice broker",
    clientVersion: "1.0.0",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
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

async function readJson(
  request: IncomingMessage,
  limit = BODY_LIMIT,
): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body is too large");
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
  const requestUrl = new URL(request.url || "/", "http://voice-broker.local");
  const path = requestUrl.pathname;
  if (request.method === "GET" && path === "/health") {
    sendJson(response, gatewayReady ? 200 : 503, {
      ok: gatewayReady,
      service: "openclaw-voice-broker",
      shoppingConfigured: Boolean(HOME_ASSISTANT_URL && HOME_ASSISTANT_TOKEN),
      cameraAnalysisConfigured: Boolean(OPENAI_API_KEY),
      cameraAnalysisModel: OPENAI_VISION_MODEL,
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
  if (request.method === "GET" && path === "/household") {
    try {
      sendJson(response, 200, await getHouseholdHub());
    } catch (error) {
      sendJson(response, 502, { error: safeError(error) });
    }
    return;
  }
  if (request.method === "GET" && path === "/shopping/events") {
    await openShoppingEventStream(request, response);
    return;
  }
  if (request.method === "GET" && path === "/shopping/activity") {
    const requestedLimit = Number.parseInt(
      requestUrl.searchParams.get("limit") || "20",
      10,
    );
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 100))
      : 20;
    sendJson(response, 200, {
      activities: shoppingActivities.slice(-limit).reverse(),
    });
    return;
  }
  if (request.method === "GET" && path === "/shopping/household") {
    try {
      sendJson(response, 200, await getShoppingHousehold());
    } catch (error) {
      sendJson(response, 502, { error: safeError(error) });
    }
    return;
  }
  if (request.method === "POST" && path === "/shopping/camera/analyze") {
    try {
      const body = await readJson(request, CAMERA_BODY_LIMIT);
      sendJson(response, 200, await analyzeShoppingCamera(body));
    } catch (error) {
      const message = safeError(error);
      const status = message.includes("required") ? 400 : 502;
      sendJson(response, status, { error: message });
    }
    return;
  }
  if (
    request.method === "POST" &&
    (path === "/shopping/share" || path === "/shopping/household")
  ) {
    const body = await readJson(request);
    try {
      sendJson(
        response,
        200,
        path === "/shopping/share"
          ? await shareShoppingList(body.source, body.notifyService)
          : await updateShoppingHousehold(body),
      );
    } catch (error) {
      const message = safeError(error);
      const status =
        message.includes("Choose") || message.includes("configured") ? 400 : 502;
      sendJson(response, status, { error: message });
    }
    return;
  }
  if (request.method === "POST" && path === "/household/control") {
    const body = await readJson(request);
    try {
      sendJson(response, 200, await toggleHouseholdControl(body));
    } catch (error) {
      const message = safeError(error);
      sendJson(response, message.includes("not available") ? 400 : 502, {
        error: message,
      });
    }
    return;
  }

  const shoppingItemPrefix = "/shopping/items/";
  const isShoppingWrite =
    (request.method === "POST" && path === "/shopping/items") ||
    (request.method === "POST" && path === "/shopping/items/batch") ||
    (request.method === "POST" && path === "/shopping/reconcile") ||
    (request.method === "POST" && path === "/shopping/organize") ||
    (request.method === "POST" && path === "/shopping/clear-completed") ||
    ((request.method === "PATCH" || request.method === "DELETE") &&
      path.startsWith(shoppingItemPrefix));
  if (isShoppingWrite) {
    const body = await readJson(request);
    try {
      if (request.method === "POST" && path === "/shopping/items") {
        sendJson(response, 200, await addShoppingItem(body.text, body.source));
        return;
      }
      if (request.method === "POST" && path === "/shopping/items/batch") {
        sendJson(
          response,
          200,
          await addShoppingItems(body.items, body.source),
        );
        return;
      }
      if (request.method === "POST" && path === "/shopping/reconcile") {
        sendJson(
          response,
          200,
          await reconcileShoppingItems(
            body.items,
            body.commit === true,
            body.source,
          ),
        );
        return;
      }
      if (request.method === "POST" && path === "/shopping/organize") {
        sendJson(response, 200, await organizeShoppingItems(body.source));
        return;
      }
      if (request.method === "POST" && path === "/shopping/clear-completed") {
        sendJson(
          response,
          200,
          await clearCompletedShoppingItems(body.source),
        );
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
      sendJson(response, 200, await removeShoppingItem(id, body.source));
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
      // The kiosk microphone is close to a speaker and lives in a shared room.
      // Bias VAD toward a nearby speaker while retaining a natural pause length.
      vadThreshold: TOUCHSCREEN_VAD_THRESHOLD,
      silenceDurationMs: TOUCHSCREEN_VAD_SILENCE_MS,
      prefixPaddingMs: TOUCHSCREEN_VAD_PREFIX_MS,
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
    connectHomeAssistantEvents();
    void connectGateway().catch((error) => {
      console.error(`Initial OpenClaw connection failed: ${safeError(error)}`);
    });
  });
}

const shoppingHeartbeat = setInterval(() => {
  for (const response of shoppingEventClients) {
    try {
      response.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      shoppingEventClients.delete(response);
    }
  }
}, 15_000);
shoppingHeartbeat.unref();

function shutdown(): void {
  gateway?.stop();
  homeAssistantSocket?.close();
  if (homeAssistantReconnectTimer) clearTimeout(homeAssistantReconnectTimer);
  clearInterval(shoppingHeartbeat);
  for (const response of shoppingEventClients) response.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
