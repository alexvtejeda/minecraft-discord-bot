package mc.lobbybridge;

import java.util.List;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.title.Title;
import org.bukkit.Server;
import org.bukkit.entity.Player;

/** Lobby on a real Paper server. Players who left in the meantime are skipped. */
final class PaperLobby implements Lobby {
    private final Server server;

    PaperLobby(Server server) {
        this.server = server;
    }

    @Override
    public List<String> online() {
        return server.getOnlinePlayers().stream().map(Player::getName).toList();
    }

    @Override
    public void broadcast(String message) {
        server.broadcast(Component.text(message, NamedTextColor.GREEN));
    }

    @Override
    public void message(String player, String message) {
        Player p = server.getPlayerExact(player);
        if (p != null) p.sendMessage(Component.text(message, NamedTextColor.YELLOW));
    }

    @Override
    public void actionBar(String player, String message) {
        Player p = server.getPlayerExact(player);
        if (p != null) p.sendActionBar(Component.text(message));
    }

    @Override
    public void title(String player, String title) {
        Player p = server.getPlayerExact(player);
        if (p != null) p.showTitle(Title.title(Component.text(title), Component.empty()));
    }

    @Override
    public void transfer(String player, String host, int port) {
        Player p = server.getPlayerExact(player);
        if (p != null) p.transfer(host, port);
    }
}
