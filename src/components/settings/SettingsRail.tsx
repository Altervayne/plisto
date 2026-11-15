// -- Framework Imports --
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

// -- Icon Imports --
import { ChevronDown } from "lucide-react";

// -- Utils Imports --
import { menuKeyTarget } from "./menuNav";
import { SETTINGS_SECTIONS } from "./settingsSections";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { SettingsSectionId } from "./settingsSections";

// -- Style Imports --
import styles from "./SettingsRail.module.css";

interface NavProps {
  active: SettingsSectionId;
  onPick: (id: SettingsSectionId) => void;
}

/**
 * The section list beside the column, outside the scroller so it stays put. The shown section reads
 * in ink; a click shows another. Below the width that fits it the stylesheet hides the rail and the
 * Sections control takes over, so the page holds both and CSS picks one.
 */
export function SettingsRail({ active, onPick }: NavProps) {
  const t = useT();
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  // Arrows, Home and End move focus between entries; Tab order is untouched.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const focused = items.current.findIndex((el) => el === document.activeElement);
    const next = menuKeyTarget(e.key, focused < 0 ? 0 : focused, SETTINGS_SECTIONS.length);
    if (next == null || focused < 0) return;
    e.preventDefault();
    items.current[next]?.focus();
  };

  return (
    <nav className={styles.rail} aria-label={t((d) => d.settings.sections)} onKeyDown={onKeyDown}>
      {SETTINGS_SECTIONS.map((section, i) => (
        <button
          key={section.id}
          ref={(el) => {
            items.current[i] = el;
          }}
          type="button"
          className={styles.item}
          data-nav-focus={section.id === active ? "" : undefined}
          aria-current={section.id === active ? "page" : undefined}
          onClick={() => onPick(section.id)}
        >
          {t(section.label)}
        </button>
      ))}
    </nav>
  );
}

/**
 * The rail folded into one button in the head. It names the current section, since nothing else on
 * screen does at this width, and opens the same list as a menu: focus lands on the current entry, the
 * arrows, Home and End move, Escape or a pick closes and returns focus to the button. The menu role
 * keeps the window shortcuts (Escape included) out of the way while it is open, and the menu closes if
 * the view widens and the button is hidden.
 */
export function SectionsMenu({ active, onPick }: NavProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const currentIndex = Math.max(
    0,
    SETTINGS_SECTIONS.findIndex((section) => section.id === active),
  );
  const current = SETTINGS_SECTIONS[currentIndex];

  useEffect(() => {
    if (!open) return;
    items.current[currentIndex]?.focus();
    // Keyed on open alone: a section change while the menu is up must not pull focus back.
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    let observer: ResizeObserver | null = null;
    if (wrap.current && typeof ResizeObserver !== "undefined") {
      // A hidden fold measures zero wide: the view widened past the fold, so the menu goes with it.
      observer = new ResizeObserver((entries) => {
        if (entries.some((entry) => entry.contentRect.width === 0)) setOpen(false);
      });
      observer.observe(wrap.current);
    }
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      observer?.disconnect();
    };
  }, [open]);

  const closeToTrigger = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeToTrigger();
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    const focused = items.current.findIndex((el) => el === document.activeElement);
    const next = menuKeyTarget(e.key, focused < 0 ? currentIndex : focused, SETTINGS_SECTIONS.length);
    if (next == null) return;
    e.preventDefault();
    items.current[next]?.focus();
  };

  return (
    <div ref={wrap} className={styles.fold}>
      <button
        ref={trigger}
        type="button"
        data-nav-focus=""
        className={styles.button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t((d) => d.settings.sectionsCurrent, { name: t(current.label) })}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{t(current.label)}</span>
        <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={t((d) => d.settings.sections)}
          className={styles.menu}
          onKeyDown={onMenuKeyDown}
        >
          {SETTINGS_SECTIONS.map((section, i) => (
            <button
              key={section.id}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`${styles.item} ${styles.menuItem}`}
              aria-current={section.id === active ? "page" : undefined}
              onClick={() => {
                closeToTrigger();
                onPick(section.id);
              }}
            >
              {t(section.label)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
