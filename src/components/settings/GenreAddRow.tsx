// -- Component Imports --
import { GenreAdder } from "../common/GenreAdder";
import { SettingRow } from "./SettingRow";

// -- Hook Imports --
import { useWriteGate } from "../organize/useWriteGate";

// -- State Imports --
import { useCreateGenre, useGenres } from "../../state/organize/store";

// -- i18n Imports --
import { useT } from "../../i18n";

/**
 * The Settings row that adds a genre to the vocabulary. The list above it keeps showing while the albums
 * load; only the Create row waits, since the store refuses the write until then.
 */
export function GenreAddRow({ className }: { className?: string }) {
  const genres = useGenres();
  const createGenre = useCreateGenre();
  const gate = useWriteGate("albums");
  const t = useT();

  // The store surfaces any failure through its error channel; swallow the rejection here.
  const onCreate = (name: string) => {
    void createGenre(name).catch(() => {});
  };

  return (
    <SettingRow id="addGenre" className={className}>
      <GenreAdder
        genres={genres}
        onPick={() => {}}
        onCreate={onCreate}
        placeholder={t((d) => d.settings.addGenre)}
        createTip={gate.tip}
      />
    </SettingRow>
  );
}
