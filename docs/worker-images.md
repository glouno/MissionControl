# Worker image qualification

The public recipe is an operator build template. It requires a digest-pinned
`NODE_IMAGE`, exact `CODEX_VERSION` and `CLAUDE_VERSION`. It does not ship binaries,
a prebuilt image, provider credentials or installation-specific image identities.
Review the vendor installation/redistribution terms before building/distributing.

Native npm packages can require vendor-specific installation scripts or binary
packages. The template disables lifecycle scripts deliberately; inspect and
qualify each vendor's actual release payload rather than broadly enabling scripts.
The current template is unqualified until both executables are verified in the
built immutable image and its full dependency/license inventory passes.

Controllers select immutable image digests in external host configuration.
Execution uses read-only roots, dropped capabilities, bounded resources, scoped
networking and disposable private homes. Subscription homes require a separate
explicit session store and one writer; they must not reuse the metered worker's
ambient CLI configuration or the operator's personal home.
