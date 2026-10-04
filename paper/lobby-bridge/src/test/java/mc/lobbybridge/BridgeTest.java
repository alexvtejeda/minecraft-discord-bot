package mc.lobbybridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class BridgeTest {
    static final Host ALEX = new Host("100.64.0.3", 25565, "adventure", "Alex");
    final FakeLobby lobby = new FakeLobby();
    final Bridge bridge = new Bridge(lobby);

    void ticks(int n) {
        for (int i = 0; i < n; i++) bridge.tick();
    }

    @Test
    void countsDownThenSendsEveryone() {
        lobby.players.addAll(List.of("sam", "kim"));
        bridge.setHost(ALEX);
        assertEquals("broadcast: Alex is hosting adventure. Sending you there in 10s. Type /stay to remain here.", lobby.events.get(0));
        ticks(10);
        assertTrue(lobby.events.contains("sam actionbar: Sending you to Alex's server in 1s"));
        assertTrue(lobby.transfers().isEmpty());
        bridge.tick();
        assertEquals(List.of("sam -> 100.64.0.3:25565", "kim -> 100.64.0.3:25565"), lobby.transfers());
    }

    @Test
    void stayKeepsYouUntilPlay() {
        lobby.players.addAll(List.of("sam", "kim"));
        bridge.setHost(ALEX);
        bridge.stay("sam");
        assertTrue(lobby.events.contains("sam message: You'll stay in the lobby. Type /play when you want to go."));
        ticks(11);
        assertEquals(List.of("kim -> 100.64.0.3:25565"), lobby.transfers());
        bridge.play("sam");
        assertEquals(List.of("kim -> 100.64.0.3:25565", "sam -> 100.64.0.3:25565"), lobby.transfers());
    }

    @Test
    void joiningWhileHostedSendsYouOnTheNextTick() {
        bridge.setHost(ALEX);
        assertTrue(lobby.events.isEmpty());
        lobby.players.add("sam");
        bridge.join("sam");
        assertEquals(List.of("sam title: Sending you to Alex's server…"), lobby.events);
        bridge.tick();
        assertEquals(List.of("sam -> 100.64.0.3:25565"), lobby.transfers());
    }

    @Test
    void hostGoingAwayCancelsTheCountdown() {
        lobby.players.add("sam");
        bridge.setHost(ALEX);
        ticks(3);
        bridge.setHost(null);
        assertTrue(lobby.events.contains("broadcast: Hosting stopped, so nobody is being sent anywhere."));
        ticks(20);
        assertTrue(lobby.transfers().isEmpty());
    }

    @Test
    void theSameHostTwiceIsOneAnnouncement() {
        lobby.players.add("sam");
        bridge.setHost(ALEX);
        bridge.setHost(new Host("100.64.0.3", 25565, "adventure", "Alex"));
        assertEquals(1, lobby.events.stream().filter(e -> e.startsWith("broadcast:")).count());
    }

    @Test
    void nobodyHosting() {
        bridge.join("sam");
        bridge.play("sam");
        bridge.stay("sam");
        assertEquals(List.of(
                "sam message: Nobody's hosting right now. /status in Discord shows who hosted last.",
                "sam message: Nobody's hosting right now. Anyone with mc-host can start with mc-host start.",
                "sam message: Nobody's hosting right now, so you're staying anyway."), lobby.events);
    }

    @Test
    void aRefusedTransferSaysHowToRetry() {
        lobby.players.add("sam");
        lobby.refuseTransfer.add("sam");
        bridge.setHost(ALEX);
        bridge.play("sam");
        assertTrue(lobby.events.contains("sam message: Couldn't send you over. Type /play to try again."));
    }

    @Test
    void consoleCommand() {
        assertEquals("lobbybridge: Sam the Builder is hosting adventure at 100.64.0.9:25565",
                bridge.command("host 100.64.0.9 25565 adventure Sam the Builder"));
        assertEquals(new Host("100.64.0.9", 25565, "adventure", "Sam the Builder"), bridge.host());
        assertEquals("lobbybridge: nobody is hosting", bridge.command("none"));
        assertNull(bridge.host());
        assertTrue(bridge.command("host x notaport w h").startsWith("Usage:"));
        assertTrue(bridge.command("").startsWith("Usage:"));
    }
}
