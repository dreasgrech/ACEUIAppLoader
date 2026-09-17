"""gen_protofields.py - turn the recovered .proto schemas into a lookup the console ships.

The game mirrors protobuf messages into the `window.Model*` globals every frame, but a
live object only shows the fields the game happened to populate. The recovered schemas in
ACEGameInternals/proto say what the message *can* carry, including fields this build never
fills in -- which is exactly the interesting part.

This reads those .proto files and writes `devconsole/protofields.js`, a plain data file
the console loads on demand (`.fields <name>`), so the schema can be compared against the
live object in game.

    python tools/gen_protofields.py [--protos <dir>] [--out <file>]

Only the UI-facing schemas are included, to keep the shipped file small: PlatformUiTypes
(every UI model and the types they nest), the game-mode scoring messages and the raw input
axes. The file is listed under app.json's "files" key, so it ships but is not subject to
the test kit's style rules for scripts.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_internals():
    """
    ACEGameInternals/proto: $ACE_INTERNALS_DIR, or a checkout beside any directory above
    this one. It used to be "the sibling of this repo", which stopped being true when the
    console moved into the loader's apps/ -- and this is a tool you reach for once a game
    version, so a wrong default would have been found the hard way.
    """
    override = os.environ.get("ACE_INTERNALS_DIR")
    if override:
        return os.path.join(override, "proto")
    here = HERE
    while True:
        candidate = os.path.join(os.path.dirname(here), "ACEGameInternals", "proto")
        if os.path.isdir(candidate):
            return candidate
        parent = os.path.dirname(here)
        if parent == here:
            return candidate
        here = parent


DEFAULT_INTERNALS = find_internals()

# the schemas worth shipping: everything a page can actually read
WANTED = ["PlatformUiTypes.proto", "InputEnum.proto"]
WANTED_GLOBS = [os.path.join("gamemodes", "*.proto")]

FIELD_RE = re.compile(
    r"^\s*(?:(repeated|optional|required)\s+)?"      # label
    r"([A-Za-z_][\w.]*(?:<[^>]+>)?)\s+"              # type (incl. Foo.Bar and map<k,v>)
    r"([A-Za-z_]\w*)\s*=\s*(\d+)\s*;"                # name = number;
)
ENUM_VALUE_RE = re.compile(r"^\s*([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*;")
MESSAGE_RE = re.compile(r"^\s*message\s+([A-Za-z_]\w*)\s*\{")
ENUM_RE = re.compile(r"^\s*enum\s+([A-Za-z_]\w*)\s*\{")

# which JS global carries which message (curated: ACEGameInternals/docs/ui-models.md,
# cross-checked against the 12 globals actually published, measured in game 2026-09-15)
MODELS = {
    "ModelCurrentCar": "UICurrentCarState",
    "ModelUIState": "UIState",
    "ModelUISessionState": "UISessionState",
    "ModelTiming": "UITimingState",
    "ModelLeaderboard": "UILeaderboardState",
    "ModelUIRealtimeLeaderboard": "UIRealtimeLeaderboardState",
    "ModelUIRadarState": "UIRadarState",
    "ModelCarsOnTrack": "UICarsOnTrackState",
    "ModelUIDriverState": "UIDriverState",
    "ModelUIPenaltyState": "UIPenaltyState",
    "ModelUIReplayState": "UIReplayState",
    "ModelUIFreeRoamState": "UIFreeRoamState",
    "ModelUIExInputsAxii": "UIExInputsAxii",
}


def latest_version_dir(protos_root):
    names = sorted(n for n in os.listdir(protos_root) if os.path.isdir(os.path.join(protos_root, n)))
    if not names:
        raise SystemExit("no version directory under %s" % protos_root)
    return names[-1]


def wanted_files(version_dir):
    import glob

    out = []
    for name in WANTED:
        path = os.path.join(version_dir, name)
        if os.path.exists(path):
            out.append(path)
    for pattern in WANTED_GLOBS:
        out.extend(sorted(glob.glob(os.path.join(version_dir, pattern))))
    return out


def parse(path):
    """Returns (messages, enums) from one .proto, handling nesting by brace depth."""
    messages = {}
    enums = {}
    stack = []            # (kind, name, container)
    depth = 0

    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped or stripped.startswith("//"):
                # still track braces inside comments-free lines only
                pass

            msg = MESSAGE_RE.match(line)
            enm = ENUM_RE.match(line)

            if msg:
                stack.append(("message", msg.group(1), []))
                depth += 1
                continue
            if enm:
                stack.append(("enum", enm.group(1), []))
                depth += 1
                continue

            if "{" in stripped and not msg and not enm:
                depth += stripped.count("{")
            if "}" in stripped:
                closes = stripped.count("}")
                for _ in range(closes):
                    if stack and depth == len(stack):
                        kind, name, items = stack.pop()
                        if kind == "message":
                            messages[name] = items
                        else:
                            enums[name] = items
                    depth = max(0, depth - 1)
                continue

            if not stack:
                continue

            kind, _, items = stack[-1]
            if kind == "enum":
                m = ENUM_VALUE_RE.match(line)
                if m:
                    items.append([m.group(1), int(m.group(2))])
                continue

            m = FIELD_RE.match(line)
            if m:
                label, ftype, fname, fnum = m.groups()
                items.append([fname, ftype, int(fnum), label or ""])

    return messages, enums


def build(version_dir):
    messages, enums, origin = {}, {}, {}
    for path in wanted_files(version_dir):
        base = os.path.basename(path)
        msgs, ens = parse(path)
        for name, fields in msgs.items():
            messages[name] = fields
            origin[name] = base
        enums.update(ens)
    return messages, enums, origin


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--protos", default=DEFAULT_INTERNALS, help="ACEGameInternals/proto directory")
    parser.add_argument("--out", default=os.path.join(HERE, "devconsole", "protofields.js"))
    args = parser.parse_args()

    if not os.path.isdir(args.protos):
        raise SystemExit("no proto directory at %s (clone ACEGameInternals beside the loader repo, or set ACE_INTERNALS_DIR)" % args.protos)

    version = latest_version_dir(args.protos)
    version_dir = os.path.join(args.protos, version)
    messages, enums, origin = build(version_dir)

    if not messages:
        raise SystemExit("parsed no messages from %s" % version_dir)

    payload = {
        "version": version,
        "messages": messages,
        "enums": enums,
        "origin": origin,
        "models": {k: v for k, v in MODELS.items() if v in messages},
    }

    body = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    text = (
        "/* Generated by tools/gen_protofields.py from ACEGameInternals/proto/%s -- do not edit.\n"
        "   Loaded on demand by the console's .fields command; listed under app.json \"files\". */\n"
        "window.ACEProtoFields = %s;\n" % (version, body)
    )

    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)

    unmapped = sorted(set(MODELS.values()) - set(messages))
    print("%s: %d messages, %d enums, %d models, %.1f KB" % (
        os.path.relpath(args.out, HERE), len(messages), len(enums), len(payload["models"]), len(text) / 1024.0))
    if unmapped:
        print("note: these mapped messages were not found in the shipped schemas: %s" % ", ".join(unmapped))
    return 0


if __name__ == "__main__":
    sys.exit(main())
