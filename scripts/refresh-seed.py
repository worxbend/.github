#!/usr/bin/env python3
"""Refresh the committed fallback copy of the repository list.

The site does not need this file to be current. It fetches the real list from GitHub in the
visitor's browser every few hours — see docs/assets/js/core/github.js. The seed exists for the one
case that fetch cannot cover: a first-time visitor whose network call fails, either because they
are offline or because their IP address has already spent GitHub's sixty anonymous requests for
this hour. Without a seed those visitors would get an empty catalogue; with one they get a slightly
old catalogue, clearly labelled as such.

It is also what the page paints on first load, before the network answers, so the catalogue is on
screen immediately rather than after a spinner.

No credentials. This calls exactly the same public, anonymous endpoints the browser calls, so
running it needs nothing set up:

    python3 scripts/refresh-seed.py

Three requests, well inside the anonymous limit. Re-run it whenever the committed copy has drifted
far enough to be worth a commit; nothing breaks if you never do.
"""

from __future__ import annotations

import datetime as dt
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORE = ROOT / "docs/assets/js/core/github.js"
OUT = ROOT / "docs/assets/js/data/seed.js"


def fail(message: str) -> None:
    print(f"refresh-seed: {message}", file=sys.stderr)
    sys.exit(1)


def read_accounts() -> list[tuple[str, str]]:
    """Take the account list from github.js rather than repeating it here.

    Two copies of this list would eventually disagree, and the disagreement would show up as a
    whole account quietly missing from the offline fallback but present online — which is exactly
    the kind of bug nobody thinks to look for.
    """
    text = CORE.read_text(encoding="utf-8")
    block = re.search(r"export const ACCOUNTS = \[(.*?)\n\];", text, re.S)
    if not block:
        fail("could not find ACCOUNTS in core/github.js")
    found = re.findall(r"login:\s*'([^']+)'\s*,\s*kind:\s*'([^']+)'", block.group(1), re.S)
    if not found:
        fail("ACCOUNTS in core/github.js did not parse")
    # A partial parse is the dangerous case: the regular expression matches two of three accounts,
    # every request succeeds, and the seed silently ships without one whole account. Counting the
    # `login:` keys independently catches that, where checking for "at least one match" would not.
    declared = len(re.findall(r"login:\s*'", block.group(1)))
    if declared != len(found):
        fail(f"parsed {len(found)} of {declared} accounts from core/github.js — "
             "the ACCOUNTS literal is not in the shape this script expects")
    return found


def fetch(url: str):
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "worxbend-seed-refresh"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code in (403, 429):
            fail("GitHub rate-limited this IP address. The anonymous allowance is 60 requests an "
                 "hour; wait for it to reset and run this again.")
        fail(f"GitHub returned HTTP {error.code} for {url}")
    except urllib.error.URLError as error:
        fail(f"could not reach GitHub: {error.reason}")


def main() -> None:
    accounts = read_accounts()
    rows = []
    for login, kind in accounts:
        path = "orgs" if kind == "org" else "users"
        url = (f"https://api.github.com/{path}/{login}/repos"
               f"?per_page=100&sort=pushed&direction=desc&type=owner&page=1")
        batch = fetch(url)
        if not isinstance(batch, list):
            fail(f"unexpected response shape for {login}")
        if len(batch) == 100:
            print(f"refresh-seed: warning — {login} filled a whole page; the seed may be short. "
                  "Check MAX_PAGES handling in core/github.js.", file=sys.stderr)
        for raw in batch:
            # Mirror normalise() in core/github.js exactly. The seed and a live response have to
            # be the same shape, because the merge layer cannot tell them apart.
            rows.append({
                "name": raw["name"],
                "owner": login,
                "url": raw["html_url"],
                "home": (raw.get("homepage") or "").strip(),
                "description": (raw.get("description") or "").strip(),
                "lang": raw.get("language") or "",
                "stars": raw.get("stargazers_count") or 0,
                "forks": raw.get("forks_count") or 0,
                "updated": (raw.get("pushed_at") or "")[:10],
                "topics": (raw.get("topics") or [])[:12],
                "isFork": bool(raw.get("fork")),
                "isArchived": bool(raw.get("archived")),
            })
        print(f"refresh-seed: {login}: {len(batch)} repositories")

    rows.sort(key=lambda r: (r["updated"], r["stars"]), reverse=True)
    stamp = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()

    header = f"""/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Written by scripts/refresh-seed.py from GitHub's public, anonymous API. Re-running that script
 * overwrites everything below.
 *
 * This is a fallback and a first-paint placeholder, not the source of truth. The live catalogue
 * is fetched in the browser by core/github.js; this copy is what the page shows before that
 * answers, and what it keeps showing if the visitor is offline or GitHub has rate-limited their
 * address. The page always says which of the two it is displaying.
 *
 * To change how a repository reads on the site, edit overrides.js — not this file.
 *
 * Captured {stamp}
 */

/** Every public repository on the three accounts, in the same shape a live response produces. */
export const SEED = """

    OUT.write_text(header + json.dumps(rows, indent=2, ensure_ascii=False) + ";\n",
                   encoding="utf-8")
    print(f"refresh-seed: wrote {len(rows)} repositories to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
