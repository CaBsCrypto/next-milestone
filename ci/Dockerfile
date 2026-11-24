FROM node:24-bookworm-slim AS node
FROM ubuntu:24.04

ENV CARGO_HOME=/opt/rust/cargo RUSTUP_HOME=/opt/rust/rustup
ENV PATH=/opt/rust/cargo/bin:/opt/solana/bin:/opt/solana/solana-release/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential bzip2 ca-certificates clang curl git libssl-dev libudev-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --retry 3 https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.96.0

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

COPY ci/install-solana.sh /tmp/install-solana.sh
RUN bash /tmp/install-solana.sh /opt/solana

WORKDIR /workspace
