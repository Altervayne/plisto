// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Library Imports --
import { Puzzle } from "lucide-react";

// -- Utils Imports --
import { iconKey, loadIcon } from "../../state/plugins/iconCache";

// -- Type Imports --
import type { IconSource } from "../../state/plugins/iconCache";

// -- Style Imports --
import styles from "./PluginIcon.module.css";

/**
 * A plugin's icon on a square tile. The icon arrives as a data URL from the backend, never from the
 * plugin's own frame host; while it loads, and when the plugin has none, the puzzle piece stands in.
 * A null `source` skips the read (a plugin whose manifest cannot be read).
 */
export function PluginIcon({ source, size = 32 }: { source: IconSource | null; size?: number }) {
  const key = source ? iconKey(source) : null;
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!source || !key) return;
    let alive = true;
    void loadIcon(source).then((url) => {
      if (alive) setLoaded({ key, url });
    });
    return () => {
      alive = false;
    };
    // `source` is a fresh object each render; `key` carries its identity.
  }, [key]);

  const url = loaded && loaded.key === key ? loaded.url : null;
  return (
    <span className={styles.tile} style={{ width: size, height: size }} aria-hidden="true">
      {url ? (
        <img className={styles.img} src={url} alt="" draggable={false} />
      ) : (
        <Puzzle size={Math.round(size * 0.5)} strokeWidth={1.8} />
      )}
    </span>
  );
}
