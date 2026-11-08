/** What Escape does on the ambient stage: close the open sheet first, leave only when none is open. */
export function ambientEscape(sheetOpen: boolean): "sheet" | "exit" {
  return sheetOpen ? "sheet" : "exit";
}
