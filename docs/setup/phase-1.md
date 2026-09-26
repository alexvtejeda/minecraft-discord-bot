# Phase 1: Local test run on Fedora

Run these from the repo root. Nothing here touches your personal tailnet.

## 1. Update the tailnet policy (voice chat)

Open the Minecraft tailnet's admin console, go to **Access controls**, and paste in
`infra/tailscale/policy.hujson`. Then save. The new UDP test must pass.

## 2. Build the tool

```bash
bun install
(cd apps/agent && bun run build)
alias mc-host="$PWD/apps/agent/dist/mc-host"
```

## 3. Build and start the adventure server

```bash
mc-host profile build-server adventure ~/mc-test/adventure --packs ./VanillaTweaks_d471400_UNZIP_ME
mc-host profile run ~/mc-test/adventure
```

- The first run asks you to accept Mojang's EULA. Type `yes`.
- Wait for `Done (…)! For help, type "help"`.
- In the server console, run:
  - `datapack list`: all 10 Vanilla Tweaks packs should be under **enabled**. They're
    26.2 packs, so a "made for an older version" note is fine. If any show as
    **available** instead, run `datapack enable "file/<name>.zip"` and note which ones.
    (8 other Vanilla Tweaks packs were dropped because their 26.2 versions stop a 26.3
    server from starting. Add them back once Vanilla Tweaks releases 26.3 versions.)
  - `chunky radius 2000`, then `chunky start`, to pre-generate the area around spawn.

## 4. Join through Prism

```bash
mc-host profile build-mrpack adventure ~/mc-test/adventure.mrpack
```

- In Prism, go to **Add Instance → Import**, pick `adventure.mrpack`, keep the optional
  mods ticked, and launch it.
- Go to **Multiplayer → Add Server → `localhost`** and join.
- Check that you can place a Waystone, open a Traveler's Backpack, and see JEI.

## 5. Vanilla client on vanilla-plus

```bash
mc-host profile build-server vanilla-plus ~/mc-test/vanilla-plus --packs ./VanillaTweaks_d471400_UNZIP_ME
mc-host profile run ~/mc-test/vanilla-plus
```

Stop the adventure server first, because both use port 25565. Join `localhost` from a
**plain vanilla 26.3** Prism instance with no mods.

## Done when

- [ ] The policy saved with both tests passing
- [ ] `adventure` boots and all 10 datapacks are enabled
- [ ] Joined `adventure` from the imported `.mrpack`
- [ ] Joined `vanilla-plus` from a vanilla client
- [ ] `Ctrl+C` stops the server cleanly (no crash summary printed)
