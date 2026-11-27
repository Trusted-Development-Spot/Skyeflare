#!/usr/bin/env python3
"""
SkyeFlare Autonomous Hosting Deal, Pricing & Coupon Sync Agent
--------------------------------------------------------------
Runs automatically via GitHub Actions (every 6 hours) to:
1. Check official public offer & promo pages for all 8 hosting providers.
2. Verify whether active promo codes are still live; rotate in newly published
   official codes or mark expired codes (moving them to `expiredCoupons` and
   activating direct checkout auto-deals when applicable).
3. Detect verified introductory & renewal price updates within strict per-host
   sanity bounds and sync `data/hosting-deals.json` automatically without manual
   code edits.
4. Preserve last-known-good values whenever an upstream host blocks automated
   requests (WAF/Cloudflare) or times out.
"""

from __future__ import annotations

import datetime as dt
import html
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
    "Mozilla/5.0 (compatible; SkyeFlareDealMonitor/2.0; "
    "+https://skyeflare.com/about.html)"
)

REQUEST_TIMEOUT_SECONDS = 15

# Strict sanity bounds prevent noisy HTML/JS numbers from corrupting real plan prices.
PROVIDER_SPECS: dict[str, dict[str, Any]] = {
    "hostinger": {
        "url": "https://www.hostinger.com/web-hosting",
        "plan_anchor": r"Premium",
        "intro_bounds": (2.25, 4.99),
        "renewal_bounds": (7.99, 19.99),
        "check_coupons": False,
    },
    "bluehost": {
        "url": "https://www.bluehost.com/hosting/shared",
        "plan_anchor": r"(?:Starter|Basic)",
        "intro_bounds": (1.95, 7.99),
        "renewal_bounds": (7.99, 19.99),
        "check_coupons": False,
    },
    "namecheap": {
        "url": "https://www.namecheap.com/hosting/shared/",
        "coupon_url": "https://www.namecheap.com/promos/coupons/",
        "plan_anchor": r"Stellar",
        "intro_bounds": (1.20, 4.99),
        "renewal_bounds": (3.50, 9.99),
        "check_coupons": True,
        "coupon_context_pattern": r"(?:shared\s+hosting|stellar|hosting)[^.]{0,220}?\b([A-Z0-9]{7,18})\b",
    },
    "siteground": {
        "url": "https://www.siteground.com/web-hosting.htm",
        "plan_anchor": r"StartUp",
        "intro_bounds": (2.49, 7.99),
        "renewal_bounds": (12.99, 29.99),
        "check_coupons": False,
    },
    "a2hosting": {
        "url": "https://www.a2hosting.com/web-hosting/",
        "plan_anchor": r"(?:Startup|Ignite|Starter)",
        "intro_bounds": (1.99, 6.99),
        "renewal_bounds": (8.99, 19.99),
        "check_coupons": False,
    },
    "dreamhost": {
        "url": "https://www.dreamhost.com/hosting/shared/",
        "plan_anchor": r"(?:Shared\s+Starter|Launch)",
        "intro_bounds": (1.79, 5.99),
        "renewal_bounds": (6.99, 16.99),
        "check_coupons": False,
    },
    "ionos": {
        "url": "https://www.ionos.com/hosting/web-hosting",
        "plan_anchor": r"Plus",
        "intro_bounds": (0.75, 5.99),
        "renewal_bounds": (6.00, 18.00),
        "check_coupons": False,
    },
    "cloudways": {
        "url": "https://www.cloudways.com/en/pricing.php",
        "plan_anchor": r"(?:DigitalOcean|Standard)",
        "intro_bounds": (11.00, 16.00),
        "renewal_bounds": (11.00, 16.00),
        "flat_pricing": True,
        "check_coupons": False,
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

NOISE_TOKENS = {
    "DOCTYPE",
    "CHARSET",
    "VIEWPORT",
    "CONTENT",
    "HTTPSEVERYWHERE",
    "LOCALHOST",
    "CLOUDFLARE",
    "NAMECHEAP",
    "PROMOCODE",
    "COUPONCODE",
    "WORDPRESS",
    "JAVASCRIPT",
    "UNDEFINED",
    "APPLICATION",
    "STYLESHEET",
    "SHAREDHOSTING",
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
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            status = getattr(resp, "status", 200)
            raw = resp.read(500_000)
            return status, raw.decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as err:
        if err.code != 403:
            raise
        # Graceful curl fallback for hosts filtering Python urllib TLS fingerprints
        import subprocess

        proc = subprocess.run(
            ["curl", "-sL", "--max-time", str(REQUEST_TIMEOUT_SECONDS), "-A", USER_AGENT, url],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout:
            return 200, proc.stdout
        raise


def is_bot_challenge(raw_html: str) -> bool:
    lowered = raw_html[:6000].lower()
    markers = (
        "just a moment...",
        "cf-browser-verification",
        "attention required! | cloudflare",
        "enable javascript and cookies to continue",
        "access denied",
        "captcha",
    )
    return len(raw_html) < 1500 or any(m in lowered for m in markers)


def strip_html_text(raw_html: str) -> str:
    cleaned = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw_html)
    cleaned = re.sub(r"(?s)<[^>]+>", " ", cleaned)
    cleaned = html.unescape(cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def extract_jsonld_prices(raw_html: str) -> list[float]:
    prices: list[float] = []
    for block in re.findall(
        r'(?is)<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        raw_html,
    ):
        for match in re.findall(r'"price"\s*:\s*"?(\d+(?:\.\d{1,2})?)"?', block):
            try:
                prices.append(float(match))
            except ValueError:
                continue
    return prices


def extract_anchored_prices(
    raw_html: str,
    visible_text: str,
    plan_anchor: str,
    intro_bounds: tuple[float, float],
    renewal_bounds: tuple[float, float],
) -> tuple[float | None, float | None]:
    intro_candidate: float | None = None
    renewal_candidate: float | None = None

    # 1. Look near plan anchor in visible text for monthly intro price ($X.XX/mo or $X.XX /mo)
    anchor_windows = re.findall(
        rf"(?is){plan_anchor}.{{0,240}}",
        visible_text,
    )
    intro_matches: list[float] = []
    for window in anchor_windows:
        for m in re.findall(r"\$\s*(\d{1,2}(?:\.\d{2})?)\s*(?:/\s*mo|per\s*month|/\s*month)", window, re.I):
            val = float(m)
            if intro_bounds[0] <= val <= intro_bounds[1]:
                intro_matches.append(val)

    if not intro_matches:
        # Fallback to JSON-LD structured offers within intro bounds
        for val in extract_jsonld_prices(raw_html):
            if intro_bounds[0] <= val <= intro_bounds[1]:
                intro_matches.append(val)

    if intro_matches:
        intro_candidate = round(min(intro_matches), 2)

    # 2. Look specifically for explicit renewal / regular price phrasing
    renewal_matches: list[float] = []
    for m in re.findall(
        r"(?:renews\s+at|renewal\s+(?:rate|price)\s*(?:of|:)?|regular(?:ly)?\s*(?:at|:)?)\s*\$\s*(\d{1,2}\.\d{2})\s*(?:/\s*mo|per\s*month)?",
        visible_text,
        re.I,
    ):
        val = float(m)
        if renewal_bounds[0] <= val <= renewal_bounds[1]:
            renewal_matches.append(val)

    if renewal_matches:
        renewal_candidate = round(renewal_matches[0], 2)

    return intro_candidate, renewal_candidate


def extract_live_promo_codes(raw_html: str, visible_text: str, spec: dict[str, Any]) -> list[str]:
    candidates: list[str] = []

    # 1. Explicit HTML coupon attributes / code tags
    attr_patterns = [
        r'(?:data-coupon|data-promo|data-code)=["\']([A-Z0-9]{6,18})["\']',
        r'"(?:couponCode|promoCode|coupon_code)"\s*:\s*"([A-Z0-9]{6,18})"',
        r"<code[^>]*>\s*([A-Z0-9]{6,18})\s*</code>",
    ]
    for pat in attr_patterns:
        for m in re.findall(pat, raw_html):
            if m not in NOISE_TOKENS and any(ch.isalpha() for ch in m):
                candidates.append(m)

    # 2. Contextual pattern near shared hosting keywords
    ctx_pat = spec.get("coupon_context_pattern")
    if ctx_pat:
        for m in re.findall(ctx_pat, visible_text, re.I):
            token = m.strip().upper()
            if (
                token not in NOISE_TOKENS
                and token.isalnum()
                and any(ch.isalpha() for ch in token)
                and any(ch.isdigit() for ch in token)
            ):
                candidates.append(token)

    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for code in candidates:
        if code not in seen:
            seen.add(code)
            unique.append(code)
    return unique


def sync_provider_coupon(provider: dict[str, Any], spec: dict[str, Any], now_iso: str) -> list[str]:
    notes: list[str] = []
    if provider.get("promoType") != "promo_code" or not provider.get("promoCode"):
        return notes

    current_code = str(provider["promoCode"]).strip()
    expires_at = provider.get("couponExpiresAt")
    expired_by_date = False
    if expires_at:
        try:
            exp_dt = dt.datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
            expired_by_date = dt.datetime.now(dt.timezone.utc) >= exp_dt
        except ValueError:
            expired_by_date = False

    coupon_url = spec.get("coupon_url") or spec.get("url")
    live_codes: list[str] = []
    fetch_ok = False

    if coupon_url and spec.get("check_coupons"):
        try:
            status_code, raw_html = fetch_page(coupon_url)
            if 200 <= status_code < 400 and not is_bot_challenge(raw_html):
                fetch_ok = True
                visible = strip_html_text(raw_html)
                if re.search(rf"\b{re.escape(current_code)}\b", raw_html, re.I):
                    live_codes.append(current_code)
                for extracted in extract_live_promo_codes(raw_html, visible, spec):
                    if extracted not in live_codes:
                        live_codes.append(extracted)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
            fetch_ok = False

    still_valid = (current_code in live_codes if fetch_ok else not expired_by_date) and not expired_by_date

    if still_valid:
        provider["status"] = "Verified Active"
        return notes

    # Code is expired or removed on verified official coupon page
    replacement = next((c for c in live_codes if c != current_code), None)
    history = provider.setdefault("expiredCoupons", [])
    if not any(item.get("code") == current_code for item in history):
        history.insert(
            0,
            {
                "code": current_code,
                "expiredAt": now_iso,
                "replacedBy": replacement,
            },
        )
        del history[5:]

    if replacement:
        provider["promoCode"] = replacement
        provider["status"] = "Verified Active"
        provider["promoHeadline"] = provider["promoHeadline"].replace(current_code, replacement)
        provider["redemptionSteps"] = [
            step.replace(current_code, replacement) for step in provider.get("redemptionSteps", [])
        ]
        notes.append(f"rotated expired code {current_code} -> {replacement}")
    else:
        # Automatically fall back to direct checkout auto-deal so visitors never copy a dead code
        provider["promoCode"] = None
        provider["promoType"] = "auto_deal"
        provider["promoBadgeText"] = "Auto-Applied Deal"
        provider["status"] = "Auto-Deal Active"
        provider["promoHeadline"] = (
            f"Previous code {current_code} expired — direct checkout promo rate "
            f"(${provider['introPriceMonthly']:.2f}/mo) applies automatically"
        )
        notes.append(f"marked {current_code} expired and switched to auto_deal fallback")

    return notes


def update_price_copy(
    provider: dict[str, Any],
    old_intro: float,
    new_intro: float,
    old_renewal: float,
    new_renewal: float,
    old_discount: int,
    new_discount: int,
) -> None:
    term = int(provider.get("billingTermMonths", 12))
    old_total = old_intro * term
    new_total = new_intro * term
    for field in ("promoHeadline", "promoTerms"):
        text = provider.get(field)
        if not isinstance(text, str):
            continue
        if old_intro != new_intro:
            text = text.replace(f"${old_intro:.2f}", f"${new_intro:.2f}")
            text = text.replace(f"${old_total:.2f}", f"${new_total:.2f}")
        if old_renewal != new_renewal:
            text = text.replace(f"${old_renewal:.2f}", f"${new_renewal:.2f}")
        if old_discount != new_discount and old_discount > 0:
            text = text.replace(f"{old_discount}%", f"{new_discount}%")
        provider[field] = text
    if old_discount != new_discount and old_discount > 0:
        provider["redemptionSteps"] = [
            step.replace(f"{old_discount}%", f"{new_discount}%")
            for step in provider.get("redemptionSteps", [])
        ]


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

    now_iso = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    verified_count = 0
    preserved_count = 0
    updated_count = 0

    for provider in providers:
        pid = provider.get("id", "")
        if not validate_provider_entry(provider):
            print(f"WARNING: Schema check failed for '{pid}', skipping.")
            continue

        spec = PROVIDER_SPECS.get(pid)
        if not spec:
            preserved_count += 1
            continue

        provider.setdefault("expiredCoupons", [])
        change_notes: list[str] = []

        # 1. Coupon lifecycle check (rotate new code or mark expired)
        change_notes.extend(sync_provider_coupon(provider, spec, now_iso))

        # 2. Live pricing check on primary offer page
        try:
            status_code, raw_html = fetch_page(spec["url"])
            if 200 <= status_code < 400 and not is_bot_challenge(raw_html):
                verified_count += 1
                visible_text = strip_html_text(raw_html)
                live_intro, live_renewal = extract_anchored_prices(
                    raw_html,
                    visible_text,
                    spec["plan_anchor"],
                    spec["intro_bounds"],
                    spec["renewal_bounds"],
                )

                old_intro = float(provider["introPriceMonthly"])
                old_renewal = float(provider["renewalPriceMonthly"])
                old_discount = int(provider.get("discountPercent", 0))
                new_intro = old_intro
                new_renewal = old_renewal

                if live_intro is not None and live_intro <= old_renewal and abs(live_intro - old_intro) >= 0.01:
                    new_intro = live_intro
                    provider["introPriceMonthly"] = new_intro
                    provider["plans"][0]["introPriceMonthly"] = new_intro
                    change_notes.append(f"intro ${old_intro:.2f} -> ${new_intro:.2f}")

                if spec.get("flat_pricing") and new_intro != old_intro:
                    new_renewal = new_intro
                    provider["renewalPriceMonthly"] = new_renewal
                    provider["plans"][0]["renewalPriceMonthly"] = new_renewal
                elif live_renewal is not None and live_renewal >= new_intro and abs(live_renewal - old_renewal) >= 0.01:
                    new_renewal = live_renewal
                    provider["renewalPriceMonthly"] = new_renewal
                    provider["plans"][0]["renewalPriceMonthly"] = new_renewal
                    change_notes.append(f"renewal ${old_renewal:.2f} -> ${new_renewal:.2f}")

                if new_renewal > new_intro:
                    new_discount = max(0, min(95, round((1.0 - (new_intro / new_renewal)) * 100)))
                else:
                    new_discount = 0
                provider["discountPercent"] = new_discount

                if new_intro != old_intro or new_renewal != old_renewal:
                    update_price_copy(
                        provider, old_intro, new_intro, old_renewal, new_renewal, old_discount, new_discount
                    )

                provider["lastVerifiedAt"] = now_iso
                if change_notes:
                    updated_count += 1
                    provider["lastChangeNote"] = "; ".join(change_notes)
                    print(f"[UPDATED] {pid}: {provider['lastChangeNote']}")
                else:
                    print(f"[OK] {pid}: verified live (${new_intro:.2f}/mo intro, ${new_renewal:.2f}/mo renewal)")
            else:
                preserved_count += 1
                print(f"[PRESERVED] {pid}: Upstream challenge/HTTP {status_code}; keeping verified baseline.")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            preserved_count += 1
            print(f"[PRESERVED] {pid}: Fetch skipped ({exc}); keeping verified baseline.")

    if not all(validate_provider_entry(p) for p in providers):
        print("ERROR: Post-sync validation failed; aborting write.", file=sys.stderr)
        return 1

    payload["lastUpdated"] = now_iso

    temp_file = DATA_FILE.with_suffix(".json.tmp")
    with temp_file.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")

    os.replace(temp_file, DATA_FILE)
    print(
        f"Sync complete at {now_iso}: {verified_count} live-verified, "
        f"{updated_count} auto-updated, {preserved_count} preserved."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(sync_deals())
