/*
 * Where Settings lists a plugin: the visualizer catalog or the plugins list. A plugin is listed in
 * the catalog only when everything it is or does shows as tiles there: a UI plugin with
 * visualizers, no page of its own, no sidebar, and only capabilities a visualizer frame uses.
 * Anything that exists or runs outside the stage puts it in the plugins list. Computed here once;
 * the app only reads it.
 */

// -- Library Imports --
use serde::Serialize;

// -- Local Imports --
use super::manifest::{Capability, Manifest, Tier};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Listing {
    Catalog,
    Plugins,
}

const FRAME_CAPABILITIES: [Capability; 5] = [
    Capability::Visualizer,
    Capability::VisualizerWaveform,
    Capability::Storage,
    Capability::PlaybackRead,
    Capability::LibraryRead,
];

pub fn listing(manifest: &Manifest) -> Listing {
    let visualizer_only = manifest.tier == Tier::Ui
        && !manifest.visualizers.is_empty()
        && manifest.capabilities.contains(&Capability::Visualizer)
        && manifest.entry.is_none()
        && manifest.sidebar.is_none()
        && manifest
            .capabilities
            .iter()
            .all(|cap| FRAME_CAPABILITIES.contains(cap));
    if visualizer_only {
        Listing::Catalog
    } else {
        Listing::Plugins
    }
}

#[cfg(test)]
mod tests;
