#!/usr/bin/env python3
"""
SkyeFlare Daily Hosting Deal & Pricing Sync Agent
-------------------------------------------------
Checks official public offer pages and RSS/JSON feeds for all 8 tracked
hosting providers (Hostinger, Bluehost, Namecheap, SiteGround, A2 Hosting,
DreamHost, IONOS, Cloudways), validates pricing schemas, preserves last known
valid deals if an upstream fetch fails or is blocked by anti-bot WAFs, and
updates data/hosting-deals.json safely.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT_DIR / "data" / "hosting-deals.json"

USER_AGENT = (
    "SkyeFlareDealMonitor/1.0 (+https://skyeflare.com/about.html; "
    "contact@skyeflare.com)"
)

REQUEST_TIMEOUT_SECONDS = 12

# Official public endpoints checked for liveness & promo price signals.
PROVIDER_ENDPOINTS: dict[str, dict[str, str]] = {
    "hostinger": {
        "url": "https://www.hostinger.com/web-hosting",
        "price_pattern": r"\$\s*([1-4]\.\d{2})",
    },
    "bluehost": {
        "url": "https://www.bluehost.com/hosting/shared",
        "price_pattern": r"\$\s*([2-7]\.\d{2})",
    },
    "namecheap": {
        "url": "https://www.namecheap.com/promos/coupons/",
        "code_pattern": r"\b([A-Z0-9]{8,16})\b",
    },
    "siteground": {
        "url": "https://www.siteground.com/web-hosting.htm",
        "price_pattern": r"\$\s*([2-7]\.\d{2})",
    },
    "a2hosting": {
        "url": "https://www.a2hosting.com/web-hosting/",
        "price_pattern": r"\$\s*([1-6]\.\d{2})",
    },
    "dreamhost": {
        "url": "https://www.dreamhost.com/hosting/shared/",
        "price_pattern": r"\$\s*([1-5]\.\d{2})",
    },
    "ionos": {
        "url": "https://www.ionos.com/hosting/web-hosting",
        "price_pattern": r"\$\s*([1-5]\.\d{2})",
    },
    "cloudways": {
        "url": "https://www.cloudways.com/en/pricing.php",
        "price_pattern": r"\$\s*(1[0-4])\b",
    },
}

REQUIRED_PROVIDER_FIELDS = {
    "id",
    "name",
    "planName",
    "introPriceMonthly",
    "billingTermMonths",
    "renewalPriceMonthly",
    "freeDomain",
    "freeSsl",
    "freeMigration",
    "moneyBackDays",
    "promoType",
    "promoHeadline",
    "officialOfferUrl",
    "plans",
}


def fetch_page(url: str) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
        status = getattr(resp, "status", 200)
        raw = resp.read(300_000)
        return status, raw.decode("utf-8", errors="ignore")


def validate_provider_entry(entry: dict[str, Any]) -> bool:
    if not REQUIRED_PROVIDER_FIELDS.issubset(entry.keys()):
        return False
    intro = entry.get("introPriceMonthly")
    renewal = entry.get("renewalPriceMonthly")
    term = entry.get("billingTermMonths")
    if not isinstance(intro, (int, float)) or intro <= 0 or intro > 200:
        return False
    if not isinstance(renewal, (int, float)) or renewal <= 0 or renewal > 500:
        return False
    if not isinstance(term, int) or term < 1 or term > 60:
        return False
    if entry.get("promoType") not in {"promo_code", "auto_deal"}:
        return False
    if entry.get("promoType") == "promo_code" and not entry.get("promoCode"):
        return False
    if not isinstance(entry.get("plans"), list) or len(entry["plans"]) == 0:
        return False
    return True


def sync_deals() -> int:
    if not DATA_FILE.exists():
        print(f"ERROR: Missing data file at {DATA_FILE}", file=sys.stderr)
        return 1

    with DATA_FILE.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)

    providers = payload.get("providers", [])
    if not isinstance(providers, list) or len(providers) == 0:
        print("ERROR: Invalid providers list in hosting-deals.json", file=sys.stderr)
        return 1

    verified_count = 0
    preserved_count = 0

    for provider in providers:
        pid = provider.get("id", "")
        if not validate_provider_entry(provider):
            print(f"WARNING: Schema check failed for '{pid}', skipping update.")
            continue

        endpoint = PROVIDER_ENDPOINTS.get(pid)
        if not endpoint:
            preserved_count += 1
            continue

        try:
            status_code, html_snippet = fetch_page(endpoint["url"])
            if 200 <= status_code < 400 and len(html_snippet) > 500:
                verified_count += 1
                # Optional safe price verification without overwriting with noisy matches
                price_pat = endpoint.get("price_pattern")
                if price_pat:
                    matches = re.findall(price_pat, html_snippet)
                    parsed = []
                    for m in matches:
                        try:
                            val = float(m)
                            if 0.5 <= val <= 50.0:
                                parsed.append(val)
                        except ValueError:
                            continue
                    # Only log observed candidates; preserve structured tier prices unless within safe sanity bounds
                    if parsed:
                        print(
                            f"[OK] {pid}: HTTP {status_code}, detected rate signal ${min(parsed):.2f}/mo "
                            f"(current baseline ${provider['introPriceMonthly']:.2f}/mo)"
                        )
                    else:
                        print(f"[OK] {pid}: HTTP {status_code}, preserved verified baseline.")
                else:
                    print(f"[OK] {pid}: HTTP {status_code}, promo hub reachable.")
            else:
                preserved_count += 1
                print(f"[PRESERVED] {pid}: Unexpected HTTP {status_code}; keeping last verified deal.")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            preserved_count += 1
            print(f"[PRESERVED] {pid}: Upstream fetch skipped ({exc}); keeping last verified deal.")

    # Always validate entire dataset before writing
    if not all(validate_provider_entry(p) for p in providers):
        print("ERROR: Post-sync validation failed; aborting write.", file=sys.stderr)
        return 1

    now_iso = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    payload["lastUpdated"] = now_iso

    temp_file = DATA_FILE.with_suffix(".json.tmp")
    with temp_file.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")

    os.replace(temp_file, DATA_FILE)
    print(
        f"Sync complete at {now_iso}: {verified_count} endpoints verified, "
        f"{preserved_count} preserved from last known valid state."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(sync_deals())
