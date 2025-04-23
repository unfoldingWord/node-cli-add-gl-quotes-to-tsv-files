# Use Node 20 on Ubuntu as base image
FROM node:20-slim

LABEL maintainer="Rich Mahn <richmahn@wycliffeassociates.org>"
LABEL description="Docker image for TSV processing with add-gl-quotes-to-tsv-files"

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install required system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    jq \
    gettext-base \
    git \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install add-gl-quotes-to-tsv-files globally
RUN npm install -g add-gl-quotes-to-tsv-files

# Set version label from the installed package
RUN CLI_VERSION=$(npm list -g add-gl-quotes-to-tsv-files --json | jq -r '.dependencies["add-gl-quotes-to-tsv-files"].version') \
    && echo "CLI Version: $CLI_VERSION" \
    && echo "VERSION=$CLI_VERSION" >> /etc/environment

# Verify installations
RUN echo "Node version: $(node -v)" \
    && echo "NPM version: $(npm -v)" \
    && echo "add-gl-quotes-to-tsv-files version: $(add-gl-quotes-to-tsv-files --version)" \
    && echo "gettext-base version: $(envsubst --version | head -n 1)"

# Set working directory
WORKDIR /workspace

# Default command to display versions when container runs
CMD ["sh", "-c", "echo 'Node version: '$(node -v) && echo 'TSV CLI version: '$(add-gl-quotes-to-tsv-files --version)"]