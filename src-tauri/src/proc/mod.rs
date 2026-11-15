/*
 * Child processes Plisto starts: the Job Object that owns a child's process tree, the spawn that puts
 * a child in its job before it runs, and the AppContainer launch of a helper, which is `plisto.exe`
 * itself started in a helper mode.
 */

// Only debug builds and tests start a helper; a release build runs the helper modes alone.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub mod acl;
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub mod contained;
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub mod container;
pub mod helper;
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub mod helper_launch;
pub mod job;
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub mod session;
pub mod spawn;
#[cfg(test)]
pub(crate) mod test_helper;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_container;
