# Copilot Instructions for `Ray.Tampermonkey`

## Project overview
- This repository contains independent Tampermonkey userscripts.
- Current scripts are plain JavaScript files, organized by feature folder.
- Prefer minimal dependencies; default to **vanilla JavaScript**.
- Target runtime is the browser userscript environment, not Node.js.

## General coding rules
- Keep each userscript self-contained in a single `.js` file unless the user asks for refactoring.
- Preserve the Tampermonkey metadata block exactly at the top of each script.
- Do not introduce build tools, bundlers, TypeScript, or package managers unless explicitly requested.
- Prefer small, targeted edits over broad rewrites.
- Keep compatibility with modern Chromium-based browsers unless the task states otherwise.
- Avoid adding external network requests unless required by the feature.

## Userscript conventions
- Wrap runtime code in an IIFE:
  - `(() => { 'use strict'; /* ... */ })();`
- Use `const` by default; use `let` only when reassignment is needed.
- Avoid polluting the page global scope.
- Prefer DOM-safe operations and idempotent initialization.
- When observing DOM changes, debounce or limit expensive rescans.
- For async browser work, handle timeout and failure paths explicitly.

## Maintainability standards
- Reuse existing helper functions and patterns before adding new abstractions.
- Prefer descriptive function names such as `handleDetailPage`, `extractYearFromDetailPage`, `renderDetailBox`.
- Keep functions focused and reasonably short.
- Add comments only when the intent is not obvious from the code.
- Preserve existing naming and style within the edited file.

## UI and DOM update standards
- Avoid fragile selectors when a more stable selector is available.
- When injecting UI, ensure duplicate elements are not created.
- Keep injected styles namespaced to avoid collisions.
- Do not break existing page layout; prefer non-invasive overlays, badges, or appended blocks.

## Network and caching standards
- Be conservative with request frequency.
- Reuse existing cache mechanisms when present.
- Cache error states separately when appropriate to avoid repeated failing requests.
- Do not remove throttling, timeout, or cache logic unless the task requires it.

## When modifying scripts
- Preserve existing behavior unless the requested change explicitly alters it.
- Check both happy path and fallback path logic.
- Consider page transitions in SPA-like sites such as Bilibili and Jira.
- Keep selectors, observers, and injected elements resilient across repeated navigation.

## Documentation expectations
- If behavior changes materially, update the relevant `README.md`.
- Keep documentation concise and practical.

## Preferred response behavior for AI edits
- First understand the target script and its current patterns.
- Match the repository's existing plain-JS style.
- Propose the smallest viable change that solves the request.
- Call out risks if a site selector or remote API behavior may be unstable.
