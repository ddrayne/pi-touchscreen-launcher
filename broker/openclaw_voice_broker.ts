#!/usr/bin/env node
/**
 * Narrow LAN broker for the kitchen screen.
 *
 * The Home Assistant token stays on this Mac. The Pi receives only the narrow
 * results it needs: the canonical shopping list, household summary, weather,
 * the kitchen speaker's now-playing state, and whether anyone is in the
 * kitchen. Voice is handled by the Pi's Home Assistant satellite, so this
 * broker has no dependency on OpenClaw.
 */

import { createHash, randomUUID } from "node:crypto";
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

const HOST = process.env.VOICE_BROKER_HOST?.trim() || "0.0.0.0";
const PORT = Number.parseInt(process.env.VOICE_BROKER_PORT || "18890", 10);
const ALLOWED_IPS = new Set(
  (process.env.VOICE_BROKER_ALLOWED_IPS || "127.0.0.1,::1,192.168.86.232")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const BODY_LIMIT = 128 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
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
const KITCHEN_MEDIA_ENTITY = /^media_player\.[a-z0-9_]+$/.test(
  process.env.KITCHEN_MEDIA_ENTITY?.trim() || "",
)
  ? (process.env.KITCHEN_MEDIA_ENTITY as string).trim()
  : "media_player.kitchen_kitchen";
const KITCHEN_PRESENCE_ENTITIES = (
  process.env.KITCHEN_PRESENCE_ENTITIES ||
  "binary_sensor.kitchen_motion_sensor_motion,binary_sensor.kitchen_motion"
)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => /^binary_sensor\.[a-z0-9_]+$/.test(entry));
const KITCHEN_ILLUMINANCE_ENTITY = /^sensor\.[a-z0-9_]+$/.test(
  process.env.KITCHEN_ILLUMINANCE_ENTITY?.trim() || "",
)
  ? (process.env.KITCHEN_ILLUMINANCE_ENTITY as string).trim()
  : "sensor.kitchen_motion_sensor_illuminance";
const OPEN_METEO_URL = (
  process.env.OPEN_METEO_URL?.trim() || "https://api.open-meteo.com/v1/forecast"
).replace(/\/+$/, "");
const WEATHER_CACHE_MS = 10 * 60_000;
const MEDIA_ART_LIMIT = 4 * 1024 * 1024;

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
type ShoppingReminderSettings = {
  enabled: boolean;
  zoneEntityId: string | null;
  personEntityId: string;
  notifyService: string;
};

const shoppingEventClients = new Set<ServerResponse>();
const homeEventClients = new Set<ServerResponse>();
const presenceStates = new Map<string, { on: boolean; changedAt: string | null }>();
let presenceLoaded = false;
let illuminanceLux: number | null = null;
let mediaEntityPicture: string | null = null;
let lastMediaJson = "";
let homeLocation: { latitude: number; longitude: number } | null = null;
let weatherCache: { at: number; value: JsonRecord } | null = null;
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

function sendSseEvent(
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
      if (activity) sendSseEvent(response, "activity", activity);
      sendSseEvent(response, "snapshot", snapshot);
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
        }
      : null,
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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberAt(values: unknown, index: number): number | null {
  return Array.isArray(values) ? finiteNumber(values[index]) : null;
}

function stringAt(values: unknown, index: number): string | null {
  return Array.isArray(values) && typeof values[index] === "string"
    ? (values[index] as string)
    : null;
}

function envCoordinate(name: string, limit: number): number | null {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

async function getHomeLocation(): Promise<{ latitude: number; longitude: number }> {
  if (homeLocation) return homeLocation;
  const latitude = envCoordinate("WEATHER_LATITUDE", 90);
  const longitude = envCoordinate("WEATHER_LONGITUDE", 180);
  if (latitude !== null && longitude !== null) {
    homeLocation = { latitude, longitude };
    return homeLocation;
  }
  const zone = asRecord(await homeAssistantJson("/api/states/zone.home"));
  const attributes = asRecord(zone.attributes);
  const zoneLatitude = finiteNumber(attributes.latitude);
  const zoneLongitude = finiteNumber(attributes.longitude);
  if (zoneLatitude === null || zoneLongitude === null) {
    throw new Error("Home Assistant has no home location for the forecast");
  }
  homeLocation = { latitude: zoneLatitude, longitude: zoneLongitude };
  return homeLocation;
}

/**
 * The next 16 hours of Open-Meteo's forecast for the home zone. Open-Meteo is
 * free, needs no key, and gives an hourly chance of rain, which Home
 * Assistant's default Met.no weather entity does not.
 */
async function getWeather(): Promise<JsonRecord> {
  if (weatherCache && Date.now() - weatherCache.at < WEATHER_CACHE_MS) {
    return weatherCache.value;
  }
  try {
    const { latitude, longitude } = await getHomeLocation();
    const url = new URL(OPEN_METEO_URL);
    url.search = new URLSearchParams({
      latitude: latitude.toFixed(4),
      longitude: longitude.toFixed(4),
      current: "temperature_2m,weather_code,is_day",
      hourly: "temperature_2m,precipitation_probability,precipitation,weather_code",
      daily: "temperature_2m_max,temperature_2m_min,sunrise,sunset",
      timezone: "auto",
      forecast_days: "2",
    }).toString();
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(HOME_ASSISTANT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Open-Meteo request failed (${response.status})`);
    const forecast = asRecord(await response.json());
    const current = asRecord(forecast.current);
    const hourly = asRecord(forecast.hourly);
    const daily = asRecord(forecast.daily);
    const currentHour = typeof current.time === "string" ? current.time.slice(0, 13) : "";
    const times = Array.isArray(hourly.time) ? hourly.time : [];
    const hours = times
      .flatMap((time, index): JsonRecord[] => {
        if (typeof time !== "string") return [];
        if (currentHour && time.slice(0, 13) < currentHour) return [];
        return [
          {
            time,
            temperature: numberAt(hourly.temperature_2m, index),
            precipitationProbability: numberAt(hourly.precipitation_probability, index),
            precipitation: numberAt(hourly.precipitation, index),
            weatherCode: numberAt(hourly.weather_code, index),
          },
        ];
      })
      .slice(0, 16);
    const value: JsonRecord = {
      now: {
        temperature: finiteNumber(current.temperature_2m),
        weatherCode: finiteNumber(current.weather_code),
        isDay: current.is_day !== 0,
      },
      today: {
        high: numberAt(daily.temperature_2m_max, 0),
        low: numberAt(daily.temperature_2m_min, 0),
        sunrise: stringAt(daily.sunrise, 0),
        sunset: stringAt(daily.sunset, 0),
      },
      hours,
      updatedAt: new Date().toISOString(),
    };
    weatherCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    if (weatherCache) return { ...weatherCache.value, stale: true };
    throw error;
  }
}

async function getEntityState(entityId: string): Promise<JsonRecord | null> {
  try {
    return asRecord(await homeAssistantJson(`/api/states/${entityId}`));
  } catch (error) {
    if (safeError(error).includes("(404)")) return null;
    throw error;
  }
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? cleanItemText(value) || null : null;
}

/** What the kitchen speaker is doing, without exposing Home Assistant URLs or tokens. */
function mediaSnapshot(state: JsonRecord | null): JsonRecord {
  const attributes = asRecord(state?.attributes);
  const picture =
    typeof attributes.entity_picture === "string" ? attributes.entity_picture : null;
  mediaEntityPicture = picture;
  return {
    entityId: KITCHEN_MEDIA_ENTITY,
    state: typeof state?.state === "string" ? state.state : "unavailable",
    title: optionalText(attributes.media_title),
    artist: optionalText(attributes.media_artist) ?? optionalText(attributes.media_album_artist),
    album: optionalText(attributes.media_album_name),
    source: optionalText(attributes.app_name) ?? optionalText(attributes.source),
    volume: finiteNumber(attributes.volume_level),
    muted: attributes.is_volume_muted === true,
    artVersion: picture
      ? createHash("sha1").update(picture).digest("hex").slice(0, 12)
      : null,
  };
}

async function getMedia(): Promise<JsonRecord> {
  return mediaSnapshot(await getEntityState(KITCHEN_MEDIA_ENTITY));
}

const MEDIA_SERVICES: Record<string, string> = {
  play_pause: "media_play_pause",
  next: "media_next_track",
  previous: "media_previous_track",
};

async function controlMedia(body: JsonRecord): Promise<JsonRecord> {
  const action = typeof body.action === "string" ? body.action : "";
  if (action === "volume") {
    const volume = finiteNumber(body.volume);
    if (volume === null) throw new Error("A volume between 0 and 1 is required");
    await homeAssistantJson("/api/services/media_player/volume_set", {
      entity_id: KITCHEN_MEDIA_ENTITY,
      volume_level: Math.max(0, Math.min(1, volume)),
    });
    return { ok: true };
  }
  const service = MEDIA_SERVICES[action];
  if (!service) throw new Error("That media action is not supported");
  await homeAssistantJson(`/api/services/media_player/${service}`, {
    entity_id: KITCHEN_MEDIA_ENTITY,
  });
  return { ok: true };
}

/** Album art comes through Home Assistant's media proxy, which needs the token. */
async function sendMediaArt(response: ServerResponse): Promise<void> {
  if (!mediaEntityPicture) await getMedia();
  const picture = mediaEntityPicture;
  const fromHomeAssistant = Boolean(picture?.startsWith("/api/"));
  const url = fromHomeAssistant ? `${HOME_ASSISTANT_URL}${picture}` : picture || "";
  if (!fromHomeAssistant && !/^https:\/\//.test(url)) {
    sendJson(response, 404, { error: "There is no artwork for the kitchen speaker" });
    return;
  }
  const upstream = await fetch(url, {
    headers: fromHomeAssistant ? { Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}` } : {},
    signal: AbortSignal.timeout(HOME_ASSISTANT_TIMEOUT_MS),
  });
  const contentType = upstream.headers.get("content-type") || "";
  const body = Buffer.from(await upstream.arrayBuffer());
  if (!upstream.ok || !contentType.startsWith("image/") || body.length > MEDIA_ART_LIMIT) {
    sendJson(response, 502, { error: "The artwork could not be loaded" });
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    "Cache-Control": "private, max-age=600",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function readLux(state: JsonRecord | null): number | null {
  const value = Number.parseFloat(typeof state?.state === "string" ? state.state : "");
  return Number.isFinite(value) ? Math.round(value) : null;
}

function rememberPresence(entityId: string, state: JsonRecord | null): void {
  const value = state?.state;
  if (!state || value === "unavailable" || value === "unknown") {
    presenceStates.delete(entityId);
    return;
  }
  presenceStates.set(entityId, {
    on: value === "on",
    changedAt: typeof state.last_changed === "string" ? state.last_changed : null,
  });
}

/** Whether anyone is in the kitchen; the screen sleeps a while after it empties. */
function presenceSnapshot(): JsonRecord {
  const sensors = [...presenceStates.values()];
  const changedAt =
    sensors
      .map((sensor) => sensor.changedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  return {
    known: presenceLoaded && sensors.length > 0,
    occupied: sensors.some((sensor) => sensor.on),
    changedAt,
    illuminance: illuminanceLux,
  };
}

async function loadHomeState(): Promise<JsonRecord> {
  const [presence, illuminance, media] = await Promise.all([
    Promise.all(
      KITCHEN_PRESENCE_ENTITIES.map(
        async (entityId) => [entityId, await getEntityState(entityId)] as const,
      ),
    ),
    getEntityState(KITCHEN_ILLUMINANCE_ENTITY).catch(() => null),
    getEntityState(KITCHEN_MEDIA_ENTITY),
  ]);
  for (const [entityId, state] of presence) rememberPresence(entityId, state);
  presenceLoaded = true;
  illuminanceLux = readLux(illuminance);
  const mediaState = mediaSnapshot(media);
  lastMediaJson = JSON.stringify(mediaState);
  return { presence: presenceSnapshot(), media: mediaState };
}

function broadcastHomeEvent(event: string, data: unknown): void {
  for (const response of homeEventClients) {
    try {
      sendSseEvent(response, event, data);
    } catch {
      homeEventClients.delete(response);
    }
  }
}

function handleHomeStateChange(entityId: string, newState: JsonRecord): void {
  if (KITCHEN_PRESENCE_ENTITIES.includes(entityId)) {
    const before = JSON.stringify(presenceSnapshot());
    rememberPresence(entityId, newState);
    presenceLoaded = true;
    const after = presenceSnapshot();
    if (JSON.stringify(after) !== before) broadcastHomeEvent("presence", after);
    return;
  }
  if (entityId === KITCHEN_ILLUMINANCE_ENTITY) {
    const lux = readLux(newState);
    if (lux !== illuminanceLux) {
      illuminanceLux = lux;
      broadcastHomeEvent("presence", presenceSnapshot());
    }
    return;
  }
  if (entityId === KITCHEN_MEDIA_ENTITY) {
    // Players report their position constantly; only real changes are sent on.
    const media = mediaSnapshot(newState);
    const json = JSON.stringify(media);
    if (json !== lastMediaJson) {
      lastMediaJson = json;
      broadcastHomeEvent("media", media);
    }
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
      // Presence and media may have changed while the socket was down.
      refreshHomeClients();
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
        handleHomeStateChange(entityId, asRecord(data.new_state));
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
    // A close event always follows and schedules the reconnect. Calling
    // close() here re-enters the failing handshake and overflows the stack.
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
  sendSseEvent(response, "connected", {
    at: new Date().toISOString(),
    homeAssistantConnected:
      homeAssistantSocket?.readyState === WebSocket.OPEN,
  });
  try {
    sendSseEvent(response, "snapshot", await getShoppingSnapshot());
  } catch (error) {
    sendSseEvent(response, "error", { error: safeError(error) });
  }
  const cleanup = () => shoppingEventClients.delete(response);
  request.on("close", cleanup);
  response.on("close", cleanup);
}

/** Kitchen presence and the kitchen speaker, pushed to the screen as they change. */
async function openHomeEventStream(
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
  homeEventClients.add(response);
  const cleanup = () => homeEventClients.delete(response);
  request.on("close", cleanup);
  response.on("close", cleanup);
  try {
    sendSseEvent(response, "snapshot", await loadHomeState());
  } catch (error) {
    // Not "error": EventSource treats an event by that name as a broken stream.
    sendSseEvent(response, "unavailable", { error: safeError(error) });
  }
}

/** Resends everything after Home Assistant's event socket (re)connects. */
function refreshHomeClients(): void {
  loadHomeState()
    .then((state) => broadcastHomeEvent("snapshot", state))
    .catch((error) => broadcastHomeEvent("unavailable", { error: safeError(error) }));
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
    sendJson(response, 200, {
      ok: true,
      service: "kitchen-home-broker",
      homeAssistantConfigured: Boolean(HOME_ASSISTANT_URL && HOME_ASSISTANT_TOKEN),
      homeAssistantConnected: homeAssistantSocket?.readyState === WebSocket.OPEN,
    });
    return;
  }
  if (request.method === "GET" && path === "/weather") {
    try {
      sendJson(response, 200, await getWeather());
    } catch (error) {
      sendJson(response, 502, { error: safeError(error) });
    }
    return;
  }
  if (request.method === "GET" && path === "/media") {
    try {
      sendJson(response, 200, await getMedia());
    } catch (error) {
      sendJson(response, 502, { error: safeError(error) });
    }
    return;
  }
  if (request.method === "GET" && path === "/media/art") {
    try {
      await sendMediaArt(response);
    } catch (error) {
      if (!response.headersSent) sendJson(response, 502, { error: safeError(error) });
    }
    return;
  }
  if (request.method === "POST" && path === "/media/control") {
    const body = await readJson(request);
    try {
      sendJson(response, 200, await controlMedia(body));
    } catch (error) {
      const message = safeError(error);
      const status =
        message.includes("required") || message.includes("not supported") ? 400 : 502;
      sendJson(response, status, { error: message });
    }
    return;
  }
  if (request.method === "GET" && path === "/home/events") {
    await openHomeEventStream(request, response);
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

  sendJson(response, 404, { error: "Not found" });
}

const server = createServer((request, response) => {
  void route(request, response).catch((error) => {
    console.error(`Kitchen broker request failed: ${safeError(error)}`);
    if (!response.headersSent) sendJson(response, 502, { error: safeError(error) });
    else response.end();
  });
});
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = 15_000;

server.listen(PORT, HOST, () => {
  console.log(`Kitchen broker listening on ${HOST}:${PORT}`);
  connectHomeAssistantEvents();
});

const eventHeartbeat = setInterval(() => {
  for (const clients of [shoppingEventClients, homeEventClients]) {
    for (const response of clients) {
      try {
        response.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        clients.delete(response);
      }
    }
  }
}, 15_000);
eventHeartbeat.unref();

function shutdown(): void {
  homeAssistantSocket?.close();
  if (homeAssistantReconnectTimer) clearTimeout(homeAssistantReconnectTimer);
  clearInterval(eventHeartbeat);
  for (const response of [...shoppingEventClients, ...homeEventClients]) response.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
