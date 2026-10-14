#!/usr/bin/env python3
"""Versie toekennen uit de beschreven wijzigingen (wijzigingen/*.txt).

Meerdere agents en mensen werken tegelijk; daarom kiest niemand zelf een versienummer tijdens het werk. Elke wijziging
krijgt een eigen bestand in wijzigingen/ (scripts/wijziging.sh). Pas bij publiceren (scripts/publish.sh) of bij het
samenvoegen van een pull request (CI, job "versie") bepaalt dit script het volgende nummer, ten opzichte van wat er op
dat moment op main staat:

  python3 scripts/release.py apply [--base-version FILE] [--base-changelog FILE] [--message-file FILE]

  - leest alle wijzigingen/*.txt (regels voor de gebruiker; lege regels en regels met # tellen niet; een regel "!major"
    maakt er een hoofdversie van: 1.9 -> 2.0);
  - neemt ook regels mee uit een "oude stijl" ophoging (een bovenste item in changelog.json dat nog niet op main staat);
  - schrijft VERSION en changelog.json (het nieuwe item bovenaan de changelog van main) en verwijdert de wijzigingsbestanden;
  - schrijft het commitbericht ("Versie X.Y" + de regels) naar --message-file en print "X.Y CODE".
Exitcode 2 = geen beschreven wijziging gevonden.
"""
import argparse
import datetime
import glob
import json
import os
import re
import sys
import zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_version(text):
    name = re.search(r"^VERSION_NAME=(.+)$", text, re.M)
    code = re.search(r"^VERSION_CODE=(\d+)$", text, re.M)
    if not name or not code:
        sys.exit("VERSION mist VERSION_NAME of VERSION_CODE")
    return name.group(1).strip(), int(code.group(1))


def fragments():
    files = sorted(f for f in glob.glob(os.path.join(ROOT, "wijzigingen", "*.txt")))
    lines, major = [], False
    for f in files:
        for raw in open(f, encoding="utf-8").read().splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line == "!major":
                major = True
                continue
            if line.startswith("- "):
                line = line[2:].strip()
            if line not in lines:
                lines.append(line)
    return files, lines, major


def main():
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["apply", "check"])
    p.add_argument("--base-version", default=os.path.join(ROOT, "VERSION"))
    p.add_argument("--base-changelog", default=os.path.join(ROOT, "changelog.json"))
    p.add_argument("--message-file")
    a = p.parse_args()

    base_name, base_code = read_version(open(a.base_version, encoding="utf-8").read())
    base_log = json.load(open(a.base_changelog, encoding="utf-8"))
    base_versions = {e["version"] for e in base_log}

    files, lines, major = fragments()
    # Oude stijl (scripts/bump.sh van vóór versie 1.20): een eigen item bovenaan changelog.json dat main nog niet kent.
    current_log = json.load(open(os.path.join(ROOT, "changelog.json"), encoding="utf-8"))
    for e in current_log:
        if e["version"] in base_versions:
            break
        for c in e.get("changes", []):
            if c not in lines:
                lines.append(c)

    if a.cmd == "check":
        print(f"{len(files)} wijzigingsbestand(en), {len(lines)} regel(s)")
        sys.exit(0 if lines else 2)
    if not lines:
        print("Geen beschreven wijziging gevonden. Beschrijf wat je veranderde: scripts/wijziging.sh \"wat de gebruiker merkt\"", file=sys.stderr)
        sys.exit(2)

    maj, minor = (int(x) for x in base_name.split("."))
    name = f"{maj + 1}.0" if major else f"{maj}.{minor + 1}"
    code = base_code + 1

    version_text = open(a.base_version, encoding="utf-8").read()
    version_text = re.sub(r"^VERSION_NAME=.*$", f"VERSION_NAME={name}", version_text, flags=re.M)
    version_text = re.sub(r"^VERSION_CODE=.*$", f"VERSION_CODE={code}", version_text, flags=re.M)
    open(os.path.join(ROOT, "VERSION"), "w", encoding="utf-8").write(version_text)

    today = datetime.datetime.now(zoneinfo.ZoneInfo("Europe/Amsterdam")).date().isoformat()
    log = [{"version": name, "date": today, "changes": lines}] + base_log
    with open(os.path.join(ROOT, "changelog.json"), "w", encoding="utf-8") as fh:
        json.dump(log, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    for f in files:
        os.remove(f)

    if a.message_file:
        with open(a.message_file, "w", encoding="utf-8") as fh:
            fh.write(f"Versie {name}\n\n" + "\n".join("- " + c for c in lines) + "\n")
    print(f"{name} {code}")


if __name__ == "__main__":
    main()
