# Two to Tango

A same-room vocabulary game for teenagers, run by a parent as game master. See [docs/SPEC.md](docs/SPEC.md) for the product and [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for the technical plan.

## Development

```sh
npm install
npm test          # vitest
npm run typecheck # tsc -b
```

| Folder | What |
| --- | --- |
| `packages/core` | Item schema, answer boxes, given letters, bank checks |
| `content` | Item banks |
| `docs` | Spec and implementation plan |

## Licenses

Code and content are licensed separately.

| Part | License | Covers |
| --- | --- | --- |
| Code | [AGPL-3.0-only](LICENSE) | Everything outside `content/`, including the bank generation scripts and prompts |
| Item banks | [CC BY-SA 4.0](content/LICENSE) | Everything inside `content/` |

The copyright holder reserves the right to distribute builds of the app through app stores, whose terms are generally seen as incompatible with the GPL family of licenses.

Outside contributions need a contributor agreement allowing app-store distribution. Until one exists, this repository doesn't accept outside code.
