#!/usr/bin/env python3
"""Restarts the kiosk when Chromium wedges.

Three signals, each seen on the Pi:

- the page's main thread stops talking to the bridge (its wake poll is the
  heartbeat) while the launcher window is the one on screen;
- the browser's UI thread stops answering DevTools, which is what happens
  when a child process cannot be reaped;
- Chromium's shared memory, which lives in tmpfs, grows past a limit, which
  is what an unread-fetch-body leak looks like long before it wedges.

Pure decision logic lives here with its clock and actions injected, so it
can be tested without a Pi.
"""

from __future__ import annotations

import time
from typing import Any, Callable


class LauncherWatchdog:
    def __init__(
        self,
        *,
        now: Callable[[], float] = time.monotonic,
        launcher_uptime: Callable[[], float | None],
        window_active: Callable[[], bool],
        devtools_ok: Callable[[], bool],
        tmp_used_bytes: Callable[[], int],
        restart: Callable[[str], None],
        log: Callable[[str], None] = print,
        heartbeat_timeout: float = 180.0,
        grace: float = 120.0,
        probe_failures: int = 3,
        tmp_limit: int = 1_250_000_000,
        restart_cooldown: float = 300.0,
    ) -> None:
        self._now = now
        self._launcher_uptime = launcher_uptime
        self._window_active = window_active
        self._devtools_ok = devtools_ok
        self._tmp_used_bytes = tmp_used_bytes
        self._restart = restart
        self._log = log
        self.heartbeat_timeout = heartbeat_timeout
        self.grace = grace
        self.probe_failures = probe_failures
        self.tmp_limit = tmp_limit
        self.restart_cooldown = restart_cooldown
        self._last_heartbeat: float | None = None
        self._consecutive_probe_failures = 0
        self._last_restart_at: float | None = None
        self._last_restart_reason = ""
        self._restarts = 0

    def heartbeat(self) -> None:
        """The page's main thread made a request."""
        self._last_heartbeat = self._now()

    def tick(self) -> str | None:
        """Evaluates the signals once; returns the reason when it restarted."""
        now = self._now()
        uptime = self._launcher_uptime()
        if uptime is None or uptime < self.grace:
            # A launcher that just started (by us or by systemd) is still loading.
            self._consecutive_probe_failures = 0
            return None
        if self._last_restart_at is not None and now - self._last_restart_at < self.restart_cooldown:
            return None

        reason = self._shared_memory_reason() or self._devtools_reason() or self._heartbeat_reason(now, uptime)
        if reason is None:
            return None
        self._log(f"Launcher watchdog restarting the kiosk: {reason}")
        self._restart(reason)
        self._last_restart_at = now
        self._last_restart_reason = reason
        self._restarts += 1
        self._last_heartbeat = None
        self._consecutive_probe_failures = 0
        return reason

    def _shared_memory_reason(self) -> str | None:
        used = self._tmp_used_bytes()
        if used > self.tmp_limit:
            return f"Chromium shared memory in tmpfs is {used / 1_048_576:.0f} MB"
        return None

    def _devtools_reason(self) -> str | None:
        if self._devtools_ok():
            self._consecutive_probe_failures = 0
            return None
        self._consecutive_probe_failures += 1
        if self._consecutive_probe_failures >= self.probe_failures:
            return f"DevTools did not answer {self._consecutive_probe_failures} probes in a row"
        return None

    def _heartbeat_reason(self, now: float, uptime: float) -> str | None:
        if not self._window_active():
            return None
        silence = now - self._last_heartbeat if self._last_heartbeat is not None else uptime
        if silence > self.heartbeat_timeout:
            return f"no page heartbeat for {silence:.0f} s"
        return None

    def status(self) -> dict[str, Any]:
        now = self._now()
        return {
            "restarts": self._restarts,
            "lastRestartReason": self._last_restart_reason,
            "secondsSinceRestart": None if self._last_restart_at is None else now - self._last_restart_at,
            "secondsSinceHeartbeat": None if self._last_heartbeat is None else now - self._last_heartbeat,
            "devtoolsProbeFailures": self._consecutive_probe_failures,
        }
