//! NDJSON lines from the agent, with the line cap: a line over it is refused
//! and skipped, never fatal (ADR-0009).

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub enum Line {
    Complete(Vec<u8>),
    /// Longer than the cap, newline included; its bytes were dropped as they came.
    TooLong,
    /// The stream ended. A last line without its newline is dropped.
    End,
}

/// Reads the next line, holding at most `cap` bytes of it.
pub async fn next_line(
    reader: &mut (impl AsyncBufRead + Unpin),
    cap: usize,
) -> std::io::Result<Line> {
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(Line::End);
        }
        let newline = available.iter().position(|&b| b == b'\n');
        let take = newline.unwrap_or(available.len());
        // With its newline the line must fit in `cap`, so its bytes stay under it.
        if !too_long && line.len() + take < cap {
            line.extend_from_slice(&available[..take]);
        } else {
            too_long = true;
            line = Vec::new();
        }
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(if too_long {
                Line::TooLong
            } else {
                Line::Complete(line)
            });
        }
    }
}
