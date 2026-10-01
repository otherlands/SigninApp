#!/usr/bin/env bash
# cleanup-1001-junk-people.sh — deactivate the people rows whose NAME is a card number (wedge Enter hit "add person"), then list.
PIN=$(grep ^ADMIN_PIN /etc/eright-signin.env | cut -d= -f2)
ids=$(curl -s -H "X-Admin-Pin: $PIN" 'localhost:3000/api/people' | tr '}' '\n' | grep '"name":"[0-9]\{10\}"' | grep -oE '"id":"[^"]+"' | cut -d'"' -f4)
n=0
for id in $ids; do curl -s -o /dev/null -X DELETE -H "X-Admin-Pin: $PIN" "localhost:3000/api/people/$id" && n=$((n+1)); done
echo "deactivated $n junk people"
echo '-- active people (name / cardUid):'
curl -s -H "X-Admin-Pin: $PIN" 'localhost:3000/api/people' | tr '}' '\n' | grep -oE '"name":"[^"]*"|"cardUid":("[^"]*"|null)' | paste - -
