// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Icon Imports --
import { ChevronRight, CircleHelp } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../../common/IconButton";
import { QuietButton } from "../../common/QuietButton";
import { Switch } from "../../common/Switch/Switch";
import { PluginIcon } from "../../plugins/PluginIcon";
import { PluginTag } from "../../plugins/PluginTag";
import { TextLink, WithLink } from "../../plugins/TextLink";
import { DevRowTools } from "../plugins/DevRowTools";
import { PluginLogPanel } from "../plugins/PluginLogPanel";
import { PluginRowPanel } from "../plugins/PluginRowPanel";
import { PluginKindTile } from "./PluginKindTile";

// -- State Imports --
import { restartPlugin } from "../../../state/plugins/restartPlugin";
import { usePlugins } from "../../../state/plugins/store";
import { toggleKind } from "../../../state/player/visualizerCatalog";
import {
  openPluginHub,
  useClearPluginFamilyFocus,
  useOpenSettings,
  usePluginFamilyFocus,
} from "../../../state/shell/store";

// -- Utils Imports --
import { settingAnchorId } from "../settingsRegistry";
import { familySettingId } from "../settingsTarget";
import { familyStatusText } from "./familyText";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { Catalog, CatalogState } from "../../../state/player/visualizerCatalog";
import type { FamilySwitchAction } from "../../../state/plugins/pluginFamily";
import type { CatalogFamily } from "./useCatalogRows";
import type { FamilyOps } from "./useFamilyOps";

// -- Style Imports --
import styles from "./PluginFamily.module.css";

/** The catalog state after a plugin family's own flag flips; null while the catalog is read-only. */
function withFamilyFlag(
  catalog: Catalog,
  flip: Extract<FamilySwitchAction, { kind: "catalog" }>,
): CatalogState | null {
  if (!catalog.writable) return null;
  const { kinds, groups } = catalog.state;
  return { kinds, groups: flip.on ? groups.filter((g) => g !== flip.family) : [...groups, flip.family] };
}

/** The catalog state without a family's off flag; null while the catalog is read-only. */
function withoutFlag(catalog: Catalog, family: string): CatalogState | null {
  if (!catalog.writable) return null;
  return { kinds: catalog.state.kinds, groups: catalog.state.groups.filter((g) => g !== family) };
}

/**
 * One plugin's family: a heading row (icon, name, tag, count or status line, and the one control its
 * state allows), the details panel when unfolded, the line that Plisto has not checked its visualizers,
 * and the tiles, all on one surface that is the heading row's width. A visualizer-only plugin is
 * managed here; a plugin with its own page points to Plugins and its switch is the family's flag.
 */
export function PluginFamily({
  family,
  catalog,
  onChange,
  ops,
}: {
  family: CatalogFamily;
  catalog: Catalog;
  onChange: (next: CatalogState | null) => void;
  ops: FamilyOps;
}) {
  const t = useT();
  const info = family.plugin!;
  const row = usePlugins().find((r) => r.id === info.pluginId);
  const focus = usePluginFamilyFocus();
  const clearFocus = useClearPluginFamilyFocus();
  const openSettings = useOpenSettings();
  const [open, setOpen] = useState(focus === info.pluginId);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    if (focus !== info.pluginId) return;
    setOpen(true);
    clearFocus();
  }, [focus, info.pluginId, clearFocus]);

  if (!row) return null;
  const view = info.view;
  const kindsOff = catalog.state.kinds;
  const total = family.rows.length;
  const on = family.rows.filter((r) => !kindsOff.includes(r.id)).length;
  const unfolded = open && view.expandable;
  const showTiles = view.tiles && total > 0;
  const flip = view.flip;
  const toPlugins = () => openPluginHub(row.id);

  const link =
    view.link === "plugins" ? (
      <TextLink onClick={toPlugins}>{t((d) => d.plugins.vis.openInPlugins)}</TextLink>
    ) : view.link === "restartNormally" ? (
      <TextLink onClick={ops.restartNormally}>{t((d) => d.plugins.safeBanner.restart)}</TextLink>
    ) : null;

  const tools = (
    <DevRowTools
      plain
      canReload={row.source_path !== null}
      busy={ops.busy}
      onReload={() => ops.reload(row)}
      onOpenLog={() => setLogOpen((v) => !v)}
    />
  );

  const classes = [styles.wrap, unfolded ? styles.open : "", view.status === "newer" ? styles.grey : ""];

  return (
    <div
      className={classes.filter(Boolean).join(" ")}
      id={settingAnchorId(familySettingId(info.pluginId))}
      data-family={family.id}
    >
      <div className={styles.head}>
        <PluginIcon source={info.icon} size={32} />
        <div className={styles.main}>
          <div className={styles.name}>
            <span className={styles.nameText}>{info.name}</span>
            <PluginTag kind="plugin" />
            <span className={styles.unchecked}>
              <CircleHelp size={13} strokeWidth={1.8} aria-hidden="true" />
              {t((d) => d.plugins.vis.notChecked)}
            </span>
          </div>
          <div className={`${styles.status} ${view.warn ? styles.warn : ""}`}>
            {familyStatusText(view.status, row, { on, total }, ops.currentVersion, t)} {link}
          </div>
        </div>
        <div className={styles.acts}>
          {view.inline === "restart" ? (
            <QuietButton onClick={() => void restartPlugin(row)} disabled={ops.busy}>
              {t((d) => d.plugins.frame.restart)}
            </QuietButton>
          ) : null}
          {view.inline === "review" ? (
            <QuietButton onClick={() => ops.review(row)} disabled={ops.busy}>
              {t((d) => d.plugins.review)}
            </QuietButton>
          ) : null}
          {view.inline === "uninstall" ? (
            <QuietButton destructive onClick={() => ops.uninstall(row)} disabled={ops.busy}>
              {t((d) => d.plugins.uninstall)}
            </QuietButton>
          ) : null}
          {view.inline === null ? (
            <Switch
              checked={view.checked}
              label={t((d) => d.plugins.enableLabel, { name: info.name })}
              disabled={view.locked || ops.busy || (flip?.kind === "catalog" && !catalog.writable)}
              onChange={() => {
                if (!flip) return;
                if (flip.kind === "plugin") {
                  if (flip.clearFlag) onChange(withoutFlag(catalog, flip.clearFlag));
                  if (flip.enable !== row.enabled) ops.setEnabled(row, flip.enable);
                } else onChange(withFamilyFlag(catalog, flip));
              }}
            />
          ) : null}
          {view.expandable ? (
            <span className={styles.chevron}>
              <IconButton
                aria-label={t((d) => d.plugins.details)}
                aria-expanded={unfolded}
                onClick={() => setOpen(!open)}
              >
                <ChevronRight size={16} strokeWidth={1.8} />
              </IconButton>
            </span>
          ) : null}
        </div>
      </div>
      {unfolded && info.mixed ? (
        <div className={styles.fromPanel}>
          <p className={styles.from}>{t((d) => d.plugins.vis.fromPlugin, { name: info.name })}</p>
          <div className={styles.fromFoot}>
            <QuietButton onClick={toPlugins}>{t((d) => d.plugins.vis.openInPlugins)}</QuietButton>
          </div>
        </div>
      ) : null}
      {unfolded && !info.mixed ? (
        <PluginRowPanel
          row={row}
          busy={ops.busy}
          onToggle={(enable) => ops.setEnabled(row, enable)}
          onUninstall={() => ops.uninstall(row)}
          family={{
            tools: ops.devMode ? tools : null,
            below: (
              <>
                {ops.devMode && logOpen ? (
                  <PluginLogPanel nested rows={[row]} activeId={row.id} onSelect={() => {}} />
                ) : null}
                <p className={styles.elsewhere}>
                  <WithLink
                    text={t((d) => d.plugins.vis.managedElsewhere)}
                    link={
                      <TextLink onClick={() => openSettings({ target: "plugins" })}>
                        {t((d) => d.plugins.section)}
                      </TextLink>
                    }
                  />
                </p>
              </>
            ),
          }}
        />
      ) : null}
      {showTiles ? (
        <div className={styles.note}>
          <CircleHelp size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>{t((d) => d.plugins.vis.notCheckedLine)}</span>
        </div>
      ) : null}
      {showTiles ? (
        <div className={styles.tiles}>
          {family.rows.map((kind) => {
            const kindOn = !kindsOff.includes(kind.id);
            return (
              <PluginKindTile
                key={kind.id}
                row={kind}
                on={kindOn}
                dimmed={!kindOn || view.status !== "on"}
                disabled={view.status !== "on" || !catalog.writable}
                onChange={() => onChange(toggleKind(catalog, kind.id))}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
