#!/usr/bin/env python3
"""Configure protected signing secrets without printing their values or passing them in argv."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("secrets_file", type=Path, help="Private JSON file outside this repository")
parser.add_argument("--repo", default="renevanes/own-cloud")
args = parser.parse_args()
if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
    parser.error("Use an owner/repository name")
if os.name == "posix" and args.secrets_file.stat().st_mode & 0o077:
    parser.error("The private file must have mode 600 (chmod 600)")
values = json.loads(args.secrets_file.read_text())
names = ("ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD")
if any(not isinstance(values.get(name), str) or not values[name] for name in names):
    parser.error("The private JSON must contain all four nonempty signing secrets")
for name in names:
    result = subprocess.run(["gh", "secret", "set", name, "--repo", args.repo], input=values[name], text=True)
    if result.returncode:
        raise SystemExit("GitHub refused signing-secret configuration. Use an account with Actions-secret administration rights.")
    print(f"Configured {name}")
