# Use the official Gitea runner image as base
FROM gitea/runner-images:ubuntu-latest

# Label information
LABEL maintainer="Rich Mahn <richmahn@unfoldingword.org>" \
      description="Docker image for TSV processing with add-gl-quotes-to-tsv-files"

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js v20 using a more direct approach
RUN apt-get update && \
    apt-get install -y ca-certificates curl gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y nodejs jq gettext-base && \
    rm -rf /var/lib/apt/lists/*

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

# Working directory is already set by the base image
# User setup is already handled by the base image
# Entrypoint is already configured correctly in the base image