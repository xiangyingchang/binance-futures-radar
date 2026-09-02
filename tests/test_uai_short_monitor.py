#!/usr/bin/env python3
import io
import os
import stat
import sys
import unittest
import urllib.error
from contextlib import redirect_stdout
from email.message import Message
from pathlib import Path
from typing import cast
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "hermes"))
import uai_short_monitor as monitor  # noqa: E402  # type: ignore[import-not-found]


class UaiMonitorPureFunctionTests(unittest.TestCase):
    def test_wilder_rsi_all_gain_is_100(self):
        self.assertEqual(monitor.current_rsi([1, 2, 3, 4, 5, 6, 7]), 100.0)

    def test_parse_klines_rejects_invalid_ohlc_instead_of_using_zero(self):
        valid = [1000, "1.0", "1.2", "0.9", "1.1", "0", 1999, "10"]
        bad_missing = [1000, "1.0", "bad", "0.9", "1.1", "0", 1999, "10"]
        bad_shape = [1000, "1.0", "0.8", "0.9", "1.1", "0", 1999, "10"]
        self.assertEqual(len(monitor.parse_klines([valid])), 1)
        self.assertEqual(monitor.parse_klines([bad_missing, bad_shape]), [])

    def test_percentile_rank_uses_less_or_equal(self):
        self.assertEqual(monitor.percentile_rank([0.1 + i * 0.1 for i in range(10)], 1.0), 100.0)
        self.assertEqual(monitor.percentile_rank([0.1 + i * 0.1 for i in range(10)], 0.1), 10.0)

    def test_oi_changes_use_nearest_prior_snapshots(self):
        start = 1_700_000_000_000
        rows = [
            {"timestamp": start, "sumOpenInterest": "100"},
            {"timestamp": start + 144 * 60 * 60 * 1000, "sumOpenInterest": "120"},
            {"timestamp": start + 168 * 60 * 60 * 1000, "sumOpenInterest": "150"},
        ]
        result = monitor.compute_oi_changes(rows)
        self.assertAlmostEqual(result["oi24hPct"], 25.0)
        self.assertAlmostEqual(result["oi7dPct"], 50.0)

    def _metrics(self):
        return {
            "dataErrors": [],
            "lastPrice": 100.0,
            "fundingPercentile": 95.0,
            "oi24hPct": 25.0,
            "oi7dPct": 35.0,
            "reversal": {
                "recentHigh": 150.0,
                "invalidationPrice": 160.0,
                "structureBreak1h": False,
                "structureBreak4h": False,
                "rsi1hCrossBelow80": True,
                "rsi4hDeclining": False,
                "bearishDivergence": False,
            },
            "oneHourClosed": [],
            "fourHourClosed": [],
        }

    def test_status_machine_prioritizes_data_error_and_invalidation(self):
        metrics = self._metrics()
        self.assertEqual(monitor.determine_status(metrics), "WATCH_EXTREME")

        metrics["reversal"]["structureBreak4h"] = True
        self.assertEqual(monitor.determine_status(metrics), "SHORT_CONFIRMED")

        metrics["dataErrors"] = ["ticker failed"]
        self.assertEqual(monitor.determine_status(metrics), "DATA_ERROR")

        metrics["dataErrors"] = []
        metrics["lastPrice"] = 151.0
        self.assertEqual(monitor.determine_status(metrics), "INVALIDATED")

    def test_status_machine_fails_closed_on_missing_critical_value(self):
        metrics = self._metrics()
        metrics["lastPrice"] = None
        self.assertEqual(monitor.determine_status(metrics), "DATA_ERROR")
        metrics = self._metrics()
        metrics["oi7dPct"] = None
        self.assertEqual(monitor.determine_status(metrics), "DATA_ERROR")

    def test_state_signature_omits_small_price_noise(self):
        metrics = self._metrics()
        metrics["oneHourClosed"] = [
            {"low": 98.0},
            {"low": 97.0},
            {"low": 96.0},
        ]
        first = monitor.state_signature(metrics)
        metrics["lastPrice"] = 100.4
        second = monitor.state_signature(metrics)
        self.assertEqual(first, second)
        self.assertNotIn("100.4", second)

    def test_data_error_signature_is_stable(self):
        metrics = self._metrics()
        metrics["dataErrors"] = ["ticker unavailable"]
        first = monitor.state_signature(metrics)
        metrics["lastPrice"] = 120.0
        second = monitor.state_signature(metrics)
        self.assertEqual(first, second)
        self.assertEqual(first, "UAI_STATE|state=DATA_ERROR|funding=UNKNOWN|break1h=0|break4h=0|rsi1hCross=0|rsi4hDecl=0|bearDiv=0|squeeze=0|trigger1h=NA|trigger4h=NA|invalidation=NA|data=ERROR")

    def test_missing_http_date_is_not_accepted_as_fresh(self):
        self.assertEqual(monitor._freshness_error({"ageSec": None}), "missing HTTP Date")
        self.assertEqual(monitor._freshness_error({"date": "bad", "ageSec": None}), "unparseable HTTP Date")

    def test_payload_timestamp_requires_fresh_non_future_value(self):
        now_ms = 1_700_000_000_000
        self.assertIsNone(monitor._payload_timestamp_error("premium.time", now_ms - 30_000, now_ms))
        self.assertIn("timestamp age", monitor._payload_timestamp_error("premium.time", now_ms - 181_000, now_ms) or "")
        self.assertIn("future", monitor._payload_timestamp_error("premium.time", now_ms + 6_000, now_ms) or "")

    def test_wrapper_files_are_executable(self):
        root = Path(__file__).resolve().parents[1] / "scripts" / "hermes"
        for name in ("uai-short-monitor.py", "uai-short-monitor-state.py", "uai_short_monitor.py"):
            mode = os.stat(root / name).st_mode
            self.assertTrue(mode & stat.S_IXUSR, name)

    def test_rate_limit_is_not_retried_through_second_opener(self):
        class RateLimitedOpener:
            def __init__(self):
                self.calls = 0

            def open(self, request, timeout):
                self.calls += 1
                raise urllib.error.HTTPError(request.full_url, 429, "rate limited", Message(), None)

        first = RateLimitedOpener()
        second = RateLimitedOpener()
        with patch.object(monitor, "_openers", return_value=[first, second]):
            with self.assertRaisesRegex(RuntimeError, "HTTP 429; retry suppressed") as raised:
                monitor.fetch_json("https://www.binance.com/fapi/v1/test")
            cause = cast(urllib.error.HTTPError, raised.exception.__cause__)
            self.assertIsInstance(cause, urllib.error.HTTPError)
            cause.close()
        self.assertEqual(first.calls, 1)
        self.assertEqual(second.calls, 0)

    def test_detail_contains_no_auto_trade_instruction(self):
        metrics = self._metrics()
        metrics.update(
            {
                "snapshotTime": "2026-09-02T00:00:00+00:00",
                "sourceDates": ["Wed, 02 Sep 2026 00:00:00 GMT"],
                "lastPrice": 100.0,
                "markPrice": 99.9,
                "indexPrice": 99.8,
                "change24hPct": 10.0,
                "return7dPct": 30.0,
                "high24h": 110.0,
                "low24h": 90.0,
                "quoteVolume24h": 1000000,
                "fundingRate": 0.0005,
                "fundingIntervalHours": 4,
                "fundingAprPct": 109.5,
                "fundingPercentile": 95.0,
                "fundingSamples": 100,
                "dailyRsiLive": 90.0,
                "dailyRsiClosed": 88.0,
                "rsi1hLive": 70.0,
                "rsi4hLive": 80.0,
                "oiCurrent": 1000.0,
                "oiCurrentValue": 100000.0,
                "oi24hPct": 25.0,
                "oi7dPct": 35.0,
                "oiSamples": 169,
            }
        )
        output = monitor.format_detail(metrics)
        self.assertIn("autoTrade=false", output)
        self.assertIn("STATUS|WATCH_EXTREME", output)
        self.assertIn("SQUEEZE_RISK/逼空风险高", output)

    def test_top_level_failure_degrades_to_data_error(self):
        buffer = io.StringIO()
        with patch.object(monitor, "scan_live", side_effect=RuntimeError("network down")), redirect_stdout(buffer):
            result = monitor.main(["--state"])
        self.assertEqual(result, 0)
        self.assertIn("state=DATA_ERROR", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
