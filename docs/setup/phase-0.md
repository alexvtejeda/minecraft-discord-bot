# Phase 0: Account setup

This is a one-time manual setup. Store every secret it gives you in your password manager.
None of them go in this repo. They're loaded into the Worker with `wrangler secret put`
in Phase 2 and Phase 3.

**Secrets you'll have at the end**

| Name | From |
|---|---|
| `DISCORD_APPLICATION_ID` | Discord → General Information |
| `DISCORD_PUBLIC_KEY` | Discord → General Information |
| `DISCORD_BOT_TOKEN` | Discord → Bot |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard (right sidebar or URL) |
| `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` | Tailscale → Trust credentials |
| `TS_TAILNET` | Tailscale → Settings → General (tailnet name). `-` also works with OAuth. |

## 1. GitHub

The repo is public, so never commit jars, worlds or secrets. `.gitignore` already covers them.

## 2. Discord

1. Go to <https://discord.com/developers/applications> and click **New Application**.
   Name it something like "Blockbot".
2. **General Information**: copy the **Application ID** and the **Public Key**.
   Leave **Interactions Endpoint URL** empty for now. It gets set in Phase 3, once the
   Worker is deployed.
3. **Bot**:
   - Click **Reset Token** and copy the bot token.
   - Turn **Public Bot** off, so only you can add the bot to servers.
   - Leave all **Privileged Gateway Intents** off. The bot uses HTTP interactions, not the gateway.
4. **Installation / OAuth2 URL Generator**:
   - Scopes: `bot` and `applications.commands`.
   - Bot permissions: View Channels, Send Messages, Embed Links, Attach Files.
   - Open the URL it generates and add the bot to your server.
5. In your Discord server:
   - Create a role called exactly `MC Maintainer` and give it to yourself.
   - Create a channel for bot announcements, for example `#minecraft`.

## 3. Cloudflare

1. Sign up at <https://dash.cloudflare.com/sign-up> and verify your email.
2. Open **R2 Object Storage** and subscribe to the free plan. This asks for a payment
   method. Usage stays within the free tier: 10 GB of storage, and downloads are free.
3. Optional but recommended: in **Billing → Notifications**, set a usage alert so a
   surprise bill can't happen.
4. Copy your **Account ID**.
5. Don't create the bucket or database yet. Wrangler creates them in Phase 2. You'll run
   `npx wrangler login` then, because it opens a browser.

## 4. Tailscale (new account for the Minecraft tailnet)

1. Sign up at <https://login.tailscale.com/start> with the new identity you're dedicating
   to this. That tailnet stays separate from your personal one.
2. **Access controls → edit the policy file**:
   - Replace the default allow-all policy with the contents of `infra/tailscale/policy.hujson`.
   - Save. The `tests` block runs automatically. If a test fails, the save is rejected.
3. **Settings → Trust credentials → Credential → OAuth**:
   - Description: `discord-bot`.
   - Scopes: **Keys → Auth Keys → Write** and **Devices → Core → Write**.
   - Tags: `tag:mc-player`.
   - Generate the credential and copy the **client ID** and **secret** straight away,
     because they're shown only once.
4. Copy the tailnet name from **Settings → General**.
5. Don't join your Fedora box to this tailnet with the system `tailscale` client. It stays
   on your personal tailnet. When it hosts, it joins the Minecraft tailnet through the
   Docker sidecar (Phase 2).
6. Optional: join your phone or laptop with your admin account to test. Admin devices can
   reach players on port 25565 (`autogroup:member` in the policy).

## Done when

- [X] The bot appears (offline) in the member list of your Discord server
- [X] The `MC Maintainer` role exists and you have it
- [X] The R2 plan is active on Cloudflare
- [X] The Tailscale policy saved without test failures, and the OAuth client exists with `tag:mc-player`
- [X] All the secrets in the table above are saved in your password manager
