# Claude Code Replica

A local terminal coding assistant for Anthropic and OpenAI-compatible model providers. Requires Node.js 22.22.1 or newer.

## Run from Source

```sh
npm install
npm run build
npm start
```

Configure your provider with a local `.env` file using [.env.example](.env.example). API keys and local settings are not included in release packages.

## Documentation

- [Quick start](docs/快速开始.md)
- [Advanced usage and SDKs](docs/深度使用指南.md)
- [Managed loops](docs/loop-management.md)
- [Release notes](docs/CHANGELOG.md)
- [Limitations](docs/局限性说明.md)

## Development

```sh
npm run typecheck
npm run check
npm test
npm run smoke
npm run smoke:package
```

The package check builds and unpacks the actual npm archive, checks CLI and SDK entry points, and verifies release-note rendering without contacting a model provider. It requires `tar`. It uses the checkout's installed external dependencies; it does not replace a clean-install check.

Builds retain source maps locally. Release archives contain JavaScript, SDKs, examples and user documentation, excluding source maps, tests, local configuration and historical reports. Maintainer navigation starts at [docs/README.md](https://github.com/zxjgod/claude_personal/blob/main/docs/README.md); historical records are indexed in [docs/archive/README.md](https://github.com/zxjgod/claude_personal/blob/main/docs/archive/README.md).
