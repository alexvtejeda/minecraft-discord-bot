# Built by scripts/install-lobby.sh around a freshly compiled mc-host and lobby-bridge.jar.
# No Java in the image: mc-host downloads Java 25 into /data/cache/mc-host/java on first start.
FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY mc-host /usr/local/bin/mc-host
COPY lobby-bridge.jar /opt/mc-host/lobby-bridge.jar
ENV MC_DATA_DIR=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache \
    MC_LOBBY_BRIDGE_JAR=/opt/mc-host/lobby-bridge.jar
WORKDIR /data
ENTRYPOINT ["mc-host"]
CMD ["lobby"]
