# Agent Note: Subscription media uses durable Harness attachments

Status: implemented

English | [中文](2026-09-11-subscription-media-output.zh.md)

## Problem

Subscription providers expose different image-generation protocols, while a conversation needs one durable representation for presentation, subsequent requests, and replay. Returning provider URLs or base64 as ordinary text loses attachment authorization and can retain oversized payloads in model history. A generated image can also make a later request fail when its adapter cannot represent images in assistant messages.

## Decision

Subscription media uses the existing `ImageBlock`, attachment service, and compact assistant streams. Provider-specific image generation belongs in FI provider code and model-facing tools, not the agent loop or a new Session format. Generated image bytes pass through attachment admission before a result exposes their durable references; native assistant images and tool-result images use the existing session authorization and gallery components.

Input images retain the [normalized attachment and deterministic request pipeline](2026-08-20-unified-image-request-pipeline.md). Input files retain the native Harness rule: the log stores structured file references, and request assembly projects them to deterministic read-only file handles for every provider. auth2api's native document and file-upload endpoints do not replace this rule.

Native provider signatures require the bytes and part ordering that the provider signed. Image normalization is a separate display operation: signed originals need durable verbatim storage when normalization can change those bytes, while private replay metadata carries references rather than base64. An adapter whose assistant wire messages cannot carry images uses explicit identity-preserving text for that history; it does not forge a user message or claim that omitted pixels were sent.

Image-generation capability is independent of image input. A provider with no raster-generation endpoint, including Claude, is not advertised as a native image generator. A chat model can use a configured image-generation tool backed by a different signed-in provider. Subscription operations resolve stored OAuth grants and retain provider-owned metadata; they do not fall back to separately billed API credentials.

## Alternatives considered

**Add a new core media protocol or change the agent loop.** Existing image blocks, tool results, attachment authorization, and compact stream records already represent the required durable facts. A parallel protocol would duplicate those owners and increase upstream merge risk.

**Return image URLs or base64 as text.** Text does not provide durable image admission, authorized retrieval, or consistent gallery rendering. It also risks losing images when remote URLs expire and inflates history when bytes are embedded.

**Replay normalized bytes with the original native signature.** Normalization can change orientation, metadata, dimensions, or encoding. A signature over the original provider part cannot be assumed to authorize those changed bytes.

**Send arbitrary file bytes instead of Harness file handles.** That would change every adapter's established input contract and bypass the execution filesystem's read-only access mapping. Native auth2api document endpoints remain separate from Harness request assembly.

## Consequences

Provider implementation and configuration determine which image-generation models are available. Shared agent-loop, released Session generations, SDK protocols, and upstream default bundles remain unchanged. Durable originals and normalized previews can consume separate immutable objects under the attachment backend's existing retention policy. Image-generating requests can consume subscription credits; an ambiguous failed generation must not silently trigger another provider or an API-key fallback.

The [embedded stream reader decision](../architecture/2026-09-06-embedded-stream-record-readers.md) continues to govern image lookup and stream projection. This note extends the input-image decision with output ownership; it does not supersede its normalization, request-size, or remote-file policies.

## Verification

Focused provider tests cover generated-image admission, malformed and oversized output, cancellation, ordering, and replay. Native-runtime tests cover file-handle projection and structured image input across all four route names. The authored `subscription-image-output` headless scenario imports a real PNG through `read_image` before preserving its reference in assistant content and compact stream records; it is durable Harness evidence, not a substitute for live provider generation.
