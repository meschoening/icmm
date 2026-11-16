//! Reads a JSON Schema on stdin and writes its Rust types, via typify, on stdout.
//!
//! `icmm-wire gen` runs it on `wire/wire.schema.json` reshaped for typify
//! (draft-07 `definitions`, union variants inlined), then rustfmts the output.

use std::io::{self, Read, Write};
use std::process::ExitCode;

use typify::{TypeSpace, TypeSpaceSettings};

fn main() -> ExitCode {
    match generate() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("wire-gen: {e}");
            ExitCode::FAILURE
        }
    }
}

fn generate() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let schema: schemars::schema::RootSchema = serde_json::from_str(&input)?;
    let mut settings = TypeSpaceSettings::default();
    settings.with_struct_builder(false);
    let mut space = TypeSpace::new(&settings);
    space.add_root_schema(schema)?;
    let file: syn::File = syn::parse2(space.to_stream())?;
    io::stdout().write_all(prettyplease::unparse(&file).as_bytes())?;
    Ok(())
}
