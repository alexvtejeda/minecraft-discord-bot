# Phase 2a: Deploy the Worker and host from Fedora

Design: [../superpowers/specs/2026-09-26-phase-2a-hosting-design.md](../superpowers/specs/2026-09-26-phase-2a-hosting-design.md)

## 1. Create the D1 database and the R2 bucket

```bash
cd apps/worker
bunx wrangler login
bunx wrangler d1 create mc-bot          # copy the database_id it prints
bunx wrangler r2 bucket create mc-bot
```

Edit `apps/worker/wrangler.jsonc`:
- set `d1_databases[0].database_id` to the ID printed above
- set `vars.R2_ACCOUNT_ID` to your Cloudflare account ID (Dashboard → R2 → Overview, right-hand side)

Neither value is a secret, so commit them.

```bash
bunx wrangler d1 migrations apply DB --remote
```

## 2. Secrets

1. Dashboard → R2 → **Manage API tokens** → create a token with **Object Read & Write**, scoped to the `mc-bot` bucket.
2. Store the secrets. Each command prompts for its value, so nothing lands in your shell history:
   ```bash
   bunx wrangler secret put R2_ACCESS_KEY_ID
   bunx wrangler secret put R2_SECRET_ACCESS_KEY
   openssl rand -base64 32 | tr -d '\n' > /tmp/mc-admin-secret   # or any long random string
   bunx wrangler secret put ADMIN_SECRET < /tmp/mc-admin-secret
   ```
3. Put the Worker URL and the same admin secret in `~/.config/mc-host/admin.json` (mode 600):
   ```json
   { "workerUrl": "https://mc-bot.<you>.workers.dev", "secret": "<the admin secret>" }
   ```
   Then `shred -u /tmp/mc-admin-secret`.

## 3. Deploy

```bash
bunx wrangler deploy
curl -s https://mc-bot.<you>.workers.dev/health      # → ok
```

## 4. Your hosting token and the tailnet auth key

```bash
bun apps/agent/src/cli.ts admin token mint <your discord id> <your name>
```
In the Minecraft tailnet's admin console, go to Settings → Keys → **Generate auth key**:
- Reusable: off
- Ephemeral: off
- Pre-approved: on
- Tags: `tag:mc-player`

## 5. Install and import the Phase 1 world

```bash
scripts/install.sh --worker-url https://mc-bot.<you>.workers.dev --token <token> --authkey tskey-auth-…
mc-host admin world create adventure --import <the Phase 1 server folder>
mc-host admin status
```

## Manual checklist

- [ ] `mc-host status` shows the imported world at rev 1, with nobody hosting.
- [ ] `mc-host start` downloads rev 1, builds, prints "Hosting … Players connect to 100.x.y.z:25565".
- [ ] Join from another device on the Minecraft tailnet (a phone or laptop tagged `mc-player`) using that address.
- [ ] Typing `list` in the hosting terminal shows the players.
- [ ] Wait for an autosave, or temporarily edit `AUTOSAVE_MS`. The terminal says "Autosaved as rev 2" and `mc-host admin status` shows rev 2.
- [ ] **R2 checksum:** the autosave upload succeeded. That means R2 accepted the signed `x-amz-checksum-sha256` header. If R2 rejects it (HTTP 400/501 on the PUT), remove the header from `r2Storage().putTarget` and note it in the spec. Commit still checks the size, and the agent checks the sha256 on download.
- [ ] Ctrl+C: the server stops, "World saved as rev 3", and `mc-host admin status` shows nobody hosting.
- [ ] `mc-host start`, then from another terminal `docker kill mc-host-agent` partway through the session. The next `mc-host start` asks "Your last session didn't finish uploading … Upload it now? [Y/n]". Enter uploads it.
- [ ] `mc-host stop` from a second terminal stops a running session the same way Ctrl+C does.
- [ ] `mc-host admin world create vanilla-plus --replace`, then `mc-host start`. Chunky starts pre-generating (`chunky progress` in the console shows it).
