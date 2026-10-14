@AGENTS.md

# Alleen voor Claude

- Publiceer met `CLAUDE_SESSION_URL=<sessielink> scripts/publish.sh` (voegt de Claude-regels toe); de commitauteur is
  standaard Rene van Es.
- Stuur Rene na het publiceren de APK uit release `vX.Y`.
- Gebruik nooit `pkill -f` in deze omgeving (dat stopt de shell); stop processen via hun procesgroep.
