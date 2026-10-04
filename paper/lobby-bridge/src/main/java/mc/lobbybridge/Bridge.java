package mc.lobbybridge;

import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * The lobby's rules. When a host comes up, everyone online gets a countdown and is then sent
 * over, unless they typed /stay. Anyone joining while a host is up is sent on the next tick.
 * tick() is called once a second.
 */
public final class Bridge {
    public static final int COUNTDOWN_SECONDS = 10;
    static final String USAGE = "Usage: lobbybridge none | lobbybridge host <address> <port> <world> <holder>";

    private final Lobby lobby;
    private Host host;
    /** Seconds left, or -1 when no countdown is running. */
    private int countdown = -1;
    private final Set<String> staying = new HashSet<>();
    private final Set<String> arriving = new HashSet<>();

    public Bridge(Lobby lobby) {
        this.lobby = lobby;
    }

    public Host host() {
        return host;
    }

    public void setHost(Host next) {
        if (Objects.equals(host, next)) return;
        boolean counting = countdown >= 0;
        host = next;
        countdown = -1;
        staying.clear();
        arriving.clear();
        if (next == null) {
            if (counting) lobby.broadcast("Hosting stopped, so nobody is being sent anywhere.");
            return;
        }
        if (lobby.online().isEmpty()) return;
        lobby.broadcast(next.holder() + " is hosting " + next.world() + ". Sending you there in " + COUNTDOWN_SECONDS + "s. Type /stay to remain here.");
        countdown = COUNTDOWN_SECONDS;
    }

    public void tick() {
        for (String player : List.copyOf(arriving)) {
            arriving.remove(player);
            send(player);
        }
        if (countdown < 0) return;
        if (countdown == 0) {
            countdown = -1;
            for (String player : lobby.online()) if (!staying.contains(player)) send(player);
            return;
        }
        for (String player : lobby.online()) {
            if (!staying.contains(player)) lobby.actionBar(player, "Sending you to " + host.holder() + "'s server in " + countdown + "s");
        }
        countdown--;
    }

    public void join(String player) {
        if (host == null) {
            lobby.message(player, "Nobody's hosting right now. /status in Discord shows who hosted last.");
            return;
        }
        lobby.title(player, "Sending you to " + host.holder() + "'s server…");
        arriving.add(player);
    }

    public void quit(String player) {
        staying.remove(player);
        arriving.remove(player);
    }

    public void stay(String player) {
        if (host == null) {
            lobby.message(player, "Nobody's hosting right now, so you're staying anyway.");
            return;
        }
        staying.add(player);
        arriving.remove(player);
        lobby.message(player, "You'll stay in the lobby. Type /play when you want to go.");
    }

    public void play(String player) {
        if (host == null) {
            lobby.message(player, "Nobody's hosting right now. Anyone with mc-host can start with mc-host start.");
            return;
        }
        staying.remove(player);
        send(player);
    }

    /** The console command from mc-host lobby: "none", or "host <address> <port> <world> <holder…>". Returns the reply. */
    public String command(String args) {
        String[] parts = args.trim().split("\\s+", 5);
        if (parts.length == 1 && parts[0].equals("none")) {
            setHost(null);
            return "lobbybridge: nobody is hosting";
        }
        if (parts.length == 5 && parts[0].equals("host")) {
            int port;
            try {
                port = Integer.parseInt(parts[2]);
            } catch (NumberFormatException e) {
                return USAGE;
            }
            setHost(new Host(parts[1], port, parts[3], parts[4]));
            return "lobbybridge: " + parts[4] + " is hosting " + parts[3] + " at " + parts[1] + ":" + port;
        }
        return USAGE;
    }

    private void send(String player) {
        try {
            lobby.transfer(player, host.address(), host.port());
        } catch (IllegalStateException e) {
            lobby.message(player, "Couldn't send you over. Type /play to try again.");
        }
    }
}
