/*
 * Types for plisto-sdk.js, protocol 1. Include this file in a TypeScript project to type window.plisto.
 * PlistoMethods lists every method of this API version: one quoted key per line.
 */

export type PlistoErrorCode =
  | "denied"
  | "rate_limited"
  | "invalid_args"
  | "too_large"
  | "not_found"
  | "unknown_method"
  | "busy"
  | "timeout"
  | "unavailable";

export type PlistoLocale = "en" | "fr" | (string & {});
export type PlistoTheme = "light" | "dark";
export type PlistoAppMode = "player" | "organizer" | "both";
export type PlistoLogLevel = "debug" | "info" | "warn" | "error";

export interface AppInfo {
  api_version: number;
  plisto_version: string;
  plugin_id: string;
  plugin_version: string;
  locale: PlistoLocale;
  theme: PlistoTheme;
  app_mode: PlistoAppMode;
  tier: "ui" | "native";
  granted: string[];
}

export interface AppMethodsResult {
  api_version: number;
  methods: string[];
}

export interface StorageGetArgs {
  key: string;
}
export interface StorageGetResult {
  found: boolean;
  value: unknown;
}
export interface StorageSetArgs {
  key: string;
  value: unknown;
}
export interface StorageSetResult {
  usage: number;
}
export interface StorageRemoveArgs {
  key: string;
}
export interface StorageRemoveResult {
  removed: boolean;
  usage: number;
}
export interface StorageKeysArgs {
  prefix?: string;
}
export interface StorageKeysResult {
  keys: string[];
}
export interface StorageClearResult {
  usage: number;
}
export interface StorageUsageResult {
  usage: number;
  quota: number;
}
export interface LogWriteArgs {
  level: PlistoLogLevel;
  text: string;
}
export interface LogWriteResult {
  truncated: boolean;
}

export type PlistoTone = "neutral" | "accent" | "warn";
export type EmptyResult = Record<string, never>;

/** One chip: exactly one of `text` (1 to 12 characters) and `count` (an integer from 0 to 2147483647). */
export interface PlistoChipInput {
  text?: string;
  count?: number;
  /** Default "neutral". */
  tone?: PlistoTone;
}

export interface UiToastArgs {
  /** Plain text, 1 to 140 characters. */
  text: string;
  /** Label of an optional action button, 1 to 24 characters. */
  action?: string;
}
export type UiToastResult = { result: "dismissed" } | { result: "action"; gesture: string };

export interface UiConfirmArgs {
  /** 1 to 60 characters. */
  title: string;
  /** 1 to 300 characters. */
  body: string;
  /** 1 to 24 characters. */
  confirm_label: string;
  /** 1 to 24 characters; Plisto's own "Cancel" when left out. */
  cancel_label?: string;
  /** A token from a recent click; lets a background page ask while its page is closed. */
  gesture?: string;
}
export interface UiConfirmResult {
  answer: boolean;
}

export interface UiChipsArgs {
  /** At most 2; an empty array clears. */
  chips: PlistoChipInput[];
}

export interface UiOpenPageArgs {
  /** 1 to 64 visible ASCII characters, or null for the page's start. */
  route?: string | null;
  gesture?: string;
}

/** `label: null` keeps the label declared in the manifest. */
export interface NavStateInput {
  label?: string | null;
  chip?: PlistoChipInput | null;
  visible?: boolean;
}
export interface StatusStateInput {
  /** 1 to 40 characters. */
  text: string;
  tone?: PlistoTone;
  visible?: boolean;
}
export interface ProgressStateInput {
  /** 0 to 1 inclusive; null shows an indeterminate sweep. */
  value: number | null;
  /** Up to 40 characters; null shows the declared label. */
  text?: string | null;
  visible?: boolean;
}
export interface ToggleStateInput {
  on: boolean;
  /** Default true. */
  enabled?: boolean;
  visible?: boolean;
}
export interface ActionStateInput {
  label?: string | null;
  /** Default true. */
  enabled?: boolean;
  visible?: boolean;
}
/** The state of one item, matching the item's declared type. An update replaces the whole state. */
export type SidebarStateInput =
  | NavStateInput
  | StatusStateInput
  | ProgressStateInput
  | ToggleStateInput
  | ActionStateInput;

export interface UiSidebarUpdateArgs {
  item_id: string;
  state: SidebarStateInput;
}

/** A click on one of the plugin's toggle or action items. `value` is null for an action. */
export interface SidebarInput {
  item_id: string;
  value: boolean | null;
  /** Single-use token, valid for 5 seconds; pass it to ui.confirm or ui.open_page. */
  gesture: string;
}

export interface PlistoMethods {
  "app.info": { args: {}; result: AppInfo };
  "app.methods": { args: {}; result: AppMethodsResult };
  "storage.get": { args: StorageGetArgs; result: StorageGetResult };
  "storage.set": { args: StorageSetArgs; result: StorageSetResult };
  "storage.remove": { args: StorageRemoveArgs; result: StorageRemoveResult };
  "storage.keys": { args: StorageKeysArgs; result: StorageKeysResult };
  "storage.clear": { args: {}; result: StorageClearResult };
  "storage.usage": { args: {}; result: StorageUsageResult };
  "log.write": { args: LogWriteArgs; result: LogWriteResult };
  "ui.toast": { args: UiToastArgs; result: UiToastResult };
  "ui.confirm": { args: UiConfirmArgs; result: UiConfirmResult };
  "ui.open_page": { args: UiOpenPageArgs; result: EmptyResult };
  "ui.chips": { args: UiChipsArgs; result: EmptyResult };
  "ui.sidebar.update": { args: UiSidebarUpdateArgs; result: EmptyResult };
}

export interface CallOptions {
  /** 1 to 600000; default 10000. */
  timeoutMs?: number;
}

/** The shape of a rejected call. The constructor exists only as `plisto.PlistoError`. */
export interface PlistoError extends Error {
  readonly code: PlistoErrorCode;
  /** Set only for rate_limited: how long to wait before retrying. */
  readonly retryAfterMs: number | null;
  /** Refines the code when the host gives one; "no_gesture" comes with denied. Otherwise null. */
  readonly reason: string | null;
}

export interface PlistoErrorConstructor {
  new (code: PlistoErrorCode, message?: string, retryAfterMs?: number, reason?: string): PlistoError;
  readonly prototype: PlistoError;
}

export interface PlistoEvents {
  visibility: boolean;
  theme: PlistoTheme;
  sidebar: SidebarInput;
  /** The page's route; null for none. */
  route: string | null;
}

export interface Plisto {
  readonly sdkVersion: string;
  /** Resolves with the app info once Plisto has initialised this page. */
  readonly ready: Promise<AppInfo>;
  /** Last known values; null, false and null before init. */
  readonly info: AppInfo | null;
  readonly pageOpen: boolean;
  readonly route: string | null;
  readonly PlistoError: PlistoErrorConstructor;
  call<M extends keyof PlistoMethods>(
    method: M,
    args?: PlistoMethods[M]["args"],
    options?: CallOptions,
  ): Promise<PlistoMethods[M]["result"]>;
  /** For methods this version of the types does not know; rejects unknown_method if the host lacks it. */
  call(method: string, args?: object, options?: CallOptions): Promise<unknown>;
  /** True when the host listed the method at init; false before init. */
  has(method: string): boolean;
  on<E extends keyof PlistoEvents>(event: E, callback: (value: PlistoEvents[E]) => void): () => void;
  readonly app: {
    info(): Promise<AppInfo>;
    methods(): Promise<AppMethodsResult>;
  };
  readonly storage: {
    /** Resolves the stored value when found, else `fallback`. */
    get<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<StorageSetResult>;
    remove(key: string): Promise<StorageRemoveResult>;
    keys(prefix?: string): Promise<StorageKeysResult>;
    clear(): Promise<StorageClearResult>;
    usage(): Promise<StorageUsageResult>;
  };
  readonly ui: {
    /** Resolves when the toast leaves the screen. Needs the ui.toast capability. */
    toast(text: string, options?: { action?: string }): Promise<UiToastResult>;
    /** Resolves the user's answer. Needs ui.confirm; refused without a page or a gesture. */
    confirm(args: UiConfirmArgs): Promise<boolean>;
    /** Needs ui.chips. */
    chips(chips: PlistoChipInput[]): Promise<EmptyResult>;
    /** Opens this plugin's own page. Refused without the page open or a gesture. */
    openPage(route?: string | null, gesture?: string): Promise<EmptyResult>;
    readonly sidebar: {
      /** Needs ui.sidebar. */
      update(itemId: string, state: SidebarStateInput): Promise<EmptyResult>;
    };
  };
  readonly log: {
    debug(text: string): Promise<LogWriteResult>;
    info(text: string): Promise<LogWriteResult>;
    warn(text: string): Promise<LogWriteResult>;
    error(text: string): Promise<LogWriteResult>;
  };
}

declare global {
  interface Window {
    plisto: Plisto;
  }
}
