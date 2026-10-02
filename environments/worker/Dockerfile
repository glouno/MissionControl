# Pin NODE_IMAGE to the qualified immutable base digest before building.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 curl procps && rm -rf /var/lib/apt/lists/*
# Vendor tools are installed only at build time by the operator after terms review.
ARG CODEX_VERSION
ARG CLAUDE_VERSION
RUN test -n "$CODEX_VERSION" && test -n "$CLAUDE_VERSION" && \
    npm install --global --ignore-scripts \
      "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}"
RUN mkdir -p /workspace /home/worker && chown 1000:1000 /workspace /home/worker
USER 1000:1000
ENV HOME=/home/worker
WORKDIR /workspace
ENTRYPOINT ["sleep", "infinity"]
