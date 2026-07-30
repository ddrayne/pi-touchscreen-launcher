"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  InlineRealtimeVoice,
  type InlineVoiceStatus,
  type InlineVoiceTranscript,
} from "../lib/realtimeVoice";

type WindowSpecies = {
  common_name: string;
  count: number;
  tier?: string;
};

type BirdframeNow = {
  latest?: {
    common_name?: string;
    confidence?: number;
    at?: string;
    seconds_ago?: number;
  };
  today_species_count?: number;
  window_minutes?: number;
  window_species?: WindowSpecies[];
};

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

type ConversationEntry = {
  id: number;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
};

type ShoppingItem = {
  id: string;
  text: string;
  completed: boolean;
};

type ShoppingSnapshot = {
  items: ShoppingItem[];
  activeCount: number;
  completedCount: number;
  syncedAt?: string;
  source?: string;
  outcome?: string;
};

const fallbackBirds: BirdframeNow = {
  latest: {
    common_name: "The garden is listening",
    confidence: 0,
    at: "",
  },
  today_species_count: 0,
  window_minutes: 60,
  window_species: [],
};

const emptyShopping: ShoppingSnapshot = {
  items: [],
  activeCount: 0,
  completedCount: 0,
};

async function readShoppingResponse(response: Response): Promise<ShoppingSnapshot> {
  const result = (await response.json().catch(() => ({}))) as ShoppingSnapshot & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(result.error || "The shopping list is unavailable");
  }
  return result;
}

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

function updateConversation(
  entries: ConversationEntry[],
  update: InlineVoiceTranscript,
): ConversationEntry[] {
  const text = update.text;
  if (!text.trim()) return entries;
  const next = [...entries];
  const last = next.at(-1);
  if (last?.role === update.role && last.streaming) {
    const merged = update.final
      ? text.startsWith(last.text)
        ? text
        : last.text.toLowerCase().startsWith(text.toLowerCase().slice(0, 12))
          ? text
          : `${last.text}${text}`
      : `${last.text}${text}`;
    next[next.length - 1] = { ...last, text: merged, streaming: !update.final };
  } else {
    if (last?.streaming) next[next.length - 1] = { ...last, streaming: false };
    next.push({
      id: Date.now() + Math.floor(Math.random() * 1000),
      role: update.role,
      text: text.trimStart(),
      streaming: !update.final,
    });
  }
  return next.slice(-6);
}

export function Launcher() {
  const [now, setNow] = useState(() => new Date());
  const [status, setStatus] = useState<ApplianceStatus>({});
  const [birds, setBirds] = useState<BirdframeNow>(fallbackBirds);
  const [voiceState, setVoiceState] = useState<InlineVoiceStatus>("idle");
  const [voiceDetail, setVoiceDetail] = useState<string | null>(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraFrame, setCameraFrame] = useState(() => Date.now());
  const [shopping, setShopping] = useState<ShoppingSnapshot>(emptyShopping);
  const [shoppingLoaded, setShoppingLoaded] = useState(false);
  const [shoppingOpen, setShoppingOpen] = useState(false);
  const [shoppingError, setShoppingError] = useState<string | null>(null);
  const [shoppingBusy, setShoppingBusy] = useState<string | null>(null);
  const [newShoppingItem, setNewShoppingItem] = useState("");
  const [editingShoppingItem, setEditingShoppingItem] =
    useState<ShoppingItem | null>(null);
  const lastWakeSequence = useRef(0);
  const voiceSession = useRef<InlineRealtimeVoice | null>(null);
  const newShoppingItemInput = useRef<HTMLInputElement | null>(null);
  const voiceActive = voiceState !== "idle";

  const muteWake = useCallback((seconds: number) => {
    void fetch("/api/wake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mute", seconds }),
    }).catch(() => undefined);
  }, []);

  const refreshShopping = useCallback(async () => {
    try {
      const result = await readShoppingResponse(
        await fetch("/api/shopping", { cache: "no-store" }),
      );
      setShopping(result);
      setShoppingLoaded(true);
      setShoppingError(null);
      try {
        window.localStorage.setItem(
          "touchscreen-shopping-list",
          JSON.stringify(result),
        );
      } catch {
        // The live list still works when browser storage is unavailable.
      }
    } catch (error) {
      setShoppingLoaded(true);
      setShoppingError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refresh = useCallback(async () => {
    const [statusResult, birdResult] = await Promise.allSettled([
      fetch("/api/status", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("status unavailable");
        return response.json() as Promise<ApplianceStatus>;
      }),
      fetch("/api/birdframe", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("BirdFrame unavailable");
        return response.json() as Promise<BirdframeNow>;
      }),
    ]);

    if (statusResult.status === "fulfilled") setStatus(statusResult.value);
    if (birdResult.status === "fulfilled") setBirds(birdResult.value);
    void refreshShopping();
  }, [refreshShopping]);

  useEffect(() => {
    const loadCachedShopping = window.setTimeout(() => {
      try {
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
    const clock = window.setInterval(() => setNow(new Date()), 15_000);
    const poll = window.setInterval(() => void refresh(), 20_000);
    return () => {
      window.clearTimeout(loadCachedShopping);
      window.clearTimeout(initial);
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [refresh]);

  useEffect(() => {
    if (!shoppingOpen) return;
    const poll = window.setInterval(() => void refreshShopping(), 8_000);
    return () => window.clearInterval(poll);
  }, [refreshShopping, shoppingOpen]);

  const stopVoice = useCallback(() => {
    const current = voiceSession.current;
    voiceSession.current = null;
    current?.stop();
    muteWake(4);
    setVoiceState("idle");
    setVoiceDetail(null);
    setInputLevel(0);
  }, [muteWake]);

  const startVoice = useCallback(async () => {
    if (voiceSession.current) return;
    muteWake(30);
    setConversation([]);
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
          setConversation((current) => updateConversation(current, entry));
        }
      },
      onIdleTimeout: () => {
        if (voiceSession.current === session) stopVoice();
      },
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
  }, [muteWake, stopVoice]);

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

  const closeCamera = useCallback(() => {
    setCameraOpen(false);
    setCameraError(null);
  }, []);

  const openCamera = useCallback(() => {
    stopVoice();
    setCameraOpen(true);
    setCameraError(null);
    setCameraFrame(Date.now());
  }, [stopVoice]);

  useEffect(() => {
    if (!cameraOpen) return;
    const refreshCamera = window.setInterval(
      () => setCameraFrame(Date.now()),
      2_000,
    );
    return () => window.clearInterval(refreshCamera);
  }, [cameraOpen]);

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
  }, []);

  const toggleShoppingItem = useCallback(
    async (item: ShoppingItem) => {
      if (shoppingBusy) return;
      setShoppingBusy(item.id);
      setShoppingError(null);
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
          await fetch(`/api/shopping/items/${encodeURIComponent(item.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ completed: !item.completed }),
          }),
        );
        setShopping(result);
      } catch (error) {
        setShoppingError(error instanceof Error ? error.message : String(error));
        void refreshShopping();
      } finally {
        setShoppingBusy(null);
      }
    },
    [refreshShopping, shoppingBusy],
  );

  const addShoppingItem = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = newShoppingItem.trim();
      if (!text || shoppingBusy) return;
      setShoppingBusy("add");
      setShoppingError(null);
      try {
        const result = await readShoppingResponse(
          await fetch("/api/shopping/items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          }),
        );
        setShopping(result);
        setNewShoppingItem("");
        window.setTimeout(() => newShoppingItemInput.current?.focus(), 80);
      } catch (error) {
        setShoppingError(error instanceof Error ? error.message : String(error));
      } finally {
        setShoppingBusy(null);
      }
    },
    [newShoppingItem, shoppingBusy],
  );

  const saveShoppingItem = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!editingShoppingItem || shoppingBusy) return;
      const text = editingShoppingItem.text.trim();
      if (!text) return;
      setShoppingBusy(editingShoppingItem.id);
      setShoppingError(null);
      try {
        const result = await readShoppingResponse(
          await fetch(
            `/api/shopping/items/${encodeURIComponent(editingShoppingItem.id)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text }),
            },
          ),
        );
        setShopping(result);
        setEditingShoppingItem(null);
      } catch (error) {
        setShoppingError(error instanceof Error ? error.message : String(error));
      } finally {
        setShoppingBusy(null);
      }
    },
    [editingShoppingItem, shoppingBusy],
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
      try {
        const result = await readShoppingResponse(
          await fetch(`/api/shopping/items/${encodeURIComponent(item.id)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        );
        setShopping(result);
        if (editingShoppingItem?.id === item.id) setEditingShoppingItem(null);
      } catch (error) {
        setShoppingError(error instanceof Error ? error.message : String(error));
      } finally {
        setShoppingBusy(null);
      }
    },
    [editingShoppingItem, shoppingBusy],
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
    try {
      const result = await readShoppingResponse(
        await fetch("/api/shopping/clear-completed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      setShopping(result);
    } catch (error) {
      setShoppingError(error instanceof Error ? error.message : String(error));
    } finally {
      setShoppingBusy(null);
    }
  }, [shopping.completedCount, shoppingBusy]);

  const species = birds.window_species?.slice(0, 4) ?? [];
  const activeShoppingItems = shopping.items.filter((item) => !item.completed);
  const completedShoppingItems = shopping.items.filter((item) => item.completed);
  const latestName = birds.latest?.common_name || "The garden is listening";
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
        disabled={shoppingBusy !== null}
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
          onClick={() => setEditingShoppingItem(item)}
        >
          {item.text}
        </button>
      )}
      <button
        type="button"
        className="shopping-sheet__remove"
        aria-label={`Remove ${item.text}`}
        disabled={shoppingBusy !== null}
        onClick={() => void removeShoppingItem(item)}
      >
        ×
      </button>
    </div>
  );

  return (
    <main className="launcher">
      <div className="launcher__frame">
        <header className="launcher__masthead">
          <div>
            <p className="launcher__eyebrow">Touchscreen · home</p>
            <h1 className="launcher__place">A quiet intelligence</h1>
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
                  <span>{entry.role === "user" ? "You" : "Assistant"}</span>
                  {entry.text}
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
          <button
            type="button"
            className="bird-card"
            onClick={openBirdframe}
            disabled={!birdframeReady}
          >
            <span className="bird-card__open">Open journal →</span>
            <p className="bird-card__eyebrow">Live from BirdFrame</p>
            <h2 className="bird-card__title">{latestName}</h2>
            <p className="bird-card__meta">
              {timeAgo(birds.latest?.seconds_ago)}
              {birds.today_species_count
                ? ` · ${birds.today_species_count} voices today`
                : ""}
            </p>
            <div className="bird-card__voices">
              {species.length > 0 ? (
                species.map((entry) => (
                  <span className="bird-card__voice" key={entry.common_name}>
                    {entry.common_name} · {entry.count}
                  </span>
                ))
              ) : (
                <span className="bird-card__voice">
                  Listening across the last {birds.window_minutes || 60} minutes
                </span>
              )}
            </div>
          </button>

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
                data-ready={!shoppingError && shoppingLoaded}
              />
              {!shoppingError ? "Synced" : "Last known list"}
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

            <section className="shopping-sheet__section" aria-labelledby="to-buy">
              <header>
                <h3 id="to-buy">To buy</h3>
                <span>{shopping.activeCount}</span>
              </header>
              <div className="shopping-sheet__list">
                {activeShoppingItems.length ? (
                  activeShoppingItems.map(renderShoppingRow)
                ) : (
                  <p className="shopping-sheet__empty">
                    The list is clear. Add something above or ask OpenClaw.
                  </p>
                )}
              </div>
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
          </div>
        </section>
      ) : null}

      {cameraOpen ? (
        <section className="camera-sheet" aria-label="Camera preview">
          <header className="camera-sheet__bar">
            <button
              type="button"
              className="camera-sheet__close"
              onClick={closeCamera}
            >
              ← Home
            </button>
            <p className="camera-sheet__eyebrow">Camera · private preview</p>
            <span aria-hidden="true">●</span>
          </header>
          <div className="camera-sheet__view">
            {/* The native camera endpoint is intentionally a changing JPEG URL. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/camera.jpg?frame=${cameraFrame}`}
              alt="Live view from the Raspberry Pi camera"
              onLoad={() => setCameraError(null)}
              onError={() =>
                setCameraError("The camera could not be opened. Trying again…")
              }
            />
            {cameraError ? (
              <p className="camera-sheet__message">{cameraError}</p>
            ) : null}
            <span className="camera-sheet__privacy">
              Native camera preview · stays on this Pi
            </span>
          </div>
        </section>
      ) : null}
    </main>
  );
}
