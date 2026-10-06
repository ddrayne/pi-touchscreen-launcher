"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  InlineRealtimeVoice,
  type InlineVoiceStatus,
} from "../lib/realtimeVoice";
import {
  updateVoiceConversation,
  type VoiceConversationEntry,
} from "../lib/voiceConversation";
import { useFrameClock } from "../lib/frame/clock";
import { playClip, stopClip } from "../lib/frame/clips";
import {
  DEFAULT_FRAME_CONFIG,
  loadFrameConfig,
  type FrameConfig,
} from "../lib/frame/config";
import { gardenContext } from "../lib/frame/context";
import { tierWord } from "../lib/frame/scene";
import { useBirdframeStream } from "../lib/frame/stream";
import { Frame, type FrameMode } from "./frame/Frame";

const FRAME_WIDTH = 1200;
const FRAME_HEIGHT = 1920;
const HOME_IDLE_MS = 90_000;

function initialMode(): FrameMode {
  if (typeof window === "undefined") return "frame";
  const requested = new URLSearchParams(window.location.search).get("mode");
  return requested === "home" || requested === "conversation" ? requested : "frame";
}

function greetingFor(at: number): string {
  const hour = new Date(at).getHours();
  if (hour < 5) return "Still up?";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Goodnight";
}

type ApplianceStatus = {
  gatewayReady?: boolean;
  voiceReady?: boolean;
  birdframeReady?: boolean;
  birdframeRunning?: boolean;
  wakeReady?: boolean;
  shoppingReady?: boolean;
};

type WakeStatus = {
  pending?: boolean;
  sequence?: number;
  muted?: boolean;
};

function VoiceTranscriptText({ entry }: { entry: VoiceConversationEntry }) {
  const settledLength =
    entry.streaming && typeof entry.revealFrom === "number"
      ? Math.min(entry.text.length, Math.max(0, entry.revealFrom))
      : entry.text.length;
  const settled = entry.text.slice(0, settledLength);
  const arriving = entry.text.slice(settledLength);

  return (
    <span className="assistant__utterance-copy">
      {settled}
      {arriving ? (
        <span
          className="assistant__stream-chunk"
          key={`${entry.text.length}:${arriving}`}
        >
          {arriving}
        </span>
      ) : null}
    </span>
  );
}

type ShoppingItem = {
  id: string;
  text: string;
  completed: boolean;
  name?: string;
  quantity?: number;
  unit?: string;
  category?:
    | "produce"
    | "bakery"
    | "chilled"
    | "meat-fish"
    | "pantry"
    | "drinks"
    | "household"
    | "personal"
    | "other";
};

type ShoppingSnapshot = {
  items: ShoppingItem[];
  activeCount: number;
  completedCount: number;
  syncedAt?: string;
  source?: string;
  revision?: string;
  outcome?: string;
};

type ShoppingActivity = {
  id: string;
  at: string;
  action: string;
  source: string;
  text?: string;
  detail?: string;
};

type ShoppingOperation = {
  id: string;
  at: string;
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body: Record<string, unknown>;
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

type ShoppingReconciliation = {
  proposed: string[];
  missing: string[];
  alreadyListed: string[];
  committed: boolean;
  snapshot: ShoppingSnapshot;
};

type ShoppingHousehold = {
  settings: {
    enabled: boolean;
    zoneEntityId: string | null;
    personEntityId: string;
    notifyService: string;
  };
  zones: Array<{ entityId: string; name: string }>;
  people: Array<{ entityId: string; name: string }>;
  notificationTargets: Array<{ service: string; name: string }>;
};

type ShoppingShareResult = {
  sentTo: string;
  snapshot: ShoppingSnapshot;
};

type HouseholdHub = {
  weather: {
    entityId: string;
    name: string;
    condition: string;
    temperature: number | null;
    unit: string;
    humidity: number | null;
    cloudCoverage?: number | null;
    windSpeed?: number | null;
    windSpeedUnit?: string | null;
    windBearing?: number | null;
  } | null;
  events: Array<{
    calendar: string;
    summary: string;
    start: string;
    end: string;
    allDay: boolean;
  }>;
  controls: Array<{
    entityId: string;
    name: string;
    state: string;
    active: boolean;
  }>;
  refreshedAt: string;
};

const emptyShopping: ShoppingSnapshot = {
  items: [],
  activeCount: 0,
  completedCount: 0,
};

const shoppingOutboxKey = "touchscreen-shopping-outbox";

class ShoppingRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readShoppingResponse(response: Response): Promise<ShoppingSnapshot> {
  const result = (await response.json().catch(() => ({}))) as ShoppingSnapshot & {
    error?: string;
  };
  if (!response.ok) {
    throw new ShoppingRequestError(
      result.error || "The shopping list is unavailable",
      response.status,
    );
  }
  if (
    !Array.isArray(result.items) ||
    typeof result.activeCount !== "number" ||
    typeof result.completedCount !== "number"
  ) {
    throw new ShoppingRequestError("The shopping list returned invalid data", 502);
  }
  return result;
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const result = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new ShoppingRequestError(
      result.error || "The request could not be completed",
      response.status,
    );
  }
  return result;
}

function readShoppingOutbox(): ShoppingOperation[] {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(shoppingOutboxKey) || "[]",
    ) as ShoppingOperation[];
    return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
  } catch {
    return [];
  }
}

function writeShoppingOutbox(operations: ShoppingOperation[]): void {
  window.localStorage.setItem(
    shoppingOutboxKey,
    JSON.stringify(operations.slice(-100)),
  );
}

function createShoppingOperation(
  path: string,
  method: ShoppingOperation["method"],
  body: Record<string, unknown>,
): ShoppingOperation {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    path,
    method,
    body: { ...body, source: "touchscreen" },
  };
}

function isRetryableShoppingError(error: unknown): boolean {
  return (
    !(error instanceof ShoppingRequestError) ||
    error.status >= 500 ||
    error.status === 408 ||
    error.status === 429
  );
}

const shoppingCategoryOrder: Array<NonNullable<ShoppingItem["category"]>> = [
  "produce",
  "bakery",
  "chilled",
  "meat-fish",
  "pantry",
  "drinks",
  "household",
  "personal",
  "other",
];

const shoppingCategoryLabels: Record<
  NonNullable<ShoppingItem["category"]>,
  string
> = {
  produce: "Fruit & veg",
  bakery: "Bakery",
  chilled: "Chilled",
  "meat-fish": "Meat & fish",
  pantry: "Pantry",
  drinks: "Drinks",
  household: "Household",
  personal: "Personal care",
  other: "Other",
};

function replaceShoppingItems(
  snapshot: ShoppingSnapshot,
  items: ShoppingItem[],
): ShoppingSnapshot {
  return {
    ...snapshot,
    items,
    activeCount: items.filter((item) => !item.completed).length,
    completedCount: items.filter((item) => item.completed).length,
  };
}

function timeAgo(seconds: number | undefined): string {
  if (typeof seconds !== "number" || seconds < 0) return "waiting for a call";
  if (seconds < 60) return "heard just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "heard a minute ago";
  if (minutes < 60) return `heard ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return `heard ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

function formatClock(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

function formatDate(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
}

function weatherSymbol(condition: string | undefined): string {
  if (!condition) return "○";
  if (condition.includes("lightning")) return "ϟ";
  if (condition.includes("rain") || condition.includes("pour")) return "☂";
  if (condition.includes("snow") || condition.includes("hail")) return "✣";
  if (condition.includes("cloud") || condition.includes("fog")) return "☁";
  if (condition.includes("sun") || condition.includes("clear")) return "☀";
  return "○";
}

function formatHubEventStart(start: string, allDay: boolean): string {
  const date = new Date(allDay ? `${start}T12:00:00` : start);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(date);
}

export function Launcher() {
  const [status, setStatus] = useState<ApplianceStatus>({});
  const [mode, setMode] = useState<FrameMode>(initialMode);
  const [lastTouch, setLastTouch] = useState(0);
  const [frameConfig, setFrameConfig] = useState<FrameConfig>(DEFAULT_FRAME_CONFIG);
  const [playingLatest, setPlayingLatest] = useState(false);
  const frameNow = useFrameClock(1000);
  const stream = useBirdframeStream();
  const [householdHub, setHouseholdHub] = useState<HouseholdHub | null>(null);
  const [hubPage, setHubPage] = useState<0 | 1>(0);
  const [hubBusy, setHubBusy] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<InlineVoiceStatus>("idle");
  const [voiceDetail, setVoiceDetail] = useState<string | null>(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [conversation, setConversation] = useState<VoiceConversationEntry[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraFrame, setCameraFrame] = useState(() => Date.now());
  const [cameraAnalysis, setCameraAnalysis] =
    useState<CameraShoppingAnalysis | null>(null);
  const [cameraSelectedItems, setCameraSelectedItems] = useState<string[]>([]);
  const [cameraBusy, setCameraBusy] = useState<"analyze" | "add" | null>(null);
  const [cameraNotice, setCameraNotice] = useState<string | null>(null);
  const [shopping, setShopping] = useState<ShoppingSnapshot>(emptyShopping);
  const [shoppingLoaded, setShoppingLoaded] = useState(false);
  const [shoppingOpen, setShoppingOpen] = useState(false);
  const [shoppingError, setShoppingError] = useState<string | null>(null);
  const [shoppingNotice, setShoppingNotice] = useState<string | null>(null);
  const [shoppingBusy, setShoppingBusy] = useState<string | null>(null);
  const [shoppingOnline, setShoppingOnline] = useState(true);
  const [shoppingPendingCount, setShoppingPendingCount] = useState(0);
  const [shoppingActivities, setShoppingActivities] = useState<
    ShoppingActivity[]
  >([]);
  const [shoppingHousehold, setShoppingHousehold] =
    useState<ShoppingHousehold | null>(null);
  const [shoppingHouseholdBusy, setShoppingHouseholdBusy] = useState<
    "share" | "settings" | null
  >(null);
  const [newShoppingItem, setNewShoppingItem] = useState("");
  const [editingShoppingItem, setEditingShoppingItem] =
    useState<ShoppingItem | null>(null);
  const lastWakeSequence = useRef(0);
  const contextRef = useRef<() => string | null>(() => null);
  const voiceSession = useRef<InlineRealtimeVoice | null>(null);
  const newShoppingItemInput = useRef<HTMLInputElement | null>(null);
  const flushingShoppingOutbox = useRef(false);
  const swipeStart = useRef<number | null>(null);
  const voiceActive = voiceState !== "idle";

  const muteWake = useCallback((seconds: number) => {
    void fetch("/api/wake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mute", seconds }),
    }).catch(() => undefined);
  }, []);

  const acceptShoppingSnapshot = useCallback((result: ShoppingSnapshot) => {
    if (
      !Array.isArray(result.items) ||
      typeof result.activeCount !== "number" ||
      typeof result.completedCount !== "number"
    ) {
      return;
    }
    setShopping(result);
    setShoppingLoaded(true);
    setShoppingOnline(true);
    setShoppingError(null);
    try {
      window.localStorage.setItem(
        "touchscreen-shopping-list",
        JSON.stringify(result),
      );
    } catch {
      // The live list still works when browser storage is unavailable.
    }
  }, []);

  const refreshShopping = useCallback(async () => {
    try {
      const result = await readShoppingResponse(
        await fetch("/api/shopping", { cache: "no-store" }),
      );
      acceptShoppingSnapshot(result);
    } catch (error) {
      setShoppingLoaded(true);
      setShoppingOnline(false);
      setShoppingError(error instanceof Error ? error.message : String(error));
    }
  }, [acceptShoppingSnapshot]);

  const queueShoppingOperation = useCallback((operation: ShoppingOperation) => {
    const operations = [...readShoppingOutbox(), operation];
    writeShoppingOutbox(operations);
    setShoppingPendingCount(operations.length);
    setShoppingOnline(false);
  }, []);

  const flushShoppingOutbox = useCallback(async () => {
    if (flushingShoppingOutbox.current) return;
    flushingShoppingOutbox.current = true;
    try {
      const operations = readShoppingOutbox();
      const remaining = [...operations];
      for (const operation of operations) {
        try {
          const result = await readShoppingResponse(
            await fetch(operation.path, {
              method: operation.method,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(operation.body),
            }),
          );
          acceptShoppingSnapshot(result);
          remaining.shift();
          writeShoppingOutbox(remaining);
          setShoppingPendingCount(remaining.length);
        } catch (error) {
          if (!isRetryableShoppingError(error)) {
            remaining.shift();
            writeShoppingOutbox(remaining);
            setShoppingPendingCount(remaining.length);
            continue;
          }
          setShoppingOnline(false);
          break;
        }
      }
    } finally {
      flushingShoppingOutbox.current = false;
    }
  }, [acceptShoppingSnapshot]);

  const refresh = useCallback(async () => {
    const [statusResult, householdResult] = await Promise.allSettled([
      fetch("/api/status", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("status unavailable");
        return response.json() as Promise<ApplianceStatus>;
      }),
      fetch("/api/household", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("Household hub unavailable");
        return response.json() as Promise<HouseholdHub>;
      }),
    ]);

    if (statusResult.status === "fulfilled") setStatus(statusResult.value);
    if (householdResult.status === "fulfilled") {
      setHouseholdHub(householdResult.value);
    }
    void refreshShopping();
  }, [refreshShopping]);

  useEffect(() => {
    const loadCachedShopping = window.setTimeout(() => {
      try {
        setShoppingPendingCount(readShoppingOutbox().length);
        const cached = window.localStorage.getItem("touchscreen-shopping-list");
        if (cached) {
          const parsed = JSON.parse(cached) as ShoppingSnapshot;
          if (Array.isArray(parsed.items)) setShopping(parsed);
        }
      } catch {
        // Ignore an absent or invalid last-known snapshot.
      }
    }, 0);
    const initial = window.setTimeout(() => void refresh(), 0);
    const poll = window.setInterval(() => void refresh(), 20_000);
    return () => {
      window.clearTimeout(loadCachedShopping);
      window.clearTimeout(initial);
      window.clearInterval(poll);
    };
  }, [refresh]);

  useEffect(() => {
    const events = new EventSource("/api/shopping/events");
    const onSnapshot = (event: MessageEvent<string>) => {
      try {
        acceptShoppingSnapshot(JSON.parse(event.data) as ShoppingSnapshot);
      } catch {
        // A later event or the fallback poll will recover.
      }
    };
    const onActivity = (event: MessageEvent<string>) => {
      try {
        const activity = JSON.parse(event.data) as ShoppingActivity;
        setShoppingActivities((current) =>
          [activity, ...current.filter((entry) => entry.id !== activity.id)].slice(
            0,
            20,
          ),
        );
      } catch {
        // Ignore malformed event payloads.
      }
    };
    events.addEventListener("snapshot", onSnapshot as EventListener);
    events.addEventListener("activity", onActivity as EventListener);
    events.onopen = () => {
      setShoppingOnline(true);
      void flushShoppingOutbox();
    };
    events.onerror = () => setShoppingOnline(false);
    const onOnline = () => void flushShoppingOutbox();
    window.addEventListener("online", onOnline);
    return () => {
      events.close();
      window.removeEventListener("online", onOnline);
    };
  }, [acceptShoppingSnapshot, flushShoppingOutbox]);

  useEffect(() => {
    if (!shoppingOpen) return;
    void Promise.allSettled([
      fetch("/api/shopping/activity?limit=20", { cache: "no-store" }).then(
        (response) => readApiResponse<{ activities?: ShoppingActivity[] }>(response),
      ),
      fetch("/api/shopping/household", { cache: "no-store" }).then((response) =>
        readApiResponse<ShoppingHousehold>(response),
      ),
    ]).then(([activityResult, householdResult]) => {
      if (
        activityResult.status === "fulfilled" &&
        Array.isArray(activityResult.value.activities)
      ) {
        setShoppingActivities(activityResult.value.activities);
      }
      if (householdResult.status === "fulfilled") {
        setShoppingHousehold(householdResult.value);
      }
    });
  }, [shoppingOpen]);

  const stopVoice = useCallback(() => {
    const current = voiceSession.current;
    voiceSession.current = null;
    current?.stop();
    muteWake(4);
    setVoiceState("idle");
    setVoiceDetail(null);
    setInputLevel(0);
    setMode((previous) => (previous === "conversation" ? "home" : previous));
    setLastTouch(Date.now());
  }, [muteWake]);

  const startVoice = useCallback(async () => {
    if (voiceSession.current) return;
    muteWake(30);
    setConversation([]);
    setMode("conversation");
    setVoiceState("connecting");
    setVoiceDetail("Connecting to OpenClaw");
    const session = new InlineRealtimeVoice({
      onStatus: (nextState, detail) => {
        if (voiceSession.current !== session) return;
        setVoiceState(nextState);
        setVoiceDetail(detail || null);
      },
      onInputLevel: (level) => {
        if (voiceSession.current === session) setInputLevel(level);
      },
      onTranscript: (entry) => {
        if (voiceSession.current === session) {
          setConversation((current) => updateVoiceConversation(current, entry));
        }
      },
      onToolResult: () => {
        if (voiceSession.current === session) void refreshShopping();
      },
      onIdleTimeout: () => {
        if (voiceSession.current === session) stopVoice();
      },
      context: () => contextRef.current(),
    });
    voiceSession.current = session;
    try {
      await session.start();
    } catch (error) {
      if (voiceSession.current !== session) return;
      voiceSession.current = null;
      session.stop();
      muteWake(4);
      setVoiceState("error");
      setVoiceDetail(error instanceof Error ? error.message : String(error));
      setInputLevel(0);
    }
  }, [muteWake, refreshShopping, stopVoice]);

  const toggleVoice = useCallback(() => {
    if (voiceSession.current) stopVoice();
    else void startVoice();
  }, [startVoice, stopVoice]);

  useEffect(() => {
    const watchWake = window.setInterval(() => {
      void fetch("/api/wake", { cache: "no-store" })
        .then((response) => response.json() as Promise<WakeStatus>)
        .then((wake) => {
          const sequence = wake.sequence || 0;
          if (
            wake.pending &&
            sequence > lastWakeSequence.current
          ) {
            lastWakeSequence.current = sequence;
            void startVoice();
            void fetch("/api/wake", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "ack", sequence }),
            });
          }
        })
        .catch(() => undefined);
    }, 900);
    return () => window.clearInterval(watchWake);
  }, [startVoice]);

  useEffect(() => {
    if (!voiceActive) return;
    const keepMuted = window.setInterval(() => muteWake(30), 10_000);
    return () => window.clearInterval(keepMuted);
  }, [muteWake, voiceActive]);

  useEffect(() => () => voiceSession.current?.stop(), []);

  // The frame is a 1200 x 1920 stage; cover the viewport with it.
  useEffect(() => {
    void loadFrameConfig().then(setFrameConfig);
    const fit = () => {
      const scale = Math.max(
        window.innerWidth / FRAME_WIDTH,
        window.innerHeight / FRAME_HEIGHT,
      );
      const root = document.documentElement.style;
      root.setProperty("--frame-scale", scale.toFixed(4));
      root.setProperty(
        "--frame-offset",
        `${((window.innerWidth - FRAME_WIDTH * scale) / 2).toFixed(1)}px`,
      );
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Home stays while it is being used; untouched for a while, the frame returns.
  useEffect(() => {
    if (mode !== "home" || shoppingOpen || cameraOpen || voiceActive) return;
    const timer = window.setTimeout(() => {
      stopClip();
      setPlayingLatest(false);
      setMode("frame");
    }, HOME_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [mode, shoppingOpen, cameraOpen, voiceActive, lastTouch]);

  const closeCamera = useCallback(() => {
    setCameraOpen(false);
    setCameraError(null);
    setCameraAnalysis(null);
    setCameraSelectedItems([]);
    setCameraBusy(null);
    setCameraNotice(null);
  }, []);

  const openCamera = useCallback(() => {
    stopVoice();
    setCameraOpen(true);
    setCameraError(null);
    setCameraAnalysis(null);
    setCameraSelectedItems([]);
    setCameraBusy(null);
    setCameraNotice(null);
    setCameraFrame(Date.now());
  }, [stopVoice]);

  useEffect(() => {
    if (!cameraOpen || cameraAnalysis || cameraBusy === "analyze") return;
    const refreshCamera = window.setInterval(
      () => setCameraFrame(Date.now()),
      2_000,
    );
    return () => window.clearInterval(refreshCamera);
  }, [cameraAnalysis, cameraBusy, cameraOpen]);

  const analyzeCamera = useCallback(async () => {
    if (cameraBusy) return;
    setCameraBusy("analyze");
    setCameraError(null);
    setCameraNotice(null);
    setCameraAnalysis(null);
    setCameraSelectedItems([]);
    setCameraFrame(Date.now());
    try {
      const result = await readApiResponse<CameraShoppingAnalysis>(
        await fetch("/api/shopping/camera/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      setCameraAnalysis(result);
      setCameraSelectedItems(
        result.items
          .filter((item) => item.confidence >= 0.65)
          .map((item) => item.text),
      );
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : String(error));
    } finally {
      setCameraBusy(null);
    }
  }, [cameraBusy]);

  const toggleCameraCandidate = useCallback((text: string) => {
    setCameraSelectedItems((current) =>
      current.includes(text)
        ? current.filter((candidate) => candidate !== text)
        : [...current, text],
    );
  }, []);

  const addCameraItems = useCallback(async () => {
    if (cameraBusy || !cameraSelectedItems.length) return;
    setCameraBusy("add");
    setCameraError(null);
    setCameraNotice(null);
    try {
      const result = await readApiResponse<ShoppingReconciliation>(
        await fetch("/api/shopping/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: cameraSelectedItems,
            commit: true,
            source: "camera",
          }),
        }),
      );
      acceptShoppingSnapshot(result.snapshot);
      setCameraNotice(
        result.missing.length
          ? `${result.missing.length} ${
              result.missing.length === 1 ? "item" : "items"
            } added to the house list.`
          : "Everything selected was already on the house list.",
      );
      setCameraSelectedItems([]);
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : String(error));
    } finally {
      setCameraBusy(null);
    }
  }, [acceptShoppingSnapshot, cameraBusy, cameraSelectedItems]);

  const openBirdframe = useCallback(async () => {
    stopVoice();
    try {
      await fetch("/api/window", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "birdframe" }),
      });
    } catch {
      // The live card remains useful in a desktop preview without the Pi bridge.
    }
  }, [stopVoice]);

  const openShopping = useCallback(
    (focusAdd = false) => {
      stopVoice();
      setShoppingOpen(true);
      setShoppingError(null);
      setShoppingNotice(null);
      void refreshShopping();
      if (focusAdd) {
        window.setTimeout(() => newShoppingItemInput.current?.focus(), 180);
      }
    },
    [refreshShopping, stopVoice],
  );

  const closeShopping = useCallback(() => {
    setShoppingOpen(false);
    setEditingShoppingItem(null);
    setShoppingError(null);
    setShoppingNotice(null);
  }, []);

  const toggleShoppingItem = useCallback(
    async (item: ShoppingItem) => {
      if (shoppingBusy) return;
      setShoppingBusy(item.id);
      setShoppingError(null);
      const operation = createShoppingOperation(
        `/api/shopping/items/${encodeURIComponent(item.id)}`,
        "PATCH",
        { completed: !item.completed },
      );
      setShopping((current) =>
        replaceShoppingItems(
          current,
          current.items.map((entry) =>
            entry.id === item.id
              ? { ...entry, completed: !item.completed }
              : entry,
          ),
        ),
      );
      try {
        const result = await readShoppingResponse(
          await fetch(operation.path, {
            method: operation.method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(operation.body),
          }),
        );
        acceptShoppingSnapshot(result);
      } catch (error) {
        if (isRetryableShoppingError(error)) {
          queueShoppingOperation(operation);
          setShoppingError("Saved offline. This change will sync automatically.");
        } else {
          setShoppingError(error instanceof Error ? error.message : String(error));
          void refreshShopping();
        }
      } finally {
        setShoppingBusy(null);
      }
    },
    [
      acceptShoppingSnapshot,
      queueShoppingOperation,
      refreshShopping,
      shoppingBusy,
    ],
  );

  const addShoppingItem = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = newShoppingItem.trim();
      if (!text || shoppingBusy) return;
      setShoppingBusy("add");
      setShoppingError(null);
      const operation = createShoppingOperation(
        "/api/shopping/items",
        "POST",
        { text },
      );
      try {
        const result = await readShoppingResponse(
          await fetch(operation.path, {
            method: operation.method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(operation.body),
          }),
        );
        acceptShoppingSnapshot(result);
        setNewShoppingItem("");
        window.setTimeout(() => newShoppingItemInput.current?.focus(), 80);
      } catch (error) {
        if (isRetryableShoppingError(error)) {
          queueShoppingOperation(operation);
          setShopping((current) =>
            replaceShoppingItems(current, [
              ...current.items,
              {
                id: `pending:${operation.id}`,
                text,
                name: text,
                completed: false,
                category: "other",
              },
            ]),
          );
          setNewShoppingItem("");
          setShoppingError("Saved offline. This item will sync automatically.");
        } else {
          setShoppingError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setShoppingBusy(null);
      }
    },
    [
      acceptShoppingSnapshot,
      newShoppingItem,
      queueShoppingOperation,
      shoppingBusy,
    ],
  );

  const saveShoppingItem = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!editingShoppingItem || shoppingBusy) return;
      const text = editingShoppingItem.text.trim();
      if (!text) return;
      setShoppingBusy(editingShoppingItem.id);
      setShoppingError(null);
      const operation = createShoppingOperation(
        `/api/shopping/items/${encodeURIComponent(editingShoppingItem.id)}`,
        "PATCH",
        { text },
      );
      try {
        const result = await readShoppingResponse(
          await fetch(operation.path, {
            method: operation.method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(operation.body),
          }),
        );
        acceptShoppingSnapshot(result);
        setEditingShoppingItem(null);
      } catch (error) {
        if (isRetryableShoppingError(error)) {
          queueShoppingOperation(operation);
          setShopping((current) =>
            replaceShoppingItems(
              current,
              current.items.map((item) =>
                item.id === editingShoppingItem.id
                  ? { ...item, text, name: text }
                  : item,
              ),
            ),
          );
          setEditingShoppingItem(null);
          setShoppingError("Saved offline. This rename will sync automatically.");
        } else {
          setShoppingError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setShoppingBusy(null);
      }
    },
    [
      acceptShoppingSnapshot,
      editingShoppingItem,
      queueShoppingOperation,
      shoppingBusy,
    ],
  );

  const removeShoppingItem = useCallback(
    async (item: ShoppingItem) => {
      if (
        shoppingBusy ||
        !window.confirm(`Remove “${item.text}” from the shopping list?`)
      ) {
        return;
      }
      setShoppingBusy(item.id);
      setShoppingError(null);
      const operation = createShoppingOperation(
        `/api/shopping/items/${encodeURIComponent(item.id)}`,
        "DELETE",
        {},
      );
      try {
        const result = await readShoppingResponse(
          await fetch(operation.path, {
            method: operation.method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(operation.body),
          }),
        );
        acceptShoppingSnapshot(result);
        if (editingShoppingItem?.id === item.id) setEditingShoppingItem(null);
      } catch (error) {
        if (isRetryableShoppingError(error)) {
          queueShoppingOperation(operation);
          setShopping((current) =>
            replaceShoppingItems(
              current,
              current.items.filter((entry) => entry.id !== item.id),
            ),
          );
          setShoppingError("Saved offline. Removal will sync automatically.");
        } else {
          setShoppingError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setShoppingBusy(null);
      }
    },
    [
      acceptShoppingSnapshot,
      editingShoppingItem,
      queueShoppingOperation,
      shoppingBusy,
    ],
  );

  const clearCompletedShoppingItems = useCallback(async () => {
    if (
      shoppingBusy ||
      !window.confirm(
        `Remove ${shopping.completedCount} completed ${
          shopping.completedCount === 1 ? "item" : "items"
        }?`,
      )
    ) {
      return;
    }
    setShoppingBusy("clear");
    setShoppingError(null);
    const operation = createShoppingOperation(
      "/api/shopping/clear-completed",
      "POST",
      {},
    );
    try {
      const result = await readShoppingResponse(
        await fetch(operation.path, {
          method: operation.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(operation.body),
        }),
      );
      acceptShoppingSnapshot(result);
    } catch (error) {
      if (isRetryableShoppingError(error)) {
        queueShoppingOperation(operation);
        setShopping((current) =>
          replaceShoppingItems(
            current,
            current.items.filter((item) => !item.completed),
          ),
        );
        setShoppingError("Saved offline. Completed items will clear when online.");
      } else {
        setShoppingError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setShoppingBusy(null);
    }
  }, [
    acceptShoppingSnapshot,
    queueShoppingOperation,
    shopping.completedCount,
    shoppingBusy,
  ]);

  const organizeShoppingItems = useCallback(async () => {
    if (
      shoppingBusy ||
      !window.confirm(
        "Organize this list and merge duplicate products? Quantities with matching units will be combined.",
      )
    ) {
      return;
    }
    setShoppingBusy("organize");
    setShoppingError(null);
    const operation = createShoppingOperation(
      "/api/shopping/organize",
      "POST",
      {},
    );
    try {
      const result = await readShoppingResponse(
        await fetch(operation.path, {
          method: operation.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(operation.body),
        }),
      );
      acceptShoppingSnapshot(result);
      setShoppingError(
        typeof (result as ShoppingSnapshot & { duplicatesRemoved?: number })
          .duplicatesRemoved === "number"
          ? `${
              (result as ShoppingSnapshot & { duplicatesRemoved: number })
                .duplicatesRemoved
            } duplicates merged.`
          : null,
      );
    } catch (error) {
      if (isRetryableShoppingError(error)) {
        queueShoppingOperation(operation);
        setShoppingError("Saved offline. The list will organize when online.");
      } else {
        setShoppingError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setShoppingBusy(null);
    }
  }, [acceptShoppingSnapshot, queueShoppingOperation, shoppingBusy]);

  const shareShoppingList = useCallback(async () => {
    if (shoppingHouseholdBusy) return;
    const target =
      shoppingHousehold?.settings.notifyService ||
      shoppingHousehold?.notificationTargets[0]?.service;
    if (!target) {
      setShoppingError("No household phone is configured for shopping updates.");
      return;
    }
    setShoppingHouseholdBusy("share");
    setShoppingError(null);
    setShoppingNotice(null);
    try {
      const result = await readApiResponse<ShoppingShareResult>(
        await fetch("/api/shopping/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "touchscreen",
            notifyService: target,
          }),
        }),
      );
      acceptShoppingSnapshot(result.snapshot);
      const targetName =
        shoppingHousehold?.notificationTargets.find(
          (entry) => entry.service === result.sentTo,
        )?.name || "the household phone";
      setShoppingNotice(`The current list was sent to ${targetName}.`);
    } catch (error) {
      setShoppingError(error instanceof Error ? error.message : String(error));
    } finally {
      setShoppingHouseholdBusy(null);
    }
  }, [
    acceptShoppingSnapshot,
    shoppingHousehold,
    shoppingHouseholdBusy,
  ]);

  const saveShoppingHousehold = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!shoppingHousehold || shoppingHouseholdBusy) return;
      setShoppingHouseholdBusy("settings");
      setShoppingError(null);
      setShoppingNotice(null);
      try {
        const result = await readApiResponse<ShoppingHousehold>(
          await fetch("/api/shopping/household", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...shoppingHousehold.settings,
              source: "touchscreen",
            }),
          }),
        );
        setShoppingHousehold(result);
        setShoppingNotice(
          result.settings.enabled
            ? "Arrival reminders are on."
            : "Household reminder settings saved.",
        );
      } catch (error) {
        setShoppingError(error instanceof Error ? error.message : String(error));
      } finally {
        setShoppingHouseholdBusy(null);
      }
    },
    [shoppingHousehold, shoppingHouseholdBusy],
  );

  const showHubPage = useCallback(
    (page: 0 | 1) => {
      if (page === 1) stopVoice();
      setHubPage(page);
    },
    [stopVoice],
  );

  const beginHubSwipe = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") return;
    swipeStart.current = event.clientX;
  }, []);

  const finishHubSwipe = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (swipeStart.current === null) return;
      const distance = event.clientX - swipeStart.current;
      swipeStart.current = null;
      if (distance < -80 && hubPage === 0) showHubPage(1);
      if (distance > 80 && hubPage === 1) showHubPage(0);
    },
    [hubPage, showHubPage],
  );

  const toggleHouseholdControl = useCallback(
    async (entityId: string) => {
      if (hubBusy) return;
      setHubBusy(entityId);
      try {
        const result = await readApiResponse<HouseholdHub>(
          await fetch("/api/household/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entityId }),
          }),
        );
        setHouseholdHub(result);
      } finally {
        setHubBusy(null);
      }
    },
    [hubBusy],
  );

  const now = new Date(frameNow);
  const snapshot = stream.snapshot;
  const hubWeather = householdHub?.weather ?? null;
  useEffect(() => {
    contextRef.current = () => gardenContext(frameNow, frameConfig, snapshot, hubWeather);
  }, [frameNow, frameConfig, snapshot, hubWeather]);
  const species = snapshot?.species.slice(0, 4) ?? [];
  const latestCall = snapshot?.latest ?? null;
  const latestAgoSeconds = latestCall
    ? Math.max(0, Math.round((frameNow - latestCall.at) / 1000))
    : undefined;
  const newToday = snapshot?.newToday ?? [];
  const todayCount = snapshot?.todaySpeciesCount ?? 0;
  const hearLatest = () => {
    if (playingLatest) {
      stopClip();
      setPlayingLatest(false);
      return;
    }
    if (!latestCall?.clipUrl) return;
    setPlayingLatest(true);
    playClip(`/api/birdframe/clip?url=${encodeURIComponent(latestCall.clipUrl)}`, {
      onStart: (duration) => muteWake(Math.min(60, duration + 1.5)),
      onEnd: () => {
        setPlayingLatest(false);
        muteWake(1);
      },
    });
  };
  const activeShoppingItems = shopping.items.filter((item) => !item.completed);
  const completedShoppingItems = shopping.items.filter((item) => item.completed);
  const activeShoppingGroups = shoppingCategoryOrder.flatMap((category) => {
    const items = activeShoppingItems.filter(
      (item) => (item.category || "other") === category,
    );
    return items.length
      ? [{ category, label: shoppingCategoryLabels[category], items }]
      : [];
  });
  const latestName =
    latestCall?.commonName ||
    (stream.reachable ? "The garden is quiet" : "The garden is listening");
  const gatewayReady = status.gatewayReady === true;
  const voiceReady = status.voiceReady === true;
  const birdframeReady = status.birdframeReady !== false;
  const assistantPrompt =
    voiceState === "connecting"
      ? "Waking up…"
      : voiceState === "listening"
        ? "I’m listening."
        : voiceState === "thinking"
          ? "Let me look into that."
          : voiceState === "speaking"
            ? "Here’s what I found."
            : voiceState === "error"
              ? "I couldn’t start the conversation."
              : "What would you like to know?";
  const orbStyle = {
    "--voice-level": String(Math.max(0.04, inputLevel)),
  } as CSSProperties;
  const renderShoppingRow = (item: ShoppingItem) => (
    <div
      className="shopping-sheet__row"
      data-completed={item.completed}
      data-busy={shoppingBusy === item.id}
      key={item.id}
    >
      <button
        type="button"
        className="shopping-sheet__check"
        aria-label={`${item.completed ? "Put back" : "Mark bought"}: ${item.text}`}
        aria-pressed={item.completed}
        disabled={shoppingBusy !== null || item.id.startsWith("pending:")}
        onClick={() => void toggleShoppingItem(item)}
      >
        <span aria-hidden="true">{item.completed ? "✓" : ""}</span>
      </button>
      {editingShoppingItem?.id === item.id ? (
        <form className="shopping-sheet__edit" onSubmit={saveShoppingItem}>
          <input
            autoFocus
            value={editingShoppingItem.text}
            maxLength={160}
            aria-label="Edit shopping item"
            onChange={(event) =>
              setEditingShoppingItem({
                ...editingShoppingItem,
                text: event.target.value,
              })
            }
          />
          <button type="submit" disabled={shoppingBusy !== null}>
            Save
          </button>
          <button type="button" onClick={() => setEditingShoppingItem(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="shopping-sheet__item-text"
          disabled={item.id.startsWith("pending:")}
          onClick={() => setEditingShoppingItem(item)}
        >
          {item.text}
        </button>
      )}
      <button
        type="button"
        className="shopping-sheet__remove"
        aria-label={`Remove ${item.text}`}
        disabled={shoppingBusy !== null || item.id.startsWith("pending:")}
        onClick={() => void removeShoppingItem(item)}
      >
        ×
      </button>
    </div>
  );

  return (
    <main
      className="launcher"
      data-mode={mode}
      onPointerDown={(event) => {
        setLastTouch(Date.now());
        beginHubSwipe(event);
      }}
      onPointerUp={(event) => {
        if (mode === "frame") {
          setMode("home");
          return;
        }
        finishHubSwipe(event);
      }}
    >
      <Frame
        now={frameNow}
        config={frameConfig}
        stream={stream}
        weather={householdHub?.weather ?? null}
        mode={mode}
        muteWake={muteWake}
        onOpenJournal={openBirdframe}
      />
      {mode === "frame" ? null : (
      <>
      <nav className="launcher__page-nav" aria-label="Launcher pages">
        <button
          type="button"
          aria-current={hubPage === 0 ? "page" : undefined}
          aria-label="Voice home"
          onClick={() => showHubPage(0)}
        />
        <button
          type="button"
          aria-current={hubPage === 1 ? "page" : undefined}
          aria-label="Household hub"
          onClick={() => showHubPage(1)}
        />
      </nav>
      {hubPage === 0 ? (
        <div className="launcher__frame">
        <header className="launcher__masthead">
          <div>
            <p className="launcher__eyebrow">{frameConfig.place} · home</p>
            <h1 className="launcher__place">{greetingFor(frameNow)}</h1>
          </div>
          <div className="launcher__clock" aria-label={now.toLocaleString()}>
            <time className="launcher__time">{formatClock(now)}</time>
            <span className="launcher__date">{formatDate(now)}</span>
          </div>
        </header>

        <section
          className="assistant"
          data-active={voiceActive}
          aria-labelledby="assistant-prompt"
        >
          <button
            className="assistant__orb-button"
            data-state={voiceState}
            type="button"
            onClick={toggleVoice}
            aria-label={voiceActive ? "End voice conversation" : "Start voice conversation"}
            style={orbStyle}
          >
            <span className="assistant__ring" />
            <span className="assistant__ring assistant__ring--middle" />
            <span className="assistant__ring assistant__ring--inner" />
            <span className="assistant__orb" />
          </button>
          <h2 className="assistant__prompt" id="assistant-prompt">
            {assistantPrompt}
          </h2>
          {conversation.length ? (
            <div
              className="assistant__conversation"
              aria-live="polite"
              aria-label="Voice conversation"
            >
              {conversation.slice(-4).map((entry) => (
                <p
                  className="assistant__utterance"
                  data-role={entry.role}
                  data-streaming={entry.streaming}
                  key={entry.id}
                >
                  <span className="assistant__speaker">
                    {entry.role === "user" ? "You" : "Assistant"}
                  </span>
                  <VoiceTranscriptText entry={entry} />
                </p>
              ))}
            </div>
          ) : (
            <p className="assistant__hint">
              {voiceState === "error"
                ? voiceDetail ||
                  "End this conversation, then touch the light again to retry."
                : status.wakeReady
                  ? "Say “Computer” or touch the listening light to talk."
                  : "Touch the listening light to talk."}
            </p>
          )}
          {voiceActive ? (
            <button type="button" className="assistant__end" onClick={stopVoice}>
              End conversation
            </button>
          ) : null}
          <div className="assistant__status">
            <span className="status-dot" data-ready={gatewayReady && voiceReady} />
            {voiceActive
              ? voiceDetail || "Voice is live"
              : gatewayReady && voiceReady
                ? "OpenClaw voice is ready"
                : "Connecting to OpenClaw"}
          </div>
        </section>

        <section className="launcher__lower" aria-label="Home applications">
          <div className="bird-card__wrap">
            <button
              type="button"
              className="bird-card"
              onClick={openBirdframe}
              disabled={!birdframeReady}
            >
              <span className="bird-card__open">Open journal →</span>
              <p className="bird-card__eyebrow">
                {newToday.length
                  ? `New to this garden · ${newToday.join(", ")}`
                  : stream.reachable
                    ? "Live from BirdFrame"
                    : "BirdFrame unreachable"}
              </p>
              <h2 className="bird-card__title">{latestName}</h2>
              <p className="bird-card__meta">
                {timeAgo(latestAgoSeconds)}
                {latestCall?.tier ? ` · ${tierWord(latestCall.tier)}` : ""}
                {todayCount ? ` · ${todayCount} voices today` : ""}
              </p>
              <div className="bird-card__voices">
                {species.length > 0 ? (
                  species.map((entry) => (
                    <span className="bird-card__voice" key={entry.commonName}>
                      {entry.commonName} · {entry.count}
                    </span>
                  ))
                ) : (
                  <span className="bird-card__voice">
                    Listening across the last {snapshot?.windowMinutes || 60} minutes
                  </span>
                )}
              </div>
            </button>
            {latestCall?.clipUrl ? (
              <button
                type="button"
                className="bird-card__hear"
                onClick={hearLatest}
                aria-pressed={playingLatest}
              >
                {playingLatest ? "Stop" : "Hear it"}
              </button>
            ) : null}
          </div>

          <div className="launcher__side">
            <section
              className="shopping-card"
              data-ready={status.shoppingReady !== false && shoppingLoaded}
              aria-labelledby="shopping-card-title"
            >
              <button
                type="button"
                className="shopping-card__header"
                onClick={() => openShopping()}
              >
                <span>
                  <span className="shopping-card__eyebrow">House shopping</span>
                  <strong id="shopping-card-title">
                    {shoppingLoaded
                      ? `${shopping.activeCount} ${
                          shopping.activeCount === 1 ? "item" : "items"
                        }`
                      : "Loading…"}
                  </strong>
                </span>
                <span className="shopping-card__open" aria-hidden="true">
                  →
                </span>
              </button>
              <div className="shopping-card__items">
                {activeShoppingItems.length ? (
                  activeShoppingItems.slice(0, 3).map((item) => (
                    <button
                      type="button"
                      className="shopping-card__item"
                      key={item.id}
                      disabled={shoppingBusy !== null}
                      onClick={() => void toggleShoppingItem(item)}
                    >
                      <span className="shopping-card__check" aria-hidden="true" />
                      <span>{item.text}</span>
                    </button>
                  ))
                ) : (
                  <button
                    type="button"
                    className="shopping-card__empty"
                    onClick={() => openShopping(true)}
                  >
                    {shoppingError && shopping.items.length === 0
                      ? "List unavailable · tap to retry"
                      : "Nothing to buy · add an item"}
                  </button>
                )}
              </div>
              <button
                type="button"
                className="shopping-card__add"
                onClick={() => openShopping(true)}
              >
                + Add item
              </button>
            </section>
            <button
              type="button"
              className="launcher__action launcher__action--wide"
              onClick={openCamera}
            >
              <span className="launcher__action-icon">◉</span>
              <span className="launcher__action-label">Look</span>
            </button>
          </div>
        </section>
        </div>
      ) : (
        <section className="household-page" aria-label="Household hub">
          <header className="household-page__header">
            <div>
              <p className="launcher__eyebrow">Household · live</p>
              <h1>Today at home</h1>
              <p>Swipe right for voice</p>
            </div>
            <div className="household-weather">
              <span aria-hidden="true">
                {weatherSymbol(householdHub?.weather?.condition)}
              </span>
              <div>
                <strong>
                  {householdHub?.weather?.temperature ?? "–"}
                  {householdHub?.weather?.unit || "°C"}
                </strong>
                <small>
                  {householdHub?.weather?.condition.replaceAll("-", " ") ||
                    "Weather loading"}
                </small>
              </div>
            </div>
          </header>

          <div className="household-page__grid">
            <section className="household-panel household-panel--agenda">
              <header>
                <p>Coming up</p>
                <span>{formatDate(now)}</span>
              </header>
              {householdHub?.events.length ? (
                <ol>
                  {householdHub.events.slice(0, 6).map((event) => (
                    <li key={`${event.calendar}-${event.start}-${event.summary}`}>
                      <time>{formatHubEventStart(event.start, event.allDay)}</time>
                      <strong>{event.summary}</strong>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="household-panel__empty">
                  No shared household events in the next week.
                </p>
              )}
            </section>

            <section className="household-panel household-panel--controls">
              <header>
                <p>Rooms</p>
                <span>Home Assistant</span>
              </header>
              <div>
                {householdHub?.controls.map((control) => (
                  <button
                    type="button"
                    key={control.entityId}
                    data-active={control.active}
                    disabled={hubBusy !== null}
                    onClick={() => void toggleHouseholdControl(control.entityId)}
                  >
                    <span aria-hidden="true" />
                    <strong>{control.name}</strong>
                    <small>
                      {hubBusy === control.entityId
                        ? "Updating…"
                        : control.active
                          ? "On"
                          : "Off"}
                    </small>
                  </button>
                ))}
              </div>
            </section>

            <button
              type="button"
              className="household-panel household-panel--shopping"
              onClick={() => openShopping()}
            >
              <span>House shopping</span>
              <strong>
                {shopping.activeCount}{" "}
                {shopping.activeCount === 1 ? "thing" : "things"} to pick up
              </strong>
              <small>
                {activeShoppingItems
                  .slice(0, 4)
                  .map((item) => item.text)
                  .join(" · ") || "The list is clear"}
              </small>
              <i aria-hidden="true">→</i>
            </button>

            <button
              type="button"
              className="household-panel household-panel--birds"
              onClick={openBirdframe}
              disabled={!birdframeReady}
            >
              <span>Garden right now</span>
              <strong>{latestName}</strong>
              <small>{timeAgo(latestAgoSeconds)}</small>
              <i aria-hidden="true">Open BirdFrame →</i>
            </button>
          </div>
        </section>
      )}
      </>
      )}

      {shoppingOpen ? (
        <section className="shopping-sheet" aria-label="House shopping list">
          <header className="shopping-sheet__bar">
            <button
              type="button"
              className="shopping-sheet__close"
              onClick={closeShopping}
            >
              ← Home
            </button>
            <div>
              <p className="shopping-sheet__eyebrow">Canonical house list</p>
              <h2>Shopping</h2>
            </div>
            <span className="shopping-sheet__sync">
              <span
                className="status-dot"
                data-ready={shoppingOnline && shoppingPendingCount === 0}
              />
              {shoppingPendingCount > 0
                ? `${shoppingPendingCount} waiting`
                : shoppingOnline
                  ? "Live"
                  : "Offline"}
            </span>
          </header>

          <div className="shopping-sheet__content">
            <form className="shopping-sheet__add" onSubmit={addShoppingItem}>
              <label htmlFor="new-shopping-item">What do we need?</label>
              <div>
                <input
                  ref={newShoppingItemInput}
                  id="new-shopping-item"
                  value={newShoppingItem}
                  maxLength={160}
                  autoComplete="off"
                  placeholder="Add milk, coffee, apples…"
                  onChange={(event) => setNewShoppingItem(event.target.value)}
                />
                <button
                  type="submit"
                  disabled={!newShoppingItem.trim() || shoppingBusy !== null}
                >
                  {shoppingBusy === "add" ? "Adding…" : "Add"}
                </button>
              </div>
            </form>

            {shoppingError ? (
              <div className="shopping-sheet__error" role="alert">
                <span>{shoppingError}</span>
                <button type="button" onClick={() => void refreshShopping()}>
                  Try again
                </button>
              </div>
            ) : null}
            {shoppingNotice ? (
              <div className="shopping-sheet__notice" role="status">
                {shoppingNotice}
              </div>
            ) : null}

            <section className="shopping-sheet__section" aria-labelledby="to-buy">
              <header>
                <h3 id="to-buy">To buy</h3>
                <div className="shopping-sheet__section-actions">
                  {shoppingHousehold?.notificationTargets.length ? (
                    <button
                      type="button"
                      disabled={shoppingHouseholdBusy !== null}
                      onClick={() => void shareShoppingList()}
                    >
                      {shoppingHouseholdBusy === "share"
                        ? "Sending…"
                        : "Send to phone"}
                    </button>
                  ) : null}
                  {shopping.activeCount > 1 ? (
                    <button
                      type="button"
                      disabled={shoppingBusy !== null}
                      onClick={() => void organizeShoppingItems()}
                    >
                      Organize
                    </button>
                  ) : null}
                  <span>{shopping.activeCount}</span>
                </div>
              </header>
              {activeShoppingItems.length ? (
                <div className="shopping-sheet__groups">
                  {activeShoppingGroups.map((group) => (
                    <section
                      className="shopping-sheet__group"
                      aria-label={group.label}
                      key={group.category}
                    >
                      <h4>{group.label}</h4>
                      <div className="shopping-sheet__list">
                        {group.items.map(renderShoppingRow)}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="shopping-sheet__list">
                  <p className="shopping-sheet__empty">
                    The list is clear. Add something above or ask OpenClaw.
                  </p>
                </div>
              )}
            </section>

            {completedShoppingItems.length ? (
              <section
                className="shopping-sheet__section shopping-sheet__section--completed"
                aria-labelledby="bought"
              >
                <header>
                  <h3 id="bought">Bought</h3>
                  <button
                    type="button"
                    disabled={shoppingBusy !== null}
                    onClick={() => void clearCompletedShoppingItems()}
                  >
                    Clear completed
                  </button>
                </header>
                <div className="shopping-sheet__list">
                  {completedShoppingItems.map(renderShoppingRow)}
                </div>
              </section>
            ) : null}

            {shoppingHousehold ? (
              <details className="shopping-sheet__household">
                <summary>Household access & reminders</summary>
                <form onSubmit={saveShoppingHousehold}>
                  <p>
                    Everyone can manage this same list in Home Assistant. Send a
                    snapshot to a phone now, or remind someone when they enter a
                    configured shop zone.
                  </p>
                  <div className="shopping-sheet__household-grid">
                    <label>
                      Phone
                      <select
                        value={shoppingHousehold.settings.notifyService}
                        onChange={(event) =>
                          setShoppingHousehold((current) =>
                            current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    notifyService: event.target.value,
                                  },
                                }
                              : current,
                          )
                        }
                      >
                        {shoppingHousehold.notificationTargets.map((target) => (
                          <option key={target.service} value={target.service}>
                            {target.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Person
                      <select
                        value={shoppingHousehold.settings.personEntityId}
                        onChange={(event) =>
                          setShoppingHousehold((current) =>
                            current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    personEntityId: event.target.value,
                                  },
                                }
                              : current,
                          )
                        }
                      >
                        {shoppingHousehold.people.map((person) => (
                          <option key={person.entityId} value={person.entityId}>
                            {person.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Shop zone
                      <select
                        value={shoppingHousehold.settings.zoneEntityId || ""}
                        disabled={!shoppingHousehold.zones.length}
                        onChange={(event) =>
                          setShoppingHousehold((current) =>
                            current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    zoneEntityId: event.target.value || null,
                                  },
                                }
                              : current,
                          )
                        }
                      >
                        <option value="">Choose a shop zone</option>
                        {shoppingHousehold.zones.map((zone) => (
                          <option key={zone.entityId} value={zone.entityId}>
                            {zone.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {!shoppingHousehold.zones.length ? (
                    <p className="shopping-sheet__household-note">
                      No shop zones exist in Home Assistant yet. Add a zone for
                      your usual supermarket and it will appear here
                      automatically.
                    </p>
                  ) : null}
                  <div className="shopping-sheet__household-actions">
                    <label>
                      <input
                        type="checkbox"
                        checked={shoppingHousehold.settings.enabled}
                        disabled={
                          !shoppingHousehold.settings.zoneEntityId ||
                          !shoppingHousehold.settings.notifyService
                        }
                        onChange={(event) =>
                          setShoppingHousehold((current) =>
                            current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    enabled: event.target.checked,
                                  },
                                }
                              : current,
                          )
                        }
                      />
                      Remind on arrival when the list is not empty
                    </label>
                    <button
                      type="submit"
                      disabled={shoppingHouseholdBusy !== null}
                    >
                      {shoppingHouseholdBusy === "settings"
                        ? "Saving…"
                        : "Save settings"}
                    </button>
                  </div>
                </form>
              </details>
            ) : null}

            {shoppingActivities.length ? (
              <details className="shopping-sheet__activity">
                <summary>Recent activity</summary>
                <ol>
                  {shoppingActivities.slice(0, 12).map((activity) => (
                    <li key={activity.id}>
                      <span>
                        {activity.text ||
                          activity.detail ||
                          activity.action.replaceAll("-", " ")}
                      </span>
                      <small>
                        {activity.source.replace("-", " ")} ·{" "}
                        {new Intl.DateTimeFormat("en-GB", {
                          hour: "2-digit",
                          minute: "2-digit",
                        }).format(new Date(activity.at))}
                      </small>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </div>
        </section>
      ) : null}

      {cameraOpen ? (
        <section className="camera-sheet" aria-label="Shopping camera">
          <header className="camera-sheet__bar">
            <button
              type="button"
              className="camera-sheet__close"
              onClick={closeCamera}
            >
              ← Home
            </button>
            <p className="camera-sheet__eyebrow">Shopping camera</p>
            <span aria-hidden="true">●</span>
          </header>
          <div className="camera-sheet__content">
            <div className="camera-sheet__view">
              {/* The native camera endpoint is intentionally a changing JPEG URL. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/camera.jpg?frame=${cameraFrame}`}
                alt="Live view from the Raspberry Pi camera"
                onLoad={() => {
                  if (!cameraBusy) setCameraError(null);
                }}
                onError={() =>
                  setCameraError("The camera could not be opened. Trying again…")
                }
              />
              <span className="camera-sheet__privacy">
                Live preview stays on this Pi
              </span>
              <div className="camera-sheet__controls">
                <p>
                  Hold up a product, barcode, list or receipt, then analyse this
                  frame.
                </p>
                <button
                  type="button"
                  onClick={() => void analyzeCamera()}
                  disabled={cameraBusy !== null}
                >
                  {cameraBusy === "analyze"
                    ? "Looking carefully…"
                    : cameraAnalysis
                      ? "Analyse another frame"
                      : "Add what I can see"}
                </button>
              </div>
            </div>
            {cameraAnalysis || cameraError || cameraNotice ? (
              <aside className="camera-sheet__analysis" aria-live="polite">
                {cameraAnalysis ? (
                  <>
                    <p className="camera-sheet__analysis-kind">
                      {cameraAnalysis.kind.replace("-", " ")}
                      {cameraAnalysis.barcode
                        ? ` · ${cameraAnalysis.barcode}`
                        : ""}
                    </p>
                    <h2>{cameraAnalysis.summary}</h2>
                    {cameraAnalysis.items.length ? (
                      <div className="camera-sheet__candidates">
                        {cameraAnalysis.items.map((item) => {
                          const selected = cameraSelectedItems.includes(item.text);
                          return (
                            <button
                              type="button"
                              key={`${item.text}-${item.evidence}`}
                              aria-pressed={selected}
                              onClick={() => toggleCameraCandidate(item.text)}
                              disabled={cameraBusy !== null}
                            >
                              <span aria-hidden="true">
                                {selected ? "✓" : ""}
                              </span>
                              <span>
                                <strong>{item.text}</strong>
                                <small>
                                  {Math.round(item.confidence * 100)}% ·{" "}
                                  {item.evidence}
                                </small>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="camera-sheet__analysis-empty">
                        Nothing is clear enough to add yet. Move it closer and
                        try another frame.
                      </p>
                    )}
                    {cameraAnalysis.warnings.length ? (
                      <p className="camera-sheet__warning">
                        {cameraAnalysis.warnings.join(" ")}
                      </p>
                    ) : null}
                    {cameraAnalysis.items.length ? (
                      <button
                        type="button"
                        className="camera-sheet__add"
                        onClick={() => void addCameraItems()}
                        disabled={
                          cameraBusy !== null || !cameraSelectedItems.length
                        }
                      >
                        {cameraBusy === "add"
                          ? "Updating the list…"
                          : `Add ${cameraSelectedItems.length || ""} ${
                              cameraSelectedItems.length === 1 ? "item" : "items"
                            }`}
                      </button>
                    ) : null}
                  </>
                ) : null}
                {cameraNotice ? (
                  <p className="camera-sheet__notice">{cameraNotice}</p>
                ) : null}
                {cameraError ? (
                  <p className="camera-sheet__message">{cameraError}</p>
                ) : null}
                <small className="camera-sheet__data-note">
                  Analysis sends only the frame you request to the configured
                  vision service. It is not continuous.
                </small>
              </aside>
            ) : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}
