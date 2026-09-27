#!/usr/bin/env bash
# events-ct106.sh — last 8 register events + last unknown card (read-only). Pipe via ssh root@192.168.101.102 bash
python3 - <<'EOF'
import sqlite3, json
db = sqlite3.connect('/opt/eright-signin/data/signin.sqlite')
row = db.execute("select value from settings where key='lastUnknownCard'").fetchone()
print("lastUnknownCard:", row[0] if row else None)
for r in db.execute("select at,kind,source,device,note from events order by at desc limit 8"):
    print(*r, sep=" | ")
EOF
