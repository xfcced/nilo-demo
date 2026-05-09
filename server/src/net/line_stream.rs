use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use wtransport::{RecvStream, SendStream};

pub type OutboundLineSender = mpsc::UnboundedSender<String>;
pub type OutboundLineReceiver = mpsc::UnboundedReceiver<String>;

pub fn outbound_line_channel() -> (OutboundLineSender, OutboundLineReceiver) {
    mpsc::unbounded_channel()
}

pub struct LineReader {
    reader: BufReader<RecvStream>,
    buffer: Vec<u8>,
}

impl LineReader {
    pub fn new(recv_stream: RecvStream) -> Self {
        Self {
            reader: BufReader::new(recv_stream),
            buffer: Vec::new(),
        }
    }

    pub async fn read_line(&mut self) -> Result<Option<String>> {
        self.buffer.clear();
        let bytes_read = self
            .reader
            .read_until(b'\n', &mut self.buffer)
            .await
            .context("failed to read line from WebTransport stream")?;

        if bytes_read == 0 {
            return Ok(None);
        }

        Ok(Some(
            String::from_utf8_lossy(&self.buffer).trim().to_owned(),
        ))
    }
}

pub async fn write_lines(
    mut send_stream: SendStream,
    mut receiver: OutboundLineReceiver,
) -> Result<()> {
    while let Some(line) = receiver.recv().await {
        send_stream
            .write_all(line.as_bytes())
            .await
            .context("failed to write line payload")?;
        send_stream
            .write_all(b"\n")
            .await
            .context("failed to write line delimiter")?;
    }

    Ok(())
}
