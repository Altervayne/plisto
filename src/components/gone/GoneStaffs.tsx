// -- Style Imports --
import styles from "./GoneStaffs.module.css";

/** Five pulsing bars for a check or a scan in progress. `tall` is the larger form for a whole-body state. */
export function GoneStaffs({ tall = false }: { tall?: boolean }) {
  return (
    <span className={tall ? `${styles.staffs} ${styles.tall}` : styles.staffs} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
