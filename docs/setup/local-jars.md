# Local jars: rollout and everyday use

## Rollout (once)

1. Release the agent first, so hosts can update before the Worker turns 0.2.0 away:
   `git tag v0.3.0 && git push origin v0.3.0`, and wait for the release workflow.
2. Apply the migration and deploy:
   ```bash
   cd apps/worker
   bunx wrangler d1 migrations apply mc-bot --remote   # adds the jars table
   bun run deploy
   bun run register   # adds /mod upload
   ```
3. Tell hosts to run `/setup host` once to get mc-host 0.3.0.

## Adding a jar

From the terminal (any size up to 32 MB):

    mc-host admin jar add cst "mods/the-deeper-end-fabric-1.1.1.jar"

From Discord: `/mod upload jar:<file> side:Everyone`.

Either way you get one line. Paste it into the profile's `"mods"`, then:

    mc-host profile resolve cst
    mc-host profile check-packs cst      # boots the server; names missing dependencies
    git commit -am "feat(profiles): add <mod> to cst"

Deploy, then `/world repin`.

## Removing a jar

Delete its line, resolve, commit, deploy, `/world repin`. The jar stays in R2 so older
snapshots can still be rolled back to.
