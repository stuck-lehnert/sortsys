# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /cryptpad
ADD --checksum=sha256:f2624bb673eb4fd08952bda9343e5167506715aca91917b1956b2e4b76e1a672 https://codeload.github.com/cryptpad/cryptpad/tar.gz/86dc5ae80daa47f3b46487da9b33aeeb38846899 /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /cryptpad && rm /tmp/source.tar.gz
RUN npm ci --omit=dev && npm run install:components
# The pinned upstream installer verifies SHA-512 for both v9.3.2+3 archives.
RUN bash ./install-office.sh --accept-license --no-rdfind && npm run build
COPY patch-office.cjs /tmp/patch-office.cjs
RUN node /tmp/patch-office.cjs /cryptpad && rm /tmp/patch-office.cjs && npm run build
# This service does not expose CryptPad's CKEditor pad application. Remove its
# obsolete editor and sample pages rather than ship the known vulnerable code.
RUN npm pkg delete dependencies.ckeditor && npm prune --omit=dev \
    && rm -rf www/components/ckeditor

FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends nginx ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /cryptpad
COPY --from=build --chown=node:node /cryptpad /cryptpad
COPY --chown=node:node . /opt/sortsys-office
RUN mkdir -p /var/lib/sortsys-office && chown node:node /var/lib/sortsys-office
ENV NODE_ENV=production CRYPTPAD_CONFIG=/opt/sortsys-office/config.cjs CRYPTPAD_CONFIG_INFRA=/opt/sortsys-office/infra.cjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s CMD ["node", "/opt/sortsys-office/run.cjs", "--health"]
CMD ["node", "/opt/sortsys-office/run.cjs"]
