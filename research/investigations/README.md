# Active Research & Investigations

This directory contains documentation of ongoing research, experiments, and investigations into various technical challenges and opportunities.

## Purpose

- Document technical investigations and their findings
- Track research into new technologies and approaches
- Preserve knowledge about attempted solutions and their outcomes
- Inform future architectural decisions

## Investigations

### [Python Agent Browser Execution](./python-agent-browser-execution.md)
**Status**: Active Research  
**Date**: January 2026  
**Summary**: Investigation into running Python-based Quest agents in the browser using WebAssembly Component Model tooling (componentize-py + JCO).

**Key Findings**:
- componentize-py usage is correct per official documentation
- Toolchain incompatibility between componentize-py (wasmtime-optimized) and JCO (browser execution)
- JavaScript agents work perfectly; Python agents have runtime string encoding issues
- Architecture is sound and future-proof

**Recommendation**: Continue with JavaScript agents; revisit Python when toolchain matures.

---

## Adding New Investigations

When documenting a new investigation:

1. Create a descriptive markdown file in this directory
2. Update this README with a summary entry
3. Include: Status, Date, Summary, Key Findings, and Recommendations
4. Link to relevant code, issues, or external resources
