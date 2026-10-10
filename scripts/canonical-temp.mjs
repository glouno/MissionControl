// Development/qualification fixtures must satisfy the same canonical-path checks
// as installations. macOS TMPDIR commonly contains the /var -> /private/var alias.
// Resolve only the temporary parent; never normalize configured runtime paths or
// the deliberately redirected paths used by rejection tests. Children inherit it.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.TMPDIR = realpathSync(tmpdir());
