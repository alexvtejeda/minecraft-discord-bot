package mc.lobbybridge;

/** Who the lobby sends players to, as told by mc-host lobby. */
public record Host(String address, int port, String world, String holder) {}
