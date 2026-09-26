# Built by scripts/install.sh around a freshly compiled mc-host binary.
FROM eclipse-temurin:25-jre
COPY mc-host /usr/local/bin/mc-host
ENV MC_DATA_DIR=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache
WORKDIR /data
ENTRYPOINT ["mc-host"]
CMD ["start"]
