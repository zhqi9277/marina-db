// Escapes for OS unit files. Kept here so autostart and the hosts share one implementation.

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * systemd expands `%` specifiers and `$` variables inside ExecStart, so a
 * literal path must double them (`%%`, `$$`). Only the ExecStart command line
 * uses this; unit metadata such as Description is unchanged.
 */
export function systemdEscape(value) {
  return String(value).replace(/%/g, '%%').replace(/\$/g, '$$$$');
}
