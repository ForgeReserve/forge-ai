# fedimint-receiver: holds Fedimint eCash for the gateway (docs/FEDIMINT-RECEIVER.md).
# Build from this directory: docker build -t forge-fedimint-receiver services/fedimint-receiver
#
# Base images pinned by digest, resolved with `docker buildx imagetools inspect` on 2026-11-19:
# rust:1.91.1-slim-bookworm (the toolchain rust-toolchain.toml names) to build, and distroless
# cc-debian12:nonroot (glibc and libstdc++ for RocksDB, CA certificates, no shell) to run. Both are
# Debian 12, so the binary finds the same glibc it was linked against.
FROM rust:1.91.1-slim-bookworm@sha256:8514999d4786ef12efe89239e86b3d0a021b94b9d35108c8efe6c79ca7dc1a65 AS build
# RocksDB and AWS-LC are compiled from source: a C/C++ compiler, CMake and libclang for bindgen.
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang libclang-dev cmake g++ make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# rust-toolchain.toml is left out on purpose: the image already has that toolchain, and the file
# would make rustup fetch clippy and rustfmt.
COPY Cargo.toml Cargo.lock ./
# The dependencies first, in their own layer, so a change to src/ rebuilds only this crate.
RUN mkdir -p src/bin \
    && echo 'fn main() {}' > src/main.rs \
    && echo 'fn main() {}' > src/bin/devfed.rs \
    && touch src/lib.rs \
    && cargo build --release --locked --bin fedimint-receiver \
    && rm -rf src
COPY src ./src
RUN touch src/main.rs src/lib.rs \
    && cargo build --release --locked --bin fedimint-receiver \
    && mkdir /data

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /src/target/release/fedimint-receiver /usr/local/bin/fedimint-receiver
# The data directory, owned by the image's non-root user (uid 65532).
COPY --from=build --chown=65532:65532 /data /data
ENV FEDIMINT_RECEIVER_DATA_DIR=/data \
    FEDIMINT_RECEIVER_LISTEN=0.0.0.0:8790
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/usr/local/bin/fedimint-receiver", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/fedimint-receiver"]
