# Contributing to fi

fi welcomes focused pull requests, documentation improvements, and reproducible bug reports. It builds on DeepSeek Harness and Cordis; report fi-specific behavior in [this repository's issues](https://github.com/OJamals/fi/issues).

## Try fi and report a problem

Start with the [download and setup guide](../README.md#get-started). Include your app version, operating system and architecture, provider, exact model ID, reproduction steps, and expected and actual results. Distinguish sign-in, model discovery, and generation failures. Remove tokens, account identifiers, and private project content from logs or screenshots.

## Make a first contribution

1. Browse [good first issues](https://github.com/OJamals/fi/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22), or open an issue describing a small improvement. Discuss large changes before implementing them.
2. Follow [source setup](../README.md#run) and the [development guide](../docs/development.md). Read [AGENTS.md](../AGENTS.md); changes under `packages/` also require the architecture guide linked there.
3. Keep your change focused. Update the owning documentation and any bilingual counterpart. Add behavior coverage for fixes; follow the repository's snapshot requirements for user-visible changes.
4. Run the checks relevant to your change and [pre-push checks](../.agents/skills/dsh-pre-push-checks/SKILL.md). Report the commands and results in your pull request, including any checks you could not run.
5. Open a pull request against `main`. Explain the problem, resulting behavior, and validation. Include screenshots for UI changes and preserve attribution to upstream work.

Provider work needs separate evidence for catalog discovery and actual generation. Never commit credentials or claim account-wide support from a single successful request.

## Other ways to help

Test installation on your platform, improve setup instructions, share a reproducible workflow, or build a plugin. An honest report of an installation obstacle is useful even without a code change.
