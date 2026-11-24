#!/usr/bin/env bash
# Publishes server.json to the official MCP Registry for the version in package.json, once npm
# shows it. mcp-publisher is downloaded at MCP_PUBLISHER_VERSION and its signature checked first.
set -euo pipefail
archive="mcp-publisher_linux_amd64.tar.gz"
base_url="https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}"
curl --fail --location --silent --show-error --output "$archive" "$base_url/$archive"
curl --fail --location --silent --show-error --output "$archive.sigstore.json" "$base_url/$archive.sigstore.json"
cosign verify-blob \
  --bundle "$archive.sigstore.json" \
  --certificate-identity "https://github.com/modelcontextprotocol/registry/.github/workflows/release.yml@refs/tags/${MCP_PUBLISHER_VERSION}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "$archive"
tar xzf "$archive" mcp-publisher
rm -f "$archive" "$archive.sigstore.json"
# npm takes a few minutes to show a new version; the registry checks it.
version="$(node -p 'require("./package.json").version')"
for _ in $(seq 1 30); do
  [ "$(npm view "sap-ui-automation@$version" version 2>/dev/null)" = "$version" ] && break
  sleep 20
done
./mcp-publisher login github-oidc
./mcp-publisher publish
