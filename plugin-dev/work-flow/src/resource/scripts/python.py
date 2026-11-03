import json
import os
import sys
import textwrap
import traceback

try:
    body = json.load(sys.stdin)
    namespace = {}
    exec("def main(input, params):\n" + textwrap.indent(body["code"], "    "), namespace)
    value = namespace["main"](body["input"], body["params"])
    result = json.dumps({"ok": True, "value": value}, ensure_ascii=False, allow_nan=False)
except BaseException:
    result = json.dumps({"ok": False, "error": traceback.format_exc()[-8192:]}, ensure_ascii=False)

sys.stdout.flush()
sys.stderr.flush()
with os.fdopen(3, "w", encoding="utf-8") as protocol:
    protocol.write(result + "\n")
