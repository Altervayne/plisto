/*
 * The visualizer popover a context menu opens beside itself for one album or track: the stored default
 * of that target, which need not be what plays. A pick writes the default and closes the popover and the
 * menu. Reactivity and layout are global settings and stay in the Player's picker.
 */

// -- Framework Imports --
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

// -- Icon Imports --
import { Check, Waves } from "lucide-react";

// -- Component Imports --
import { GroupMarkers } from "../tiles/GroupMarkers";
import { KindTag } from "../tiles/KindTag";
import { KindTile } from "../tiles/KindTile";
import { VisualizerGlyph } from "../VisualizerGlyph";

// -- Hook Imports --
import { useVisualizerPopoverModel, type VisualizerScope } from "./useVisualizerPopoverModel";

// -- State Imports --
import { groupLabel } from "../../../../state/player/visualizerRegistry";
import type { VisualizerKind } from "../../../../state/player/visualizerKind";
import type { SkippedDefault } from "../../../../state/player/visualizerResolve";

// -- Utils Imports --
import { nextFocus, type NavDirection } from "../tiles/focusNav";
import { VISUALIZER_VIEWS } from "../visualizerViews";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { MenuPanelApi } from "../../../common/ContextMenu";

// -- Style Imports --
// The rows and separators are the Player picker's, the tabs the segmented control's.
import menuStyles from "../../MenuRows.module.css";
import segmentStyles from "../../../common/SegmentedControl.module.css";
import styles from "./VisualizerPopover.module.css";

const NAV_KEYS: readonly string[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/**
 * Opens on the tab holding the stored kind, else the album default, with focus on the checked control.
 * The arrows move by position across the rows, the tabs and the tiles; Escape is the side panel's.
 */
export function VisualizerPopover({ scope, close }: { scope: VisualizerScope } & MenuPanelApi) {
  const t = useT();
  const { model, title, subtitle, ready, pick } = useVisualizerPopoverModel(scope, close);
  const [tabPicked, setTab] = useState<string>(model.openTab);
  // A family turned off while the popover is open leaves its tab with nothing to show.
  const tab = model.groups.some((g) => g.id === tabPicked) ? tabPicked : model.openTab;
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const first =
      root?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
      root?.querySelector<HTMLElement>("[data-kind]");
    first?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root || !NAV_KEYS.includes(event.key)) return;
    const items = [...root.querySelectorAll<HTMLElement>("[data-nav]")];
    const here = items.indexOf(document.activeElement as HTMLElement);
    if (here < 0) return;
    event.preventDefault();
    const rects = items.map((el) => el.getBoundingClientRect());
    const next = nextFocus(rects, here, event.key as NavDirection);
    if (next != null) items[next].focus();
  };

  const kindName = (kind: VisualizerKind) => t(VISUALIZER_VIEWS[kind].label);
  const topLabel =
    model.topLabel.form === "albumDefault"
      ? t((d) => d.player.visualizerUseAlbumDefault, { name: kindName(model.topLabel.kind) })
      : t((d) => d.player.visualizerUseGlobal);
  const disabled = ready ? undefined : true;
  const kinds = model.groups.find((g) => g.id === tab)?.kinds ?? [];
  // One quiet line: the stored kind the catalog turns off, else the album default it turns off, else the
  // album default a track follows.
  const { albumDefault, albumDefaultOff } = model;
  const skipped: SkippedDefault | null =
    model.turnedOff ?? (albumDefaultOff ? { kind: albumDefaultOff, tier: "album" } : null);
  let quiet: string | null = null;
  if (skipped) {
    const name = kindName(skipped.kind);
    quiet =
      skipped.tier === "track"
        ? t((d) => d.player.visualizerSkippedTrack, { name })
        : t((d) => d.player.visualizerSkippedAlbum, { name });
  } else if (albumDefault) {
    quiet = t((d) => d.player.visualizerAlbumDefaultLine, { name: kindName(albumDefault) });
  }
  // With no checked tile on this tab, its first tile is the grid's tab stop.
  const hasChecked = kinds.some((k) => k === model.stored);

  const row = (kind: VisualizerKind | null, checked: boolean, icon: ReactNode, label: string) => (
    <div className={menuStyles.group}>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-disabled={disabled}
        tabIndex={checked ? 0 : -1}
        data-nav=""
        className={menuStyles.item}
        onClick={() => pick(kind)}
      >
        <span className={menuStyles.icon} aria-hidden="true">
          {icon}
        </span>
        <span className={menuStyles.label}>{label}</span>
        <span className={menuStyles.check} aria-hidden="true">
          {checked ? <Check size={15} strokeWidth={2} /> : null}
        </span>
      </button>
    </div>
  );

  return (
    <div ref={rootRef} className={styles.root} onKeyDown={onKeyDown}>
      <div className={styles.head}>
        <span className={styles.title}>{t((d) => d.player.visualizerHeader, { name: title })}</span>
        {subtitle ? <span className={styles.sub}>{subtitle}</span> : null}
      </div>
      {row(null, model.topChecked, <Waves size={16} strokeWidth={1.8} />, topLabel)}
      <div className={menuStyles.sep} />
      <div className={`${segmentStyles.control} ${styles.tabs}`} role="tablist">
        {model.groups.map((group) => {
          const active = group.id === tab;
          return (
            <button
              key={group.id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-nav=""
              className={`${segmentStyles.segment} ${styles.tab} ${active ? segmentStyles.active : ""}`}
              onClick={() => setTab(group.id)}
            >
              {groupLabel(group.id, t)}
              <GroupMarkers active={model.markers[group.id].active} setAside={model.markers[group.id].setAside} />
            </button>
          );
        })}
      </div>
      <div className={styles.grid} role="radiogroup" aria-label={groupLabel(tab, t)}>
        {kinds.map((kind, i) => {
          const checked = kind === model.stored;
          return (
            <KindTile
              key={kind}
              kind={kind}
              checked={checked}
              aria-disabled={disabled}
              tabIndex={checked || (!hasChecked && i === 0) ? 0 : -1}
              tag={
                kind === model.setAside ? (
                  <KindTag form="set-aside" label={t((d) => d.player.visualizerTagAlbum)} />
                ) : undefined
              }
              onClick={() => pick(kind)}
            />
          );
        })}
      </div>
      <div className={menuStyles.sep} />
      {row("off", model.stored === "off", <VisualizerGlyph kind="off" />, kindName("off"))}
      {quiet ? <div className={styles.quiet}>{quiet}</div> : null}
    </div>
  );
}
