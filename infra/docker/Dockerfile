# Built by scripts/install.sh around a freshly compiled mc-host binary.
# No Java in the image: mc-host downloads the Java each world needs into /data/cache/mc-host/java.
FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY mc-host /usr/local/bin/mc-host
ENV MC_DATA_DIR=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache
WORKDIR /data
ENTRYPOINT ["mc-host"]
CMD ["start"]
