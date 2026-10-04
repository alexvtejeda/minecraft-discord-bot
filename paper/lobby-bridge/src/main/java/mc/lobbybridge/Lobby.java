package mc.lobbybridge;

import java.util.List;

/** The bits of the server Bridge needs, so its rules can be tested without one. Players are named. */
public interface Lobby {
    List<String> online();
    void broadcast(String message);
    void message(String player, String message);
    void actionBar(String player, String message);
    void title(String player, String title);
    /** Throws IllegalStateException when the client can't be transferred right now. */
    void transfer(String player, String host, int port);
}
