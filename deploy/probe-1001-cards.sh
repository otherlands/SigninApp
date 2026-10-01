#!/usr/bin/env bash
# probe-1001-cards.sh — read-only: enrolled people/cards, last events, recent card journal lines on CT106.
PIN=$(grep ^ADMIN_PIN /etc/eright-signin.env | cut -d= -f2)
echo '-- people (name / cardUid):'
curl -s -H "X-Admin-Pin: $PIN" 'localhost:3000/api/people?all=1' | tr '}' '\n' | grep -oE '"name":"[^"]*"|"cardUid":("[^"]*"|null)' | paste - -
echo '-- last 10 events:'
curl -s -H "X-Admin-Pin: $PIN" 'localhost:3000/api/events?limit=10' | tr '}' '\n' | grep -oE '"kind":"[^"]*"|"at":"[^"]*"|"device":("[^"]*"|null)|"note":("[^"]*"|null)' | paste - - - -
echo '-- lastUnknownCard:'
curl -s localhost:3000/api/state | grep -oE '"lastUnknownCard":(null|\{[^}]*\})'
echo '-- journal since 23:50:'
journalctl -u eright-signin --since '23:50' --no-pager -o cat | grep -iE 'sign|card|401|404|reader' | tail -8
