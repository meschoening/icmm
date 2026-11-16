//! The wire: the types, commands and command list generated from the
//! registry in `engine/icmm/wire` by `uv run icmm-wire gen`.

pub mod commands;
pub mod types;

include!("command_names.rs");
