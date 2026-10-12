#!/usr/bin/env python3
"""Fail closed before reusing or promoting an immutable release artifact."""
import hashlib
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text())
annotations = manifest.get("annotations", {})
assert annotations.get("org.opencontainers.image.revision") == sys.argv[2], "Artifact belongs to another commit"
assert annotations.get("org.opencontainers.image.version") == sys.argv[3], "Artifact has another version"
if len(sys.argv) == 5:
    with Path(sys.argv[4]).open("rb") as apk:
        digest = "sha256:" + hashlib.file_digest(apk, "sha256").hexdigest()
    assert any(layer.get("digest") == digest for layer in manifest.get("layers", [])), "Version already exists with another APK; bump the version"
