#!/usr/bin/env python3
"""The launcher watchdog decides when a wedged Chromium must be restarted."""

from __future__ import annotations

import unittest

from launcher_watchdog import LauncherWatchdog


class Harness:
    def __init__(self) -> None:
        self.now = 1_000.0
        self.launcher_started_at = 1_000.0
        self.window_active = True
        self.devtools_ok = True
        self.tmp_used = 100 * 1024 * 1024
        self.restarts: list[str] = []
        self.logged: list[str] = []
        self.watchdog = LauncherWatchdog(
            now=lambda: self.now,
            launcher_uptime=lambda: self.now - self.launcher_started_at,
            window_active=lambda: self.window_active,
            devtools_ok=lambda: self.devtools_ok,
            tmp_used_bytes=lambda: self.tmp_used,
            restart=self._restart,
            log=self.logged.append,
            heartbeat_timeout=180,
            grace=120,
            probe_failures=3,
            tmp_limit=1_250_000_000,
            restart_cooldown=300,
        )

    def _restart(self, reason: str) -> None:
        self.restarts.append(reason)
        self.launcher_started_at = self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class WatchdogTests(unittest.TestCase):
    def test_a_fresh_launcher_gets_a_grace_period(self) -> None:
        h = Harness()
        h.advance(60)
        self.assertIsNone(h.watchdog.tick())
        self.assertEqual(h.restarts, [])

    def test_restarts_when_the_page_stops_talking(self) -> None:
        h = Harness()
        h.advance(130)
        h.watchdog.heartbeat()
        h.advance(100)
        self.assertIsNone(h.watchdog.tick())
        h.advance(100)
        reason = h.watchdog.tick()
        self.assertIn("heartbeat", reason or "")
        self.assertEqual(len(h.restarts), 1)

    def test_the_heartbeat_rule_waits_while_birdframe_is_in_front(self) -> None:
        # Behind another window Chromium throttles timers heavily, so silence
        # from the page proves nothing while the launcher is not on screen.
        h = Harness()
        h.advance(130)
        h.watchdog.heartbeat()
        h.window_active = False
        h.advance(600)
        self.assertIsNone(h.watchdog.tick())
        h.window_active = True
        self.assertIsNotNone(h.watchdog.tick())

    def test_no_heartbeat_at_all_after_grace_counts_as_silence(self) -> None:
        h = Harness()
        h.advance(130)
        self.assertIsNone(h.watchdog.tick())
        h.advance(200)
        self.assertIsNotNone(h.watchdog.tick())

    def test_restarts_when_the_browser_ui_thread_stops_answering(self) -> None:
        h = Harness()
        h.advance(130)
        h.watchdog.heartbeat()
        h.devtools_ok = False
        self.assertIsNone(h.watchdog.tick())
        h.advance(30)
        h.watchdog.heartbeat()
        self.assertIsNone(h.watchdog.tick())
        h.advance(30)
        h.watchdog.heartbeat()
        reason = h.watchdog.tick()
        self.assertIn("DevTools", reason or "")
        self.assertEqual(len(h.restarts), 1)

    def test_a_single_devtools_miss_is_forgiven(self) -> None:
        h = Harness()
        h.advance(130)
        h.watchdog.heartbeat()
        h.devtools_ok = False
        h.watchdog.tick()
        h.devtools_ok = True
        h.watchdog.tick()
        h.devtools_ok = False
        h.watchdog.tick()
        h.watchdog.tick()
        self.assertEqual(h.restarts, [])

    def test_restarts_when_chromium_shared_memory_fills_tmp(self) -> None:
        h = Harness()
        h.advance(130)
        h.watchdog.heartbeat()
        h.tmp_used = 1_300_000_000
        reason = h.watchdog.tick()
        self.assertIn("shared memory", reason or "")
        self.assertEqual(len(h.restarts), 1)

    def test_restarts_are_rate_limited_and_restart_a_grace_period(self) -> None:
        h = Harness()
        h.advance(130)
        h.watchdog.heartbeat()
        h.tmp_used = 1_300_000_000
        self.assertIsNotNone(h.watchdog.tick())
        h.advance(130)
        self.assertIsNone(h.watchdog.tick(), "cooldown must hold")
        h.advance(200)
        self.assertIsNotNone(h.watchdog.tick())
        self.assertEqual(len(h.restarts), 2)

    def test_status_reports_what_it_saw(self) -> None:
        h = Harness()
        h.advance(130)
        h.watchdog.heartbeat()
        h.advance(4)
        self.assertAlmostEqual(h.watchdog.status()["secondsSinceHeartbeat"], 4.0)
        h.tmp_used = 1_300_000_000
        h.watchdog.tick()
        status = h.watchdog.status()
        self.assertEqual(status["restarts"], 1)
        self.assertIn("shared memory", status["lastRestartReason"])
        # A restart forgets the old page; the next heartbeat belongs to the new one.
        self.assertIsNone(status["secondsSinceHeartbeat"])
        self.assertAlmostEqual(status["secondsSinceRestart"], 0.0)


if __name__ == "__main__":
    unittest.main()
