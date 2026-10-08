---
name: notion-token
description: Check, refresh or redo the Notion sign-in behind fleetwood's plan view. Use when the plan view says "as of …" and stops updating, when Notion plans are missing, or when asked to fix, refresh or re-login the Notion token.
---

# Notion token

The plan view reads Notion as Kilian, through the OAuth connection "Fleetwood
Kilian" (read-only, Tasks Database and Milestones). `notion.tokenCommand` in
`~/.fleetwood/config.json` only reads the access token from the Keychain:

```json
"notion": { "tokenCommand": "security find-generic-password -a \"$USER\" -w -s fleetwood-notion-token" }
```

Nothing refreshes it on its own. When it stops working, run the script beside
this file, in this order:

```bash
node .claude/skills/notion-token/notion-token.mjs check    # token ok?
node .claude/skills/notion-token/notion-token.mjs refresh  # new pair from the refresh token
node .claude/skills/notion-token/notion-token.mjs login    # browser sign-in, last resort
```

Then press refresh in the plan drawer. No restart needed: the command runs on
every fetch.

## Keychain items

| service | what |
|---|---|
| `fleetwood-notion-token` | access token, what `tokenCommand` prints |
| `fleetwood-notion-refresh-token` | refresh token; Notion replaces it on every refresh |
| `fleetwood-notion-client-secret` | the connection's client secret |

The client secret is set by hand, once. Copy it from the connection page at
notion.so/profile/integrations, then:

```bash
security add-generic-password -U -a "$USER" -s fleetwood-notion-client-secret -w "$(pbpaste)" && pbcopy </dev/null
```

## Gotchas

- **`login` on the consent page:** pick Bigblue and keep Tasks Database and
  Milestones selected. A page left out reads as a plan with no tickets.
- **`invalid_grant` on refresh:** the refresh token was already spent (a refresh
  whose answer was lost). Run `login`.
- **`redirect_uri` mismatch:** the redirect must be sent unencoded on the
  authorize link; the script does. A sign-in code is spent by its first exchange,
  failed or not, so a retry needs a new sign-in.
- **Never print a token.** `check` proves it works without showing it.
