FROM docker:27-cli AS docker-cli

FROM node:22-slim

RUN apt-get update && apt-get install -y \
    bash \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

COPY compose/nanoclaw-entrypoint.sh /usr/local/bin/nanoclaw-entrypoint.sh
RUN chmod +x /usr/local/bin/nanoclaw-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/nanoclaw-entrypoint.sh"]
