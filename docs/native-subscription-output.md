# Native subscription output and review handoff

`src/control/nativeOutputSchema.ts` adapts the application JSON schema for
strict native structured output. It clones the original schema, recursively
sets `additionalProperties: false` on objects with declared properties, and
marks every declared property as required, including nested objects. The
original schema is not mutated and remains the authority for validation.

Originally optional properties gain a nullable transport alternative: they
must appear in native output, using `null` to represent absence.
`normalizeNativeOutput` uses the original schema to remove those optional
null-valued properties before original schema validation. It traverses nested
objects and array items, resolving local references and matching union
branches. Required nulls and unknown fields are preserved, so normalization
does not hide invalid output: required fields that disallow null and unknown
fields rejected by the original schema remain invalid. Removing optional
transport nulls also allows application defaults to apply.

`src/control/subscriptionNative.ts` sends the adapted schema to the native
runtime and normalizes its structured result before worker handoff validation
or returning custom-schema output for application validation. A successful
native result does not replace the controller's independent checks and review.

After coding completes, controller review continues only after the dedicated
writer is released. It retains the current task's verifying lease rather than
releasing it or admitting another writer. Review reservation requires the
current claim and its valid lease generation; a running task, missing claim,
or stale generation cannot use this handoff. Other active writers and duplicate
review reservations still block admission. Review consumes its own subscription
attempt and usage accounting while the task attempt remains active.

The regression tests cover recursive strictness and schema immutability,
optional-null normalization and rejection of invalid required nulls and unknown
fields, native protocol handling, and review admission with lease and generation
safeguards. Run locally with existing build dependencies:

```sh
npm run build
node --test dist/control/nativeOutputSchema.test.js dist/control/subscriptionNative.test.js dist/control/subscriptionAccounting.test.js
```
