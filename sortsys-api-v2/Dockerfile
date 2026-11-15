FROM rust:1.99-bookworm AS duckdb
COPY sortsys-api-v2/rust-api/duckdb/install /tmp/install-duckdb
RUN bash /tmp/install-duckdb /opt/duckdb

FROM rust:1.99-bookworm AS builder

COPY --from=duckdb /opt/duckdb /opt/duckdb
ENV DUCKDB_LIB_DIR=/opt/duckdb DUCKDB_INCLUDE_DIR=/opt/duckdb

WORKDIR /app/sortsys-api-v2

COPY sortsys-api-v2/Cargo.toml sortsys-api-v2/Cargo.lock ./
COPY sortsys-api-v2/rust-api ./rust-api
COPY sortsys-store/Cargo.toml /app/sortsys-store/Cargo.toml
COPY sortsys-store/src /app/sortsys-store/src
COPY sortsys-zerotrust/Cargo.toml /app/sortsys-zerotrust/Cargo.toml
COPY sortsys-zerotrust/rust /app/sortsys-zerotrust/rust

RUN cargo build --release --locked --package sortsys-api --bin sortsys-api


FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libssl3 \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home sortsys

COPY --from=duckdb /opt/duckdb/libduckdb.so /usr/local/lib/
COPY --from=duckdb /opt/duckdb/extensions /usr/local/share/sortsys-duckdb/extensions
COPY sortsys-api-v2/rust-api/duckdb/licenses /usr/local/share/licenses/sortsys-duckdb
RUN ldconfig

COPY --from=builder /app/sortsys-api-v2/target/release/sortsys-api /usr/local/bin/sortsys-api

USER sortsys

ENV PORT=3000
EXPOSE 3000

CMD ["/usr/local/bin/sortsys-api"]
