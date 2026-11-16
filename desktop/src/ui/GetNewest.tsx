/**
 * "Get the newest ICMM" (#360, RF12): a link, kept on one line, that opens
 * ICMM's releases page in the OS's web browser (`open_releases_page`), where
 * its newest version is. The page's address lives with the desktop alone.
 * Where it's said, a sentence names what the newest ICMM does: "Get the
 * newest ICMM to draw it."
 */
import { commands } from "../wire/api.gen";

export function GetNewest() {
  return (
    <a
      href="#releases"
      className="link nw"
      onClick={(e) => {
        e.preventDefault();
        // The desktop logs an opener that fails; the sentence stays as it is.
        void commands.open_releases_page().catch(() => {});
      }}
    >
      Get the newest ICMM
    </a>
  );
}
