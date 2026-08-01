# STOPGAP SCAFFOLD — FOR A TO REVIEW

- Added `apps/vendorsim` to `pnpm-workspace.yaml` so Person B's vendor simulator can participate in the root workspace build.
- Added `apps/agents/*` to `pnpm-workspace.yaml` so Person B's task engine can participate in the root workspace build.

## Integration assumptions

- B4 accepts a `fact_sheet_builder(lineItem, quote, registry)` callback. B6 must provide it; the shopper does not construct FactSheets from page content.
- B4 accepts an `emit(event)` callback. B10 must wire it to the in-process SSE event bus.
