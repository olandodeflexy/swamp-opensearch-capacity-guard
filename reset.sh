#!/usr/bin/env bash
# Removes everything setup.sh and swamp repo init created, including the local
# vault and run history. The source (extensions/, mock/, staging/) stays.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .claude .swamp .swamp.yaml CLAUDE.md grants models vaults workflows
echo "Reset. Run ./setup.sh to start again."
