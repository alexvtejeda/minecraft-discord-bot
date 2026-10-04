package mc.lobbybridge;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.StringArgumentType;
import io.papermc.paper.command.brigadier.Commands;
import io.papermc.paper.plugin.lifecycle.event.types.LifecycleEvents;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

public final class LobbyBridgePlugin extends JavaPlugin implements Listener {
    private Bridge bridge;

    @Override
    public void onEnable() {
        bridge = new Bridge(new PaperLobby(getServer()));
        getServer().getPluginManager().registerEvents(this, this);
        getServer().getScheduler().runTaskTimer(this, () -> bridge.tick(), 20L, 20L);
        getLifecycleManager().registerEventHandler(LifecycleEvents.COMMANDS, event -> {
            var commands = event.registrar();
            commands.register(Commands.literal("stay")
                    .requires(source -> source.getSender() instanceof Player)
                    .executes(ctx -> {
                        bridge.stay(ctx.getSource().getSender().getName());
                        return Command.SINGLE_SUCCESS;
                    })
                    .build(), "Stay in the lobby when someone starts hosting");
            commands.register(Commands.literal("play")
                    .requires(source -> source.getSender() instanceof Player)
                    .executes(ctx -> {
                        bridge.play(ctx.getSource().getSender().getName());
                        return Command.SINGLE_SUCCESS;
                    })
                    .build(), "Go to whoever is hosting");
            // Typed by mc-host lobby into the console; players can't use it.
            commands.register(Commands.literal("lobbybridge")
                    .requires(source -> source.getSender() instanceof ConsoleCommandSender)
                    .then(Commands.argument("args", StringArgumentType.greedyString())
                            .executes(ctx -> {
                                String reply = bridge.command(StringArgumentType.getString(ctx, "args"));
                                ctx.getSource().getSender().sendPlainMessage(reply);
                                return Command.SINGLE_SUCCESS;
                            }))
                    .build(), "Set by mc-host lobby: who is hosting");
        });
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        bridge.join(event.getPlayer().getName());
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        bridge.quit(event.getPlayer().getName());
    }
}
