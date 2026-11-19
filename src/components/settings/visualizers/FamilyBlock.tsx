// -- Component Imports --
import { Switch } from "../../common/Switch/Switch";
import { Tooltip } from "../../common/Tooltip/Tooltip";
import { FamilyMark } from "../../player/visualizers/tiles/FamilyMark";
import { CatalogTile } from "./CatalogTile";

// -- State Imports --
import { useT } from "../../../i18n";
import { canTurnOff, familyState, toggleGroup, toggleKind } from "../../../state/player/visualizerCatalog";
import { groupLabel } from "../../../state/player/visualizerRegistry";

// -- Type Imports --
import type { Catalog, CatalogState } from "../../../state/player/visualizerCatalog";
import type { CatalogFamily } from "./useCatalogRows";

// -- Style Imports --
import settingsStyles from "../SettingsView.module.css";
import styles from "./FamilyBlock.module.css";

/**
 * One family: its name, a count line, its own switch, and a tile per kind. The family switch is the
 * stored flag only, so a family whose kinds are all off still reads on. A control the last-on guard
 * refuses is disabled, and the family holding the last kind says why in its header.
 */
export function FamilyBlock({
  family,
  catalog,
  onChange,
}: {
  family: CatalogFamily;
  catalog: Catalog;
  onChange: (next: CatalogState | null) => void;
}) {
  const t = useT();
  const { state, offered } = familyState(catalog, family.id);
  const familyOn = state !== "off";
  const holdsLast = familyOn && offered === 1 && catalog.offeredKinds.length === 1;
  const lastNote = t((d) => d.settings.visualizersLastOn);
  const count = familyOn
    ? t((d) => d.settings.visualizersOnCount, { n: offered, total: family.rows.length })
    : t((d) => d.settings.visualizersFamilyOff);
  const name = groupLabel(family.id, t);
  const familyGuarded = familyOn && !canTurnOff(catalog, "group", family.id);

  return (
    <div className={styles.family} data-family={family.id}>
      <div className={styles.head}>
        <h3 className={`${settingsStyles.label} ${styles.name}`}>{name}</h3>
        <FamilyMark id={family.id} />
        <span className={styles.count}>{count}</span>
        {holdsLast ? <span className={styles.count}>{lastNote}</span> : null}
        <span className={styles.grow} />
        <Tooltip label={familyGuarded && catalog.writable ? lastNote : undefined}>
          <span>
            <Switch
              checked={familyOn}
              onChange={() => onChange(toggleGroup(catalog, family.id))}
              label={name}
              disabled={!catalog.writable || familyGuarded}
            />
          </span>
        </Tooltip>
      </div>
      <div className={styles.tiles}>
        {family.rows.map((row) => {
          const on = !catalog.state.kinds.includes(row.id);
          const guarded = familyOn && on && !canTurnOff(catalog, "kind", row.id);
          return (
            <CatalogTile
              key={row.id}
              row={row}
              on={on}
              dimmed={!on || !familyOn}
              disabled={!catalog.writable || !familyOn || guarded}
              lockedNote={guarded && catalog.writable ? lastNote : undefined}
              onChange={() => onChange(toggleKind(catalog, row.id))}
            />
          );
        })}
      </div>
    </div>
  );
}
