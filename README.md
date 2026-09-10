# fi

English | [中文](README.zh.md)

<img src="apps/web/public/fi-logo.png" alt="fi" width="88">

fi is an alpha coding agent application for macOS and Windows. It combines a native desktop shell with a plugin-based agent runtime.

Current version: `0.1.6-alpha.1`

<a id="run"></a>

## Run from source

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```sh
git clone https://github.com/OJamals/fi.git
cd fi
pnpm install
pnpm run dev:desktop
```

Use `pnpm run build:official` for an official Web build. Desktop packaging, signing, and release commands are documented in [`apps/desktop`](apps/desktop/README.md).

## Updates

Production desktop builds read signed update metadata from published [fi GitHub Releases](https://github.com/OJamals/fi/releases). Alpha builds follow alpha prereleases; stable builds follow stable releases. Draft releases are ignored.

## Project status

fi is alpha software. Expect breaking changes. Read [SAFETY.md](SAFETY.md) before use.

fi is based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), originally developed by DeepSeek AI, and uses [Cordis](https://github.com/cordiverse/cordis).

## Development

See [development](docs/development.md), [architecture](docs/architecture.md), and [contributing](CONTRIBUTING.md) docs.

## License

[MIT](LICENSE). Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
