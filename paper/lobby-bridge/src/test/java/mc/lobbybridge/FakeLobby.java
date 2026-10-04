package mc.lobbybridge;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class FakeLobby implements Lobby {
    final List<String> players = new ArrayList<>();
    final List<String> events = new ArrayList<>();
    final Set<String> refuseTransfer = new HashSet<>();

    @Override public List<String> online() { return List.copyOf(players); }
    @Override public void broadcast(String message) { events.add("broadcast: " + message); }
    @Override public void message(String player, String message) { events.add(player + " message: " + message); }
    @Override public void actionBar(String player, String message) { events.add(player + " actionbar: " + message); }
    @Override public void title(String player, String title) { events.add(player + " title: " + title); }

    @Override
    public void transfer(String player, String host, int port) {
        if (refuseTransfer.contains(player)) throw new IllegalStateException("not now");
        events.add(player + " -> " + host + ":" + port);
    }

    List<String> transfers() {
        return events.stream().filter(e -> e.contains(" -> ")).toList();
    }
}
