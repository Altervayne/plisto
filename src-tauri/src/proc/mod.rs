/*
 * Child processes Plisto starts: the Job Object that owns a child's process tree, and the spawn that
 * puts a child in its job before it runs.
 */

pub mod job;
pub mod spawn;
#[cfg(test)]
mod tests;
